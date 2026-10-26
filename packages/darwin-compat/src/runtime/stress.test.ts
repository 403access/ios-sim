import { describe, expect, it } from "vitest";
import { bCond, movz, subImm, svc, words } from "../arm64/assembler.js";
import { VirtualMemory } from "../dyld/vm.js";
import { ProcessTable } from "./process-table.js";
import { GuestScheduler } from "./scheduler.js";

const THREADS = 64;
const ITERATIONS = 4000;

function threadProgram(): Uint8Array {
  return words(subImm(0, 0, 1, { setFlags: true }), bCond("ne", -4), movz(16, 1), svc(0x80));
}

describe("THR-012 concurrency stress", () => {
  it("schedules 64 guest threads to completion without leaks", () => {
    const memory = new VirtualMemory();
    const stack = memory.allocate(0x1000, { tag: "stress-stack" });
    memory.mapFixed(0x4_0000_0000n, 0x1000, {
      bytes: threadProgram(),
      tag: "stress-text",
      protection: 7,
    });
    const scheduler = new GuestScheduler(memory, { quantum: 16 });
    for (let index = 0; index < THREADS; index += 1) {
      scheduler.createThread({
        entry: 0x4_0000_0000n,
        stackPointer: stack + 0xff0n,
        argument: BigInt(ITERATIONS),
        label: `stress-${index}`,
      });
    }

    const result = scheduler.run({
      maxInstructions: THREADS * (ITERATIONS * 2 + 16),
      syscallHandler: (_thread, number) => (number === 1 ? { value: 0, halt: true } : { value: 0 }),
    });
    expect(result.reason).toBe("idle");
    expect(result.terminated).toBe(THREADS);
    expect(result.runnable).toBe(0);
    expect(result.blocked).toBe(0);
    expect(result.switches).toBeGreaterThanOrEqual(THREADS);
    expect(scheduler.listThreads()).toHaveLength(THREADS);
  });

  it("forks, exits, and reaps 64 processes", () => {
    const memory = new VirtualMemory();
    const stack = memory.allocate(0x1000, { tag: "root-stack" });
    const scheduler = new GuestScheduler(memory);
    scheduler.createThread({
      entry: 0x4_0000_1000n,
      stackPointer: stack + 0xff0n,
      label: "root",
    });
    memory.mapFixed(0x4_0000_1000n, 0x1000, {
      bytes: words(movz(0, 0), movz(16, 1), svc(0x80)),
      tag: "root-text",
      protection: 7,
    });
    const table = new ProcessTable();
    const root = table.spawn(memory, scheduler);

    const children = [];
    for (let index = 0; index < 64; index += 1) {
      children.push(table.fork(root.pid));
    }
    expect(table.list()).toHaveLength(65);

    for (const child of children) {
      const result = table.run(child.pid, {
        maxInstructions: 100,
        syscallHandler: () => ({ value: 0, halt: true }),
      });
      expect(result.status).toBe(0);
      expect(child.state).toBe("exited");
    }

    for (let index = 0; index < children.length; index += 1) {
      const reaped = table.waitpid(root.pid, -1);
      expect(reaped).not.toBeNull();
      expect(reaped?.status).toBe(0);
    }
    expect(table.list()).toHaveLength(1);
    expect(table.list()[0]?.pid).toBe(root.pid);
    expect(root.children.size).toBe(0);
  });
});
