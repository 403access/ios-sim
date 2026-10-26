import { describe, expect, it } from "vitest";
import {
  addImm,
  adrp,
  b,
  bCond,
  blr,
  cbz,
  movz,
  nop,
  ret,
  subImm,
  svc,
  words,
} from "./assembler.js";
import { disassembleInstruction, disassembleRange } from "./disassemble.js";

describe("AArch64 disassembler", () => {
  it("decodes the common integer and syscall subset", () => {
    const cases: Array<[number, string]> = [
      [nop(), "nop"],
      [ret(), "ret"],
      [blr(9), "blr x9"],
      [movz(0, 42), "movz x0, #0x2a"],
      [movz(16, 1), "movz x16, #0x1"],
      [addImm(1, 1, 8), "add x1, x1, #8"],
      [subImm(0, 0, 1, { setFlags: true }), "subs x0, x0, #1"],
      [subImm(31, 2, 4, { setFlags: true }), "cmp x2, #4"],
      [svc(0x80), "svc #128"],
      [b(8), "b 0x8"],
    ];
    for (const [word, expected] of cases) {
      expect(disassembleInstruction(word, 0n)).toBe(expected);
    }
  });

  it("resolves pc-relative branches and adrp", () => {
    expect(disassembleInstruction(bCond("ne", 12), 0x1000n)).toContain("b.ne 0x100c");
    expect(disassembleInstruction(cbz(0, 8), 0x1000n)).toContain("cbz x0, 0x1008");
    expect(disassembleInstruction(adrp(1, 0x100001000, 0x100001004), 0x100001004n)).toContain(
      "adrp x1, 0x100001000",
    );
  });

  it("dumps unknown words and respects the range limit", () => {
    const bytes = words(nop(), 0xdeadbeef, ret());
    const decoded = disassembleRange(bytes, 0x1000n, 2);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.address).toBe(0x1000n);
    expect(decoded[1]?.text).toBe(".word 0xdeadbeef");
  });
});
