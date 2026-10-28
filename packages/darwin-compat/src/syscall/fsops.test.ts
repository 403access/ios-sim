import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import { SYS_ACCESS, SYS_FCNTL, SYS_MKDIR, SYS_OPEN, SYS_RENAME, SYS_RMDIR } from "./numbers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fsops-"));
  roots.push(root);
  writeFileSync(join(root, "a"), "payload");
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  const kernel = new MachKernel();
  const syscalls = new DarwinSyscallKernel({
    memory,
    mach: kernel,
    task: kernel.createTask(1),
    rootDir: root,
  });
  const cpu = new Arm64Cpu();
  const call = (number: number, args: bigint[]) => {
    args.forEach((value, index) => cpu.writeRegister(index, value));
    cpu.writeRegister(16, BigInt(number));
    return syscalls.handle(number, cpu);
  };
  const path = (address: number, value: string) =>
    memory.writeBytes(BigInt(address), new TextEncoder().encode(`${value}\0`));
  return { root, memory, call, path };
}

describe("file operations", () => {
  it("renames files, creates/removes directories, and reports fcntl paths", () => {
    const { root, memory, call, path } = setup();
    path(0x1000, "/a");
    path(0x1020, "/b");
    expect(call(SYS_RENAME, [0x1000n, 0x1020n]).value).toBe(0);
    expect(readFileSync(join(root, "b"), "utf8")).toBe("payload");
    expect(existsSync(join(root, "a"))).toBe(false);

    path(0x1000, "/dir");
    expect(call(SYS_MKDIR, [0x1000n, 0o755n]).value).toBe(0);
    expect(existsSync(join(root, "dir"))).toBe(true);
    expect(call(SYS_RMDIR, [0x1000n]).value).toBe(0);
    expect(existsSync(join(root, "dir"))).toBe(false);

    writeFileSync(join(root, "file"), "x");
    path(0x1000, "/file");
    const fd = call(SYS_OPEN, [0x1000n, 0n, 0n]);
    expect(call(SYS_FCNTL, [BigInt(fd.value), 50n, 0x2000n]).value).toBe(0);
    expect(memory.readCString(0x2000n)).toBe("/file");
    expect(call(SYS_FCNTL, [BigInt(fd.value), 0n, 0n]).value).toBeGreaterThanOrEqual(3);
    expect(call(SYS_RMDIR, [0x1000n]).error).toBe(true);
    expect(call(SYS_ACCESS, [0x1000n, 0n]).value).toBe(0);
    expect(call(SYS_ACCESS, [0x1000n, 4n]).value).toBe(0);
    path(0x1000, "/missing");
    expect(call(SYS_ACCESS, [0x1000n, 0n]).error).toBe(true);
  });
});
