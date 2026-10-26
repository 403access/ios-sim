/**
 * Legacy `LC_DYLD_INFO`/`LC_DYLD_INFO_ONLY` rebase and bind opcodes (LDR-001).
 *
 * Pre-chained-fixup images encode fixup sites as a small bytecode stream in
 * `__LINKEDIT`. The decoder here is intentionally strict: every opcode,
 * ULEB/SLEB, and segment offset is validated before the loader writes memory.
 *
 * Rebase opcodes only identify a location; the pointer value already in the
 * image decides what gets slid. Bind opcodes identify a location plus a symbol
 * and dependency ordinal.
 *
 * Not decoded here: lazy-bind stubs and weak-bind coalescing (LDR-002), and
 * dyld3 threaded binds (`BIND_OPCODE_THREADED`), which fail with a stable
 * error instead of being guessed.
 */

import { MachOError } from "../errors.js";

const REBASE_OPCODE_MASK = 0xf0;
const REBASE_IMMEDIATE_MASK = 0x0f;

const REBASE_OPCODE_DONE = 0x00;
const REBASE_OPCODE_SET_TYPE_IMM = 0x10;
const REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB = 0x20;
const REBASE_OPCODE_ADD_ADDR_ULEB = 0x30;
const REBASE_OPCODE_ADD_ADDR_IMM_SCALED = 0x40;
const REBASE_OPCODE_DO_REBASE_IMM_TIMES = 0x50;
const REBASE_OPCODE_DO_REBASE_ULEB_TIMES = 0x60;
const REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB = 0x70;
const REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB = 0x80;

const BIND_OPCODE_MASK = 0xf0;
const BIND_IMMEDIATE_MASK = 0x0f;

const BIND_OPCODE_DONE = 0x00;
const BIND_OPCODE_SET_DYLIB_ORDINAL_IMM = 0x10;
const BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB = 0x20;
const BIND_OPCODE_SET_DYLIB_SPECIAL_IMM = 0x30;
const BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM = 0x40;
const BIND_OPCODE_SET_TYPE_IMM = 0x50;
const BIND_OPCODE_SET_ADDEND_SLEB = 0x60;
const BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB = 0x70;
const BIND_OPCODE_ADD_ADDR_ULEB = 0x80;
const BIND_OPCODE_DO_BIND = 0x90;
const BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB = 0xa0;
const BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED = 0xb0;
const BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB = 0xc0;
const BIND_OPCODE_THREADED = 0xd0;

const BIND_SYMBOL_FLAGS_WEAK_IMPORT = 0x1;
const POINTER_SIZE = 8;
const MAX_FIXUPS = 1_000_000;

export interface LegacySegment {
  readonly index: number;
  readonly vmAddress: number;
  readonly vmSize: number;
}

export interface LegacyRebase {
  readonly segmentIndex: number;
  /** Offset from the segment's VM address. */
  readonly segmentOffset: number;
}

export type LegacyBindOrdinal = number;

export interface LegacyBind {
  readonly segmentIndex: number;
  /** Offset from the segment's VM address. */
  readonly segmentOffset: number;
  readonly symbol: string;
  /** 0 = self, -1 = main executable, -2 = flat lookup, -3 = weak lookup. */
  readonly ordinal: LegacyBindOrdinal;
  readonly addend: bigint;
  readonly weak: boolean;
}

export interface LegacyStreams {
  readonly rebases: readonly LegacyRebase[];
  readonly binds: readonly LegacyBind[];
}

interface Cursor {
  readonly bytes: Uint8Array;
  offset: number;
  readonly end: number;
}

function cursor(bytes: Uint8Array, offset: number, size: number, label: string): Cursor {
  if (offset < 0 || size < 0 || offset + size > bytes.byteLength) {
    throw new MachOError(
      "legacy_fixups_out_of_bounds",
      `${label} stream [${offset}, ${offset + size}) exceeds the file (${bytes.byteLength} bytes)`,
    );
  }
  return { bytes, offset, end: offset + size };
}

function readU8(cursorState: Cursor, label: string): number {
  if (cursorState.offset >= cursorState.end) {
    throw new MachOError("legacy_fixups_truncated", `${label} stream ended mid-opcode`);
  }
  return cursorState.bytes[cursorState.offset++]!;
}

function readUleb(cursorState: Cursor, label: string): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = readU8(cursorState, label);
    if (shift > 49) {
      throw new MachOError("legacy_fixups_uleb_overflow", `${label} ULEB128 is too large`);
    }
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (!Number.isSafeInteger(result)) {
    throw new MachOError("legacy_fixups_uleb_overflow", `${label} ULEB128 is not a safe integer`);
  }
  return result;
}

function readSleb(cursorState: Cursor, label: string): bigint {
  let result = 0n;
  let shift = 0n;
  let byte = 0;
  do {
    byte = readU8(cursorState, label);
    if (shift > 63n) {
      throw new MachOError("legacy_fixups_sleb_overflow", `${label} SLEB128 is too large`);
    }
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while ((byte & 0x80) !== 0);
  if ((byte & 0x40) !== 0) result |= -1n << shift;
  return BigInt.asIntN(64, result);
}

function readCString(cursorState: Cursor, label: string): string {
  const start = cursorState.offset;
  while (cursorState.offset < cursorState.end && cursorState.bytes[cursorState.offset] !== 0) {
    cursorState.offset += 1;
  }
  if (cursorState.offset >= cursorState.end) {
    throw new MachOError("legacy_fixups_truncated", `${label} symbol has no NUL terminator`);
  }
  const text = new TextDecoder().decode(cursorState.bytes.subarray(start, cursorState.offset));
  cursorState.offset += 1;
  return text;
}

function segment(state: { segments: readonly LegacySegment[] }, index: number): LegacySegment {
  const found = state.segments.find((candidate) => candidate.index === index);
  if (!found) {
    throw new MachOError(
      "legacy_fixups_bad_segment",
      `legacy fixup references segment ${index}, which is not in the image`,
    );
  }
  return found;
}

function checkOffset(seg: LegacySegment, offset: number): void {
  if (offset < 0 || offset + POINTER_SIZE > seg.vmSize) {
    throw new MachOError(
      "legacy_fixups_outside_segment",
      `legacy fixup at ${offset} is outside segment ${seg.index} (size ${seg.vmSize})`,
    );
  }
}

/** Decode a rebase opcode stream into fixup locations. */
export function parseLegacyRebases(
  bytes: Uint8Array,
  offset: number,
  size: number,
  segments: readonly LegacySegment[],
): LegacyRebase[] {
  const state = { segments };
  const stream = cursor(bytes, offset, size, "rebase");
  const rebases: LegacyRebase[] = [];
  let segmentIndex = 0;
  let segmentOffset = 0;

  const emit = (): void => {
    const seg = segment(state, segmentIndex);
    checkOffset(seg, segmentOffset);
    rebases.push({ segmentIndex, segmentOffset });
    if (rebases.length > MAX_FIXUPS) {
      throw new MachOError("legacy_fixups_too_many", "rebase stream exceeds the fixup limit");
    }
  };

  while (stream.offset < stream.end) {
    const byte = readU8(stream, "rebase");
    const opcode = byte & REBASE_OPCODE_MASK;
    const immediate = byte & REBASE_IMMEDIATE_MASK;
    switch (opcode) {
      case REBASE_OPCODE_DONE:
        return rebases;
      case REBASE_OPCODE_SET_TYPE_IMM:
        break;
      case REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB:
        segmentIndex = immediate;
        segmentOffset = readUleb(stream, "rebase offset");
        break;
      case REBASE_OPCODE_ADD_ADDR_ULEB:
        segmentOffset += readUleb(stream, "rebase add");
        break;
      case REBASE_OPCODE_ADD_ADDR_IMM_SCALED:
        segmentOffset += immediate * POINTER_SIZE;
        break;
      case REBASE_OPCODE_DO_REBASE_IMM_TIMES:
        for (let index = 0; index < immediate; index += 1) {
          emit();
          segmentOffset += POINTER_SIZE;
        }
        break;
      case REBASE_OPCODE_DO_REBASE_ULEB_TIMES: {
        const count = readUleb(stream, "rebase count");
        for (let index = 0; index < count; index += 1) {
          emit();
          segmentOffset += POINTER_SIZE;
        }
        break;
      }
      case REBASE_OPCODE_DO_REBASE_ADD_ADDR_ULEB:
        emit();
        segmentOffset += POINTER_SIZE + readUleb(stream, "rebase skip");
        break;
      case REBASE_OPCODE_DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: {
        const count = readUleb(stream, "rebase count");
        const skip = readUleb(stream, "rebase skip");
        for (let index = 0; index < count; index += 1) {
          emit();
          segmentOffset += POINTER_SIZE + skip;
        }
        break;
      }
      default:
        throw new MachOError(
          "legacy_fixups_unknown_opcode",
          `unknown rebase opcode 0x${byte.toString(16)}`,
        );
    }
  }
  return rebases;
}

/**
 * Decode a bind opcode stream. `weak` selects weak-bind semantics for
 * diagnostics; the returned entries keep their symbol flags either way.
 */
export function parseLegacyBinds(
  bytes: Uint8Array,
  offset: number,
  size: number,
  segments: readonly LegacySegment[],
): LegacyBind[] {
  return decodeBinds(bytes, offset, size, segments, false);
}

/**
 * Decode a lazy-bind stream. Lazy streams use `DONE` as an entry separator,
 * not only as the end marker, so every entry is returned.
 */
export function parseLegacyLazyBinds(
  bytes: Uint8Array,
  offset: number,
  size: number,
  segments: readonly LegacySegment[],
): LegacyBind[] {
  return decodeBinds(bytes, offset, size, segments, true);
}

function decodeBinds(
  bytes: Uint8Array,
  offset: number,
  size: number,
  segments: readonly LegacySegment[],
  continueAfterDone: boolean,
): LegacyBind[] {
  const state = { segments };
  const stream = cursor(bytes, offset, size, "bind");
  const binds: LegacyBind[] = [];
  let segmentIndex = 0;
  let segmentOffset = 0;
  let ordinal = 0;
  let symbol = "";
  let addend = 0n;
  let weak = false;

  const emit = (): void => {
    if (symbol.length === 0) {
      throw new MachOError("legacy_fixups_missing_symbol", "bind opcode has no symbol name");
    }
    const seg = segment(state, segmentIndex);
    checkOffset(seg, segmentOffset);
    binds.push({ segmentIndex, segmentOffset, symbol, ordinal, addend, weak });
    if (binds.length > MAX_FIXUPS) {
      throw new MachOError("legacy_fixups_too_many", "bind stream exceeds the fixup limit");
    }
  };

  while (stream.offset < stream.end) {
    const byte = readU8(stream, "bind");
    const opcode = byte & BIND_OPCODE_MASK;
    const immediate = byte & BIND_IMMEDIATE_MASK;
    switch (opcode) {
      case BIND_OPCODE_DONE:
        if (!continueAfterDone) return binds;
        break;
      case BIND_OPCODE_SET_DYLIB_ORDINAL_IMM:
        ordinal = immediate;
        break;
      case BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB:
        ordinal = readUleb(stream, "bind ordinal");
        break;
      case BIND_OPCODE_SET_DYLIB_SPECIAL_IMM:
        ordinal = immediate === 0 ? 0 : immediate | 0xfffffff0;
        break;
      case BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM:
        weak = (immediate & BIND_SYMBOL_FLAGS_WEAK_IMPORT) !== 0;
        symbol = readCString(stream, "bind");
        break;
      case BIND_OPCODE_SET_TYPE_IMM:
        break;
      case BIND_OPCODE_SET_ADDEND_SLEB:
        addend = readSleb(stream, "bind addend");
        break;
      case BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB:
        segmentIndex = immediate;
        segmentOffset = readUleb(stream, "bind offset");
        break;
      case BIND_OPCODE_ADD_ADDR_ULEB:
        segmentOffset += readUleb(stream, "bind add");
        break;
      case BIND_OPCODE_DO_BIND:
        emit();
        segmentOffset += POINTER_SIZE;
        break;
      case BIND_OPCODE_DO_BIND_ADD_ADDR_ULEB:
        emit();
        segmentOffset += POINTER_SIZE + readUleb(stream, "bind skip");
        break;
      case BIND_OPCODE_DO_BIND_ADD_ADDR_IMM_SCALED:
        emit();
        segmentOffset += POINTER_SIZE + immediate * POINTER_SIZE;
        break;
      case BIND_OPCODE_DO_BIND_ULEB_TIMES_SKIPPING_ULEB: {
        const count = readUleb(stream, "bind count");
        const skip = readUleb(stream, "bind skip");
        for (let index = 0; index < count; index += 1) {
          emit();
          segmentOffset += POINTER_SIZE + skip;
        }
        break;
      }
      case BIND_OPCODE_THREADED:
        throw new MachOError(
          "legacy_threaded_bind_unimplemented",
          "dyld3 threaded bind opcodes are not decoded yet",
        );
      default:
        throw new MachOError(
          "legacy_fixups_unknown_opcode",
          `unknown bind opcode 0x${byte.toString(16)}`,
        );
    }
  }
  return binds;
}

/** Encode one legacy bind stream for fixtures. */
export function encodeLegacyBinds(
  entries: ReadonlyArray<{
    segmentIndex: number;
    segmentOffset: number;
    symbol: string;
    ordinal: number;
    addend?: number;
    weak?: boolean;
  }>,
  separator = false,
): Uint8Array {
  const out = new ByteSink();
  let currentAddend = 0;
  for (const entry of entries) {
    const ordinal = entry.ordinal;
    if (ordinal >= 0 && ordinal <= 0xf) {
      out.u8(BIND_OPCODE_SET_DYLIB_ORDINAL_IMM | ordinal);
    } else if (ordinal < 0 && ordinal >= -0xf) {
      out.u8(BIND_OPCODE_SET_DYLIB_SPECIAL_IMM | (ordinal & 0xf));
    } else {
      out.u8(BIND_OPCODE_SET_DYLIB_ORDINAL_ULEB);
      out.uleb(ordinal);
    }
    out.u8(BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM | (entry.weak ? 0x1 : 0x0));
    out.cstring(entry.symbol);
    out.u8(BIND_OPCODE_SET_TYPE_IMM | 0x1);
    const addend = entry.addend ?? 0;
    if (addend !== currentAddend) {
      out.u8(BIND_OPCODE_SET_ADDEND_SLEB);
      out.sleb(addend);
      currentAddend = addend;
    }
    out.u8(BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB | (entry.segmentIndex & 0xf));
    out.uleb(entry.segmentOffset);
    out.u8(BIND_OPCODE_DO_BIND);
    if (separator) out.u8(BIND_OPCODE_DONE);
  }
  out.u8(BIND_OPCODE_DONE);
  return out.toUint8Array();
}

/** Encode one legacy rebase stream for fixtures. */
export function encodeLegacyRebases(
  entries: ReadonlyArray<{ segmentIndex: number; segmentOffset: number }>,
): Uint8Array {
  const out = new ByteSink();
  for (const entry of entries) {
    out.u8(REBASE_OPCODE_SET_TYPE_IMM | 0x1);
    out.u8(REBASE_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB | (entry.segmentIndex & 0xf));
    out.uleb(entry.segmentOffset);
    out.u8(REBASE_OPCODE_DO_REBASE_IMM_TIMES | 0x1);
  }
  out.u8(REBASE_OPCODE_DONE);
  return out.toUint8Array();
}

class ByteSink {
  private readonly bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  uleb(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MachOError("legacy_fixups_bad_value", `ULEB128 value ${value} is invalid`);
    }
    let remaining = value;
    do {
      let byte = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
      if (remaining > 0) byte |= 0x80;
      this.u8(byte);
    } while (remaining > 0);
  }

  sleb(value: number): void {
    let remaining = value;
    for (;;) {
      const byte = remaining & 0x7f;
      const sign = (byte & 0x40) !== 0;
      remaining = Math.floor(remaining / 128);
      if ((remaining === 0 && !sign) || (remaining === -1 && sign)) {
        this.u8(byte);
        return;
      }
      this.u8(byte | 0x80);
    }
  }

  cstring(value: string): void {
    for (const byte of new TextEncoder().encode(value)) this.u8(byte);
    this.u8(0);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}
