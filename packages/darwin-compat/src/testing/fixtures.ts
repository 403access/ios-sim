/**
 * Shared hermetic fixtures for the compatibility tests.
 *
 * Everything here is generated from source in this repository: no Apple
 * binaries, no compiler output, no committed Mach-O. That keeps Linux CI
 * honest and makes each instruction visible in review.
 */

import {
  addImm,
  adrp,
  blr,
  cset,
  ldrUnsigned,
  movn,
  movReg,
  movz,
  subReg,
  svc,
  words,
} from "../arm64/assembler.js";
import { buildDemoProgram } from "../demo.js";
import { buildMachO } from "../macho/build.js";

export const buildHello = buildDemoProgram;
export const HELLO_BASE = 0x100000000;
export const HELLO_TEXT_BASE = 0x100001000;
export const HELLO_DATA_BASE = 0x100004000;
export const HELLO_MESSAGE = "hello from darwin\n";

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function buildHelperDylib() {
  const instructionCount = 7;
  const cstringOffset = align(0x1000 + instructionCount * 4, 16) - 0x1000;
  const cstringAddress = HELLO_BASE + 0x1000 + cstringOffset;
  const text = words(
    movz(0, 1),
    adrp(1, cstringAddress, HELLO_TEXT_BASE + 4),
    addImm(1, 1, cstringAddress & 0xfff),
    movz(2, 8),
    movz(16, 4),
    svc(0x80),
    0xd65f03c0, // ret
  );
  return buildMachO({
    fileType: "dylib",
    installName: "/lib/libhelper.dylib",
    text,
    cstring: "helper!\n",
    symbols: [{ name: "_helper", value: HELLO_TEXT_BASE }],
    exports: [{ name: "_helper", address: HELLO_TEXT_BASE }],
  });
}

/**
 * Main executable that reads a chained-fixup function pointer from __DATA,
 * calls into a dependency dylib, then exits 7.
 */
export function buildDependentProgram() {
  const text = words(
    adrp(10, HELLO_DATA_BASE, HELLO_TEXT_BASE),
    addImm(10, 10, HELLO_DATA_BASE & 0xfff),
    ldrUnsigned(9, 10, 0, 3),
    blr(9),
    movz(0, 7),
    movz(16, 1),
    svc(0x80),
  );
  return buildMachO({
    text,
    data: new Uint8Array(0x4000),
    dependencies: [{ name: "/lib/libhelper.dylib" }],
    fixups: [{ kind: "bind", offset: 0, symbol: "_helper", ordinal: 1 }],
    symbols: [{ name: "_start", value: HELLO_TEXT_BASE }],
    exports: [{ name: "_start", address: HELLO_TEXT_BASE }],
  });
}

/**
 * Same call-through-`__DATA` shape as `buildDependentProgram`, but the import
 * is encoded with legacy `LC_DYLD_INFO_ONLY` bind opcodes (LDR-001).
 */
export function buildLegacyDependentProgram() {
  const text = words(
    adrp(10, HELLO_DATA_BASE, HELLO_TEXT_BASE),
    addImm(10, 10, HELLO_DATA_BASE & 0xfff),
    ldrUnsigned(9, 10, 0, 3),
    blr(9),
    movz(0, 7),
    movz(16, 1),
    svc(0x80),
  );
  return buildMachO({
    text,
    data: new Uint8Array(0x4000),
    dependencies: [{ name: "/lib/libhelper.dylib" }],
    legacyFixups: [{ kind: "bind", offset: 0, symbol: "_helper", ordinal: 1 }],
    symbols: [{ name: "_start", value: HELLO_TEXT_BASE }],
    exports: [{ name: "_start", address: HELLO_TEXT_BASE }],
  });
}

/**
 * Executable with a legacy rebase pointer already pointing into `__TEXT`.
 * Loading it must slide the pointer by the image slide.
 */
export function buildLegacyRebaseProgram() {
  const data = new Uint8Array(0x4000);
  new DataView(data.buffer).setBigUint64(0x100, BigInt(HELLO_TEXT_BASE + 0x800), true);
  const text = words(movz(0, 0), movz(16, 1), svc(0x80));
  return buildMachO({
    text,
    data,
    legacyFixups: [{ kind: "rebase", offset: 0x100 }],
    symbols: [{ name: "_start", value: HELLO_TEXT_BASE }],
    exports: [{ name: "_start", address: HELLO_TEXT_BASE }],
  });
}

/**
 * Mach bootstrap ping: create a reply port, send a 4-byte message to the
 * bootstrap port, receive the reply, and exit 0 only when the reply body is
 * exactly 0xbeef.
 */
export function buildMachPingProgram() {
  const replySlot = 16;
  const receiveBuffer = HELLO_DATA_BASE + 0x200;
  const text = words(
    movn(16, 25), // x16 = -26: mach_reply_port
    svc(0x80),
    adrp(10, HELLO_DATA_BASE, HELLO_TEXT_BASE + 8),
    addImm(10, 10, HELLO_DATA_BASE & 0xfff),
    0xf9000940, // str x0, [x10, #16]
    0xb9000d40, // str w0, [x10, #12] (msgh_local_port)
    0xaa0a03e0, // mov x0, x10
    movz(1, 1), // MACH_SEND_MSG
    movz(2, 28),
    movz(3, 0),
    movz(4, 0),
    movz(5, 0),
    movz(6, 0),
    movn(16, 30), // x16 = -31: mach_msg_trap
    svc(0x80),
    adrp(11, receiveBuffer, HELLO_TEXT_BASE + 60),
    addImm(11, 11, receiveBuffer & 0xfff),
    movReg(0, 11),
    movz(1, 2), // MACH_RCV_MSG
    movz(3, 64),
    ldrUnsigned(4, 10, replySlot, 3),
    movn(16, 30),
    svc(0x80),
    subReg(31, 0, 0, { setFlags: true }),
    cset(3, "ne"),
    ldrUnsigned(1, 11, 24, 2),
    movz(2, 0xbeef),
    subReg(4, 1, 2, { sf: false, setFlags: true }),
    cset(4, "ne", false),
    addRegHelper(0, 3, 4),
    movz(16, 1),
    svc(0x80),
  );
  return buildMachO({
    text,
    data: makePingData(),
    symbols: [{ name: "_start", value: HELLO_TEXT_BASE }],
    exports: [{ name: "_start", address: HELLO_TEXT_BASE }],
  });
}

function addRegHelper(rd: number, rn: number, rm: number): number {
  return 0x0b000000 | 0x80000000 | (rm << 16) | (rn << 5) | rd;
}

function makePingData(): Uint8Array {
  const data = new Uint8Array(0x4000);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x1313, true);
  view.setUint32(4, 28, true);
  view.setUint32(8, 2, true); // bootstrap port
  view.setUint32(12, 0, true); // filled at runtime
  view.setUint32(16, 0, true);
  view.setInt32(20, 0x1234, true);
  view.setUint32(24, 0xfeed, true);
  return data;
}

/** Smallest possible process: exit with a chosen status. */
export function buildExitProgram(status = 0) {
  return buildMachO({
    text: words(movz(0, status), movz(16, 1), svc(0x80)),
    symbols: [{ name: "_start", value: HELLO_TEXT_BASE }],
    exports: [{ name: "_start", address: HELLO_TEXT_BASE }],
  });
}
