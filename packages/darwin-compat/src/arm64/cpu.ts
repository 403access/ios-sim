/**
 * A small AArch64 user-mode interpreter.
 *
 * This is the execution core of the native research track. It is not a JIT and
 * not a full ARM emulator: it implements the integer subset emitted by simple
 * Darwin user-space programs, with memory access delegated to the dyld VM and
 * `svc #0x80` delegated to the syscall layer.
 *
 * Deliberate omissions (all reported as `unsupported_instruction`):
 * SIMD/FP, pointer authentication enforcement, privileged/system registers,
 * atomics, and 128-bit pair loads/stores. Omissions are visible, never silent.
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

export class Arm64Cpu {
  readonly registers = new BigUint64Array(32);
  sp = 0x7ff0_0000_0000n;
  pc = 0n;
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
    this.pc = entry;
    this.sp = stackPointer;
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
      if (this.pc === 0n) this.halted = true;
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
      const rt = instruction & 0x1f;
      const offset = signExtend(BigInt((instruction >>> 5) & 0x7ffff), 19) << 2n;
      if (opc === 3) return; // PRFM
      const target = (address + offset) & MASK64;
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

  private executePair(instruction: number, memory: Arm64Memory): void {
    const opc = (instruction >>> 30) & 0x3;
    const vector = (instruction & 0x04000000) !== 0;
    const mode = (instruction >>> 23) & 0x3;
    const load = (instruction & 0x00400000) !== 0;
    const rn = (instruction >>> 5) & 0x1f;
    const rt = instruction & 0x1f;
    const rt2 = (instruction >>> 10) & 0x1f;
    if (vector || opc === 3) throw this.unsupported(instruction, this.pc - 4n);
    const scale = opc === 2 ? 8 : 4;
    const offset = signExtend(BigInt((instruction >>> 15) & 0x7f), 7) * BigInt(scale);
    const base = this.readRegisterOrSp(rn);
    const address = (base + (mode === 1 ? 0n : offset)) & MASK64;
    if (load) {
      const first = memory.read(address, scale);
      const second = memory.read((address + BigInt(scale)) & MASK64, scale);
      this.writeRegister(rt, opc === 1 ? BigInt.asUintN(64, signExtend(first, 32)) : first);
      this.writeRegister(rt2, opc === 1 ? BigInt.asUintN(64, signExtend(second, 32)) : second);
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
    if (vector) throw this.unsupported(instruction, this.pc - 4n);
    const scale = 1 << size;
    const rn = (instruction >>> 5) & 0x1f;
    const rt = instruction & 0x1f;
    const offset = BigInt((instruction >>> 10) & 0xfff) << BigInt(size);
    const address = (this.readRegisterOrSp(rn) + offset) & MASK64;
    this.doLoadStore(instruction, memory, address, size, opc, rt);
  }

  private executeScaledLoadStore(instruction: number, memory: Arm64Memory): void {
    const size = (instruction >>> 30) & 0x3;
    const vector = (instruction & 0x04000000) !== 0;
    const opc = (instruction >>> 22) & 0x3;
    if (vector) throw this.unsupported(instruction, this.pc - 4n);
    const rn = (instruction >>> 5) & 0x1f;
    const rt = instruction & 0x1f;
    const registerOffset = (instruction & 0x00200000) !== 0;
    let address: bigint;
    let writeback: bigint | null = null;
    if (registerOffset) {
      const rm = (instruction >>> 16) & 0x1f;
      const option = (instruction >>> 13) & 0x7;
      const scaled = (instruction & 0x1000) !== 0;
      const amount = scaled ? size : 0;
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
    this.doLoadStore(instruction, memory, address, size, opc, rt);
    if (writeback !== null) this.writeRegisterOrSp(rn, writeback);
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
