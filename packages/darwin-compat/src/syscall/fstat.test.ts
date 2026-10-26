import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import { SYS_FSTAT, SYS_OPEN } from "./numbers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(contents = "hello") {
  const root = mkdtempSync(join(tmpdir(), "fstat-"));
  roots.push(root);
  writeFileSync(join(root, "file"), contents);
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  memory.writeBytes(0x1000n, new TextEncoder().encode("/file\0"));
  const kernel = new MachKernel();
  const task = kernel.createTask(1);
  const syscalls = new DarwinSyscallKernel({ memory, mach: kernel, task, rootDir: root });
  const cpu = new Arm64Cpu();
  return { memory, syscalls, cpu, size: contents.length };
}

function call(syscalls: DarwinSyscallKernel, cpu: Arm64Cpu, number: number, args: bigint[]) {
  args.forEach((value, index) => cpu.writeRegister(index, value));
  cpu.writeRegister(16, BigInt(number));
  return syscalls.handle(number, cpu);
}

describe("fstat", () => {
  it("fills Darwin stat64 fields for a regular file", () => {
    const { memory, syscalls, cpu, size } = setup("hello world");
    const open = call(syscalls, cpu, SYS_OPEN, [0x1000n, 0n, 0n]);
    expect(open.value).toBeGreaterThanOrEqual(3);
    const result = call(syscalls, cpu, SYS_FSTAT, [BigInt(open.value), 0x2000n]);
    expect(result.value).toBe(0);
    const bytes = memory.readBytes(0x2000n, 144);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(4, true) & 0xf000).toBe(0x8000); // S_IFREG
    expect(Number(view.getBigInt64(96, true))).toBe(size);
    expect(Number(view.getBigInt64(104, true))).toBeGreaterThan(0);
    expect(view.getInt32(112, true)).toBeGreaterThan(0);
    expect(Number(view.getBigUint64(8, true))).toBeGreaterThan(0);
  });

  it("marks stdio as character devices and rejects unknown fds", () => {
    const { memory, syscalls, cpu } = setup();
    expect(call(syscalls, cpu, SYS_FSTAT, [1n, 0x3000n]).value).toBe(0);
    const mode = new DataView(memory.readBytes(0x3000n, 8).buffer).getUint16(4, true);
    expect(mode & 0xf000).toBe(0x2000);
    const bad = call(syscalls, cpu, SYS_FSTAT, [99n, 0x3000n]);
    expect(bad.error).toBe(true);
  });
});
