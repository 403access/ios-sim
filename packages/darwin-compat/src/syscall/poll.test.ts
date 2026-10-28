import { describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import { SYS_POLL, SYS_SELECT } from "./numbers.js";

function setup() {
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  const kernel = new MachKernel();
  const syscalls = new DarwinSyscallKernel({
    memory,
    mach: kernel,
    task: kernel.createTask(1),
    rootDir: process.cwd(),
    stdin: new TextEncoder().encode("abc"),
  });
  const cpu = new Arm64Cpu();
  const call = (args: bigint[]) => {
    args.forEach((value, index) => cpu.writeRegister(index, value));
    cpu.writeRegister(16, BigInt(SYS_POLL));
    return syscalls.handle(SYS_POLL, cpu);
  };
  const pollfd = (index: number, fd: number, events: number): void => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, fd, true);
    view.setInt16(4, events, true);
    memory.writeBytes(0x1000n + BigInt(index * 8), bytes);
  };
  const selectCall = (args: bigint[]) => {
    args.forEach((value, index) => cpu.writeRegister(index, value));
    cpu.writeRegister(16, BigInt(SYS_SELECT));
    return syscalls.handle(SYS_SELECT, cpu);
  };
  return { memory, call, pollfd, selectCall };
}

describe("poll", () => {
  it("reports stdin readable and stdout writable", () => {
    const { memory, call, pollfd } = setup();
    pollfd(0, 0, 1);
    pollfd(1, 1, 4);
    expect(call([0x1000n, 2n, 0n]).value).toBe(2);
    const first = new DataView(memory.readBytes(0x1000n, 8).buffer).getInt16(6, true);
    const second = new DataView(memory.readBytes(0x1008n, 8).buffer).getInt16(6, true);
    expect(first & 1).toBe(1);
    expect(second & 4).toBe(4);
  });

  it("reports select readiness in fd_set bitmaps", () => {
    const { memory, selectCall } = setup();
    memory.writeBytes(0x2000n, new Uint8Array(128));
    memory.writeBytes(0x2100n, new Uint8Array(128));
    const read = memory.readBytes(0x2000n, 128);
    read[0] = 1; // stdin
    memory.writeBytes(0x2000n, read);
    const write = memory.readBytes(0x2100n, 128);
    write[0] = 2; // stdout
    memory.writeBytes(0x2100n, write);
    expect(selectCall([4n, 0x2000n, 0x2100n, 0n, 0n]).value).toBe(2);
    expect(memory.readBytes(0x2000n, 1)[0]).toBe(1);
    expect(memory.readBytes(0x2100n, 1)[0]).toBe(2);
  });

  it("marks unknown descriptors POLLNVAL and ignores negative fds", () => {
    const { call, pollfd } = setup();
    pollfd(0, 99, 1);
    pollfd(1, -1, 1);
    expect(call([0x1000n, 2n, 0n]).value).toBe(1);
  });
});
