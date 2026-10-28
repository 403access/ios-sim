import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import {
  SYS_ACCESS,
  SYS_CHMOD,
  SYS_FCNTL,
  SYS_FCHMOD,
  SYS_FSYNC,
  SYS_FTRUNCATE,
  SYS_MKDIR,
  SYS_OPEN,
  SYS_RENAME,
  SYS_RMDIR,
  SYS_TRUNCATE,
  SYS_UMASK,
  SYS_GETRLIMIT,
  SYS_SETRLIMIT,
  SYS_UTIMES,
} from "./numbers.js";

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

  it("applies umask, rlimits, and utimes", () => {
    const { root, memory, call, path } = setup();
    expect(call(SYS_UMASK, [0o077n]).value).toBe(0o022);
    path(0x1000, "/created");
    const fd = call(SYS_OPEN, [0x1000n, 0x202n, 0o777n]);
    expect(fd.value).toBeGreaterThanOrEqual(3);
    expect(statSync(join(root, "created")).mode & 0o777).toBe(0o700);

    memory.write(0x2000n, 8, 256n);
    memory.write(0x2008n, 8, 1024n);
    expect(call(SYS_GETRLIMIT, [8n, 0x2100n]).value).toBe(0);
    expect(Number(memory.read(0x2100n, 8))).toBe(256);
    memory.write(0x2000n, 8, 64n);
    memory.write(0x2008n, 8, 128n);
    expect(call(SYS_SETRLIMIT, [8n, 0x2000n]).value).toBe(0);
    expect(call(SYS_GETRLIMIT, [8n, 0x2100n]).value).toBe(0);
    expect(Number(memory.read(0x2100n, 8))).toBe(64);

    path(0x1000, "/created");
    memory.write(0x2000n, 8, 1000n);
    memory.write(0x2008n, 8, 0n);
    memory.write(0x2010n, 8, 2000n);
    memory.write(0x2018n, 8, 0n);
    expect(call(SYS_UTIMES, [0x1000n, 0x2000n]).value).toBe(0);
    expect(Math.round(statSync(join(root, "created")).mtimeMs / 1000)).toBe(2000);
  });

  it("truncates, chmods, and fsyncs files", () => {
    const { root, call, path } = setup();
    path(0x1000, "/a");
    expect(call(SYS_TRUNCATE, [0x1000n, 3n]).value).toBe(0);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("pay");
    expect(call(SYS_CHMOD, [0x1000n, 0o600n]).value).toBe(0);
    expect(statSync(join(root, "a")).mode & 0o777).toBe(0o600);

    const fd = call(SYS_OPEN, [0x1000n, 2n, 0n]);
    expect(call(SYS_FTRUNCATE, [BigInt(fd.value), 1n]).value).toBe(0);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("p");
    expect(call(SYS_FCHMOD, [BigInt(fd.value), 0o640n]).value).toBe(0);
    expect(statSync(join(root, "a")).mode & 0o777).toBe(0o640);
    expect(call(SYS_FSYNC, [BigInt(fd.value)]).value).toBe(0);
  });
});
