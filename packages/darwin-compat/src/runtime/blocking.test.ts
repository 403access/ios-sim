import { describe, expect, it } from "vitest";
import { movz, svc, words } from "../arm64/assembler.js";
import { VirtualMemory } from "../dyld/vm.js";
import { Arm64Cpu } from "../arm64/cpu.js";
import { MachKernel, MACH_RCV_MSG } from "../mach/kernel.js";
import { decodeMachMessage } from "../mach/message.js";
import { DarwinSyscallKernel } from "../syscall/kernel.js";
import { SYS_MACH_MSG_TRAP } from "../syscall/numbers.js";
import { BlockingMachBridge, KERN_RECEIVE_INTERRUPTED } from "./blocking.js";
import { GuestScheduler } from "./scheduler.js";

const DATA_ADDRESS = 0x1000n;

function program(codeAddress: number, syscallNumber: number): Uint8Array {
  return words(movz(16, syscallNumber), svc(0x80), movz(0, 0), movz(16, 1), svc(0x80));
}

function setup() {
  const memory = new VirtualMemory();
  memory.mapFixed(0n, 0x1000, { bytes: program(0, 100), tag: "a", protection: 7 });
  memory.mapFixed(0x2000n, 0x1000, { bytes: program(0x2000, 101), tag: "b", protection: 7 });
  memory.mapFixed(DATA_ADDRESS, 0x1000, { tag: "data", protection: 3 });

  const kernel = new MachKernel();
  const taskA = kernel.createTask(1);
  const taskB = kernel.createTask(2);
  const { name: receiveName, portId } = kernel.insertReceiveRight(taskA, "blocking-service");
  const sendName = kernel.insertSendRight(taskB, portId);
  return { memory, kernel, taskA, taskB, receiveName, sendName, portId };
}

function bodyValue(body: Uint8Array): number {
  return new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
}

describe("BlockingMachBridge", () => {
  it("parks a receiver and wakes it when another thread sends", () => {
    const { memory, kernel, taskA, taskB, receiveName, sendName } = setup();
    const scheduler = new GuestScheduler(memory, { quantum: 16 });
    const bridge = new BlockingMachBridge(kernel, scheduler);
    const stackA = memory.allocate(0x2000, { tag: "stack-a" });
    const stackB = memory.allocate(0x2000, { tag: "stack-b" });
    const a = scheduler.createThread({
      entry: 0n,
      stackPointer: stackA + 0x1ff0n,
      label: "receiver",
    });
    const b = scheduler.createThread({
      entry: 0x2000n,
      stackPointer: stackB + 0x1ff0n,
      label: "sender",
    });

    const run = (maxInstructions = 1000) =>
      scheduler.run({
        maxInstructions,
        onTick: (now) => bridge.tick(now),
        syscallHandler: (thread, number) => {
          if (number === 100) {
            const received = bridge.receive(thread, taskA, receiveName, 1000);
            if (received.blocked) return { value: 0, blocked: true };
            memory.write(
              DATA_ADDRESS,
              4,
              BigInt(received.message ? bodyValue(received.message.body) : 0xdead),
            );
            return { value: 0 };
          }
          if (number === 101) {
            bridge.send(taskB, sendName, 0, 7, Uint8Array.from([42, 0, 0, 0]));
            return { value: 0 };
          }
          if (number === 1) return { value: 0, halt: true };
          return { value: 0 };
        },
      });

    const first = run();
    expect(first.blocked).toBe(0);
    expect(first.terminated).toBe(2);
    expect(memory.read(DATA_ADDRESS, 4)).toBe(42n);
    expect(a.state).toBe("terminated");
    expect(b.state).toBe("terminated");
    expect(bridge.waiterCount).toBe(0);
  });

  it("integrates with the real mach_msg_trap receive path", () => {
    const { memory, kernel, taskA, taskB, receiveName, sendName } = setup();
    const scheduler = new GuestScheduler(memory, { quantum: 16 });
    const bridge = new BlockingMachBridge(kernel, scheduler);
    const stack = memory.allocate(0x2000, { tag: "stack" });
    const thread = scheduler.createThread({ entry: 0n, stackPointer: stack + 0x1ff0n });
    const buffer = memory.allocate(0x1000, { tag: "message" });
    const syscalls = new DarwinSyscallKernel({
      memory,
      mach: kernel,
      task: taskA,
      rootDir: process.cwd(),
      blocking: bridge,
    });
    const cpu = new Arm64Cpu();
    cpu.reset(0n, 0x8000n);

    const receive = () => {
      cpu.writeRegister(0, buffer);
      cpu.writeRegister(1, BigInt(MACH_RCV_MSG));
      cpu.writeRegister(3, 128n);
      cpu.writeRegister(4, BigInt(receiveName));
      cpu.writeRegister(5, 0n);
      return syscalls.handle(SYS_MACH_MSG_TRAP, cpu, thread);
    };

    const first = receive();
    expect(first.blocked).toBe(true);
    expect(thread.state).toBe("blocked");
    expect(bridge.waiterCount).toBe(1);

    bridge.send(taskB, sendName, 0, 77, Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]));
    expect(thread.state).toBe("runnable");
    const second = receive();
    expect(second.blocked).toBeUndefined();
    expect(second.value).toBe(0);
    const message = decodeMachMessage(memory.readBytes(buffer, 28));
    expect(message.header.id).toBe(77);
    expect(Array.from(message.body)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("returns a timeout after an explicit tick", () => {
    const { memory, kernel, taskA, receiveName } = setup();
    const scheduler = new GuestScheduler(memory, { quantum: 16 });
    const bridge = new BlockingMachBridge(kernel, scheduler);
    const stack = memory.allocate(0x2000, { tag: "stack" });
    const a = scheduler.createThread({ entry: 0n, stackPointer: stack + 0x1ff0n });

    const run = () =>
      scheduler.run({
        maxInstructions: 1000,
        onTick: (now) => bridge.tick(now),
        syscallHandler: (thread, number) => {
          if (number === 100) {
            const received = bridge.receive(thread, taskA, receiveName, 5);
            if (received.blocked) return { value: 0, blocked: true };
            memory.write(DATA_ADDRESS, 4, received.status === 0 ? 1n : 2n);
            return { value: 0 };
          }
          if (number === 1) return { value: 0, halt: true };
          return { value: 0 };
        },
      });

    const first = run();
    expect(first.blocked).toBe(1);
    expect(bridge.waiterCount).toBe(1);
    bridge.tick(Date.now() + 1000);
    const second = run();
    expect(second.terminated).toBe(1);
    expect(memory.read(DATA_ADDRESS, 4)).toBe(2n);
    expect(a.state).toBe("terminated");
  });

  it("interrupts a parked receiver", () => {
    const { memory, kernel, taskA, receiveName } = setup();
    const scheduler = new GuestScheduler(memory, { quantum: 16 });
    const bridge = new BlockingMachBridge(kernel, scheduler);
    const stack = memory.allocate(0x2000, { tag: "stack" });
    const a = scheduler.createThread({ entry: 0n, stackPointer: stack + 0x1ff0n });

    const run = () =>
      scheduler.run({
        maxInstructions: 1000,
        syscallHandler: (thread, number) => {
          if (number === 100) {
            const received = bridge.receive(thread, taskA, receiveName, 0xffff_ffff);
            if (received.blocked) return { value: 0, blocked: true };
            memory.write(
              DATA_ADDRESS,
              4,
              BigInt(received.status === KERN_RECEIVE_INTERRUPTED ? 3 : 4),
            );
            return { value: 0 };
          }
          if (number === 1) return { value: 0, halt: true };
          return { value: 0 };
        },
      });

    expect(run().blocked).toBe(1);
    bridge.interrupt(a);
    expect(run().terminated).toBe(1);
    expect(memory.read(DATA_ADDRESS, 4)).toBe(3n);
  });
});
