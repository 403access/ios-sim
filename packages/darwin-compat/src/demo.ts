/**
 * A tiny self-contained demo program used by the CLI and documentation.
 *
 * It is assembled from the repository's own A64 encoder and Mach-O writer, so
 * `ios-sim-native demo` demonstrates every layer without reading any external
 * binary.
 */

import { addImm, adrp, movz, svc, words } from "./arm64/assembler.js";
import { buildMachO, type BuiltMachO } from "./macho/build.js";

export const DEMO_BASE = 0x100000000;
export const DEMO_TEXT_BASE = 0x100001000;
export const DEMO_MESSAGE = "hello from darwin\n";

export function buildDemoProgram(message = DEMO_MESSAGE): BuiltMachO {
  const instructionCount = 9;
  const cstringOffset = Math.ceil((0x1000 + instructionCount * 4) / 16) * 16 - 0x1000;
  const cstringAddress = DEMO_BASE + 0x1000 + cstringOffset;
  const text = words(
    movz(0, 1),
    adrp(1, cstringAddress, DEMO_TEXT_BASE + 4),
    addImm(1, 1, cstringAddress & 0xfff),
    movz(2, message.length),
    movz(16, 4),
    svc(0x80),
    movz(0, 42),
    movz(16, 1),
    svc(0x80),
  );
  return buildMachO({
    text,
    cstring: message,
    symbols: [{ name: "_start", value: DEMO_TEXT_BASE }],
    exports: [{ name: "_start", address: DEMO_TEXT_BASE }],
  });
}
