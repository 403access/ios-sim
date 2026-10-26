import { describe, expect, it } from "vitest";
import { movz, svc, words } from "../arm64/assembler.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { BlockingMachBridge } from "./blocking.js";
import { ProcessTable } from "./process-table.js";
import { GuestScheduler } from "./scheduler.js";

const RECEIVERS = 32;
const SENDERS = 32;

function program(syscallNumber: number): Uint8Array {
  return words(movz(16, syscallNumber), svc(0x80), movz(16, 1), svc(0x80));
}

describe("QA-005 concurrency suite", () => {
  it("wakes 32 Mach receivers from 32 senders without deadlock", () => {
    const memory = new VirtualMemory();
    memory.mapFixed(0n, 0x1000, { bytes: program(100), tag: "recv", protection: 7 });
    memory.mapFixed(0x2000n, 0x1000, { bytes: program(101), tag: "send", protection: 7 });
    const kernel = new MachKernel();
    const receiverTask = kernel.createTask(1);
    const senderTask = kernel.createTask(2);
    const { name: receiveName, portId } = kernel.insertReceiveRight(receiverTask, "stress");
    const sendName = kernel.insertSendRight(senderTask, portId);
    const scheduler = new GuestScheduler(memory, { quantum: 8 });
    const bridge = new BlockingMachBridge(kernel, scheduler);
    const stack = memory.allocate(0x4000, { tag: "stress-stacks" });
    let received = 0;

    for (let index = 0; index < RECEIVERS; index += 1) {
      scheduler.createThread({
        entry: 0n,
        stackPointer: stack + 0x3ff0n,
        label: `receiver-${index}`,
      });
    }
    for (let index = 0; index < SENDERS; index += 1) {
      scheduler.createThread({
        entry: 0x2000n,
        stackPointer: stack + 0x3ff0n,
        label: `sender-${index}`,
      });
    }

    const result = scheduler.run({
      maxInstructions: 100_000,
      deadlineMs: 5000,
      onTick: (now) => bridge.tick(now),
      syscallHandler: (thread, number) => {
        if (number === 100) {
          const outcome = bridge.receive(thread, receiverTask, receiveName, 1000);
          if (outcome.blocked) return { value: 0, blocked: true };
          if (outcome.message) received += 1;
          return { value: 0 };
        }
        if (number === 101) {
          bridge.send(senderTask, sendName, 0, 1, Uint8Array.from([1, 0, 0, 0]));
          return { value: 0 };
        }
        if (number === 1) return { value: 0, halt: true };
        return { value: 0 };
      },
    });

    expect(result.reason).toBe("idle");
    expect(result.terminated).toBe(RECEIVERS + SENDERS);
    expect(result.blocked).toBe(0);
    expect(result.runnable).toBe(0);
    expect(received).toBe(RECEIVERS);
  });

  it("forks 8 processes with 8 threads each and reaps them all", () => {
    const memory = new VirtualMemory();
    const stack = memory.allocate(0x2000, { tag: "root-stack" });
    memory.mapFixed(0x4_0000_0000n, 0x1000, {
      bytes: words(movz(16, 1), svc(0x80)),
      tag: "root-text",
      protection: 7,
    });
    const scheduler = new GuestScheduler(memory);
    scheduler.createThread({
      entry: 0x4_0000_0000n,
      stackPointer: stack + 0x1ff0n,
      label: "root",
    });
    const table = new ProcessTable();
    const root = table.spawn(memory, scheduler);

    const children = [];
    for (let index = 0; index < 8; index += 1) {
      const child = table.fork(root.pid);
      for (let thread = 1; thread < 8; thread += 1) {
        child.scheduler.createThread({
          entry: 0x4_0000_0000n,
          stackPointer: stack + 0x1ff0n,
          label: `child-${index}-${thread}`,
        });
      }
      children.push(child);
    }
    expect(table.list()).toHaveLength(9);

    for (const child of children) {
      const result = table.run(child.pid, {
        maxInstructions: 10_000,
        deadlineMs: 5000,
        syscallHandler: () => ({ value: 0, halt: true }),
      });
      expect(result.status).toBe(0);
      expect(child.state).toBe("exited");
    }
    for (let index = 0; index < children.length; index += 1) {
      expect(table.waitpid(root.pid, -1)?.status).toBe(0);
    }
    expect(table.list()).toHaveLength(1);
    expect(root.children.size).toBe(0);
  });

  it("interrupts parked receivers instead of leaving them blocked", () => {
    const memory = new VirtualMemory();
    memory.mapFixed(0n, 0x1000, { bytes: program(100), tag: "recv", protection: 7 });
    const kernel = new MachKernel();
    const task = kernel.createTask(1);
    const { name } = kernel.insertReceiveRight(task, "interrupt");
    const scheduler = new GuestScheduler(memory, { quantum: 4 });
    const bridge = new BlockingMachBridge(kernel, scheduler);
    const stack = memory.allocate(0x4000, { tag: "stacks" });
    const threads = [];
    for (let index = 0; index < 16; index += 1) {
      threads.push(
        scheduler.createThread({
          entry: 0n,
          stackPointer: stack + 0x3ff0n,
          label: `receiver-${index}`,
        }),
      );
    }

    scheduler.run({
      maxInstructions: 1000,
      syscallHandler: (thread, number) => {
        if (number === 100) {
          const outcome = bridge.receive(thread, task, name, 1000);
          if (outcome.blocked) return { value: 0, blocked: true };
          return { value: 0 };
        }
        if (number === 1) return { value: 0, halt: true };
        return { value: 0 };
      },
    });
    expect(threads.every((thread) => thread.state === "blocked")).toBe(true);
    for (const thread of threads) bridge.interrupt(thread);
    const result = scheduler.run({
      maxInstructions: 1000,
      syscallHandler: (thread, number) => {
        if (number === 100) {
          const outcome = bridge.receive(thread, task, name, 1000);
          if (outcome.blocked) return { value: 0, blocked: true };
          return { value: 0 };
        }
        if (number === 1) return { value: 0, halt: true };
        return { value: 0 };
      },
    });
    expect(result.terminated).toBe(16);
    expect(result.blocked).toBe(0);
  });
});
