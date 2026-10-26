import { describe, expect, it } from "vitest";
import { BinaryWriter } from "../binary.js";
import {
  CPU_SUBTYPE_ARM64_ALL,
  CPU_SUBTYPE_ARM64E,
  CPU_TYPE_ARM64,
  FAT_MAGIC,
  FAT_MAGIC_64,
} from "./constants.js";
import { parseFatHeader, selectSlice } from "./fat.js";
import { parseChainedFixups } from "./fixups.js";
import {
  encodeLegacyBinds,
  encodeLegacyRebases,
  parseLegacyBinds,
  parseLegacyRebases,
} from "./legacy-fixups.js";

function fat(
  magic: number,
  slices: Array<{ cpu: number; subtype: number; offset: number; size: number; align: number }>,
) {
  const wide = magic === FAT_MAGIC_64;
  const headerLength = 8 + slices.length * (wide ? 32 : 20);
  const needed = Math.max(headerLength, ...slices.map((slice) => slice.offset + slice.size), 64);
  const bytes = new Uint8Array(needed);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, false);
  view.setUint32(4, slices.length, false);
  slices.forEach((slice, index) => {
    const at = 8 + index * (wide ? 32 : 20);
    view.setInt32(at, slice.cpu, false);
    view.setInt32(at + 4, slice.subtype, false);
    if (wide) {
      view.setBigUint64(at + 8, BigInt(slice.offset), false);
      view.setBigUint64(at + 16, BigInt(slice.size), false);
      view.setUint32(at + 24, slice.align, false);
      view.setUint32(at + 28, 0, false);
    } else {
      view.setUint32(at + 8, slice.offset, false);
      view.setUint32(at + 12, slice.size, false);
      view.setUint32(at + 16, slice.align, false);
    }
  });
  return bytes;
}

describe("fat header coverage", () => {
  it("handles 32/64-bit headers and architecture selection", () => {
    const thin = new Uint8Array(64);
    expect(parseFatHeader(thin)).toBeNull();
    expect(parseFatHeader(new Uint8Array(4))).toBeNull();
    const fat32 = fat(FAT_MAGIC, [
      { cpu: CPU_TYPE_ARM64, subtype: CPU_SUBTYPE_ARM64_ALL, offset: 64, size: 8, align: 2 },
    ]);
    expect(parseFatHeader(fat32)?.slices[0]?.size).toBe(8);
    const fat64 = fat(FAT_MAGIC_64, [
      { cpu: CPU_TYPE_ARM64, subtype: CPU_SUBTYPE_ARM64E, offset: 96, size: 8, align: 3 },
      { cpu: CPU_TYPE_ARM64, subtype: CPU_SUBTYPE_ARM64_ALL, offset: 104, size: 8, align: 3 },
    ]);
    const parsed = parseFatHeader(fat64)!;
    expect(parsed.is64).toBe(true);
    expect(selectSlice(parsed, "arm64e").offset).toBe(96);
    expect(selectSlice(parsed, "arm64").offset).toBe(104);
  });

  it("rejects empty, oversized, truncated, misaligned, and out-of-bounds slices", () => {
    expect(() => parseFatHeader(fat(FAT_MAGIC, []))).toThrow(/zero architecture/);
    expect(() =>
      parseFatHeader(
        fat(
          FAT_MAGIC,
          Array.from({ length: 65 }, () => ({
            cpu: CPU_TYPE_ARM64,
            subtype: 0,
            offset: 0,
            size: 0,
            align: 0,
          })),
        ),
      ),
    ).toThrow(/slices/);
    expect(() =>
      parseFatHeader(
        fat(FAT_MAGIC, [
          { cpu: CPU_TYPE_ARM64, subtype: 0, offset: 0, size: 0, align: 0 },
        ]).subarray(0, 8),
      ),
    ).toThrow(/truncated|ended/);
    expect(() =>
      parseFatHeader(fat(FAT_MAGIC, [{ cpu: 1, subtype: 0, offset: 0, size: 0, align: 32 }])),
    ).toThrow(/alignment/);
    expect(() =>
      parseFatHeader(
        fat(FAT_MAGIC, [
          { cpu: CPU_TYPE_ARM64, subtype: 0, offset: 999, size: 999, align: 0 },
        ]).subarray(0, 100),
      ),
    ).toThrow(/exceeds/);
    expect(() =>
      selectSlice(
        parseFatHeader(fat(FAT_MAGIC, [{ cpu: 7, subtype: 0, offset: 0, size: 0, align: 0 }]))!,
      ),
    ).toThrow(/no arm64/);
    expect(() =>
      selectSlice(
        parseFatHeader(
          fat(FAT_MAGIC, [
            { cpu: CPU_TYPE_ARM64, subtype: CPU_SUBTYPE_ARM64_ALL, offset: 0, size: 0, align: 0 },
          ]),
        )!,
        "arm64e",
      ),
    ).toThrow(/arm64e/);
  });
});

const segments = [{ index: 0, vmAddress: 0x100000000, vmSize: 0x10000 }];

describe("legacy opcode coverage", () => {
  it("decodes every rebase opcode family", () => {
    const stream = Uint8Array.from([
      0x20,
      0x10, // segment 0, offset 0x10
      0x30,
      0x08, // add 8
      0x40 | 2, // add 16
      0x50 | 1, // do 1
      0x60,
      0x02, // do 2
      0x70,
      0x04, // do 1 + add 4
      0x80,
      0x02,
      0x08, // do 2 skipping 8
      0x00,
    ]);
    const decoded = parseLegacyRebases(stream, 0, stream.length, segments);
    expect(decoded.length).toBe(6);
    expect(decoded[0]?.segmentOffset).toBe(0x28);
  });

  it("decodes every bind opcode family", () => {
    const encoded = encodeLegacyBinds([
      { segmentIndex: 0, segmentOffset: 0, symbol: "_a", ordinal: 1, addend: 4 },
      { segmentIndex: 0, segmentOffset: 8, symbol: "_b", ordinal: 20 },
    ]);
    const binds = parseLegacyBinds(encoded, 0, encoded.length, segments);
    expect(binds.map((bind) => bind.ordinal)).toEqual([1, 20]);
    expect(binds[0]?.addend).toBe(4n);
    const manual = Uint8Array.from([
      0x30 | 0xf,
      0x40,
      0x5f,
      0x00,
      0x70,
      0x00,
      0x90, // special -1, do bind
      0xa0,
      0x04, // bind + add 4
      0xb0 | 1, // bind + scaled 8
      0xc0,
      0x02,
      0x04, // 2 binds skipping 4
      0x00,
    ]);
    expect(parseLegacyBinds(manual, 0, manual.length, segments)).toHaveLength(5);
  });

  it("rejects overflow, bad segments, and malformed symbols", () => {
    expect(() => parseLegacyRebases(Uint8Array.from([0x20, 0x80]), 0, 2, segments)).toThrow(
      /truncated|ended/,
    );
    expect(() => parseLegacyRebases(Uint8Array.from([0x21, 0x00, 0x51]), 0, 3, segments)).toThrow(
      /segment/,
    );
    expect(() =>
      parseLegacyBinds(Uint8Array.from([0x40, 0x5f, 0x00, 0x70, 0x00, 0xd0]), 0, 6, segments),
    ).toThrow(/threaded/);
    expect(() =>
      parseLegacyBinds(Uint8Array.from([0x40, 0x5f, 0x00, 0x70, 0x00, 0x90]), 0, 6, segments),
    ).not.toThrow();
    expect(parseLegacyRebases(encodeLegacyRebases([]), 0, 1, segments)).toEqual([]);
  });
});

function chainedPayload(options: {
  importsFormat?: number;
  importsCount?: number;
  symbolsFormat?: number;
  version?: number;
  pageStart?: number;
  symbol?: string;
  word?: bigint;
}) {
  const importsFormat = options.importsFormat ?? 2;
  const importSize = importsFormat === 3 ? 16 : importsFormat === 2 ? 8 : 4;
  const importsCount = options.importsCount ?? 1;
  const startsOffset = 28;
  const importsOffset = 60;
  const symbolsOffset = importsOffset + importSize * importsCount;
  const header = new BinaryWriter();
  header.u32(options.version ?? 0);
  header.u32(startsOffset);
  header.u32(importsOffset);
  header.u32(symbolsOffset);
  header.u32(importsCount);
  header.u32(importsFormat);
  header.u32(options.symbolsFormat ?? 0);
  header.u32(1); // one segment
  header.u32(8); // starts structure offset
  header.u32(24); // starts size
  header.u16(0x4000);
  header.u16(2); // PTR_64
  header.u64(0);
  header.u32(0);
  header.u16(1);
  header.u16(options.pageStart ?? 0);
  for (let index = 0; index < importsCount; index += 1) {
    if (importsFormat === 1) header.u32(1);
    else if (importsFormat === 2) {
      header.u32(1);
      header.u32(0);
    } else if (importsFormat === 3) {
      header.u64(1n);
      header.u64(0n);
    } else {
      header.u32(1);
    }
  }
  header.cstring(options.symbol ?? "_symbol");
  const bytes = new Uint8Array(0x4000);
  bytes.set(header.toUint8Array(), 0x1000);
  new DataView(bytes.buffer).setBigUint64(0, options.word ?? (1n << 63n) | 1n, true);
  return { bytes, size: header.length };
}

describe("chained import format coverage", () => {
  it("decodes ADDEND and ADDEND64 import formats", () => {
    for (const format of [2, 3]) {
      const payload = chainedPayload({ importsFormat: format });
      const fixups = parseChainedFixups(payload.bytes, 0x1000, payload.size, [
        { index: 0, fileOffset: 0, fileSize: 0x4000, vmAddress: 0x100000000 },
      ]);
      expect(fixups.imports[0]?.name).toBe("_symbol");
      expect(fixups.fixups[0]?.kind).toBe("bind");
    }
  });

  it("rejects unsupported versions, symbols/import formats, and multi-start chains", () => {
    const segments = [{ index: 0, fileOffset: 0, fileSize: 0x4000, vmAddress: 0x100000000 }];
    const expectCode = (options: Parameters<typeof chainedPayload>[0], code: string) => {
      const payload = chainedPayload(options);
      expect(() => parseChainedFixups(payload.bytes, 0x1000, payload.size, segments)).toThrow();
      try {
        parseChainedFixups(payload.bytes, 0x1000, payload.size, segments);
      } catch (error) {
        expect((error as { code?: string }).code).toBe(code);
      }
    };
    expectCode({ version: 1 }, "unsupported_fixups_version");
    expectCode({ symbolsFormat: 1 }, "unsupported_symbols_format");
    expectCode({ importsFormat: 4 }, "unsupported_imports_format");
    expectCode({ pageStart: 0x8000 }, "unsupported_multi_start");
    expectCode({ symbol: "" }, "empty_import_name");
  });
});
