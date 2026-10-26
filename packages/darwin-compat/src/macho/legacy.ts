/**
 * Legacy dyld bind and rebase opcodes (`LC_DYLD_INFO` / `LC_DYLD_INFO_ONLY`).
 *
 * ld64 emits this format when chained fixups are disabled (older deployment
 * targets, `-no_fixup_chains`, some hand-written link steps). The loader applies
 * every operation eagerly: lazy-binding streams are resolved at load time, so
 * the process never calls `dyld_stub_binder`.
 *
 * Only the classic opcode set is implemented. The arm64 threaded-bind opcode
 * (0xD0) is rejected with `legacy_threaded_binds_unimplemented` rather than
 * misparsed.
 */

import { MachOError } from "../errors.js";
import type { MachOImage } from "./types.js";

export interface LegacyRebase {
  readonly segmentIndex: number;
  readonly offset: number;
}

export interface LegacyBind {
  readonly segmentIndex: number;
  readonly offset: number;
  readonly symbol: string;
  /** 0 = self, positive = dependency ordinal, negative = special. */
  readonly ordinal: number;
  readonly addend: bigint;
  readonly weak: boolean;
}

export interface LegacyFixups {
  readonly rebases: readonly LegacyRebase[];
  readonly binds: readonly LegacyBind[];
}

const REBASE_DONE = 0x00;
const REBASE_SET_TYPE_IMM = 0x10;
const REBASE_SET_SEGMENT_AND_OFFSET_ULEB = 0x20;
const REBASE_ADD_ADDR_ULEB = 0x30;
const REBASE_ADD_ADDR_IMM_SCALED = 0x40;
const REBASE_DO_REBASE_IMM_TIMES = 0x50;
const REBASE_DO_REBASE_ULEB_TIMES = 0x60;
const REBASE_DO_REBASE_ADD_ADDR_ULEB = 0x70;
const REBASE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB = 0x80;

const BIND_DONE = 0x00;
const BIND_SET_DYLIB_ORDINAL_IMM = 0x10;
const BIND_SET_DYLIB_ORDINAL_ULEB = 0x20;
const BIND_SET_DYLIB_SPECIAL_IMM = 0x30;
const BIND_SET_SYMBOL_TRAILING_FLAGS_IMM = 0x40;
const BIND_SET_TYPE_IMM = 0x50;
const BIND_SET_ADDEND_SLEB = 0x60;
const BIND_SET_SEGMENT_AND_OFFSET_ULEB = 0x70;
const BIND_ADD_ADDR_ULEB = 0x80;
const BIND_DO_BIND = 0x90;
const BIND_DO_BIND_ADD_ADDR_ULEB = 0xa0;
const BIND_DO_BIND_ADD_ADDR_IMM_SCALED = 0xb0;
const BIND_DO_BIND_ULEB_TIMES_SKIPPING_ULEB = 0xc0;
const BIND_THREADED = 0xd0;

const MAX_OPERATIONS = 100_000;

export function parseLegacyFixups(bytes: Uint8Array, image: MachOImage): LegacyFixups {
  const info = image.dyldInfo;
  if (!info) return { rebases: [], binds: [] };
  const rebases = parseRebases(bytes, info.rebaseOffset, info.rebaseSize);
  const binds = [
    ...parseBinds(bytes, info.bindOffset, info.bindSize),
    ...parseBinds(bytes, info.weakBindOffset, info.weakBindSize),
    ...parseBinds(bytes, info.lazyBindOffset, info.lazyBindSize),
  ];
  return { rebases, binds };
}

function parseRebases(bytes: Uint8Array, offset: number, size: number): LegacyRebase[] {
  if (size === 0) return [];
  const stream = new Cursor(bytes, offset, size, "rebase");
  const rebases: LegacyRebase[] = [];
  let segmentIndex = 0;
  let segmentOffset = 0;
  let operations = 0;
  while (!stream.done) {
    const byte = stream.u8();
    const opcode = byte & 0xf0;
    const immediate = byte & 0x0f;
    if (++operations > MAX_OPERATIONS) {
      throw new MachOError("bad_legacy_rebase", "rebase opcode budget exceeded");
    }
    switch (opcode) {
      case REBASE_DONE:
        return rebases;
      case REBASE_SET_TYPE_IMM:
        break;
      case REBASE_SET_SEGMENT_AND_OFFSET_ULEB:
        segmentIndex = immediate;
        segmentOffset = Number(stream.uleb());
        break;
      case REBASE_ADD_ADDR_ULEB:
        segmentOffset += Number(stream.uleb());
        break;
      case REBASE_ADD_ADDR_IMM_SCALED:
        segmentOffset += immediate * 8;
        break;
      case REBASE_DO_REBASE_IMM_TIMES:
        rebaseMany(rebases, segmentIndex, segmentOffset, immediate, 0);
        segmentOffset += immediate * 8;
        break;
      case REBASE_DO_REBASE_ULEB_TIMES: {
        const count = Number(stream.uleb());
        rebaseMany(rebases, segmentIndex, segmentOffset, count, 0);
        segmentOffset += count * 8;
        break;
      }
      case REBASE_DO_REBASE_ADD_ADDR_ULEB: {
        rebases.push({ segmentIndex, offset: segmentOffset });
        segmentOffset += 8 + Number(stream.uleb());
        break;
      }
      case REBASE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: {
        const count = Number(stream.uleb());
        const skip = Number(stream.uleb());
        for (let index = 0; index < count; index += 1) {
          rebases.push({ segmentIndex, offset: segmentOffset });
          segmentOffset += 8 + skip;
        }
        break;
      }
      default:
        throw new MachOError(
          "bad_legacy_rebase",
          `unknown rebase opcode 0x${opcode.toString(16)} at ${stream.offset - 1}`,
        );
    }
  }
  return rebases;
}

function rebaseMany(
  rebases: LegacyRebase[],
  segmentIndex: number,
  start: number,
  count: number,
  skip: number,
): void {
  if (count > MAX_OPERATIONS) {
    throw new MachOError("bad_legacy_rebase", `rebase count ${count} is implausible`);
  }
  for (let index = 0; index < count; index += 1) {
    rebases.push({ segmentIndex, offset: start + index * (8 + skip) });
  }
}

function parseBinds(bytes: Uint8Array, offset: number, size: number): LegacyBind[] {
  if (size === 0) return [];
  const stream = new Cursor(bytes, offset, size, "bind");
  const binds: LegacyBind[] = [];
  let segmentIndex = 0;
  let segmentOffset = 0;
  let ordinal = 0;
  let symbol = "";
  let addend = 0n;
  let weak = false;
  let operations = 0;

  const bindOne = (): void => {
    if (symbol.length === 0) {
      throw new MachOError("bad_legacy_bind", "bind opcode without a symbol");
    }
    binds.push({ segmentIndex, offset: segmentOffset, symbol, ordinal, addend, weak });
  };

  while (!stream.done) {
    const byte = stream.u8();
    const opcode = byte & 0xf0;
    const immediate = byte & 0x0f;
    if (++operations > MAX_OPERATIONS) {
      throw new MachOError("bad_legacy_bind", "bind opcode budget exceeded");
    }
    switch (opcode) {
      case BIND_DONE:
        return binds;
      case BIND_SET_DYLIB_ORDINAL_IMM:
        ordinal = immediate;
        break;
      case BIND_SET_DYLIB_ORDINAL_ULEB:
        ordinal = Number(stream.uleb());
        break;
      case BIND_SET_DYLIB_SPECIAL_IMM:
        ordinal = immediate === 0 ? 0 : (immediate << 28) >> 28;
        break;
      case BIND_SET_SYMBOL_TRAILING_FLAGS_IMM:
        weak = (immediate & 0x1) !== 0;
        symbol = stream.cstring();
        break;
      case BIND_SET_TYPE_IMM:
        break;
      case BIND_SET_ADDEND_SLEB:
        addend = stream.sleb();
        break;
      case BIND_SET_SEGMENT_AND_OFFSET_ULEB:
        segmentIndex = immediate;
        segmentOffset = Number(stream.uleb());
        break;
      case BIND_ADD_ADDR_ULEB:
        segmentOffset += Number(stream.uleb());
        break;
      case BIND_DO_BIND:
        bindOne();
        segmentOffset += 8;
        break;
      case BIND_DO_BIND_ADD_ADDR_ULEB:
        bindOne();
        segmentOffset += 8 + Number(stream.uleb());
        break;
      case BIND_DO_BIND_ADD_ADDR_IMM_SCALED:
        bindOne();
        segmentOffset += 8 + immediate * 8;
        break;
      case BIND_DO_BIND_ULEB_TIMES_SKIPPING_ULEB: {
        const count = Number(stream.uleb());
        const skip = Number(stream.uleb());
        if (count > MAX_OPERATIONS) {
          throw new MachOError("bad_legacy_bind", `bind count ${count} is implausible`);
        }
        for (let index = 0; index < count; index += 1) {
          bindOne();
          segmentOffset += 8 + skip;
        }
        break;
      }
      case BIND_THREADED:
        throw new MachOError(
          "legacy_threaded_binds_unimplemented",
          "the arm64 threaded-bind opcode is not implemented; link with chained fixups",
        );
      default:
        throw new MachOError(
          "bad_legacy_bind",
          `unknown bind opcode 0x${opcode.toString(16)} at ${stream.offset - 1}`,
        );
    }
  }
  return binds;
}

class Cursor {
  private readonly bytes: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  offset: number;

  constructor(bytes: Uint8Array, offset: number, size: number, what: string) {
    if (offset < 0 || size < 0 || offset + size > bytes.length) {
      throw new MachOError(
        "bad_legacy_stream",
        `${what} stream [${offset}, ${offset + size}) is outside the image`,
      );
    }
    this.bytes = bytes;
    this.start = offset;
    this.end = offset + size;
    this.offset = offset;
  }

  get done(): boolean {
    return this.offset >= this.end;
  }

  u8(): number {
    if (this.offset >= this.end) {
      throw new MachOError("bad_legacy_stream", "unexpected end of opcode stream");
    }
    return this.bytes[this.offset++]!;
  }

  uleb(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new MachOError("bad_legacy_stream", "ULEB128 is too long");
  }

  sleb(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte = 0;
    for (let index = 0; index < 10; index += 1) {
      byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if ((byte & 0x40) !== 0 && shift < 64n) result |= -1n << shift;
        return result;
      }
    }
    throw new MachOError("bad_legacy_stream", "SLEB128 is too long");
  }

  cstring(): string {
    const start = this.offset;
    while (this.offset < this.end) {
      if (this.bytes[this.offset] === 0) {
        const value = new TextDecoder().decode(this.bytes.subarray(start, this.offset));
        this.offset += 1;
        if (value.length === 0 || value.length > 1024) {
          throw new MachOError("bad_legacy_bind", `symbol name length ${value.length} is invalid`);
        }
        return value;
      }
      this.offset += 1;
    }
    throw new MachOError("bad_legacy_bind", "unterminated symbol name");
  }
}
