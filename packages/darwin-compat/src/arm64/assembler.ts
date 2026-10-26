/**
 * Tiny A64 encoder for fixtures and unit tests.
 *
 * It deliberately covers only the instructions the compatibility layer
 * executes today. Every function returns one 32-bit little-endian instruction
 * word; tests box them with {@link words}.
 */

export type Condition =
  | "eq"
  | "ne"
  | "cs"
  | "cc"
  | "mi"
  | "pl"
  | "vs"
  | "vc"
  | "hi"
  | "ls"
  | "ge"
  | "lt"
  | "gt"
  | "le"
  | "al"
  | "nv";

const CONDITIONS: Record<Condition, number> = {
  eq: 0,
  ne: 1,
  cs: 2,
  cc: 3,
  mi: 4,
  pl: 5,
  vs: 6,
  vc: 7,
  hi: 8,
  ls: 9,
  ge: 10,
  lt: 11,
  gt: 12,
  le: 13,
  al: 14,
  nv: 15,
};

export function words(...instructions: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(instructions.length * 4);
  const view = new DataView(bytes.buffer);
  instructions.forEach((instruction, index) => view.setUint32(index * 4, instruction >>> 0, true));
  return bytes;
}

export function nop(): number {
  return 0xd503201f;
}

export function ret(reg = 30): number {
  return 0xd65f0000 | (reg << 5);
}

export function br(reg: number): number {
  return 0xd61f0000 | (reg << 5);
}

export function blr(reg: number): number {
  return 0xd63f0000 | (reg << 5);
}

/** `stp qN, qM, [Xn, #-offset]!` (128-bit pair, pre-index). */
export function stpQuadPre(rt: number, rt2: number, rn: number, offset: number): number {
  if (offset % 16 !== 0 || offset > 0 || offset < -512)
    throw new Error(`unaligned or out-of-range quad pair pre-index ${offset}`);
  return 0xad000000 | (3 << 23) | (((offset / 16) & 0x7f) << 15) | (rt2 << 10) | (rn << 5) | rt;
}

/** `ldp qN, qM, [Xn], #offset` (128-bit pair, post-index). */
export function ldpQuadPost(rt: number, rt2: number, rn: number, offset: number): number {
  if (offset % 16 !== 0 || offset < 0 || offset > 504)
    throw new Error(`unaligned or out-of-range quad pair post-index ${offset}`);
  return 0xad400000 | (1 << 23) | (((offset / 16) & 0x7f) << 15) | (rt2 << 10) | (rn << 5) | rt;
}

/** `ldr dN, [Xn, #offset]` (scalar double, unsigned immediate). */
export function ldrDouble(rt: number, rn: number, offset: number): number {
  if (offset % 8 !== 0 || offset < 0 || offset > 0x7f8)
    throw new Error(`unaligned or out-of-range double offset ${offset}`);
  return 0xfd400000 | ((offset / 8) << 10) | (rn << 5) | rt;
}

/** `str dN, [Xn, #offset]` (scalar double, unsigned immediate). */
export function strDouble(rt: number, rn: number, offset: number): number {
  if (offset % 8 !== 0 || offset < 0 || offset > 0x7f8)
    throw new Error(`unaligned or out-of-range double offset ${offset}`);
  return 0xfd000000 | ((offset / 8) << 10) | (rn << 5) | rt;
}

/** `ldp dN, dM, [Xn, #offset]`. */
export function ldpDouble(rt: number, rt2: number, rn: number, offset: number): number {
  if (offset % 8 !== 0 || offset < 0 || offset > 0x1f8)
    throw new Error(`unaligned or out-of-range double pair offset ${offset}`);
  return 0x6d400000 | ((offset / 8) << 15) | (rt2 << 10) | (rn << 5) | rt;
}

/** `stp dN, dM, [Xn, #offset]`. */
export function stpDouble(rt: number, rt2: number, rn: number, offset: number): number {
  if (offset % 8 !== 0 || offset < 0 || offset > 0x1f8)
    throw new Error(`unaligned or out-of-range double pair offset ${offset}`);
  return 0x6d000000 | ((offset / 8) << 15) | (rt2 << 10) | (rn << 5) | rt;
}

/** `fmov dN, #imm` for representable immediates. */
export function fmovDoubleImmediate(rd: number, imm8: number): number {
  return 0x1e601000 | ((imm8 & 0xff) << 13) | rd;
}

/** `fadd dN, dM, dK`. */
export function faddDouble(rd: number, rn: number, rm: number): number {
  return 0x1e602800 | (rm << 16) | (rn << 5) | rd;
}

/** `fcmp dN, dM`. */
export function fcmpDouble(rn: number, rm: number): number {
  return 0x1e602000 | (rm << 16) | (rn << 5);
}

/** `offset` is in bytes relative to the current instruction. */
export function b(offset: number): number {
  return 0x14000000 | ((offset >> 2) & 0x03ffffff);
}

export function bl(offset: number): number {
  return 0x94000000 | ((offset >> 2) & 0x03ffffff);
}

export function bCond(condition: Condition, offset: number): number {
  return 0x54000000 | (((offset >> 2) & 0x7ffff) << 5) | CONDITIONS[condition];
}

export function cbz(reg: number, offset: number, sf = true): number {
  return 0x34000000 | (sf ? 0x80000000 : 0) | (((offset >> 2) & 0x7ffff) << 5) | reg;
}

export function cbnz(reg: number, offset: number, sf = true): number {
  return 0x35000000 | (sf ? 0x80000000 : 0) | (((offset >> 2) & 0x7ffff) << 5) | reg;
}

export function tbz(reg: number, bit: number, offset: number): number {
  return (
    0x36000000 | ((bit & 0x20) << 26) | ((bit & 0x1f) << 19) | (((offset >> 2) & 0x3fff) << 5) | reg
  );
}

export function tbnz(reg: number, bit: number, offset: number): number {
  return (
    0x37000000 | ((bit & 0x20) << 26) | ((bit & 0x1f) << 19) | (((offset >> 2) & 0x3fff) << 5) | reg
  );
}

export function svc(imm = 0x80): number {
  return 0xd4000001 | ((imm & 0xffff) << 5);
}

export function brk(imm = 0): number {
  return 0xd4200000 | ((imm & 0xffff) << 5);
}

export function movz(rd: number, imm: number, shift = 0, sf = true): number {
  return (
    0x52800000 | (sf ? 0x80000000 : 0) | (((shift / 16) & 3) << 21) | ((imm & 0xffff) << 5) | rd
  );
}

export function movn(rd: number, imm: number, shift = 0, sf = true): number {
  return (
    0x12800000 | (sf ? 0x80000000 : 0) | (((shift / 16) & 3) << 21) | ((imm & 0xffff) << 5) | rd
  );
}

export function movk(rd: number, imm: number, shift = 0, sf = true): number {
  return (
    0x72800000 | (sf ? 0x80000000 : 0) | (((shift / 16) & 3) << 21) | ((imm & 0xffff) << 5) | rd
  );
}

export function movReg(rd: number, rm: number, sf = true): number {
  return orr(rd, 31, rm, sf);
}

export function addImm(
  rd: number,
  rn: number,
  imm: number,
  options: { sf?: boolean; shift12?: boolean; setFlags?: boolean } = {},
): number {
  return arithmeticImm(false, rd, rn, imm, options);
}

export function subImm(
  rd: number,
  rn: number,
  imm: number,
  options: { sf?: boolean; shift12?: boolean; setFlags?: boolean } = {},
): number {
  return arithmeticImm(true, rd, rn, imm, options);
}

export function cmpImm(rn: number, imm: number, sf = true): number {
  return subImm(31, rn, imm, { sf, setFlags: true });
}

function arithmeticImm(
  sub: boolean,
  rd: number,
  rn: number,
  imm: number,
  options: { sf?: boolean; shift12?: boolean; setFlags?: boolean },
): number {
  const sf = options.sf ?? true;
  return (
    0x11000000 |
    (sf ? 0x80000000 : 0) |
    (sub ? 0x40000000 : 0) |
    (options.setFlags ? 0x20000000 : 0) |
    (options.shift12 ? 0x400000 : 0) |
    ((imm & 0xfff) << 10) |
    (rn << 5) |
    rd
  );
}

export function addReg(
  rd: number,
  rn: number,
  rm: number,
  options: { sf?: boolean; shift?: 0 | 1 | 2 | 3; amount?: number; setFlags?: boolean } = {},
): number {
  return arithmeticReg(false, rd, rn, rm, options);
}

export function subReg(
  rd: number,
  rn: number,
  rm: number,
  options: { sf?: boolean; shift?: 0 | 1 | 2 | 3; amount?: number; setFlags?: boolean } = {},
): number {
  return arithmeticReg(true, rd, rn, rm, options);
}

function arithmeticReg(
  sub: boolean,
  rd: number,
  rn: number,
  rm: number,
  options: { sf?: boolean; shift?: 0 | 1 | 2 | 3; amount?: number; setFlags?: boolean },
): number {
  const sf = options.sf ?? true;
  return (
    0x0b000000 |
    (sf ? 0x80000000 : 0) |
    (sub ? 0x40000000 : 0) |
    (options.setFlags ? 0x20000000 : 0) |
    ((options.shift ?? 0) << 22) |
    (rm << 16) |
    (((options.amount ?? 0) & 0x3f) << 10) |
    (rn << 5) |
    rd
  );
}

export function and(rd: number, rn: number, rm: number, sf = true): number {
  return logicalReg(0, rd, rn, rm, sf);
}

export function orr(rd: number, rn: number, rm: number, sf = true): number {
  return logicalReg(1, rd, rn, rm, sf);
}

export function eor(rd: number, rn: number, rm: number, sf = true): number {
  return logicalReg(2, rd, rn, rm, sf);
}

export function ands(rd: number, rn: number, rm: number, sf = true): number {
  return logicalReg(3, rd, rn, rm, sf);
}

function logicalReg(opc: number, rd: number, rn: number, rm: number, sf: boolean): number {
  return 0x0a000000 | (sf ? 0x80000000 : 0) | (opc << 29) | (rm << 16) | (rn << 5) | rd;
}

export function mul(rd: number, rn: number, rm: number, sf = true): number {
  return madd(rd, rn, rm, 31, sf);
}

export function madd(rd: number, rn: number, rm: number, ra: number, sf = true): number {
  return 0x1b000000 | (sf ? 0x80000000 : 0) | (rm << 16) | (ra << 10) | (rn << 5) | rd;
}

export function msub(rd: number, rn: number, rm: number, ra: number, sf = true): number {
  return madd(rd, rn, rm, ra, sf) | 0x8000;
}

export function udiv(rd: number, rn: number, rm: number, sf = true): number {
  return 0x1ac00800 | (sf ? 0x80000000 : 0) | (rm << 16) | (rn << 5) | rd;
}

export function sdiv(rd: number, rn: number, rm: number, sf = true): number {
  return 0x1ac00c00 | (sf ? 0x80000000 : 0) | (rm << 16) | (rn << 5) | rd;
}

export function lslv(rd: number, rn: number, rm: number, sf = true): number {
  return 0x1ac02000 | (sf ? 0x80000000 : 0) | (rm << 16) | (rn << 5) | rd;
}

export function lsrv(rd: number, rn: number, rm: number, sf = true): number {
  return 0x1ac02400 | (sf ? 0x80000000 : 0) | (rm << 16) | (rn << 5) | rd;
}

export function asrv(rd: number, rn: number, rm: number, sf = true): number {
  return 0x1ac02800 | (sf ? 0x80000000 : 0) | (rm << 16) | (rn << 5) | rd;
}

export function csel(rd: number, rn: number, rm: number, condition: Condition, sf = true): number {
  return (
    0x1a800000 | (sf ? 0x80000000 : 0) | (rm << 16) | (CONDITIONS[condition] << 12) | (rn << 5) | rd
  );
}

export function csinc(rd: number, rn: number, rm: number, condition: Condition, sf = true): number {
  return csel(rd, rn, rm, condition, sf) | 0x400;
}

export function csinv(rd: number, rn: number, rm: number, condition: Condition, sf = true): number {
  return csel(rd, rn, rm, condition, sf) | 0x40000000;
}

export function csneg(rd: number, rn: number, rm: number, condition: Condition, sf = true): number {
  return csel(rd, rn, rm, condition, sf) | 0x40000000 | 0x400;
}

export function cset(rd: number, condition: Condition, sf = true): number {
  return csinc(rd, 31, 31, invertCondition(condition), sf);
}

export function csetm(rd: number, condition: Condition, sf = true): number {
  return csinv(rd, 31, 31, invertCondition(condition), sf);
}

export function lslImm(rd: number, rn: number, shift: number, sf = true): number {
  const width = sf ? 64 : 32;
  return ubfm(rd, rn, (width - shift) % width, width - 1 - shift, sf);
}

export function lsrImm(rd: number, rn: number, shift: number, sf = true): number {
  const width = sf ? 64 : 32;
  return ubfm(rd, rn, shift, width - 1, sf);
}

export function asrImm(rd: number, rn: number, shift: number, sf = true): number {
  const width = sf ? 64 : 32;
  return sbfm(rd, rn, shift, width - 1, sf);
}

export function ubfm(rd: number, rn: number, immr: number, imms: number, sf = true): number {
  // N (bit 22) must equal sf for bitfield instructions.
  return (
    0x53000000 |
    (sf ? 0x80400000 : 0) |
    ((immr & 0x3f) << 16) |
    ((imms & 0x3f) << 10) |
    (rn << 5) |
    rd
  );
}

export function sbfm(rd: number, rn: number, immr: number, imms: number, sf = true): number {
  return ubfm(rd, rn, immr, imms, sf) & ~0x40000000;
}

export function uxtb(rd: number, rn: number, sf = true): number {
  return ubfm(rd, rn, 0, 7, sf);
}

export function uxth(rd: number, rn: number, sf = true): number {
  return ubfm(rd, rn, 0, 15, sf);
}

export function sxtb(rd: number, rn: number, sf = true): number {
  return sbfm(rd, rn, 0, 7, sf);
}

export function sxth(rd: number, rn: number, sf = true): number {
  return sbfm(rd, rn, 0, 15, sf);
}

export function sxtw(rd: number, rn: number): number {
  return sbfm(rd, rn, 0, 31, true);
}

export function adr(rd: number, target: number, pc: number): number {
  return pcRelative(rd, target - pc, false);
}

export function adrp(rd: number, target: number, pc: number): number {
  return pcRelative(rd, target - (pc & ~0xfff), true);
}

function pcRelative(rd: number, delta: number, page: boolean): number {
  const value = page ? delta >> 12 : delta;
  const immlo = value & 3;
  const immhi = (value >> 2) & 0x7ffff;
  return 0x10000000 | (page ? 0x80000000 : 0) | (immlo << 29) | (immhi << 5) | rd;
}

export function strUnsigned(
  rt: number,
  rn: number,
  offset: number,
  size: 0 | 1 | 2 | 3 = 3,
): number {
  return loadStoreUnsigned(false, rt, rn, offset, size);
}

export function ldrUnsigned(
  rt: number,
  rn: number,
  offset: number,
  size: 0 | 1 | 2 | 3 = 3,
  signed = false,
): number {
  return loadStoreUnsigned(true, rt, rn, offset, size, signed);
}

function loadStoreUnsigned(
  load: boolean,
  rt: number,
  rn: number,
  offset: number,
  size: 0 | 1 | 2 | 3,
  signed = false,
): number {
  const scale = 1 << size;
  if (offset % scale !== 0)
    throw new Error(`unaligned load/store offset ${offset} for size ${size}`);
  const opc = load ? (signed ? 2 : 1) : 0;
  return 0x39000000 | (size << 30) | (opc << 22) | ((offset / scale) << 10) | (rn << 5) | rt;
}

export function stur(rt: number, rn: number, offset: number, size: 0 | 1 | 2 | 3 = 3): number {
  return loadStoreUnscaled(false, rt, rn, offset, size);
}

export function ldur(
  rt: number,
  rn: number,
  offset: number,
  size: 0 | 1 | 2 | 3 = 3,
  signed = false,
): number {
  return loadStoreUnscaled(true, rt, rn, offset, size, signed);
}

function loadStoreUnscaled(
  load: boolean,
  rt: number,
  rn: number,
  offset: number,
  size: 0 | 1 | 2 | 3,
  signed = false,
): number {
  const opc = load ? (signed ? 2 : 1) : 0;
  return 0x38000000 | (size << 30) | (opc << 22) | ((offset & 0x1ff) << 12) | (rn << 5) | rt;
}

export function stp(rt: number, rt2: number, rn: number, offset: number, sf = true): number {
  return loadStorePair(false, rt, rt2, rn, offset, sf, "offset");
}

export function ldp(rt: number, rt2: number, rn: number, offset: number, sf = true): number {
  return loadStorePair(true, rt, rt2, rn, offset, sf, "offset");
}

export function stpPre(rt: number, rt2: number, rn: number, offset: number, sf = true): number {
  return loadStorePair(false, rt, rt2, rn, offset, sf, "pre");
}

export function ldpPost(rt: number, rt2: number, rn: number, offset: number, sf = true): number {
  return loadStorePair(true, rt, rt2, rn, offset, sf, "post");
}

function loadStorePair(
  load: boolean,
  rt: number,
  rt2: number,
  rn: number,
  offset: number,
  sf: boolean,
  mode: "offset" | "pre" | "post",
): number {
  const scale = sf ? 8 : 4;
  if (offset % scale !== 0) throw new Error(`unaligned pair offset ${offset}`);
  const modeBits = mode === "post" ? 1 : mode === "offset" ? 2 : 3;
  return (
    0x28000000 |
    ((sf ? 2 : 0) << 30) |
    (modeBits << 23) |
    (load ? 0x400000 : 0) |
    (((offset / scale) & 0x7f) << 15) |
    (rt2 << 10) |
    (rn << 5) |
    rt
  );
}

export function ldrLiteral(rt: number, offset: number, sf = true): number {
  return 0x18000000 | ((sf ? 1 : 0) << 30) | (((offset >> 2) & 0x7ffff) << 5) | rt;
}

export function rbit(rd: number, rn: number, sf = true): number {
  return 0x5ac00000 | (sf ? 0x80000000 : 0) | (rn << 5) | rd;
}

export function rev(rd: number, rn: number, sf = true): number {
  return 0x5ac00800 | (sf ? 0x80000000 : 0) | (rn << 5) | rd;
}

export function rev16(rd: number, rn: number, sf = true): number {
  return 0x5ac00400 | (sf ? 0x80000000 : 0) | (rn << 5) | rd;
}

export function clz(rd: number, rn: number, sf = true): number {
  return 0x5ac01000 | (sf ? 0x80000000 : 0) | (rn << 5) | rd;
}

export function cls(rd: number, rn: number, sf = true): number {
  return 0x5ac01400 | (sf ? 0x80000000 : 0) | (rn << 5) | rd;
}

export function ccmp(
  rn: number,
  rm: number,
  nzcv: number,
  condition: Condition,
  sf = true,
): number {
  return (
    0x7a400000 |
    (sf ? 0x80000000 : 0) |
    (rm << 16) |
    (CONDITIONS[condition] << 12) |
    (rn << 5) |
    (nzcv & 0xf)
  );
}

export function ccmn(
  rn: number,
  rm: number,
  nzcv: number,
  condition: Condition,
  sf = true,
): number {
  return ccmp(rn, rm, nzcv, condition, sf) & ~0x40000000;
}

export function invertCondition(condition: Condition): Condition {
  const pairs: Array<[Condition, Condition]> = [
    ["eq", "ne"],
    ["cs", "cc"],
    ["mi", "pl"],
    ["vs", "vc"],
    ["hi", "ls"],
    ["ge", "lt"],
    ["gt", "le"],
    ["al", "nv"],
  ];
  for (const [a, b] of pairs) {
    if (condition === a) return b;
    if (condition === b) return a;
  }
  return "al";
}
