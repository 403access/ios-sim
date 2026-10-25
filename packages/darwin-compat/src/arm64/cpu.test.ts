import { describe, expect, it } from "vitest";
import { Arm64Cpu, type Arm64Memory, type SyscallResult } from "./cpu.js";
import {
  addImm,
  addReg,
  adrp,
  and,
  bCond,
  cbnz,
  cset,
  ldp,
  ldrUnsigned,
  lslImm,
  movk,
  movn,
  movz,
  msub,
  mul,
  ret,
  stp,
  strUnsigned,
  subReg,
  svc,
  udiv,
  words,
  csel,
} from "./assembler.js";

class TestMemory implements Arm64Memory {
  readonly bytes = new Uint8Array(0x1_0000);

  read(address: bigint, size: number): bigint {
    const at = Number(address);
    if (at < 0 || at + size > this.bytes.length) throw new Error(`read out of bounds at ${at}`);
    let value = 0n;
    for (let index = 0; index < size; index += 1)
      value |= BigInt(this.bytes[at + index]!) << BigInt(index * 8);
    return value;
  }

  write(address: bigint, size: number, value: bigint): void {
    const at = Number(address);
    if (at < 0 || at + size > this.bytes.length) throw new Error(`write out of bounds at ${at}`);
    for (let index = 0; index < size; index += 1) {
      this.bytes[at + index] = Number((value >> BigInt(index * 8)) & 0xffn);
    }
  }

  load(instructions: readonly number[]): void {
    this.bytes.set(words(...instructions), 0);
  }
}

function run(
  code: readonly number[],
  options: { max?: number; syscall?: (number: number, cpu: Arm64Cpu) => SyscallResult } = {},
) {
  const memory = new TestMemory();
  memory.load(code);
  const cpu = new Arm64Cpu();
  cpu.reset(0n, 0x8000n);
  let steps = 0;
  while (!cpu.halted && steps < (options.max ?? 1000)) {
    if (Number(cpu.pc) >= code.length * 4) break;
    cpu.step(memory, (number, machine) => {
      if (options.syscall) return options.syscall(number, machine);
      if (number === 1) {
        machine.exitStatus = Number(machine.readRegister(0)) & 0xff;
        return { value: 0, halt: true };
      }
      return { value: 0 };
    });
    steps += 1;
  }
  return { cpu, memory, steps };
}

describe("A64 interpreter", () => {
  it("moves immediates and composes 64-bit constants", () => {
    const { cpu } = run([movz(0, 0x1234), movk(0, 0x5678, 16), movz(1, 0), movn(2, 0)]);
    expect(cpu.readRegister(0)).toBe(0x5678_1234n);
    expect(cpu.readRegister(1)).toBe(0n);
    expect(cpu.readRegister(2)).toBe(0xffff_ffff_ffff_ffffn);
  });

  it("sets flags and takes conditional branches", () => {
    const { cpu } = run([
      movz(0, 5),
      subReg(1, 0, 0, { setFlags: true }),
      bCond("eq", 8),
      movz(2, 1),
      movz(3, 2),
      movz(0, 0),
      movz(16, 1),
      svc(0x80),
    ]);
    expect(cpu.readRegister(2)).toBe(0n);
    expect(cpu.readRegister(3)).toBe(2n);
  });

  it("runs a counted loop and computes a sum", () => {
    // x0=0; x1=1; x2=6; loop: x0+=x1; x1+=1; cmp x1,x2; b.ne loop
    const { cpu } = run(
      [
        movz(0, 0),
        movz(1, 1),
        movz(2, 6),
        addReg(0, 0, 1),
        addImm(1, 1, 1),
        subReg(31, 1, 2, { setFlags: true }),
        bCond("ne", -12),
        addImm(9, 0, 0),
        movz(0, 0),
        movz(16, 1),
        svc(0x80),
      ],
      { max: 100 },
    );
    expect(cpu.readRegister(9)).toBe(15n);
    expect(cpu.readRegister(1)).toBe(6n);
  });

  it("implements csel, cset, multiply, and divide", () => {
    const { cpu } = run([
      movz(0, 3),
      movz(1, 4),
      mul(2, 0, 1),
      udiv(3, 2, 1),
      msub(4, 0, 1, 2),
      subReg(5, 0, 1, { setFlags: true }),
      cset(6, "lt"),
      csel(7, 0, 1, "lt"),
    ]);
    expect(cpu.readRegister(2)).toBe(12n);
    expect(cpu.readRegister(3)).toBe(3n);
    expect(cpu.readRegister(4)).toBe(0n);
    expect(cpu.readRegister(6)).toBe(1n);
    expect(cpu.readRegister(7)).toBe(3n);
  });

  it("loads and stores with pair and unsigned offsets", () => {
    const { cpu } = run([
      movz(0, 0x1000),
      addImm(10, 0, 0),
      movz(1, 7),
      movz(2, 9),
      stp(1, 2, 10, 0),
      ldp(3, 4, 10, 0),
      strUnsigned(5, 10, 16),
      movz(5, 42),
      strUnsigned(5, 10, 16),
      ldrUnsigned(6, 10, 16),
    ]);
    expect(cpu.readRegister(3)).toBe(7n);
    expect(cpu.readRegister(4)).toBe(9n);
    expect(cpu.readRegister(6)).toBe(42n);
  });

  it("computes PC-relative addresses", () => {
    const { cpu } = run([adrp(0, 0x2000, 0), addImm(0, 0, 0x40)], { max: 2 });
    expect(cpu.readRegister(0)).toBe(0x2040n);
  });

  it("executes BL/RET and preserves the return value", () => {
    // _start: bl +12 (helper at instruction 5); exit x0
    // helper: movz x0, 55; ret
    const { cpu } = run([
      0x94000004, // bl +16
      movz(16, 1),
      svc(0x80),
      0,
      movz(0, 55),
      ret(),
    ]);
    expect(cpu.exitStatus).toBe(55);
  });

  it("sign- and zero-extends W writes", () => {
    const { cpu } = run([movz(0, 0xffff), movn(1, 0), and(2, 1, 0, false), lslImm(3, 0, 4)]);
    expect(cpu.readRegister(2)).toBe(0xffffn);
    expect(cpu.readRegister(3)).toBe(0xffff0n);
  });

  it("reports unsupported instructions with a stable code", () => {
    const memory = new TestMemory();
    memory.load([0xffffffff]);
    const cpu = new Arm64Cpu();
    cpu.reset(0n, 0x8000n);
    expect(() => cpu.step(memory, () => ({ value: 0 }))).toThrow(/unsupported A64 instruction/);
  });

  it("halts on exit and records the status", () => {
    const { cpu } = run([movz(0, 9), movz(16, 1), svc(0x80)]);
    expect(cpu.halted).toBe(true);
    expect(cpu.exitStatus).toBe(9);
  });

  it("sets carry on syscall errors", () => {
    const { cpu } = run([movz(16, 500), svc(0x80)], {
      max: 2,
      syscall: () => ({ value: 13, error: true }),
    });
    expect(cpu.readRegister(0)).toBe(13n);
    expect(cpu.nzcv & 2).toBe(2);
  });

  it("supports cbnz and shifts", () => {
    const { cpu } = run([
      movz(0, 1),
      cbnz(0, 8),
      movz(1, 1),
      movz(2, 2),
      movz(0, 0),
      movz(16, 1),
      svc(0x80),
    ]);
    expect(cpu.readRegister(1)).toBe(0n);
    expect(cpu.readRegister(2)).toBe(2n);
  });
});
