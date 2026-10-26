import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { CaptureSink, DarwinSyscallKernel } from "./kernel.js";
import {
  DARWIN_MAP_ANON,
  DARWIN_MAP_PRIVATE,
  DARWIN_O_CREAT,
  DARWIN_O_RDONLY,
  SYS_CLOSE,
  SYS_EXIT,
  SYS_FSTAT,
  SYS_GETPID,
  SYS_GETTIMEOFDAY,
  SYS_LSEEK,
  SYS_MMAP,
  SYS_MUNMAP,
  SYS_OPEN,
  SYS_READ,
  SYS_WRITE,
  DARWIN_SEEK_SET,
} from "./numbers.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "darwin-syscall-"));
  roots.push(root);
  const memory = new VirtualMemory();
  const mach = new MachKernel();
  const task = mach.createTask(42);
  const out = new CaptureSink();
  const err = new CaptureSink();
  const kernel = new DarwinSyscallKernel({
    memory,
    mach,
    task,
    rootDir: root,
    stdout: out,
    stderr: err,
  });
  const cpu = new Arm64Cpu();
  cpu.reset(0n, 0x1000n);
  const buffer = memory.allocate(0x1000, { tag: "test" });
  const call = (number: number, ...args: Array<bigint | number>) => {
    args.forEach((value, index) => cpu.writeRegister(index, BigInt(value)));
    return kernel.handle(number, cpu);
  };
  return { root, memory, mach, task, out, err, kernel, cpu, buffer, call };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Darwin syscall kernel", () => {
  it("writes to stdout and stderr sinks", () => {
    const { memory, buffer, out, call } = fixture();
    memory.writeBytes(buffer, new TextEncoder().encode("hello"));
    expect(call(SYS_WRITE, 1, buffer, 5).value).toBe(5);
    expect(call(SYS_WRITE, 2, buffer, 2).value).toBe(2);
    expect(out.text()).toBe("hello");
  });

  it("opens, reads, seeks, and closes a jailed file", () => {
    const { root, memory, buffer, call } = fixture();
    writeFileSync(join(root, "input.txt"), "abcdef");
    const path = buffer;
    memory.writeCString(path, "input.txt");
    const fd = Number(call(SYS_OPEN, path, DARWIN_O_RDONLY, 0).value);
    expect(fd).toBeGreaterThanOrEqual(3);

    expect(call(SYS_READ, fd, buffer + 0x100n, 3).value).toBe(3);
    expect(new TextDecoder().decode(memory.readBytes(buffer + 0x100n, 3))).toBe("abc");
    expect(call(SYS_LSEEK, fd, 1, DARWIN_SEEK_SET).value).toBe(1);
    expect(call(SYS_READ, fd, buffer + 0x200n, 2).value).toBe(2);
    expect(new TextDecoder().decode(memory.readBytes(buffer + 0x200n, 2))).toBe("bc");
    expect(call(SYS_CLOSE, fd).value).toBe(0);
  });

  it("creates a file inside the root and rejects path escapes", () => {
    const { root, memory, buffer, call } = fixture();
    memory.writeCString(buffer, "created.txt");
    const fd = Number(call(SYS_OPEN, buffer, DARWIN_O_RDONLY | DARWIN_O_CREAT, 0o644).value);
    expect(fd).toBeGreaterThanOrEqual(3);
    call(SYS_CLOSE, fd);
    writeFileSync(join(root, "created.txt"), "ok");
    expect(readFileSync(join(root, "created.txt"), "utf8")).toBe("ok");

    memory.writeCString(buffer, "../escape.txt");
    expect(() => call(SYS_OPEN, buffer, DARWIN_O_RDONLY, 0)).toThrow(/escapes/);
  });

  it("maps and unmaps anonymous memory", () => {
    const { memory, call } = fixture();
    const result = call(
      SYS_MMAP,
      0,
      0x4000,
      3,
      DARWIN_MAP_ANON | DARWIN_MAP_PRIVATE,
      0xffffffff,
      0,
    );
    const address = BigInt(result.value);
    expect(address).toBeGreaterThan(0n);
    memory.write(address, 8, 0x1122_3344_5566_7788n);
    expect(memory.read(address, 8)).toBe(0x1122_3344_5566_7788n);
    expect(call(SYS_MUNMAP, address, 0x4000).value).toBe(0);
    expect(() => memory.read(address, 1)).toThrow(/unmapped/);
  });

  it("reports the pid, time, and exits", () => {
    const { memory, buffer, call } = fixture();
    expect(call(SYS_GETPID).value).toBe(42);
    expect(call(SYS_GETTIMEOFDAY, buffer, 0).value).toBe(0);
    expect(memory.read(buffer, 8)).toBeGreaterThan(0n);
    const exited = call(SYS_EXIT, 7);
    expect(exited).toMatchObject({ value: 0, halt: true });
  });

  it("fails loudly for an unknown syscall in strict mode", () => {
    const { kernel, cpu } = fixture();
    expect(() => kernel.handle(9999, cpu)).toThrow(/unsupported Darwin syscall/);
    const lenient = new DarwinSyscallKernel({
      memory: kernel.memory,
      mach: kernel.mach,
      task: kernel.task,
      rootDir: kernel.rootDir,
      strict: false,
    });
    expect(lenient.handle(9999, cpu)).toMatchObject({ value: 78, error: true });
  });

  it("returns EBADF for writes to an unknown descriptor", () => {
    const { buffer, call } = fixture();
    expect(call(SYS_WRITE, 99, buffer, 1)).toMatchObject({ value: 9, error: true });
  });

  it("returns EBADF for fstat on an unknown descriptor", () => {
    const { buffer, call } = fixture();
    expect(call(SYS_FSTAT, 99, buffer)).toMatchObject({ value: 9, error: true });
  });
});
