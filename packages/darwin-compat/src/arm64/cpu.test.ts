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
  options: {
    max?: number;
    syscall?: (number: number, cpu: Arm64Cpu) => SyscallResult;
    prepare?: (memory: TestMemory, cpu: Arm64Cpu) => void;
  } = {},
) {
  const memory = new TestMemory();
  memory.load(code);
  const cpu = new Arm64Cpu();
  cpu.reset(0n, 0x8000n);
  options.prepare?.(memory, cpu);
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

/**
 * Encodings below are the words Apple clang 21 emits for the same mnemonics.
 * Keeping them literal makes a decoder regression show up as a failing word,
 * not as a subtle change in a helper.
 */
describe("A64 scalar floating point", () => {
  it("moves bits between the general and vector register files", () => {
    const { cpu } = run([0x1e604020, 0x9e660002], {
      prepare: (_memory, machine) => machine.writeVectorDouble(1, 20.5),
    });
    expect(cpu.readRegister(2)).toBe(cpu.readVectorBits(1, 64));
    expect(Number(cpu.readVectorDouble(0))).toBe(20.5);
  });

  it("adds and multiplies doubles", () => {
    const { cpu } = run([0x1e622820, 0x1e620820], {
      prepare: (_memory, machine) => {
        machine.writeVectorDouble(1, 1.5);
        machine.writeVectorDouble(2, 2.25);
      },
    });
    expect(cpu.readVectorDouble(0)).toBe(3.375);
    expect(cpu.readVectorDouble(2)).toBe(2.25);
  });

  it("decodes the fmov immediate form", () => {
    expect(run([0x1e669000]).cpu.readVectorDouble(0)).toBe(20);
    expect(run([0x1e209000]).cpu.readVectorSingle(0)).toBe(2.5);
    expect(run([0x1e2c1000]).cpu.readVectorSingle(0)).toBe(0.5);
  });

  it("compares and selects on floating-point flags", () => {
    const { cpu } = run([0x1e622020, 0x1e62bc20], {
      prepare: (_memory, machine) => {
        machine.writeVectorDouble(1, 1);
        machine.writeVectorDouble(2, 2);
      },
    });
    expect(cpu.readVectorDouble(0)).toBe(1);
    expect(cpu.nzcv & 8).toBe(8);
  });

  it("converts integers and doubles in both directions", () => {
    const { cpu } = run([movz(0, 7), 0x9e620000, 0x9e780002, 0x1e220003]);
    expect(cpu.readVectorDouble(0)).toBe(7);
    expect(cpu.readRegister(2)).toBe(7n);
    expect(cpu.readVectorSingle(3)).toBe(7);
  });

  it("loads and stores scalar doubles and quads", () => {
    const { cpu, memory } = run([0xfd400420, 0xfd000820, 0xad410420, 0xad020420], {
      prepare: (store, machine) => {
        const view = new DataView(store.bytes.buffer);
        view.setFloat64(0x108, 6.25, true);
        for (let index = 0; index < 32; index += 1) store.bytes[0x120 + index] = index + 1;
        machine.writeRegister(1, 0x100n);
      },
    });
    expect(memory.read(0x110n, 8)).toBe(0x4019_0000_0000_0000n);
    const bytes = cpu.readVector128(0);
    expect([...bytes].slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect([...cpu.readVector128(1)].slice(0, 4)).toEqual([17, 18, 19, 20]);
    expect(memory.read(0x140n, 8)).toBe(0x0807_0605_0403_0201n);
  });

  it("implements the thread pointer system registers", () => {
    const { cpu } = run([movz(0, 0x1234), 0xd51bd040, 0xd53bd041]);
    expect(cpu.readRegister(1)).toBe(0x1234n);
    expect(cpu.tpidr).toBe(0x1234n);
  });
});

describe("A64 atomics", () => {
  it("adds atomically and returns the old value", () => {
    const { cpu, memory } = run([movz(0, 5), movz(1, 7), movz(2, 0x300), 0xf8200041], {
      prepare: (store) => store.write(0x300n, 8, 10n),
    });
    expect(cpu.readRegister(1)).toBe(10n);
    expect(memory.read(0x300n, 8)).toBe(15n);
  });

  it("swaps atomically", () => {
    const { cpu, memory } = run([movz(0, 1), movz(1, 9), movz(2, 0x300), 0xf8208041], {
      prepare: (store) => store.write(0x300n, 8, 10n),
    });
    expect(cpu.readRegister(1)).toBe(10n);
    expect(cpu.readRegister(0)).toBe(1n);
    expect(memory.read(0x300n, 8)).toBe(1n);
  });

  it("compares and swaps only on equality", () => {
    const matched = run([movz(0, 10), movz(1, 9), movz(2, 0x300), 0xc8a07c41], {
      prepare: (store) => store.write(0x300n, 8, 10n),
    });
    expect(matched.memory.read(0x300n, 8)).toBe(9n);
    expect(matched.cpu.readRegister(0)).toBe(10n);

    const missed = run([movz(0, 1), movz(1, 9), movz(2, 0x300), 0xc8a07c41], {
      prepare: (store) => store.write(0x300n, 8, 10n),
    });
    expect(missed.memory.read(0x300n, 8)).toBe(10n);
    expect(missed.cpu.readRegister(0)).toBe(10n);
  });

  it("retries exclusives in a single-threaded process", () => {
    const { cpu, memory } = run([movz(1, 0x300), 0xc85f7c20, addImm(0, 0, 1), 0xc8027c20], {
      prepare: (store) => store.write(0x300n, 8, 4n),
    });
    expect(cpu.readRegister(2)).toBe(0n);
    expect(cpu.readRegister(0)).toBe(5n);
    expect(memory.read(0x300n, 8)).toBe(5n);
  });
});
