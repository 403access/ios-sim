import { describe, expect, it } from "vitest";
import { buildCorpus, runCorpus } from "./corpus.js";

describe("generated Mach-O corpus", () => {
  it("parses every valid case and rejects every invalid case", () => {
    const report = runCorpus();
    expect(report.failures).toEqual([]);
    expect(report.total).toBeGreaterThan(20);
    expect(report.valid).toBeGreaterThan(15);
    expect(report.invalid).toBeGreaterThanOrEqual(6);
  });

  it("covers load commands, pointer formats, and legacy streams", () => {
    const report = runCorpus();
    expect(report.loadCommands).toEqual(
      expect.arrayContaining([
        "LC_MAIN",
        "LC_SYMTAB",
        "LC_DYLD_INFO_ONLY",
        "LC_DYLD_CHAINED_FIXUPS",
        "LC_CODE_SIGNATURE",
        "LC_FILESET_ENTRY",
        "FAT_MAGIC",
      ]),
    );
    expect(report.pointerFormats).toEqual([1, 2, 6, 9, 12]);
    expect(report.legacyOpcodes).toEqual(
      expect.arrayContaining([
        "rebase",
        "bind",
        "mod-init",
        "interpose",
        "code-signature",
        "fileset",
      ]),
    );
  });

  it("keeps case names unique", () => {
    const cases = buildCorpus();
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });
});
