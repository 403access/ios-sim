/**
 * Small AArch64 disassembler (DX-001).
 *
 * This covers the integer/syscall subset the interpreter executes, which is
 * exactly what the native CLI needs for `inspect --disasm`. Unknown encodings
 * print `.word 0x...` instead of guessing; SIMD/FP is intentionally not
 * decoded.
 */

export interface DisassembledInstruction {
  readonly address: bigint;
  readonly word: number;
  readonly text: string;
}

const REG = (index: number): string => (index === 31 ? "sp" : `x${index}`);
const REG_OR_ZR = (index: number): string => (index === 31 ? "xzr" : `x${index}`);
const WREG = (index: number): string => (index === 31 ? "wsp" : `w${index}`);
const WREG_OR_ZR = (index: number): string => (index === 31 ? "wzr" : `w${index}`);

function matches(word: number, mask: number, value: number): boolean {
  return (word & mask) >>> 0 === value >>> 0;
}

function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

export function disassembleInstruction(word: number, address = 0n): string {
  if (matches(word, 0xffffffff, 0xd503201f)) return "nop";
  if (matches(word, 0xffffffff, 0xd503203f)) return "yield";
  if (matches(word, 0xffffffff, 0xd503207f)) return "wfe";
  if (matches(word, 0xffffffff, 0xd50320bf)) return "wfi";
  if (matches(word, 0xfffffc1f, 0xd65f0000)) {
    const rn = (word >>> 5) & 0x1f;
    return rn === 30 ? "ret" : `ret ${REG(rn)}`;
  }
  if (matches(word, 0xfffffc1f, 0xd61f0000)) return `br ${REG((word >>> 5) & 0x1f)}`;
  if (matches(word, 0xfffffc1f, 0xd63f0000)) return `blr ${REG((word >>> 5) & 0x1f)}`;
  if (matches(word, 0x7c000000, 0x14000000)) {
    const offset = signExtend(word & 0x03ff_ffff, 26) * 4;
    const target = address + BigInt(offset);
    const link = (word & 0x8000_0000) !== 0;
    return `${link ? "bl" : "b"} 0x${target.toString(16)}`;
  }
  if (matches(word, 0xff000010, 0x54000000)) {
    const cond = word & 0xf;
    const names = [
      "eq",
      "ne",
      "cs",
      "cc",
      "mi",
      "pl",
      "vs",
      "vc",
      "hi",
      "ls",
      "ge",
      "lt",
      "gt",
      "le",
      "al",
      "nv",
    ];
    const offset = signExtend((word >>> 5) & 0x7ffff, 19) * 4;
    return `b.${names[cond]} 0x${(address + BigInt(offset)).toString(16)}`;
  }
  if (matches(word, 0x7e000000, 0x34000000)) {
    const sf = (word & 0x8000_0000) !== 0;
    const nonzero = (word & 0x0100_0000) !== 0;
    const rt = word & 0x1f;
    const offset = signExtend((word >>> 5) & 0x7ffff, 19) * 4;
    return `c${nonzero ? "bnz" : "bz"} ${sf ? REG(rt) : WREG(rt)}, 0x${(address + BigInt(offset)).toString(16)}`;
  }
  if (matches(word, 0x7e000000, 0x36000000)) {
    const bit = ((word >>> 31) & 1) * 32 + ((word >>> 19) & 0x1f);
    const nonzero = (word & 0x0100_0000) !== 0;
    const rt = word & 0x1f;
    const offset = signExtend((word >>> 5) & 0x3fff, 14) * 4;
    return `t${nonzero ? "bnz" : "bz"} ${REG(rt)}, #${bit}, 0x${(address + BigInt(offset)).toString(16)}`;
  }
  if (
    matches(word, 0x7f800000, 0x52800000) ||
    matches(word, 0x7f800000, 0x12800000) ||
    matches(word, 0x7f800000, 0x72800000)
  ) {
    const sf = (word & 0x8000_0000) !== 0;
    const opc = (word >>> 29) & 0x3;
    const name = opc === 2 ? "movz" : opc === 0 ? "movn" : opc === 3 ? "movk" : ".word";
    if (name === ".word") return `.word 0x${(word >>> 0).toString(16).padStart(8, "0")}`;
    const rd = word & 0x1f;
    const imm = (word >>> 5) & 0xffff;
    const shift = ((word >>> 21) & 0x3) * 16;
    const suffix = shift === 0 ? "" : `, lsl #${shift}`;
    return `${name} ${sf ? REG_OR_ZR(rd) : WREG_OR_ZR(rd)}, #0x${imm.toString(16)}${suffix}`;
  }
  if (matches(word, 0x1f000000, 0x11000000)) {
    const sf = (word & 0x8000_0000) !== 0;
    const sub = (word & 0x4000_0000) !== 0;
    const flags = (word & 0x2000_0000) !== 0;
    const shift12 = (word & 0x0040_0000) !== 0;
    const imm = (word >>> 10) & 0xfff;
    const rn = (word >>> 5) & 0x1f;
    const rd = word & 0x1f;
    const amount = shift12 ? imm * 4096 : imm;
    if (flags && rd === 31) return `cmp ${sf ? REG(rn) : WREG(rn)}, #${amount}`;
    if (flags && rn === 31) return `cmn ${sf ? REG(rd) : WREG(rd)}, #${amount}`;
    const name = sub ? "sub" : "add";
    const suffix = shift12 ? ", lsl #12" : "";
    return `${name}${flags ? "s" : ""} ${sf ? REG(rd) : WREG(rd)}, ${sf ? REG(rn) : WREG(rn)}, #${amount}${suffix}`;
  }
  if (matches(word, 0x1f200000, 0x0b000000)) {
    const sf = (word & 0x8000_0000) !== 0;
    const sub = (word & 0x4000_0000) !== 0;
    const flags = (word & 0x2000_0000) !== 0;
    const rm = (word >>> 16) & 0x1f;
    const rn = (word >>> 5) & 0x1f;
    const rd = word & 0x1f;
    if (flags && rd === 31) return `cmp ${sf ? REG(rn) : WREG(rn)}, ${sf ? REG(rm) : WREG(rm)}`;
    return `${sub ? "sub" : "add"}${flags ? "s" : ""} ${sf ? REG(rd) : WREG(rd)}, ${sf ? REG(rn) : WREG(rn)}, ${sf ? REG(rm) : WREG(rm)}`;
  }
  if (matches(word, 0x7fe0ffe0, 0xaa0003e0)) {
    const sf = (word & 0x8000_0000) !== 0;
    const rm = (word >>> 16) & 0x1f;
    const rd = word & 0x1f;
    return `mov ${sf ? REG(rd) : WREG(rd)}, ${sf ? REG(rm) : WREG(rm)}`;
  }
  if (matches(word, 0x3b000000, 0x39000000)) {
    const size = (word >>> 30) & 0x3;
    const load = (word & 0x0040_0000) !== 0;
    const rt = word & 0x1f;
    const rn = (word >>> 5) & 0x1f;
    const offset = ((word >>> 10) & 0xfff) * (1 << size);
    const name = load ? "ldr" : "str";
    const reg = size === 0 ? WREG(rt) : REG(rt);
    return `${name} ${reg}, [${REG(rn)}${offset === 0 ? "" : `, #${offset}`}]`;
  }
  if (matches(word, 0x9f000000, 0x90000000)) {
    const rd = word & 0x1f;
    const immlo = (word >>> 29) & 0x3;
    const immhi = (word >>> 5) & 0x7ffff;
    const imm = signExtend((immhi << 2) | immlo, 21) * 4096;
    const page = address & ~0xfffn;
    return `adrp ${REG(rd)}, 0x${(page + BigInt(imm)).toString(16)}`;
  }
  if (matches(word, 0x9f000000, 0x10000000)) {
    const rd = word & 0x1f;
    const immlo = (word >>> 29) & 0x3;
    const immhi = (word >>> 5) & 0x7ffff;
    const imm = signExtend((immhi << 2) | immlo, 21);
    return `adr ${REG(rd)}, 0x${(address + BigInt(imm)).toString(16)}`;
  }
  if (matches(word, 0xffe0001f, 0xd4000001)) {
    return `svc #${(word >>> 5) & 0xffff}`;
  }
  if (matches(word, 0xffe0001f, 0xd4200000)) {
    return `brk #${(word >>> 5) & 0xffff}`;
  }
  if (matches(word, 0xffe0ffe0, 0x1b007c00)) {
    const rm = (word >>> 16) & 0x1f;
    const rn = (word >>> 5) & 0x1f;
    const rd = word & 0x1f;
    return `mul x${rd}, x${rn}, x${rm}`;
  }
  return `.word 0x${(word >>> 0).toString(16).padStart(8, "0")}`;
}

export function disassembleRange(
  bytes: Uint8Array,
  base = 0n,
  maxInstructions = 10_000,
): DisassembledInstruction[] {
  const instructions: DisassembledInstruction[] = [];
  const limit = Math.min(maxInstructions, Math.floor(bytes.length / 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < limit; index += 1) {
    const word = view.getUint32(index * 4, true);
    const address = base + BigInt(index * 4);
    instructions.push({ address, word, text: disassembleInstruction(word, address) });
  }
  return instructions;
}

/** Format disassembly with a stable address column. */
export function formatDisassembly(instructions: readonly DisassembledInstruction[]): string {
  return instructions
    .map(
      (instruction) =>
        `0x${instruction.address.toString(16).padStart(12, "0")}: ${instruction.word.toString(16).padStart(8, "0")}  ${instruction.text}`,
    )
    .join("\n");
}
