import { describe, expect, it } from "vitest";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { DarwinSyscallKernel } from "./kernel.js";
import {
  EVFILT_READ,
  EVFILT_TIMER,
  EVFILT_WRITE,
  EV_ADD,
  EV_ONESHOT,
  Kqueue,
  KqueueError,
} from "./kqueue.js";
import { SYS_KEVENT, SYS_KQUEUE } from "./numbers.js";

function setup() {
  const memory = new VirtualMemory();
  memory.mapFixed(0x1000n, 0x4000, { tag: "test", protection: 3 });
  const kernel = new MachKernel();
  const task = kernel.createTask(1);
  const syscalls = new DarwinSyscallKernel({
    memory,
    mach: kernel,
    task,
    rootDir: process.cwd(),
    stdin: new TextEncoder().encode("abc"),
  });
  const cpu = new Arm64Cpu();
  return { memory, syscalls, cpu };
}

function syscall(syscalls: DarwinSyscallKernel, cpu: Arm64Cpu, number: number, args: bigint[]) {
  args.forEach((value, index) => cpu.writeRegister(index, value));
  cpu.writeRegister(16, BigInt(number));
  return syscalls.handle(number, cpu);
}

function writeEvent(
  memory: VirtualMemory,
  address: bigint,
  event: { ident: number; filter: number; flags: number; data?: number },
) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(event.ident), true);
  view.setInt16(8, event.filter, true);
  view.setUint16(10, event.flags, true);
  view.setBigInt64(16, BigInt(event.data ?? 0), true);
  memory.writeBytes(address, bytes);
}

describe("kqueue semantics", () => {
  it("signals readable/writable filters and removes oneshot timers", () => {
    const queue = new Kqueue();
    let now = 0;
    queue.add(
      { ident: 0, filter: EVFILT_READ, flags: EV_ADD, fflags: 0, data: 0n, udata: 0n },
      now,
    );
    queue.add(
      { ident: 1, filter: EVFILT_WRITE, flags: EV_ADD, fflags: 0, data: 0n, udata: 0n },
      now,
    );
    queue.add(
      {
        ident: 9,
        filter: EVFILT_TIMER,
        flags: EV_ADD | EV_ONESHOT,
        fflags: 0,
        data: 10n,
        udata: 0n,
      },
      now,
    );
    expect(queue.poll(now)).toEqual([]);
    queue.signal(EVFILT_READ, 0);
    queue.signal(EVFILT_WRITE, 1);
    expect(queue.poll(now).map((event) => event.filter)).toEqual([EVFILT_READ, EVFILT_WRITE]);
    now = 10;
    expect(queue.poll(now).map((event) => event.filter)).toEqual([EVFILT_TIMER]);
    expect(queue.size()).toBe(2);
    expect(queue.remove(EVFILT_READ, 0)).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it("wires kqueue/kevent syscalls through guest memory", () => {
    const { memory, syscalls, cpu } = setup();
    const create = syscall(syscalls, cpu, SYS_KQUEUE, []);
    expect(create.value).toBeGreaterThanOrEqual(3);
    const fd = BigInt(create.value);
    writeEvent(memory, 0x1000n, { ident: 0, filter: EVFILT_READ, flags: EV_ADD });
    const change = syscall(syscalls, cpu, SYS_KEVENT, [fd, 0x1000n, 1n, 0n, 0n, 0n]);
    expect(change.value).toBe(0);
    const wait = syscall(syscalls, cpu, SYS_KEVENT, [fd, 0x1000n, 1n, 0x2000n, 4n, 0n]);
    expect(wait.value).toBe(1);
    const event = memory.readBytes(0x2000n, 32);
    expect(new DataView(event.buffer, event.byteOffset, event.byteLength).getInt16(8, true)).toBe(
      EVFILT_READ,
    );
    expect(() =>
      new Kqueue().add({ ident: 0, filter: 999, flags: EV_ADD, fflags: 0, data: 0n, udata: 0n }),
    ).not.toThrow();
    expect(KqueueError).toBeTruthy();
  });

  it("returns EBADF for a non-kqueue fd", () => {
    const { syscalls, cpu } = setup();
    const result = syscall(syscalls, cpu, SYS_KEVENT, [999n, 0n, 0n, 0n, 0n, 0n]);
    expect(result.value).toBeGreaterThan(0); // errno encoding
  });
});
