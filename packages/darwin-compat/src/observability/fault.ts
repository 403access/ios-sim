/**
 * Fault snapshots (OBS-006).
 *
 * When the interpreter faults, attach the same information a debugger would:
 * PC, raw instruction, disassembly, registers, stack pointer, condition flags,
 * the mapped regions around the PC, and the loaded image list. The snapshot is
 * JSON-safe so `run --json` and traces can carry it.
 */

import type { Arm64Cpu } from "../arm64/cpu.js";
import { disassembleInstruction } from "../arm64/disassemble.js";
import type { VirtualMemory } from "../dyld/vm.js";
import type { LoadedProgram } from "../dyld/loader.js";
import { errorMessage } from "../errors.js";

export interface FaultMap {
  readonly start: string;
  readonly end: string;
  readonly tag: string;
  readonly protection: number;
}

export interface FaultSnapshot {
  readonly reason: string;
  readonly pc: string;
  readonly instruction: string | null;
  readonly disassembly: string | null;
  readonly registers: Readonly<Record<string, string>>;
  readonly sp: string;
  readonly nzcv: number;
  readonly maps: readonly FaultMap[];
  readonly images: readonly string[];
}

export function captureFault(
  error: unknown,
  cpu: Arm64Cpu,
  memory: VirtualMemory,
  program?: LoadedProgram,
  pcOverride?: bigint,
): FaultSnapshot {
  const pc = pcOverride ?? cpu.pc;
  let word: number | null = null;
  try {
    word = Number(memory.read(pc, 4));
  } catch {
    word = null;
  }
  const registers: Record<string, string> = {};
  for (let index = 0; index < 31; index += 1) {
    registers[`x${index}`] = `0x${cpu.readRegister(index).toString(16)}`;
  }
  const maps = memory.regionsView
    .filter((region) => pc >= region.start - 0x4000n && pc <= region.end + 0x4000n)
    .map((region) => ({
      start: `0x${region.start.toString(16)}`,
      end: `0x${region.end.toString(16)}`,
      tag: region.tag,
      protection: region.protection,
    }));
  return {
    reason: errorMessage(error),
    pc: `0x${pc.toString(16)}`,
    instruction: word === null ? null : word.toString(16).padStart(8, "0"),
    disassembly: word === null ? null : disassembleInstruction(word, pc),
    registers,
    sp: `0x${cpu.sp.toString(16)}`,
    nzcv: cpu.nzcv,
    maps,
    images: program?.images.map((image) => image.path) ?? [],
  };
}

export function formatFault(snapshot: FaultSnapshot): string {
  const lines = [
    `fault: ${snapshot.reason}`,
    `  pc: ${snapshot.pc}`,
    `  instruction: ${snapshot.instruction ?? "<unmapped>"}  ${snapshot.disassembly ?? ""}`.trimEnd(),
    `  sp: ${snapshot.sp}  nzcv: 0x${snapshot.nzcv.toString(16)}`,
    "  registers:",
    ...Object.entries(snapshot.registers).map(([name, value]) => `    ${name}=${value}`),
  ];
  if (snapshot.maps.length > 0) {
    lines.push("  maps near pc:");
    for (const map of snapshot.maps) {
      lines.push(`    ${map.start}-${map.end} ${map.tag} prot=${map.protection}`);
    }
  }
  if (snapshot.images.length > 0) {
    lines.push(`  images: ${snapshot.images.join(", ")}`);
  }
  return lines.join("\n");
}
