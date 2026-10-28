import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import { SYS_CHDIR, SYS_FCHDIR, SYS_FSTAT, SYS_GETDIRENTRIES, SYS_OPEN } from "./numbers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dirent-"));
  roots.push(root);
  writeFileSync(join(root, "alpha"), "a");
  writeFileSync(join(root, "beta"), "bb");
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "dir", "inside"), "x");
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  memory.writeBytes(0x1000n, new TextEncoder().encode("/\0"));
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
  return { memory, call };
}

function entries(memory: VirtualMemory, buffer: bigint, bytes: number) {
  const data = memory.readBytes(buffer, bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const output: Array<{ name: string; type: number; ino: bigint }> = [];
  let offset = 0;
  while (offset + 21 <= bytes) {
    const length = view.getUint16(offset + 16, true);
    const nameLength = view.getUint16(offset + 18, true);
    if (length === 0 || offset + length > bytes) break;
    output.push({
      name: new TextDecoder().decode(data.subarray(offset + 21, offset + 21 + nameLength)),
      type: data[offset + 20]!,
      ino: view.getBigUint64(offset, true),
    });
    offset += length;
  }
  return output;
}

describe("getdirentries", () => {
  it("lists directory entries with types and advances the base", () => {
    const { memory, call } = setup();
    const open = call(SYS_OPEN, [0x1000n, 0n, 0n]);
    expect(open.value).toBeGreaterThanOrEqual(3);
    const result = call(SYS_GETDIRENTRIES, [BigInt(open.value), 0x2000n, 4096n, 0x3000n]);
    expect(result.value).toBeGreaterThan(0);
    const list = entries(memory, 0x2000n, Number(result.value));
    expect(list.map((entry) => entry.name)).toEqual(["alpha", "beta", "dir"]);
    expect(list.find((entry) => entry.name === "dir")?.type).toBe(4);
    expect(list.find((entry) => entry.name === "alpha")?.type).toBe(8);
    expect(list.every((entry) => entry.ino > 0n)).toBe(true);
    expect(Number(memory.read(0x3000n, 8))).toBe(3);
    expect(call(SYS_GETDIRENTRIES, [BigInt(open.value), 0x2000n, 4096n, 0x3000n]).value).toBe(0);
  });

  it("resolves relative paths against chdir/fchdir", () => {
    const { memory, call } = setup();
    const path = (value: string) =>
      memory.writeBytes(0x1000n, new TextEncoder().encode(`${value}\0`));
    path("/dir");
    expect(call(SYS_CHDIR, [0x1000n]).value).toBe(0);
    path("inside");
    const opened = call(SYS_OPEN, [0x1000n, 0n, 0n]);
    expect(opened.value).toBeGreaterThanOrEqual(3);
    expect(call(SYS_FSTAT, [BigInt(opened.value), 0x2000n]).value).toBe(0);
    expect(Number(new DataView(memory.readBytes(0x2000n, 144).buffer).getBigInt64(96, true))).toBe(
      1,
    );

    path("/");
    const rootFd = call(SYS_OPEN, [0x1000n, 0n, 0n]);
    expect(call(SYS_FCHDIR, [BigInt(rootFd.value)]).value).toBe(0);
    path("alpha");
    expect(call(SYS_OPEN, [0x1000n, 0n, 0n]).value).toBeGreaterThanOrEqual(3);
    path("missing");
    expect(call(SYS_CHDIR, [0x1000n]).error).toBe(true);
  });

  it("honors a short buffer and rejects non-directory fds", () => {
    const { memory, call } = setup();
    const open = call(SYS_OPEN, [0x1000n, 0n, 0n]);
    const result = call(SYS_GETDIRENTRIES, [BigInt(open.value), 0x2000n, 32n, 0x3000n]);
    expect(result.value).toBeGreaterThan(0);
    expect(entries(memory, 0x2000n, Number(result.value)).length).toBe(1);
    expect(call(SYS_GETDIRENTRIES, [1n, 0x2000n, 64n, 0x3000n]).error).toBe(true);
    expect(call(3, [BigInt(open.value), 0x2000n, 8n]).error).toBe(true); // read(2) on a directory
  });
});
