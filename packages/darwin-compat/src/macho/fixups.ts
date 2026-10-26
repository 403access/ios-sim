/**
 * `LC_DYLD_CHAINED_FIXUPS` decoding.
 *
 * Chained fixups replaced the old dyld opcode streams. A fixup chain is a
 * linked list of 64-bit words stored in writable segments; each word describes
 * either a rebase (an in-image pointer) or a bind (an imported symbol), plus the
 * distance to the next fixup. The in-memory value is a packed bitfield:
 *
 * ```text
 * rebase:  target:36  high8:8  reserved:7  next:12  bind:1
 * bind:    ordinal:24 addend:8 reserved:19 next:12  bind:1
 * ```
 *
 * The parser never rewrites memory. It produces a deterministic list of
 * operations, which makes the loader easy to test and lets `inspect` explain a
 * binary without executing it.
 */

import { BinaryReader } from "../binary.js";
import { MachOError } from "../errors.js";
import {
  DYLD_CHAINED_IMPORT,
  DYLD_CHAINED_IMPORT_ADDEND,
  DYLD_CHAINED_IMPORT_ADDEND64,
  DYLD_CHAINED_PTR_64,
  DYLD_CHAINED_PTR_64_OFFSET,
  DYLD_CHAINED_PTR_ARM64E,
  DYLD_CHAINED_PTR_ARM64E_USERLAND,
  DYLD_CHAINED_PTR_ARM64E_USERLAND24,
  DYLD_CHAINED_PTR_START_MULTI,
  DYLD_CHAINED_PTR_START_NONE,
  DYLD_CHAINED_SYMBOLS_UNCOMPRESSED,
} from "./constants.js";

export type ChainedPointerFormat = number;

export interface ChainedImport {
  readonly ordinal: number;
  readonly name: string;
  readonly weak: boolean;
  readonly addend: bigint;
}

export interface ChainedBind {
  readonly kind: "bind";
  /** File offset of the word to patch. */
  readonly location: number;
  readonly segmentIndex: number;
  readonly pageIndex: number;
  readonly format: ChainedPointerFormat;
  readonly ordinal: number;
  readonly symbol: string;
  readonly weak: boolean;
  readonly addend: bigint;
  readonly authenticated: boolean;
}

export interface ChainedRebase {
  readonly kind: "rebase";
  readonly location: number;
  readonly segmentIndex: number;
  readonly pageIndex: number;
  readonly format: ChainedPointerFormat;
  /** Packed target before high8 reconstruction. */
  readonly target: bigint;
  readonly high8: number;
  readonly authenticated: boolean;
}

export type ChainedFixup = ChainedBind | ChainedRebase;

export interface ChainedSegmentStarts {
  readonly segmentIndex: number;
  readonly pageSize: number;
  readonly pointerFormat: ChainedPointerFormat;
  readonly segmentOffset: bigint;
  readonly maxValidPointer: number;
  readonly pageCount: number;
  readonly pageStarts: readonly number[];
}

export interface ChainedFixups {
  readonly version: number;
  readonly importsFormat: number;
  readonly pointerFormats: readonly ChainedPointerFormat[];
  readonly imports: readonly ChainedImport[];
  readonly segments: readonly ChainedSegmentStarts[];
  readonly fixups: readonly ChainedFixup[];
  readonly maxChainLength: number;
}

export interface FixupSegment {
  readonly index: number;
  readonly fileOffset: number;
  readonly fileSize: number;
  readonly vmAddress: number;
}

const MAX_IMPORTS = 1_000_000;
const MAX_FIXUPS = 4_000_000;
const MAX_CHAIN = 1_000_000;

class Cursor {
  private offset = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly label: string,
    private readonly end: number,
  ) {}

  get position(): number {
    return this.offset;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.end || offset > this.bytes.byteLength) {
      throw new MachOError(
        "fixups_out_of_bounds",
        `${this.label}: offset 0x${offset.toString(16)} is outside the fixups data`,
      );
    }
    this.offset = offset;
  }

  u8(): number {
    if (this.offset + 1 > this.end) throw this.bounds(1);
    return this.bytes[this.offset++]!;
  }

  u16(): number {
    if (this.offset + 2 > this.end) throw this.bounds(2);
    const value = this.bytes[this.offset]! | (this.bytes[this.offset + 1]! << 8);
    this.offset += 2;
    return value;
  }

  u32(): number {
    if (this.offset + 4 > this.end) throw this.bounds(4);
    const value =
      (this.bytes[this.offset]! |
        (this.bytes[this.offset + 1]! << 8) |
        (this.bytes[this.offset + 2]! << 16) |
        (this.bytes[this.offset + 3]! << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const low = BigInt(this.u32());
    const high = BigInt(this.u32());
    return (high << 32n) | low;
  }

  cstring(): string {
    const start = this.offset;
    let end = start;
    while (end < this.end && this.bytes[end] !== 0) end += 1;
    if (end >= this.end) {
      throw new MachOError(
        "unterminated_string",
        `${this.label}: unterminated import symbol at 0x${start.toString(16)}`,
      );
    }
    const value = new TextDecoder().decode(this.bytes.subarray(start, end));
    this.offset = end + 1;
    return value;
  }

  private bounds(size: number): MachOError {
    return new MachOError(
      "fixups_out_of_bounds",
      `${this.label}: read of ${size} byte(s) at 0x${this.offset.toString(16)} exceeds fixups data (0x${this.end.toString(16)})`,
    );
  }
}

/**
 * Decode chained fixups. `dataOffset`/`dataSize` are relative to the start of
 * the thin Mach-O slice.
 */
export function parseChainedFixups(
  bytes: Uint8Array,
  dataOffset: number,
  dataSize: number,
  segments: readonly FixupSegment[],
): ChainedFixups {
  if (dataSize < 28) {
    throw new MachOError(
      "fixups_too_small",
      `LC_DYLD_CHAINED_FIXUPS is ${dataSize} bytes, expected at least 28`,
    );
  }
  const reader = new BinaryReader(bytes, "chained fixups");
  reader.seek(dataOffset);
  const headerStart = dataOffset;
  const version = reader.u32();
  const startsOffset = reader.u32();
  const importsOffset = reader.u32();
  const symbolsOffset = reader.u32();
  const importsCount = reader.u32();
  const importsFormat = reader.u32();
  const symbolsFormat = reader.u32();

  if (version !== 0) {
    throw new MachOError(
      "unsupported_fixups_version",
      `chained fixups version ${version} is not supported (only 0)`,
    );
  }
  if (importsCount > MAX_IMPORTS) {
    throw new MachOError(
      "too_many_imports",
      `chained fixups declare ${importsCount} imports (limit ${MAX_IMPORTS})`,
    );
  }
  if (symbolsFormat !== DYLD_CHAINED_SYMBOLS_UNCOMPRESSED) {
    throw new MachOError(
      "unsupported_symbols_format",
      `chained import symbols format ${symbolsFormat} is not supported; only uncompressed pools are implemented`,
    );
  }
  if (startsOffset >= dataSize) {
    throw new MachOError(
      "fixups_out_of_bounds",
      `starts offset 0x${startsOffset.toString(16)} is outside fixups data`,
    );
  }

  const dataEnd = dataOffset + dataSize;
  const importCursor = new Cursor(bytes, "chained imports", dataEnd);
  importCursor.seek(headerStart + importsOffset);
  const symbolCursor = new Cursor(bytes, "chained symbols", dataEnd);
  symbolCursor.seek(headerStart + symbolsOffset);

  const imports: ChainedImport[] = [];
  for (let index = 0; index < importsCount; index += 1) {
    let ordinal: number;
    let weak = false;
    let nameOffset: number;
    let addend = 0n;

    if (importsFormat === DYLD_CHAINED_IMPORT) {
      const raw = importCursor.u32();
      ordinal = ((raw & 0xff) << 24) >> 24;
      weak = ((raw >>> 8) & 1) === 1;
      nameOffset = raw >>> 9;
    } else if (importsFormat === DYLD_CHAINED_IMPORT_ADDEND) {
      const raw = importCursor.u32();
      ordinal = ((raw & 0xff) << 24) >> 24;
      weak = ((raw >>> 8) & 1) === 1;
      nameOffset = raw >>> 9;
      addend = BigInt(importCursor.u32() | 0);
    } else if (importsFormat === DYLD_CHAINED_IMPORT_ADDEND64) {
      const raw = importCursor.u64();
      ordinal = Number(BigInt.asIntN(16, raw & 0xffffn));
      weak = ((raw >> 16n) & 1n) === 1n;
      nameOffset = Number((raw >> 32n) & 0xffff_ffffn);
      addend = BigInt.asIntN(64, importCursor.u64());
    } else {
      throw new MachOError(
        "unsupported_imports_format",
        `chained imports format ${importsFormat} is not supported`,
      );
    }

    symbolCursor.seek(headerStart + symbolsOffset + nameOffset);
    const name = symbolCursor.cstring();
    if (name.length === 0) {
      throw new MachOError("empty_import_name", `chained import ${index} has an empty symbol name`);
    }
    imports.push({ ordinal, name, weak, addend });
  }

  const startsCursor = new Cursor(bytes, "chained starts", dataEnd);
  startsCursor.seek(headerStart + startsOffset);
  const startsStart = headerStart + startsOffset;
  const segCount = startsCursor.u32();
  if (segCount > 65_536) {
    throw new MachOError("too_many_segments", `chained fixups declare ${segCount} segments`);
  }
  const segInfoOffsets: number[] = [];
  for (let index = 0; index < segCount; index += 1) segInfoOffsets.push(startsCursor.u32());

  const starts: ChainedSegmentStarts[] = [];
  const fixups: ChainedFixup[] = [];

  for (let segmentIndex = 0; segmentIndex < segCount; segmentIndex += 1) {
    const infoOffset = segInfoOffsets[segmentIndex]!;
    if (infoOffset === 0) continue;
    const segment = segments[segmentIndex];
    if (!segment) {
      throw new MachOError(
        "fixups_segment_missing",
        `chained fixups describe segment ${segmentIndex}, but the Mach-O has only ${segments.length} segments`,
      );
    }
    const infoBase = startsStart + infoOffset;
    const info = new Cursor(bytes, `chained starts segment ${segmentIndex}`, dataEnd);
    info.seek(infoBase);
    const size = info.u32();
    const pageSize = info.u16();
    const pointerFormat = info.u16();
    const segmentOffset = info.u64();
    const maxValidPointer = info.u32();
    const pageCount = info.u16();
    if (pageSize === 0 || (pageSize & (pageSize - 1)) !== 0) {
      throw new MachOError(
        "invalid_page_size",
        `segment ${segmentIndex}: page size ${pageSize} is not a power of two`,
      );
    }
    if (size < 22 + pageCount * 2) {
      throw new MachOError(
        "fixups_out_of_bounds",
        `segment ${segmentIndex}: starts structure claims ${size} bytes for ${pageCount} pages`,
      );
    }
    const pageStarts: number[] = [];
    for (let page = 0; page < pageCount; page += 1) pageStarts.push(info.u16());
    starts.push({
      segmentIndex,
      pageSize,
      pointerFormat,
      segmentOffset,
      maxValidPointer,
      pageCount,
      pageStarts,
    });

    for (let page = 0; page < pageCount; page += 1) {
      const start = pageStarts[page]!;
      if (start === DYLD_CHAINED_PTR_START_NONE) continue;
      if ((start & DYLD_CHAINED_PTR_START_MULTI) !== 0) {
        throw new MachOError(
          "unsupported_multi_start",
          `segment ${segmentIndex} page ${page}: multi-start fixup chains are not implemented yet`,
        );
      }
      walkChain({
        bytes,
        segments,
        segment,
        segmentIndex,
        page,
        pageSize,
        start,
        pointerFormat,
        imports,
        fixups,
      });
    }
  }

  const pointerFormats = [...new Set(starts.map((entry) => entry.pointerFormat))];
  return {
    version,
    importsFormat,
    pointerFormats,
    imports,
    segments: starts,
    fixups,
    maxChainLength: MAX_CHAIN,
  };
}

function walkChain(input: {
  bytes: Uint8Array;
  segments: readonly FixupSegment[];
  segment: FixupSegment;
  segmentIndex: number;
  page: number;
  pageSize: number;
  start: number;
  pointerFormat: number;
  imports: readonly ChainedImport[];
  fixups: ChainedFixup[];
}): void {
  const { bytes, segment, segmentIndex, page, pageSize, pointerFormat, imports, fixups } = input;
  let start = input.start;
  let previousLocation = -1;
  let count = 0;

  while (start !== DYLD_CHAINED_PTR_START_NONE) {
    if (count++ > MAX_CHAIN) {
      throw new MachOError(
        "fixup_chain_too_long",
        `segment ${segmentIndex} page ${page}: chain exceeds ${MAX_CHAIN} entries`,
      );
    }
    const location = segment.fileOffset + page * pageSize + start;
    if (location < segment.fileOffset || location + 8 > segment.fileOffset + segment.fileSize) {
      throw new MachOError(
        "fixup_out_of_segment",
        `segment ${segmentIndex}: fixup at file offset 0x${location.toString(16)} is outside the segment`,
      );
    }
    if (location <= previousLocation) {
      throw new MachOError(
        "fixup_chain_cycle",
        `segment ${segmentIndex}: chain does not advance at 0x${location.toString(16)}`,
      );
    }
    if (location + 8 > bytes.byteLength) {
      throw new MachOError(
        "fixup_out_of_file",
        `segment ${segmentIndex}: fixup at 0x${location.toString(16)} exceeds the file`,
      );
    }
    previousLocation = location;

    const raw =
      BigInt(bytes[location]!) |
      (BigInt(bytes[location + 1]!) << 8n) |
      (BigInt(bytes[location + 2]!) << 16n) |
      (BigInt(bytes[location + 3]!) << 24n) |
      (BigInt(bytes[location + 4]!) << 32n) |
      (BigInt(bytes[location + 5]!) << 40n) |
      (BigInt(bytes[location + 6]!) << 48n) |
      (BigInt(bytes[location + 7]!) << 56n);

    const decoded = decodePointer(raw, pointerFormat, segmentIndex, page, location);
    if (decoded.kind === "bind") {
      if (decoded.ordinal >= imports.length) {
        throw new MachOError(
          "fixup_import_missing",
          `segment ${segmentIndex}: bind at 0x${location.toString(16)} references import ${decoded.ordinal}, only ${imports.length} declared`,
        );
      }
      const imported = imports[decoded.ordinal];
      if (!imported) {
        throw new MachOError(
          "fixup_import_missing",
          `segment ${segmentIndex}: bind at 0x${location.toString(16)} references missing import ${decoded.ordinal}`,
        );
      }
      fixups.push({
        kind: "bind",
        location,
        segmentIndex,
        pageIndex: page,
        format: pointerFormat,
        ordinal: decoded.ordinal,
        symbol: imported.name,
        weak: imported.weak || decoded.weak,
        addend: imported.addend + decoded.addend,
        authenticated: decoded.authenticated,
      });
    } else {
      fixups.push({
        kind: "rebase",
        location,
        segmentIndex,
        pageIndex: page,
        format: pointerFormat,
        target: decoded.target,
        high8: decoded.high8,
        authenticated: decoded.authenticated,
      });
    }
    // `next` is a stride in 4-byte units; zero terminates the chain.
    if (decoded.next === 0) {
      start = DYLD_CHAINED_PTR_START_NONE;
    } else {
      start += decoded.next * 4;
    }
  }
}

interface DecodedPointer {
  readonly next: number;
  readonly kind: "bind" | "rebase";
  readonly ordinal: number;
  readonly addend: bigint;
  readonly weak: boolean;
  readonly target: bigint;
  readonly high8: number;
  readonly authenticated: boolean;
}

function decodePointer(
  raw: bigint,
  format: number,
  segmentIndex: number,
  page: number,
  location: number,
): DecodedPointer {
  const bind = ((raw >> 63n) & 1n) === 1n;

  if (format === DYLD_CHAINED_PTR_64 || format === DYLD_CHAINED_PTR_64_OFFSET) {
    const next = Number((raw >> 51n) & 0xfffn);
    if (!bind) {
      const high8 = Number((raw >> 36n) & 0xffn);
      return {
        next,
        kind: "rebase",
        target: raw & 0xf_ffff_ffffn,
        high8,
        ordinal: 0,
        addend: 0n,
        weak: false,
        authenticated: false,
      };
    }
    const ordinal = Number(raw & 0xff_ffffn);
    const addend = BigInt.asIntN(8, (raw >> 24n) & 0xffn);
    return {
      next,
      kind: "bind",
      ordinal,
      addend,
      weak: false,
      target: 0n,
      high8: 0,
      authenticated: false,
    };
  }

  if (
    format === DYLD_CHAINED_PTR_ARM64E ||
    format === DYLD_CHAINED_PTR_ARM64E_USERLAND ||
    format === DYLD_CHAINED_PTR_ARM64E_USERLAND24
  ) {
    // arm64e uses bit 62 for `bind` and bit 63 for `auth`; the 64-bit formats
    // use bit 63 for `bind`. Mixing those masks silently turns binds into
    // rebases, so they are decoded separately.
    const next = Number((raw >> 51n) & 0x7ffn);
    const bind = ((raw >> 62n) & 1n) === 1n;
    const auth = ((raw >> 63n) & 1n) === 1n;
    if (!bind) {
      if (auth) {
        // 32-bit VM offset; PAC is decoded but not enforced by this layer.
        return {
          next,
          kind: "rebase",
          target: raw & 0xffff_ffffn,
          high8: 0,
          ordinal: 0,
          addend: 0n,
          weak: false,
          authenticated: true,
        };
      }
      const high8 = Number((raw >> 43n) & 0xffn);
      return {
        next,
        kind: "rebase",
        target: raw & 0x7ff_ffff_ffffn,
        high8,
        ordinal: 0,
        addend: 0n,
        weak: false,
        authenticated: false,
      };
    }

    const ordinalMask = format === DYLD_CHAINED_PTR_ARM64E_USERLAND24 ? 0xff_ffffn : 0xffffn;
    const ordinal = Number(raw & ordinalMask);
    const addend = auth ? 0n : BigInt.asIntN(19, (raw >> 32n) & 0x7ffffn);
    return {
      next,
      kind: "bind",
      ordinal,
      addend,
      weak: false,
      target: 0n,
      high8: 0,
      authenticated: auth,
    };
  }

  throw new MachOError(
    "unsupported_pointer_format",
    `segment ${segmentIndex} page ${page}: chained pointer format ${format} at 0x${location.toString(16)} is not supported`,
  );
}
