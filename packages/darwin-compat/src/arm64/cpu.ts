/**
 * A small AArch64 user-mode interpreter.
 *
 * This is the execution core of the native research track. It is not a JIT and
 * not a full ARM emulator: it implements the integer and scalar floating-point
 * subset emitted by compiled Darwin user-space code, with memory access
 * delegated to the dyld VM and `svc #0x80` delegated to the syscall layer.
 *
 * Deliberate omissions (all reported as `unsupported_instruction`):
 * SIMD lane arithmetic, pointer authentication enforcement, privileged/system
 * registers, and floating-point register-offset addressing. Omissions are
 * visible, never silent.
 */

import { Arm64Error } from "../errors.js";

export interface Arm64Memory {
  read(address: bigint, size: number): bigint;
  write(address: bigint, size: number, value: bigint): void;
}

export interface SyscallResult {
  readonly value: bigint | number;
  /** Stop the CPU after the syscall (exit). */
  readonly halt?: boolean;
  /** Set the AArch64 carry flag, matching Darwin's syscall error convention. */
  readonly error?: boolean;
}

export type SyscallHandler = (number: number, cpu: Arm64Cpu) => SyscallResult;

export interface Arm64Options {
  /** Called before each instruction for tracing. Keep it cheap or leave unset. */
  readonly onInstruction?: (pc: bigint, instruction: number, cpu: Arm64Cpu) => void;
}

const MASK32 = 0xffff_ffffn;
const MASK64 = 0xffff_ffff_ffff_ffffn;

interface FpConversion {
  readonly base: number;
  readonly kind: "scvtf" | "ucvtf" | "fcvtzs" | "fcvtzu";
  readonly sf: boolean;
  readonly double: boolean;
}

/**
 * Scalar conversion encodings, verified against Apple clang output for
 * `scvtf`, `ucvtf`, `fcvtzs`, and `fcvtzu` (see `cpu.test.ts`).
 */
const FP_CONVERSIONS: readonly FpConversion[] = [
  { base: 0x1e220000, kind: "scvtf", sf: false, double: false },
  { base: 0x1e620000, kind: "scvtf", sf: false, double: true },
  { base: 0x9e220000, kind: "scvtf", sf: true, double: false },
  { base: 0x9e620000, kind: "scvtf", sf: true, double: true },
  { base: 0x1e230000, kind: "ucvtf", sf: false, double: false },
  { base: 0x1e630000, kind: "ucvtf", sf: false, double: true },
  { base: 0x9e230000, kind: "ucvtf", sf: true, double: false },
  { base: 0x9e630000, kind: "ucvtf", sf: true, double: true },
  { base: 0x1e380000, kind: "fcvtzs", sf: false, double: false },
  { base: 0x1e780000, kind: "fcvtzs", sf: false, double: true },
  { base: 0x9e380000, kind: "fcvtzs", sf: true, double: false },
  { base: 0x9e780000, kind: "fcvtzs", sf: true, double: true },
  { base: 0x1e390000, kind: "fcvtzu", sf: false, double: false },
  { base: 0x1e790000, kind: "fcvtzu", sf: false, double: true },
  { base: 0x9e390000, kind: "fcvtzu", sf: true, double: false },
  { base: 0x9e790000, kind: "fcvtzu", sf: true, double: true },
];

export class Arm64Cpu {
  readonly registers = new BigUint64Array(32);
  /** 32 × 128-bit NEON registers, little-endian. Only scalar lanes are used. */
  private readonly vectorBytes = new Uint8Array(32 * 16);
  private readonly vectorView = new DataView(this.vectorBytes.buffer, this.vectorBytes.byteOffset);
  sp = 0x7ff0_0000_0000n;
  pc = 0n;
  /** `TPIDR_EL0`, the user thread pointer. One thread per task, so one value. */
  tpidr = 0n;
  /** Last address watched by an exclusive load; the interpreter is single-threaded. */
  private exclusiveAddress: bigint | null = null;
  /** N=8, Z=4, C=2, V=1. */
  nzcv = 0;
  halted = false;
  exitStatus = 0;
  instructions = 0;
  private readonly onInstruction: Arm64Options["onInstruction"];

  constructor(options: Arm64Options = {}) {
    this.onInstruction = options.onInstruction;
  }

  reset(entry: bigint, stackPointer: bigint): void {
    this.registers.fill(0n);
    this.vectorBytes.fill(0);
    this.pc = entry;
    this.sp = stackPointer;
    this.tpidr = 0n;
    this.exclusiveAddress = null;
    this.nzcv = 0;
    this.halted = false;
    this.exitStatus = 0;
    this.instructions = 0;
  }

  readRegister(index: number): bigint {
    if (index === 31) return 0n;
    return this.registers[index] ?? 0n;
  }

  writeRegister(index: number, value: bigint): void {
    if (index === 31) return;
    this.registers[index] = BigInt.asUintN(64, value);
  }

  /** Raw 128-bit vector register. Callers must not mutate the returned view. */
  readVector(index: number): Uint8Array {
    return this.vectorBytes.subarray(index * 16, index * 16 + 16);
  }

  /** Scalar lane bits (32 or 64) of a vector register. */
  readVectorBits(index: number, bits: 32 | 64): bigint {
    const offset = index * 16;
    return bits === 64
      ? this.vectorView.getBigUint64(offset, true)
      : BigInt(this.vectorView.getUint32(offset, true));
  }

  /** Write a scalar lane; an AArch64 FP write clears the upper lanes. */
  writeVectorBits(index: number, bits: 32 | 64, value: bigint): void {
    const offset = index * 16;
    this.vectorView.setBigUint64(offset + 8, 0n, true);
    if (bits === 64) {
      this.vectorView.setBigUint64(offset, BigInt.asUintN(64, value), true);
    } else {
      this.vectorView.setUint32(offset, Number(BigInt.asUintN(32, value)), true);
      this.vectorView.setUint32(offset + 4, 0, true);
    }
  }

  readVectorDouble(index: number): number {
    return this.vectorView.getFloat64(index * 16, true);
  }

  writeVectorDouble(index: number, value: number): void {
    const offset = index * 16;
    this.vectorView.setFloat64(offset, value, true);
    this.vectorView.setBigUint64(offset + 8, 0n, true);
  }

  readVectorSingle(index: number): number {
    return this.vectorView.getFloat32(index * 16, true);
  }

  writeVectorSingle(index: number, value: number): void {
    const offset = index * 16;
    this.vectorView.setFloat32(offset, value, true);
    this.vectorView.setUint32(offset + 4, 0, true);
    this.vectorView.setBigUint64(offset + 8, 0n, true);
  }

  /** Copy 16 bytes in or out of a vector register (LD/ST Q). */
  readVector128(index: number): Uint8Array {
    return this.vectorBytes.slice(index * 16, index * 16 + 16);
  }

  writeVector128(index: number, bytes: Uint8Array): void {
    if (bytes.length !== 16) throw new Arm64Error("internal_error", "vector write needs 16 bytes");
    this.vectorBytes.set(bytes, index * 16);
  }

  step(memory: Arm64Memory, syscall: SyscallHandler): void {
    if (this.halted) return;
    const instructionAddress = this.pc;
    const instruction = Number(memory.read(this.pc, 4) & MASK32);
    this.onInstruction?.(this.pc, instruction, this);
    this.pc = (this.pc + 4n) & MASK64;
    this.instructions += 1;
    this.execute(instruction, instructionAddress, memory, syscall);
  }

  private execute(
    instruction: number,
    address: bigint,
    memory: Arm64Memory,
    syscall: SyscallHandler,
  ): void {
    // NOP and hint space (including PAC/AUT no-ops for this prototype).
    if (instruction === 0xd503201f || matches(instruction, 0xfff8f01f, 0xd503301f)) return;
    if (matches(instruction, 0xfffff01f, 0xd503201f)) return;

    // Branch, exception, and system instructions.
    if (matches(instruction, 0x7c000000, 0x14000000)) {
      const link = (instruction & 0x80000000) !== 0;
      const offset = signExtend(BigInt(instruction & 0x03ffffff), 26) << 2n;
      if (link) this.writeRegister(30, this.pc);
      this.pc = (address + offset) & MASK64;
      return;
    }
    if (matches(instruction, 0xff000010, 0x54000000)) {
      const condition = instruction & 0xf;
      const offset = signExtend(BigInt((instruction >>> 5) & 0x7ffff), 19) << 2n;
      if (this.conditionHolds(condition)) this.pc = (address + offset) & MASK64;
      return;
    }
    if (matches(instruction, 0x7e000000, 0x34000000)) {
      const sf = (instruction & 0x80000000) !== 0;
      const notZero = (instruction & 0x01000000) !== 0;
      const rt = instruction & 0x1f;
      const value = this.readRegister(rt);
      const zero = sf ? value === 0n : (value & MASK32) === 0n;
      const offset = signExtend(BigInt((instruction >>> 5) & 0x7ffff), 19) << 2n;
      if (zero !== notZero) this.pc = (address + offset) & MASK64;
      return;
    }
    if (matches(instruction, 0x7e000000, 0x36000000)) {
      const bit = ((instruction >>> 19) & 0x1f) | ((instruction & 0x80000000) !== 0 ? 0x20 : 0);
      const notZero = (instruction & 0x01000000) !== 0;
      const rt = instruction & 0x1f;
      const value = this.readRegister(rt);
      const set = ((value >> BigInt(bit)) & 1n) === 1n;
      const offset = signExtend(BigInt((instruction >>> 5) & 0x3fff), 14) << 2n;
      if (set === notZero) this.pc = (address + offset) & MASK64;
      return;
    }
    if (matches(instruction, 0xfffffc1f, 0xd61f0000)) {
      this.pc = this.readRegister((instruction >>> 5) & 0x1f) & ~0x3n;
      return;
    }
    if (matches(instruction, 0xfffffc1f, 0xd63f0000)) {
      const target = this.readRegister((instruction >>> 5) & 0x1f) & ~0x3n;
      this.writeRegister(30, this.pc);
      this.pc = target;
      return;
    }
    if (matches(instruction, 0xfffffc1f, 0xd65f0000)) {
      this.pc = this.readRegister((instruction >>> 5) & 0x1f) & ~0x3n;
      if (this.pc === 0n) {
        // The compat entry ABI starts at `main` with LR = 0, so returning
        // from the entry point exits with x0, like `exit(main(...))`.
        this.halted = true;
        this.exitStatus = Number(BigInt.asIntN(32, this.readRegister(0))) & 0xff;
      }
      return;
    }
    if (matches(instruction, 0xffe0001f, 0xd4000001)) {
      const number = Number(BigInt.asIntN(64, this.readRegister(16)));
      const result = syscall(number, this);
      this.writeRegister(0, BigInt(result.value));
      this.setFlag("c", result.error === true);
      if (result.halt) this.halted = true;
      return;
    }
    if (
      matches(instruction, 0xffe0001f, 0xd4200000) ||
      matches(instruction, 0xffe0001f, 0xd4400000)
    ) {
      throw new Arm64Error(
        "breakpoint",
        `BRK/HLT at 0x${address.toString(16)} (imm 0x${((instruction >>> 5) & 0xffff).toString(16)})`,
        { pc: address.toString(16) },
      );
    }

    // Barriers are no-ops for a single-threaded interpreter.
    if (matches(instruction, 0xfffff09f, 0xd503309f)) return;

    // Thread pointer and condition flags.
    if (matches(instruction, 0xffffffe0, 0xd53bd040)) {
      this.writeRegister(instruction & 0x1f, this.tpidr);
      return;
    }
    if (matches(instruction, 0xffffffe0, 0xd51bd040)) {
      this.tpidr = this.readRegister(instruction & 0x1f);
      return;
    }
    if (matches(instruction, 0xffffffe0, 0xd53b4200)) {
      this.writeRegister(instruction & 0x1f, BigInt(this.nzcv));
      return;
    }
    if (matches(instruction, 0xffffffe0, 0xd51b4200)) {
      this.nzcv = Number(this.readRegister(instruction & 0x1f)) & 0xf;
      return;
    }

    // Vector zeroing and 128-bit register copies emitted by clang for
    // aggregate initialisation (`movi v.2d, #0`, `mov v.16b, v.16b`).
    if (matches(instruction, 0xffffffe0, 0x6f00e400)) {
      this.writeVector128(instruction & 0x1f, new Uint8Array(16));
      return;
    }
    if (matches(instruction, 0xbfe0fc00, 0x0ea01c00)) {
      this.writeVector128(instruction & 0x1f, this.readVector128((instruction >>> 16) & 0x1f));
      return;
    }

    // Scalar floating point, moves between register files, and conversions.
    const topByte = instruction >>> 24;
    if (topByte === 0x1e || topByte === 0x9e) {
      this.executeFp(instruction, address);
      return;
    }

    // Atomic memory operations. Single-threaded, so exclusives always succeed.
    if (matches(instruction, 0x3f600c00, 0x08400c00)) {
      this.executeExclusiveLoad(instruction, memory);
      return;
    }
    if (matches(instruction, 0x3f600c00, 0x08000c00)) {
      this.executeExclusiveStore(instruction, memory);
      return;
    }
    if (matches(instruction, 0x3fa07c00, 0x08a07c00)) {
      this.executeCompareAndSwap(instruction, memory);
      return;
    }
    if (matches(instruction, 0x3f200800, 0x38200000)) {
      this.executeAtomicMemory(instruction, memory);
      return;
    }

    // PC-relative addressing.
    if ((instruction & 0x1f000000) === 0x10000000) {
      const page = (instruction & 0x80000000) !== 0;
      const immlo = (instruction >>> 29) & 0x3;
      const immhi = (instruction >>> 5) & 0x7ffff;
      let immediate = signExtend(BigInt((immhi << 2) | immlo), 21);
      if (page) immediate <<= 12n;
      const base = page ? (this.pc - 4n) & ~0xfffn : this.pc - 4n;
      this.writeRegister(instruction & 0x1f, base + immediate);
      return;
    }

    // Add/subtract immediate.
    if ((instruction & 0x1f000000) === 0x11000000) {
      const sf = (instruction & 0x80000000) !== 0;
      const subtract = (instruction & 0x40000000) !== 0;
      const setFlags = (instruction & 0x20000000) !== 0;
      const shift = (instruction & 0x00400000) !== 0;
      const imm = BigInt((instruction >>> 10) & 0xfff) << (shift ? 12n : 0n);
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const operand = this.readRegisterOrSp(rn);
      const result = subtract ? operand - imm : operand + imm;
      if (setFlags) {
        this.setArithmeticFlags(operand, imm, result, sf, subtract);
        if (rd !== 31) this.writeRegister(rd, sf ? result : result & MASK32);
      } else if (rd === 31) {
        this.sp = sf ? result & MASK64 : result & MASK32;
      } else {
        this.writeRegister(rd, sf ? result & MASK64 : result & MASK32);
      }
      return;
    }

    // Logical immediate.
    if ((instruction & 0x1f800000) === 0x12000000) {
      const sf = (instruction & 0x80000000) !== 0;
      const opc = (instruction >>> 29) & 0x3;
      const n = (instruction & 0x00400000) !== 0;
      const immr = (instruction >>> 16) & 0x3f;
      const imms = (instruction >>> 10) & 0x3f;
      const mask = decodeLogicalImmediate(n, immr, imms, sf ? 64 : 32);
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const value = this.readRegister(rn);
      let result: bigint;
      if (opc === 0) result = value & mask;
      else if (opc === 1) result = value | mask;
      else if (opc === 2) result = value ^ mask;
      else result = value & mask;
      if (opc === 3) this.setLogicalFlags(result, sf);
      this.writeRegister(rd, sf ? result : result & MASK32);
      return;
    }

    // Move wide immediate.
    if ((instruction & 0x1f800000) === 0x12800000) {
      const sf = (instruction & 0x80000000) !== 0;
      const opc = (instruction >>> 29) & 0x3;
      const hw = (instruction >>> 21) & 0x3;
      if (!sf && hw > 1) throw this.unsupported(instruction, address);
      const shift = BigInt(hw * 16);
      const imm = BigInt((instruction >>> 5) & 0xffff) << shift;
      const rd = instruction & 0x1f;
      const datasizeMask = sf ? MASK64 : MASK32;
      if (opc === 0) this.writeRegister(rd, ~imm & datasizeMask & datasizeMask);
      else if (opc === 2) this.writeRegister(rd, imm);
      else if (opc === 3) {
        const current = this.readRegister(rd);
        const keepMask = ~(0xffffn << shift) & datasizeMask;
        this.writeRegister(rd, (current & keepMask) | imm);
      } else {
        throw this.unsupported(instruction, address);
      }
      return;
    }

    // Bitfield.
    if ((instruction & 0x1f800000) === 0x13000000) {
      const sf = (instruction & 0x80000000) !== 0;
      const opc = (instruction >>> 29) & 0x3;
      const n = (instruction & 0x00400000) !== 0;
      const immr = (instruction >>> 16) & 0x3f;
      const imms = (instruction >>> 10) & 0x3f;
      const datasize = sf ? 64 : 32;
      if (n !== sf || immr >= datasize || imms >= datasize)
        throw this.unsupported(instruction, address);
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const source = this.readRegister(rn);
      const mask = datasize === 64 ? MASK64 : MASK32;
      let result: bigint;
      if (opc === 0) {
        const rotated = ror(source & mask, BigInt(immr), datasize);
        const width = imms + 1;
        const field = rotated & ((1n << BigInt(width)) - 1n);
        result = BigInt.asUintN(datasize, signExtend(field, width));
      } else if (opc === 2) {
        const rotated = ror(source & mask, BigInt(immr), datasize);
        const width = imms + 1;
        result = rotated & ((1n << BigInt(width)) - 1n);
      } else {
        const width = imms + 1;
        const base = (1n << BigInt(width)) - 1n;
        let replicate = 0n;
        for (let shift = 0; shift < datasize; shift += width) replicate |= base << BigInt(shift);
        const wmask = ror(replicate & mask, BigInt(immr), datasize);
        result =
          (this.readRegister(rd) & ~wmask) | (ror(source & mask, BigInt(immr), datasize) & wmask);
      }
      this.writeRegister(rd, result & mask);
      return;
    }

    // Extract.
    if ((instruction & 0x1f800000) === 0x13800000) {
      const sf = (instruction & 0x80000000) !== 0;
      const n = (instruction & 0x00400000) !== 0;
      if (n !== sf) throw this.unsupported(instruction, address);
      const datasize = sf ? 64 : 32;
      const rm = (instruction >>> 16) & 0x1f;
      const lsb = (instruction >>> 10) & 0x3f;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      if (lsb >= datasize) throw this.unsupported(instruction, address);
      const low = this.readRegister(rn) >> BigInt(lsb);
      const high = this.readRegister(rm) << BigInt(datasize - lsb);
      this.writeRegister(rd, (low | high) & (datasize === 64 ? MASK64 : MASK32));
      return;
    }

    // Conditional compare.
    if ((instruction & 0x1fe00010) === 0x1a400000) {
      const sf = (instruction & 0x80000000) !== 0;
      const subtract = (instruction & 0x40000000) !== 0;
      const rm = (instruction >>> 16) & 0x1f;
      const condition = (instruction >>> 12) & 0xf;
      const rn = (instruction >>> 5) & 0x1f;
      const nzcv = instruction & 0xf;
      if (this.conditionHolds(condition)) {
        const a = this.readRegister(rn);
        const b = this.readRegister(rm);
        const result = subtract ? a - b : a + b;
        this.setArithmeticFlags(a, b, result, sf, subtract);
      } else {
        this.nzcv = nzcv;
      }
      return;
    }

    // Conditional select.
    if ((instruction & 0x1fe00000) === 0x1a800000) {
      const sf = (instruction & 0x80000000) !== 0;
      const invert = (instruction & 0x40000000) !== 0;
      const rm = (instruction >>> 16) & 0x1f;
      const condition = (instruction >>> 12) & 0xf;
      const op2 = (instruction >>> 10) & 0x3;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      let result: bigint;
      if (this.conditionHolds(condition)) {
        result = this.readRegister(rn);
      } else {
        const operand = this.readRegister(rm);
        const mask = sf ? MASK64 : MASK32;
        if (!invert && op2 === 0) result = operand;
        else if (!invert && op2 === 1) result = (operand + 1n) & mask;
        else if (invert && op2 === 0) result = ~operand & mask;
        else result = (~operand + 1n) & mask;
      }
      this.writeRegister(rd, sf ? result & MASK64 : result & MASK32);
      return;
    }

    // Data processing (2 source).
    if ((instruction & 0x1fe00000) === 0x1ac00000) {
      const sf = (instruction & 0x80000000) !== 0;
      const rm = (instruction >>> 16) & 0x1f;
      const opcode = (instruction >>> 10) & 0x3f;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const datasize = sf ? 64 : 32;
      const mask = sf ? MASK64 : MASK32;
      const a = this.readRegister(rn) & mask;
      const b = this.readRegister(rm) & mask;
      let result: bigint;
      if (opcode === 0x02) {
        result = b === 0n ? 0n : a / b;
      } else if (opcode === 0x03) {
        const sa = BigInt.asIntN(datasize, a);
        const sb = BigInt.asIntN(datasize, b);
        if (sb === 0n) result = 0n;
        else if (sa === -(1n << BigInt(datasize - 1)) && sb === -1n) result = sa;
        else result = sa / sb;
      } else if (opcode === 0x08 || opcode === 0x09 || opcode === 0x0a || opcode === 0x0b) {
        const amount = Number(b % BigInt(datasize));
        if (opcode === 0x08) result = a << BigInt(amount);
        else if (opcode === 0x09) result = a >> BigInt(amount);
        else if (opcode === 0x0a) result = BigInt.asIntN(datasize, a) >> BigInt(amount);
        else result = ror(a, BigInt(amount), datasize);
        if (amount !== 0) {
          const carrySource =
            opcode === 0x08 ? a >> BigInt(datasize - amount) : a >> BigInt(amount - 1);
          this.setFlag("c", (carrySource & 1n) === 1n);
        }
        this.setFlag("n", ((result >> BigInt(datasize - 1)) & 1n) === 1n);
        this.setFlag("z", (result & mask) === 0n);
      } else {
        throw this.unsupported(instruction, address);
      }
      this.writeRegister(rd, result & mask);
      return;
    }

    // Data processing (3 source).
    if ((instruction & 0x1f000000) === 0x1b000000) {
      const sf = (instruction & 0x80000000) !== 0;
      const op54 = (instruction >>> 29) & 0x3;
      const op31 = (instruction >>> 21) & 0x7;
      const rm = (instruction >>> 16) & 0x1f;
      const o0 = (instruction & 0x8000) !== 0;
      const ra = (instruction >>> 10) & 0x1f;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const mask = sf ? MASK64 : MASK32;
      const a = this.readRegister(rn);
      const b = this.readRegister(rm);
      const addend = this.readRegister(ra);
      let result: bigint;
      if (op54 === 0 && op31 === 0) {
        result = o0 ? a * b - addend : a * b + addend;
      } else if (op54 === 1 && op31 === 1) {
        const product = BigInt.asIntN(64, BigInt.asIntN(32, a) * BigInt.asIntN(32, b));
        result = o0 ? product - BigInt.asIntN(64, addend) : product + BigInt.asIntN(64, addend);
      } else if (op54 === 1 && op31 === 5) {
        const product = BigInt.asUintN(64, BigInt.asUintN(32, a) * BigInt.asUintN(32, b));
        result = o0 ? product - BigInt.asUintN(64, addend) : product + BigInt.asUintN(64, addend);
      } else if (op54 === 1 && op31 === 2) {
        result = (BigInt.asIntN(64, a) * BigInt.asIntN(64, b)) >> 64n;
      } else if (op54 === 1 && op31 === 6) {
        result = (BigInt.asUintN(64, a) * BigInt.asUintN(64, b)) >> 64n;
      } else {
        throw this.unsupported(instruction, address);
      }
      this.writeRegister(rd, result & mask);
      return;
    }

    // Data processing (1 source).
    if ((instruction & 0x5fe00000) === 0x5ac00000) {
      const sf = (instruction & 0x80000000) !== 0;
      const opcode2 = (instruction >>> 16) & 0x1f;
      const opcode = (instruction >>> 10) & 0x3f;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      if (opcode2 !== 0) throw this.unsupported(instruction, address);
      const datasize = sf ? 64 : 32;
      const value = this.readRegister(rn) & (sf ? MASK64 : MASK32);
      let result: bigint;
      if (opcode === 0) {
        result = reverseBits(value, datasize);
      } else if (opcode === 1) {
        result = reverseBytesWithin(value, 2, datasize);
      } else if (opcode === 2) {
        result = sf ? reverseBytesWithin(value, 4, datasize) : reverseBytesWithin(value, 4, 32);
      } else if (opcode === 3) {
        result = reverseBytesWithin(value, sf ? 8 : 4, datasize);
      } else if (opcode === 4) {
        result = BigInt(datasize - bitLength(value));
      } else if (opcode === 5) {
        const signed = BigInt.asIntN(datasize, value);
        result = BigInt(countLeadingSignBits(signed, datasize) - 1);
      } else {
        throw this.unsupported(instruction, address);
      }
      this.writeRegister(rd, result & (sf ? MASK64 : MASK32));
      return;
    }

    // Load/store pair.
    if ((instruction & 0x3a000000) === 0x28000000) {
      this.executePair(instruction, memory);
      return;
    }

    // Load/store register (unsigned immediate).
    if ((instruction & 0x3b000000) === 0x39000000) {
      this.executeUnsignedLoadStore(instruction, memory);
      return;
    }

    // Load/store literal.
    if ((instruction & 0x3b000000) === 0x18000000) {
      const opc = (instruction >>> 30) & 0x3;
      const vector = (instruction & 0x04000000) !== 0;
      const rt = instruction & 0x1f;
      const offset = signExtend(BigInt((instruction >>> 5) & 0x7ffff), 19) << 2n;
      if (!vector && opc === 3) return; // PRFM
      const target = (address + offset) & MASK64;
      if (vector) {
        const scale = opc === 0 ? 4 : opc === 1 ? 8 : opc === 2 ? 16 : 0;
        if (scale === 0) throw this.unsupported(instruction, address);
        this.writeVectorValue(rt, scale, this.readBytes(memory, target, scale));
        return;
      }
      let value = memory.read(target, opc === 0 ? 4 : 8);
      if (opc === 2) value = BigInt.asUintN(64, signExtend(value, 32));
      this.writeRegister(rt, value);
      return;
    }

    // Load/store register (unscaled/pre/post or register offset).
    if ((instruction & 0x3b200000) === 0x38000000 || (instruction & 0x3b200c00) === 0x38200800) {
      this.executeScaledLoadStore(instruction, memory);
      return;
    }

    // Add/subtract shifted/extended register.
    if ((instruction & 0x1f200000) === 0x0b000000 || (instruction & 0x1f200000) === 0x0b200000) {
      const extended = (instruction & 0x00200000) !== 0;
      const sf = (instruction & 0x80000000) !== 0;
      const subtract = (instruction & 0x40000000) !== 0;
      const setFlags = (instruction & 0x20000000) !== 0;
      const rm = (instruction >>> 16) & 0x1f;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const datasize = sf ? 64 : 32;
      const mask = sf ? MASK64 : MASK32;
      const a = this.readRegisterOrSp(rn);
      let b: bigint;
      if (extended) {
        const option = (instruction >>> 13) & 0x7;
        const shift = (instruction >>> 10) & 0x7;
        b = extendRegister(this.readRegister(rm), option, shift, datasize);
      } else {
        const shiftType = (instruction >>> 22) & 0x3;
        const amount = (instruction >>> 10) & 0x3f;
        b = shiftRegister(this.readRegister(rm), shiftType, BigInt(amount), datasize);
      }
      const result = subtract ? a - (b & mask) : a + (b & mask);
      if (setFlags) {
        this.setArithmeticFlags(a & mask, b & mask, result, sf, subtract);
        if (rd !== 31) this.writeRegister(rd, result & mask);
      } else if (!extended && rd === 31) {
        this.sp = result & mask;
      } else {
        this.writeRegister(rd, result & mask);
      }
      return;
    }

    // Logical shifted register.
    if ((instruction & 0x1f000000) === 0x0a000000) {
      const sf = (instruction & 0x80000000) !== 0;
      const opc = (instruction >>> 29) & 0x3;
      const shiftType = (instruction >>> 22) & 0x3;
      const invert = (instruction & 0x00200000) !== 0;
      const rm = (instruction >>> 16) & 0x1f;
      const amount = (instruction >>> 10) & 0x3f;
      const rn = (instruction >>> 5) & 0x1f;
      const rd = instruction & 0x1f;
      const datasize = sf ? 64 : 32;
      if (!sf && amount >= 32) throw this.unsupported(instruction, address);
      const a = this.readRegister(rn);
      let b = shiftRegister(this.readRegister(rm), shiftType, BigInt(amount), datasize);
      if (invert) b = ~b;
      let result: bigint;
      if (opc === 0) result = a & b;
      else if (opc === 1) result = a | b;
      else if (opc === 2) result = a ^ b;
      else result = a & b;
      if (opc === 3) this.setLogicalFlags(result, sf);
      this.writeRegister(rd, result & (sf ? MASK64 : MASK32));
      return;
    }

    throw this.unsupported(instruction, address);
  }

  /**
   * Scalar floating point: arithmetic, comparisons, selects, moves between
   * register files, conversions, and immediate moves.
   *
   * Encodings are the ARMv8 scalar subset, cross-checked against Apple clang
   * output (see `cpu.test.ts`). Anything outside the subset throws.
   */
  private executeFp(instruction: number, address: bigint): void {
    const double = (instruction & 0x00400000) !== 0;
    const rd = instruction & 0x1f;
    const rn = (instruction >>> 5) & 0x1f;
    const rm = (instruction >>> 16) & 0x1f;
    const read = (index: number): number =>
      double ? this.readVectorDouble(index) : this.readVectorSingle(index);
    const write = (index: number, value: number): void => {
      if (double) this.writeVectorDouble(index, value);
      else this.writeVectorSingle(index, Math.fround(value));
    };

    // Two-source arithmetic.
    const twoSource = (instruction & 0xff20fc00) >>> 0;
    let arithmetic: ((a: number, b: number) => number) | null = null;
    switch (twoSource) {
      case 0x1e200800:
        arithmetic = (a, b) => a * b;
        break;
      case 0x1e201800:
        arithmetic = (a, b) => a / b;
        break;
      case 0x1e202800:
        arithmetic = (a, b) => a + b;
        break;
      case 0x1e203800:
        arithmetic = (a, b) => a - b;
        break;
      case 0x1e204800:
        arithmetic = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? a + b : Math.max(a, b));
        break;
      case 0x1e205800:
        arithmetic = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? a + b : Math.min(a, b));
        break;
      case 0x1e206800:
        arithmetic = (a, b) => a + b;
        break;
      case 0x1e207800:
        arithmetic = (a, b) => a + b;
        break;
      default:
        break;
    }
    if (arithmetic) {
      write(rd, arithmetic(read(rn), read(rm)));
      return;
    }

    // Conditional select.
    if ((instruction & 0xff200c00) === 0x1e200c00) {
      const condition = (instruction >>> 12) & 0xf;
      write(rd, this.conditionHolds(condition) ? read(rn) : read(rm));
      return;
    }

    // Comparisons: register and zero forms, quiet and signalling.
    const compare = (instruction & 0xff20fc00) >>> 0;
    if (
      compare === 0x1e202000 ||
      compare === 0x1e202010 ||
      compare === 0x1e202008 ||
      compare === 0x1e202018
    ) {
      const isDouble = (instruction & 0x00400000) !== 0;
      const zeroForm = (instruction & 0x8) !== 0;
      const left = isDouble ? this.readVectorDouble(rn) : this.readVectorSingle(rn);
      const right = zeroForm ? 0 : isDouble ? this.readVectorDouble(rm) : this.readVectorSingle(rm);
      this.setFpCompareFlags(left, right);
      return;
    }

    // One-source operations.
    const oneSource = (instruction & 0xfffffc00) >>> 0;
    if (oneSource === 0x1e204000 || oneSource === 0x1e604000) {
      write(rd, read(rn));
      return;
    }
    if (oneSource === 0x1e20c000 || oneSource === 0x1e60c000) {
      write(rd, Math.abs(read(rn)));
      return;
    }
    if (oneSource === 0x1e214000 || oneSource === 0x1e614000) {
      write(rd, -read(rn));
      return;
    }
    if (oneSource === 0x1e21c000 || oneSource === 0x1e61c000) {
      write(rd, Math.sqrt(read(rn)));
      return;
    }
    if (oneSource === 0x1e22c000) {
      // FCVT Dd, Sn
      this.writeVectorDouble(rd, this.readVectorSingle(rn));
      return;
    }
    if (oneSource === 0x1e624000) {
      // FCVT Sd, Dn
      this.writeVectorSingle(rd, this.readVectorDouble(rn));
      return;
    }

    // Moves between the general-purpose and floating-point register files.
    if (oneSource === 0x1e260000) {
      this.writeRegister(rd, this.readVectorBits(rn, 32));
      return;
    }
    if (oneSource === 0x1e270000) {
      this.writeVectorBits(rd, 32, this.readRegister(rn));
      return;
    }
    if (oneSource === 0x9e660000) {
      this.writeRegister(rd, this.readVectorBits(rn, 64));
      return;
    }
    if (oneSource === 0x9e670000) {
      this.writeVectorBits(rd, 64, this.readRegister(rn));
      return;
    }

    // FMOV (scalar, immediate). VFPExpandImm, ARMv8 §C3.2.4.
    if (matches(instruction, 0xff801fe0, 0x1e001000)) {
      const bits = (instruction & 0x00400000) !== 0 ? 64 : 32;
      const imm8 = (instruction >>> 13) & 0xff;
      const sign = (imm8 >>> 7) & 1;
      const b = (imm8 >>> 6) & 1;
      const lowExp = (imm8 >>> 4) & 0x3;
      const exponentWidth = bits === 64 ? 11 : 8;
      const repeatWidth = bits === 64 ? 8 : 5;
      const exponent =
        ((b ? 0 : 1) << (exponentWidth - 1)) | (b ? ((1 << repeatWidth) - 1) << 2 : 0) | lowExp;
      const fraction = BigInt(imm8 & 0xf) << BigInt(bits === 64 ? 48 : 19);
      const raw =
        (BigInt(sign) << BigInt(bits - 1)) |
        (BigInt(exponent) << BigInt(bits - 1 - exponentWidth)) |
        fraction;
      this.writeVectorBits(rd, bits, raw);
      return;
    }

    // Integer <-> floating-point conversions.
    for (const conversion of FP_CONVERSIONS) {
      if ((instruction & 0xfffffc00) >>> 0 !== conversion.base) continue;
      const integerBits = conversion.sf ? 64 : 32;
      const rawInteger = conversion.sf ? this.readRegister(rn) : this.readRegister(rn) & MASK32;
      const integer =
        conversion.kind === "ucvtf"
          ? Number(rawInteger)
          : Number(BigInt.asIntN(integerBits, rawInteger));
      const source = conversion.double ? this.readVectorDouble(rn) : this.readVectorSingle(rn);
      if (conversion.kind === "scvtf" || conversion.kind === "ucvtf") {
        write(rd, integer);
      } else {
        const truncated = saturatingTruncate(source, integerBits);
        this.writeRegister(rd, truncated);
      }
      return;
    }

    throw this.unsupported(instruction, address);
  }

  private setFpCompareFlags(left: number, right: number): void {
    if (Number.isNaN(left) || Number.isNaN(right)) {
      // Unordered: N=0, Z=0, C=1, V=1.
      this.nzcv = 0b0011;
    } else if (left === right) {
      this.nzcv = 0b0110;
    } else if (left < right) {
      this.nzcv = 0b1000;
    } else {
      this.nzcv = 0b0010;
    }
  }

  private executeExclusiveLoad(instruction: number, memory: Arm64Memory): void {
    const size = 1 << ((instruction >>> 30) & 0x3);
    const rt = instruction & 0x1f;
    const rn = (instruction >>> 5) & 0x1f;
    const address = this.readRegister(rn);
    const acquireOnly = (instruction & 0x00800000) !== 0;
    if (!acquireOnly) this.exclusiveAddress = address;
    this.writeRegister(rt, memory.read(address, size));
  }

  private executeExclusiveStore(instruction: number, memory: Arm64Memory): void {
    const size = 1 << ((instruction >>> 30) & 0x3);
    const rs = (instruction >>> 16) & 0x1f;
    const rt = instruction & 0x1f;
    const rn = (instruction >>> 5) & 0x1f;
    const address = this.readRegister(rn);
    const releaseOnly = (instruction & 0x00800000) !== 0;
    if (releaseOnly) {
      memory.write(address, size, this.readRegister(rt));
      return;
    }
    const success = this.exclusiveAddress === address;
    if (success) memory.write(address, size, this.readRegister(rt));
    this.exclusiveAddress = null;
    this.writeRegister(rs, success ? 0n : 1n);
  }

  private executeCompareAndSwap(instruction: number, memory: Arm64Memory): void {
    const size = 1 << ((instruction >>> 30) & 0x3);
    const rs = (instruction >>> 16) & 0x1f;
    const rt = instruction & 0x1f;
    const rn = (instruction >>> 5) & 0x1f;
    const address = this.readRegister(rn);
    const mask = size === 8 ? MASK64 : (1n << BigInt(size * 8)) - 1n;
    const old = memory.read(address, size);
    if (old === (this.readRegister(rs) & mask)) {
      memory.write(address, size, this.readRegister(rt));
    }
    this.writeRegister(rs, old);
  }

  private executeAtomicMemory(instruction: number, memory: Arm64Memory): void {
    const size = 1 << ((instruction >>> 30) & 0x3);
    const rs = (instruction >>> 16) & 0x1f;
    const rt = instruction & 0x1f;
    const rn = (instruction >>> 5) & 0x1f;
    const operation = (instruction >>> 12) & 0xf;
    const mask = size === 8 ? MASK64 : (1n << BigInt(size * 8)) - 1n;
    const address = this.readRegister(rn);
    const old = memory.read(address, size);
    const operand = this.readRegister(rs) & mask;
    let next: bigint;
    switch (operation) {
      case 0:
        next = (old + operand) & mask;
        break;
      case 1:
        next = old & ~operand & mask;
        break;
      case 2:
        next = old ^ operand;
        break;
      case 3:
        next = old | operand;
        break;
      case 8:
        next = operand;
        break;
      default:
        throw this.unsupported(instruction, this.pc - 4n);
    }
    memory.write(address, size, next);
    this.writeRegister(rt, old);
  }

  private executePair(instruction: number, memory: Arm64Memory): void {
    const opc = (instruction >>> 30) & 0x3;
    const vector = (instruction & 0x04000000) !== 0;
    const mode = (instruction >>> 23) & 0x3;
    const load = (instruction & 0x00400000) !== 0;
    const rn = (instruction >>> 5) & 0x1f;
    const rt = instruction & 0x1f;
    const rt2 = (instruction >>> 10) & 0x1f;
    const scale = vector
      ? opc === 0
        ? 4
        : opc === 1
          ? 8
          : opc === 2
            ? 16
            : 0
      : opc === 2
        ? 8
        : opc === 0 || opc === 1
          ? 4
          : 0;
    if (scale === 0) throw this.unsupported(instruction, this.pc - 4n);
    const offset = signExtend(BigInt((instruction >>> 15) & 0x7f), 7) * BigInt(scale);
    const base = this.readRegisterOrSp(rn);
    const address = (base + (mode === 1 ? 0n : offset)) & MASK64;
    if (load) {
      if (vector) {
        this.writeVectorValue(rt, scale, this.readBytes(memory, address, scale));
        this.writeVectorValue(
          rt2,
          scale,
          this.readBytes(memory, (address + BigInt(scale)) & MASK64, scale),
        );
      } else {
        const first = memory.read(address, scale);
        const second = memory.read((address + BigInt(scale)) & MASK64, scale);
        this.writeRegister(rt, opc === 1 ? BigInt.asUintN(64, signExtend(first, 32)) : first);
        this.writeRegister(rt2, opc === 1 ? BigInt.asUintN(64, signExtend(second, 32)) : second);
      }
    } else if (vector) {
      this.writeBytes(memory, address, scale, this.readVectorValue(rt, scale));
      this.writeBytes(
        memory,
        (address + BigInt(scale)) & MASK64,
        scale,
        this.readVectorValue(rt2, scale),
      );
    } else {
      memory.write(address, scale, this.readRegister(rt));
      memory.write((address + BigInt(scale)) & MASK64, scale, this.readRegister(rt2));
    }
    if (mode === 1 || mode === 3) this.writeRegisterOrSp(rn, (base + offset) & MASK64);
  }

  private executeUnsignedLoadStore(instruction: number, memory: Arm64Memory): void {
    const size = (instruction >>> 30) & 0x3;
    const vector = (instruction & 0x04000000) !== 0;
    const opc = (instruction >>> 22) & 0x3;
    const scale = size === 0 ? (opc >= 2 ? 16 : 1) : 1 << size;
    const rn = (instruction >>> 5) & 0x1f;
    const rt = instruction & 0x1f;
    const offset = BigInt((instruction >>> 10) & 0xfff) << BigInt(size);
    const address = (this.readRegisterOrSp(rn) + offset) & MASK64;
    if (vector) {
      if (size === 0 && opc < 2) throw this.unsupported(instruction, this.pc - 4n);
      const load = opc === 1 || opc === 3;
      if (!load && opc !== 0 && opc !== 2) throw this.unsupported(instruction, this.pc - 4n);
      this.doVectorLoadStore(instruction, memory, address, scale, load, rt);
      return;
    }
    this.doLoadStore(instruction, memory, address, size, opc, rt);
  }

  private executeScaledLoadStore(instruction: number, memory: Arm64Memory): void {
    const size = (instruction >>> 30) & 0x3;
    const vector = (instruction & 0x04000000) !== 0;
    const opc = (instruction >>> 22) & 0x3;
    const scale = size === 0 ? (opc >= 2 ? 16 : 1) : 1 << size;
    const rn = (instruction >>> 5) & 0x1f;
    const rt = instruction & 0x1f;
    const registerOffset = (instruction & 0x00200000) !== 0;
    let address: bigint;
    let writeback: bigint | null = null;
    if (registerOffset) {
      const rm = (instruction >>> 16) & 0x1f;
      const option = (instruction >>> 13) & 0x7;
      const scaled = (instruction & 0x1000) !== 0;
      const amount = scaled ? (scale === 16 ? 4 : size) : 0;
      const offset = extendRegister(this.readRegister(rm), option, amount, 64);
      address = (this.readRegisterOrSp(rn) + offset) & MASK64;
    } else {
      const mode = (instruction >>> 10) & 0x3;
      if (mode === 2) throw this.unsupported(instruction, this.pc - 4n); // unprivileged
      const offset = signExtend(BigInt((instruction >>> 12) & 0x1ff), 9);
      const base = this.readRegisterOrSp(rn);
      address = (base + (mode === 1 ? 0n : offset)) & MASK64;
      if (mode === 1 || mode === 3) writeback = (base + offset) & MASK64;
    }
    if (vector) {
      if (size === 0 && opc < 2) throw this.unsupported(instruction, this.pc - 4n);
      this.doVectorLoadStore(instruction, memory, address, scale, opc === 1 || opc === 3, rt);
    } else {
      this.doLoadStore(instruction, memory, address, size, opc, rt);
    }
    if (writeback !== null) this.writeRegisterOrSp(rn, writeback);
  }

  private doVectorLoadStore(
    instruction: number,
    memory: Arm64Memory,
    address: bigint,
    scale: number,
    load: boolean,
    rt: number,
  ): void {
    if (load) this.writeVectorValue(rt, scale, this.readBytes(memory, address, scale));
    else this.writeBytes(memory, address, scale, this.readVectorValue(rt, scale));
  }

  private readVectorValue(index: number, scale: number): Uint8Array {
    if (scale === 16) return this.readVector128(index);
    const bytes = new Uint8Array(scale);
    const bits = this.readVectorBits(index, (scale * 8) as 32 | 64);
    for (let byte = 0; byte < scale; byte += 1) {
      bytes[byte] = Number((bits >> BigInt(byte * 8)) & 0xffn);
    }
    return bytes;
  }

  private writeVectorValue(index: number, scale: number, bytes: Uint8Array): void {
    if (scale === 16) {
      this.writeVector128(index, bytes);
      return;
    }
    let bits = 0n;
    for (let byte = 0; byte < scale; byte += 1) {
      bits |= BigInt(bytes[byte] ?? 0) << BigInt(byte * 8);
    }
    this.writeVectorBits(index, (scale * 8) as 32 | 64, bits);
  }

  private readBytes(memory: Arm64Memory, address: bigint, size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 8) {
      const chunk = Math.min(8, size - offset);
      const value = memory.read(address + BigInt(offset), chunk);
      for (let byte = 0; byte < chunk; byte += 1) {
        bytes[offset + byte] = Number((value >> BigInt(byte * 8)) & 0xffn);
      }
    }
    return bytes;
  }

  private writeBytes(memory: Arm64Memory, address: bigint, size: number, bytes: Uint8Array): void {
    for (let offset = 0; offset < size; offset += 8) {
      const chunk = Math.min(8, size - offset);
      let value = 0n;
      for (let byte = 0; byte < chunk; byte += 1) {
        value |= BigInt(bytes[offset + byte] ?? 0) << BigInt(byte * 8);
      }
      memory.write(address + BigInt(offset), chunk, value);
    }
  }

  private doLoadStore(
    instruction: number,
    memory: Arm64Memory,
    address: bigint,
    size: number,
    opc: number,
    rt: number,
  ): void {
    if (opc === 2 && size === 3) return; // PRFM
    if (opc === 0) {
      memory.write(address, 1 << size, this.readRegister(rt));
      return;
    }
    let value = memory.read(address, 1 << size);
    if (opc === 1) {
      if (size < 3) value = value & ((1n << BigInt(8 << size)) - 1n);
    } else if (opc === 2) {
      value =
        size === 2
          ? BigInt.asUintN(64, signExtend(value, 32))
          : BigInt.asUintN(32, signExtend(value, 8 << size));
    } else {
      value = BigInt.asUintN(64, signExtend(value, 8 << size));
    }
    this.writeRegister(rt, value);
  }

  private readRegisterOrSp(index: number): bigint {
    return index === 31 ? this.sp : this.readRegister(index);
  }

  private writeRegisterOrSp(index: number, value: bigint): void {
    const masked = value & MASK64;
    if (index === 31) this.sp = masked;
    else this.writeRegister(index, masked);
  }

  private setArithmeticFlags(
    a: bigint,
    b: bigint,
    result: bigint,
    sf: boolean,
    subtract: boolean,
  ): void {
    const bits = sf ? 64 : 32;
    const mask = sf ? MASK64 : MASK32;
    const sign = 1n << BigInt(bits - 1);
    const left = a & mask;
    const right = b & mask;
    const value = result & mask;
    const n = (value & sign) !== 0n;
    const z = value === 0n;
    let c: boolean;
    let v: boolean;
    if (subtract) {
      c = left >= right;
      v = ((left ^ right) & (left ^ value) & sign) !== 0n;
    } else {
      c = left + right > mask;
      v = ((left ^ value) & (right ^ value) & sign) !== 0n;
    }
    this.nzcv = (n ? 8 : 0) | (z ? 4 : 0) | (c ? 2 : 0) | (v ? 1 : 0);
  }

  private setLogicalFlags(result: bigint, sf: boolean): void {
    const bits = sf ? 64 : 32;
    const value = result & (sf ? MASK64 : MASK32);
    const n = ((value >> BigInt(bits - 1)) & 1n) === 1n;
    const z = value === 0n;
    this.nzcv = (n ? 8 : 0) | (z ? 4 : 0);
  }

  private setFlag(flag: "n" | "z" | "c" | "v", value: boolean): void {
    const bits = flag === "n" ? 3 : flag === "z" ? 2 : flag === "c" ? 1 : 0;
    if (value) this.nzcv |= 1 << bits;
    else this.nzcv &= ~(1 << bits);
  }

  private conditionHolds(condition: number): boolean {
    const n = (this.nzcv & 8) !== 0;
    const z = (this.nzcv & 4) !== 0;
    const c = (this.nzcv & 2) !== 0;
    const v = (this.nzcv & 1) !== 0;
    switch (condition) {
      case 0:
        return z;
      case 1:
        return !z;
      case 2:
        return c;
      case 3:
        return !c;
      case 4:
        return n;
      case 5:
        return !n;
      case 6:
        return v;
      case 7:
        return !v;
      case 8:
        return c && !z;
      case 9:
        return !c || z;
      case 10:
        return n === v;
      case 11:
        return n !== v;
      case 12:
        return !z && n === v;
      case 13:
        return z || n !== v;
      case 14:
        return true;
      default:
        return false;
    }
  }

  private unsupported(instruction: number, address: bigint): Arm64Error {
    return new Arm64Error(
      "unsupported_instruction",
      `unsupported A64 instruction 0x${instruction.toString(16).padStart(8, "0")} at 0x${address.toString(16)}`,
      { instruction: `0x${instruction.toString(16)}`, pc: address.toString(16) },
    );
  }
}

function matches(instruction: number, mask: number, value: number): boolean {
  return (instruction & mask) >>> 0 === value >>> 0;
}

function signExtend(value: bigint, bits: number): bigint {
  return BigInt.asIntN(bits, value);
}

function ror(value: bigint, amount: bigint, width: number): bigint {
  const bits = BigInt(width);
  const mask = (1n << bits) - 1n;
  const normalized = ((amount % bits) + bits) % bits;
  const masked = value & mask;
  if (normalized === 0n) return masked;
  return ((masked >> normalized) | (masked << (bits - normalized))) & mask;
}

function decodeLogicalImmediate(n: boolean, immr: number, imms: number, datasize: number): bigint {
  const combined = (n ? 0x40 : 0) | (~imms & 0x3f);
  if (combined === 0)
    throw new Arm64Error("invalid_immediate", "logical immediate has no set bits");
  const len = 31 - Math.clz32(combined);
  if (len < 1) throw new Arm64Error("invalid_immediate", "logical immediate length is invalid");
  const levels = (1 << len) - 1;
  const s = imms & levels;
  const r = immr & levels;
  if (s === levels) throw new Arm64Error("invalid_immediate", "logical immediate mask is invalid");
  const esize = 1 << len;
  let element = (1n << BigInt(s + 1)) - 1n;
  element = ror(element, BigInt(r), esize);
  let result = 0n;
  for (let shift = 0; shift < datasize; shift += esize) result |= element << BigInt(shift);
  return result & (datasize === 64 ? MASK64 : MASK32);
}

function shiftRegister(value: bigint, type: number, amount: bigint, width: number): bigint {
  const bits = BigInt(width);
  const mask = (1n << bits) - 1n;
  const unsigned = value & mask;
  if (amount === 0n) return unsigned;
  if (type === 0) return (unsigned << amount) & mask;
  if (type === 1) return unsigned >> amount;
  if (type === 2) return BigInt.asUintN(width, BigInt.asIntN(width, unsigned) >> amount);
  return ror(unsigned, amount, width);
}

function extendRegister(value: bigint, option: number, shift: number, width: number): bigint {
  let result: bigint;
  if (option === 0) result = BigInt.asUintN(8, value);
  else if (option === 1) result = BigInt.asUintN(16, value);
  else if (option === 2) result = BigInt.asUintN(32, value);
  else if (option === 3) result = BigInt.asUintN(64, value);
  else if (option === 4) result = BigInt.asUintN(64, BigInt.asIntN(8, value));
  else if (option === 5) result = BigInt.asUintN(64, BigInt.asIntN(16, value));
  else if (option === 6) result = BigInt.asUintN(64, BigInt.asIntN(32, value));
  else result = value;
  return BigInt.asUintN(width, result << BigInt(shift));
}

function reverseBits(value: bigint, width: number): bigint {
  let result = 0n;
  for (let index = 0; index < width; index += 1) {
    result |= ((value >> BigInt(index)) & 1n) << BigInt(width - 1 - index);
  }
  return result;
}

function reverseBytesWithin(value: bigint, elementBytes: number, width: number): bigint {
  let result = 0n;
  const elementBits = elementBytes * 8;
  const elements = width / elementBits;
  for (let element = 0; element < elements; element += 1) {
    let chunk = (value >> BigInt(element * elementBits)) & ((1n << BigInt(elementBits)) - 1n);
    let reversed = 0n;
    for (let byte = 0; byte < elementBytes; byte += 1) {
      reversed |= ((chunk >> BigInt(byte * 8)) & 0xffn) << BigInt((elementBytes - 1 - byte) * 8);
      chunk &= ~(0xffn << BigInt(byte * 8));
    }
    result |= reversed << BigInt(element * elementBits);
  }
  return result & ((1n << BigInt(width)) - 1n);
}

function bitLength(value: bigint): number {
  if (value === 0n) return 0;
  return value.toString(2).length;
}

/** FCVTZS/FCVTZU saturate like the hardware; NaN converts to zero. */
function saturatingTruncate(value: number, bits: 32 | 64): bigint {
  if (Number.isNaN(value)) return 0n;
  const truncated = Math.trunc(value);
  if (truncated >= 0) {
    const max = bits === 32 ? 0x7fff_ffff : 0x7fff_ffff_ffff_ffff;
    return BigInt(Math.min(truncated, max));
  }
  const min = bits === 32 ? -0x8000_0000 : -0x8000_0000_0000_0000;
  return BigInt(Math.max(truncated, min));
}

function countLeadingSignBits(value: bigint, width: number): number {
  if (value < 0n) value = BigInt.asUintN(width, value);
  let count = 0;
  const signBit = (value >> BigInt(width - 1)) & 1n;
  for (let index = width - 2; index >= 0; index -= 1) {
    if (((value >> BigInt(index)) & 1n) !== signBit) break;
    count += 1;
  }
  return count;
}
