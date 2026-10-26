import { describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { CaptureSink, DarwinSyscallKernel } from "./kernel.js";
import { SYS_READV, SYS_WRITEV } from "./numbers.js";

function setup() {
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  const kernel = new MachKernel();
  const task = kernel.createTask(1);
  const stdout = new CaptureSink();
  const syscalls = new DarwinSyscallKernel({
    memory,
    mach: kernel,
    task,
    rootDir: process.cwd(),
    stdin: new TextEncoder().encode("abcdef"),
    stdout,
  });
  const cpu = new Arm64Cpu();
  const iovec = (index: number, address: bigint, length: number): void => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, address, true);
    view.setBigUint64(8, BigInt(length), true);
    memory.writeBytes(0x1000n + BigInt(index * 16), bytes);
  };
  return { memory, syscalls, cpu, stdout, iovec };
}

function call(syscalls: DarwinSyscallKernel, cpu: Arm64Cpu, number: number, args: bigint[]) {
  args.forEach((value, index) => cpu.writeRegister(index, value));
  cpu.writeRegister(16, BigInt(number));
  return syscalls.handle(number, cpu);
}

describe("readv/writev", () => {
  it("scatters stdin across iovecs and gathers stdout", () => {
    const { memory, syscalls, cpu, stdout, iovec } = setup();
    iovec(0, 0x2000n, 3);
    iovec(1, 0x2010n, 3);
    const read = call(syscalls, cpu, SYS_READV, [0n, 0x1000n, 2n]);
    expect(read.value).toBe(6);
    expect(new TextDecoder().decode(memory.readBytes(0x2000n, 3))).toBe("abc");
    expect(new TextDecoder().decode(memory.readBytes(0x2010n, 3))).toBe("def");
    iovec(0, 0x2000n, 3);
    iovec(1, 0x2010n, 3);
    const write = call(syscalls, cpu, SYS_WRITEV, [1n, 0x1000n, 2n]);
    expect(write.value).toBe(6);
    expect(stdout.text()).toBe("abcdef");
  });

  it("rejects implausible iovec counts", () => {
    const { syscalls, cpu } = setup();
    const result = call(syscalls, cpu, SYS_WRITEV, [1n, 0x1000n, 2000n]);
    expect(result.error).toBe(true);
  });
});
