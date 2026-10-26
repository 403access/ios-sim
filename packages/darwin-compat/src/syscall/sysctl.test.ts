import { describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import { CTL_HW, CTL_KERN, HW_MEMSIZE, HW_NCPU, KERN_OSRELEASE } from "./sysctl.js";
import { SYS_SYSCTL } from "./numbers.js";

function setup() {
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  const kernel = new MachKernel();
  const syscalls = new DarwinSyscallKernel({
    memory,
    mach: kernel,
    task: kernel.createTask(1),
    rootDir: process.cwd(),
  });
  const cpu = new Arm64Cpu();
  const mib = (address: bigint, values: number[]): void => {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt32(index * 4, value, true));
    memory.writeBytes(address, bytes);
  };
  return { memory, syscalls, cpu, mib };
}

function call(syscalls: DarwinSyscallKernel, cpu: Arm64Cpu, args: bigint[]) {
  args.forEach((value, index) => cpu.writeRegister(index, value));
  cpu.writeRegister(16, BigInt(SYS_SYSCTL));
  return syscalls.handle(SYS_SYSCTL, cpu);
}

describe("sysctl", () => {
  it("returns CPU count, memory size, and OS release", () => {
    const { memory, syscalls, cpu, mib } = setup();
    mib(0x1000n, [CTL_HW, HW_NCPU]);
    memory.write(0x1010n, 8, 8n);
    expect(call(syscalls, cpu, [0x1000n, 2n, 0x2000n, 0x1010n]).value).toBe(0);
    expect(Number(memory.read(0x2000n, 4))).toBe(1);

    mib(0x1000n, [CTL_HW, HW_MEMSIZE]);
    memory.write(0x1010n, 8, 8n);
    expect(call(syscalls, cpu, [0x1000n, 2n, 0x2000n, 0x1010n]).value).toBe(0);
    expect(Number(memory.read(0x2000n, 8))).toBe(512 * 1024 * 1024);

    mib(0x1000n, [CTL_KERN, KERN_OSRELEASE]);
    memory.write(0x1010n, 8, 32n);
    expect(call(syscalls, cpu, [0x1000n, 2n, 0x2000n, 0x1010n]).value).toBe(0);
    expect(memory.readCString(0x2000n)).toBe("24.0.0");
  });

  it("reports ENOENT for unknown MIBs and ENOMEM for short buffers", () => {
    const { memory, syscalls, cpu, mib } = setup();
    mib(0x1000n, [999, 999]);
    memory.write(0x1010n, 8, 8n);
    expect(call(syscalls, cpu, [0x1000n, 2n, 0x2000n, 0x1010n]).error).toBe(true);

    mib(0x1000n, [CTL_HW, HW_MEMSIZE]);
    memory.write(0x1010n, 8, 4n);
    const short = call(syscalls, cpu, [0x1000n, 2n, 0x2000n, 0x1010n]);
    expect(short.error).toBe(true);
    expect(Number(memory.read(0x1010n, 8))).toBe(8);
  });
});
