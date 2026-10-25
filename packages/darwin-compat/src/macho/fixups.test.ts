import { describe, expect, it } from "vitest";
import { BinaryWriter } from "../binary.js";
import { parseChainedFixups } from "./fixups.js";

function fixupsForWord(word: bigint, pointerFormat: number) {
  const header = new BinaryWriter();
  header.u32(0); // version
  header.u32(28); // starts offset
  header.u32(60); // imports offset
  header.u32(64); // symbols offset
  header.u32(1); // imports count
  header.u32(1); // DYLD_CHAINED_IMPORT
  header.u32(0); // uncompressed symbols

  header.u32(1); // one segment
  header.u32(8); // starts structure offset

  header.u32(24); // starts_in_segment size
  header.u16(0x4000);
  header.u16(pointerFormat);
  header.u64(0); // segment offset
  header.u32(0);
  header.u16(1); // page count
  header.u16(0); // first fixup at page offset 0

  header.u32(1); // import: ordinal 1, name offset 0
  header.cstring("_symbol");

  const bytes = new Uint8Array(0x4000);
  bytes.set(header.toUint8Array(), 0x1000);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, word, true);
  return parseChainedFixups(bytes, 0x1000, header.length, [
    { index: 0, fileOffset: 0, fileSize: 0x4000, vmAddress: 0x100000000 },
  ]);
}

describe("chained fixup pointer formats", () => {
  it("decodes a PTR_64 bind", () => {
    const fixups = fixupsForWord((1n << 63n) | 1n, 2);
    expect(fixups.pointerFormats).toEqual([2]);
    expect(fixups.fixups[0]).toMatchObject({
      kind: "bind",
      symbol: "_symbol",
      ordinal: 1,
      authenticated: false,
    });
  });

  it("decodes a PTR_64 rebase with high8", () => {
    const fixups = fixupsForWord(0x100001000n | (0x12n << 36n), 2);
    expect(fixups.fixups[0]).toMatchObject({ kind: "rebase", target: 0x100001000n, high8: 0x12 });
  });

  it("decodes an arm64e bind using bit 62, not bit 63", () => {
    const fixups = fixupsForWord((1n << 62n) | 1n, 1);
    expect(fixups.fixups[0]).toMatchObject({
      kind: "bind",
      symbol: "_symbol",
      authenticated: false,
    });
  });

  it("decodes an arm64e authenticated bind and rebase", () => {
    const bind = fixupsForWord((1n << 63n) | (1n << 62n) | 1n, 1);
    expect(bind.fixups[0]).toMatchObject({ kind: "bind", symbol: "_symbol", authenticated: true });
    const rebase = fixupsForWord((1n << 63n) | 0x1234n, 1);
    expect(rebase.fixups[0]).toMatchObject({
      kind: "rebase",
      target: 0x1234n,
      authenticated: true,
    });
  });

  it("rejects unknown pointer formats", () => {
    expect(() => fixupsForWord(1n, 99)).toThrow(/not supported/);
  });
});
