import { describe, expect, it } from "vitest";
import {
  encodeLegacyBinds,
  encodeLegacyRebases,
  parseLegacyBinds,
  parseLegacyRebases,
} from "./legacy-fixups.js";

const segments = [
  { index: 0, vmAddress: 0, vmSize: 0x100000000 },
  { index: 1, vmAddress: 0x100001000, vmSize: 0x4000 },
  { index: 2, vmAddress: 0x100004000, vmSize: 0x4000 },
];

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "missing-code";
  }
  return "no-error";
}

describe("legacy dyld opcodes", () => {
  it("round-trips bind ordinal, weak flag, and signed addend", () => {
    const stream = encodeLegacyBinds([
      { segmentIndex: 2, segmentOffset: 0, symbol: "_one", ordinal: 1 },
      { segmentIndex: 2, segmentOffset: 8, symbol: "_two", ordinal: 3, addend: -16, weak: true },
      { segmentIndex: 2, segmentOffset: 16, symbol: "_flat", ordinal: -2 },
    ]);
    const binds = parseLegacyBinds(stream, 0, stream.length, segments);
    expect(binds).toEqual([
      { segmentIndex: 2, segmentOffset: 0, symbol: "_one", ordinal: 1, addend: 0n, weak: false },
      { segmentIndex: 2, segmentOffset: 8, symbol: "_two", ordinal: 3, addend: -16n, weak: true },
      { segmentIndex: 2, segmentOffset: 16, symbol: "_flat", ordinal: -2, addend: 0n, weak: false },
    ]);
  });

  it("round-trips rebase locations and skips", () => {
    const stream = encodeLegacyRebases([
      { segmentIndex: 2, segmentOffset: 0 },
      { segmentIndex: 2, segmentOffset: 0x20 },
    ]);
    expect(parseLegacyRebases(stream, 0, stream.length, segments)).toEqual([
      { segmentIndex: 2, segmentOffset: 0 },
      { segmentIndex: 2, segmentOffset: 0x20 },
    ]);
  });

  it("decodes repeated rebases and immediate-scaled bind skipping", () => {
    const rebase = Uint8Array.from([
      0x20 | 2, // SET_SEGMENT_AND_OFFSET_ULEB(2)
      0x00, // offset 0
      0x50 | 2, // DO_REBASE_IMM_TIMES(2)
      0x00, // DONE
    ]);
    expect(parseLegacyRebases(rebase, 0, rebase.length, segments)).toEqual([
      { segmentIndex: 2, segmentOffset: 0 },
      { segmentIndex: 2, segmentOffset: 8 },
    ]);

    const bind = Uint8Array.from([
      0x10 | 1, // SET_DYLIB_ORDINAL_IMM(1)
      0x40, // SET_SYMBOL_TRAILING_FLAGS_IMM
      0x5f, // "_"
      0x78, // "x"
      0x00, // NUL
      0x70 | 2, // SET_SEGMENT_AND_OFFSET_ULEB(2)
      0x00, // offset 0
      0xb0 | 1, // DO_BIND_ADD_ADDR_IMM_SCALED(1)
      0x00, // DONE
    ]);
    expect(parseLegacyBinds(bind, 0, bind.length, segments)).toEqual([
      { segmentIndex: 2, segmentOffset: 0, symbol: "_x", ordinal: 1, addend: 0n, weak: false },
    ]);
  });

  it("fails with stable codes for malformed streams", () => {
    expect(
      codeOf(() =>
        parseLegacyRebases(Uint8Array.from([0x22, 0x80, 0x80, 0x01, 0x51, 0x00]), 0, 6, segments),
      ),
    ).toBe("legacy_fixups_outside_segment");
    expect(codeOf(() => parseLegacyRebases(Uint8Array.from([0x20, 0x82]), 0, 2, segments))).toBe(
      "legacy_fixups_truncated",
    );
    expect(codeOf(() => parseLegacyRebases(Uint8Array.from([0xf0]), 0, 1, segments))).toBe(
      "legacy_fixups_unknown_opcode",
    );
    expect(codeOf(() => parseLegacyBinds(Uint8Array.from([0x90, 0x00]), 0, 2, segments))).toBe(
      "legacy_fixups_missing_symbol",
    );
    expect(codeOf(() => parseLegacyBinds(Uint8Array.from([0xd0]), 0, 1, segments))).toBe(
      "legacy_threaded_bind_unimplemented",
    );
    expect(codeOf(() => parseLegacyBinds(Uint8Array.from([0x00]), 0, 1, segments))).toBe(
      "no-error",
    );
  });
});
