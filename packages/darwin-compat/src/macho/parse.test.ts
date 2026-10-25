import { describe, expect, it } from "vitest";
import { movz, ret, svc, words } from "../arm64/assembler.js";
import { buildHello, HELLO_BASE, HELLO_TEXT_BASE } from "../testing/fixtures.js";
import { buildMachO } from "./build.js";
import { CPU_TYPE_ARM64 } from "./constants.js";
import { parseMachO } from "./parse.js";

describe("Mach-O parser", () => {
  it("parses a generated executable", () => {
    const built = buildHello();
    const { image, fat } = parseMachO(built.bytes);
    expect(fat).toBeNull();
    expect(image.header.cpuType).toBe(CPU_TYPE_ARM64);
    expect(image.header.fileType).toBe(2);
    expect(image.main).toEqual({ entryOffset: 0x1000, stackSize: 8 * 1024 * 1024 });
    expect(image.preferredBase).toBe(HELLO_BASE);
    expect(image.textSegment?.name).toBe("__TEXT");
    expect(image.segments.map((segment) => segment.name)).toEqual([
      "__PAGEZERO",
      "__TEXT",
      "__DATA",
      "__LINKEDIT",
    ]);
    expect(image.symbols.find((symbol) => symbol.name === "_start")?.value).toBe(HELLO_TEXT_BASE);
    expect(image.exportsTrie?.exports.get("_start")?.address).toBe(0x1000);
    expect(image.chainedFixups).toBeNull();
    expect(image.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(image.buildVersion?.platform).toBe(7);
  });

  it("selects the arm64 slice of a universal binary", () => {
    const built = buildHello();
    const fatBytes = new Uint8Array(0x1000 + built.bytes.length);
    const view = new DataView(fatBytes.buffer);
    view.setUint32(0, 0xcafebabe, false);
    view.setUint32(4, 1, false);
    view.setInt32(8, CPU_TYPE_ARM64, false);
    view.setInt32(12, 0, false);
    view.setUint32(16, 0x1000, false);
    view.setUint32(20, built.bytes.length, false);
    view.setUint32(24, 12, false);
    fatBytes.set(built.bytes, 0x1000);

    const { image, fat } = parseMachO(fatBytes);
    expect(fat?.slices).toHaveLength(1);
    expect(image.sliceOffset).toBe(0x1000);
    expect(image.main?.entryOffset).toBe(0x1000);
  });

  it("rejects a truncated header and non-Mach-O data", () => {
    expect(() => parseMachO(new Uint8Array(8))).toThrow(/at least 32/);
    expect(() => parseMachO(new Uint8Array(64))).toThrow(/magic/);
  });

  it("rejects a load command that overruns sizeofcmds", () => {
    const built = buildHello();
    const corrupted = built.bytes.slice();
    const view = new DataView(corrupted.buffer);
    view.setUint32(20, view.getUint32(20, true) + 0x1000, true);
    expect(() => parseMachO(corrupted)).toThrow(/sizeofcmds/);
  });

  it("decodes chained fixups and imports", () => {
    const data = new Uint8Array(0x4000);
    const built = buildMachO({
      text: words(movz(0, 0), ret()),
      cstring: "x",
      data,
      dependencies: [{ name: "/lib/libhelper.dylib" }],
      fixups: [
        { kind: "rebase", offset: 0, target: 0x100001000 },
        { kind: "bind", offset: 8, symbol: "_helper", ordinal: 1 },
      ],
      symbols: [{ name: "_start", value: 0x100001000 }],
    });
    const { image } = parseMachO(built.bytes);
    const fixups = image.chainedFixups;
    expect(fixups).not.toBeNull();
    expect(fixups?.imports).toEqual([{ ordinal: 1, name: "_helper", weak: false, addend: 0n }]);
    expect(fixups?.fixups).toHaveLength(2);
    expect(fixups?.fixups[0]).toMatchObject({
      kind: "rebase",
      location: built.layout.dataFileOffset,
    });
    expect(fixups?.fixups[1]).toMatchObject({
      kind: "bind",
      symbol: "_helper",
      addend: 0n,
      location: built.layout.dataFileOffset + 8,
    });
  });

  it("uses symbol-table fallback when no exports trie exists", () => {
    const built = buildMachO({
      text: words(ret()),
      symbols: [
        { name: "_start", value: 0x100001000 },
        { name: "_dataSymbol", value: 0x100004000 },
      ],
    });
    const { image } = parseMachO(built.bytes);
    expect(image.exportsTrie).toBeNull();
    expect(image.symbols.map((symbol) => symbol.name)).toEqual(["_start", "_dataSymbol"]);
  });
});
