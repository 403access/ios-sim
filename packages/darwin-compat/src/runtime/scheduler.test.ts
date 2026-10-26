import { describe, expect, it } from "vitest";
import {
  addImm,
  adrp,
  bCond,
  cmpImm,
  ldrUnsigned,
  movz,
  strUnsigned,
  svc,
  words,
} from "../arm64/assembler.js";
import { VirtualMemory } from "../dyld/vm.js";
import { GuestScheduler } from "./scheduler.js";

const CODE_ADDRESS = 0n;
const DATA_ADDRESS = 0x1000n;

function incrementProgram(dataAddress: number, iterations: number, pc = 0): Uint8Array {
  // x9 = data address; loop: load/increment/store; x1++; cmp; b.ne; exit(0)
  return words(
    adrp(9, dataAddress, pc),
    addImm(9, 9, dataAddress & 0xfff),
    movz(1, 0),
    ldrUnsigned(0, 9, 0, 2),
    addImm(0, 0, 1, { sf: false }),
    strUnsigned(0, 9, 0, 2),
    addImm(1, 1, 1),
    cmpImm(1, iterations),
    bCond("ne", -20),
    movz(0, 0),
    movz(16, 1),
    svc(0x80),
  );
}

function setup() {
  const memory = new VirtualMemory();
  const codeA = incrementProgram(Number(DATA_ADDRESS), 4);
  const codeB = incrementProgram(Number(DATA_ADDRESS) + 4, 4, 0x2000);
  memory.mapFixed(CODE_ADDRESS, 0x1000, { bytes: codeA, tag: "text-a", protection: 7 });
  memory.mapFixed(0x2000n, 0x1000, { bytes: codeB, tag: "text-b", protection: 7 });
  memory.mapFixed(DATA_ADDRESS, 0x1000, { tag: "data", protection: 3 });
  return memory;
}

describe("GuestScheduler", () => {
  it("round-robins two threads over shared memory", () => {
    const memory = setup();
    const scheduler = new GuestScheduler(memory, { quantum: 8 });
    const stackA = memory.allocate(0x2000, { tag: "stack-a" });
    const stackB = memory.allocate(0x2000, { tag: "stack-b" });
    const a = scheduler.createThread({
      entry: CODE_ADDRESS,
      stackPointer: stackA + 0x1ff0n,
      label: "a",
    });
    const b = scheduler.createThread({
      entry: 0x2000n,
      stackPointer: stackB + 0x1ff0n,
      label: "b",
    });

    const result = scheduler.run({
      maxInstructions: 10_000,
      syscallHandler: (_thread, number, cpu) => {
        if (number === 1) return { value: 0, halt: true };
        return { value: 0 };
      },
    });

    expect(result.terminated).toBe(2);
    expect(result.switches).toBeGreaterThan(2);
    expect(a.exitStatus).toBe(0);
    expect(b.exitStatus).toBe(0);
    expect(memory.read(DATA_ADDRESS, 4)).toBe(4n);
    expect(memory.read(DATA_ADDRESS + 4n, 4)).toBe(4n);
  });

  it("blocks one thread and resumes it when another unblocks it", () => {
    const memory = setup();
    const scheduler = new GuestScheduler(memory, { quantum: 16 });
    const stackA = memory.allocate(0x2000, { tag: "stack-a" });
    const stackB = memory.allocate(0x2000, { tag: "stack-b" });

    const blockingProgram = words(movz(16, 999), svc(0x80), movz(0, 0), movz(16, 1), svc(0x80));
    memory.mapFixed(0x2000n, 0x1000, { bytes: blockingProgram, tag: "block-text", protection: 7 });
    const unblockingProgram = words(movz(16, 998), svc(0x80), movz(0, 0), movz(16, 1), svc(0x80));
    memory.mapFixed(0x3000n, 0x1000, {
      bytes: unblockingProgram,
      tag: "unblock-text",
      protection: 7,
    });

    const waiter = scheduler.createThread({
      entry: 0x2000n,
      stackPointer: stackA + 0x1ff0n,
      label: "waiter",
    });
    const waker = scheduler.createThread({
      entry: 0x3000n,
      stackPointer: stackB + 0x1ff0n,
      label: "waker",
    });
    let blockedSeen = false;
    let unblockedSeen = false;

    const result = scheduler.run({
      maxInstructions: 1000,
      syscallHandler: (thread, number, cpu) => {
        if (number === 999) {
          scheduler.block(thread, "test-wait");
          blockedSeen = true;
          return { value: 0 };
        }
        if (number === 998) {
          scheduler.unblock(waiter);
          unblockedSeen = true;
          return { value: 0 };
        }
        if (number === 1) return { value: 0, halt: true };
        return { value: 0 };
      },
    });

    expect(blockedSeen).toBe(true);
    expect(unblockedSeen).toBe(true);
    expect(waiter.state).toBe("terminated");
    expect(waker.state).toBe("terminated");
    expect(result.terminated).toBe(2);
  });

  it("reports a budget stop instead of hanging", () => {
    const memory = new VirtualMemory();
    const loop = words(movz(0, 0), bCond("al", -4));
    memory.mapFixed(0n, 0x1000, { bytes: loop, tag: "loop", protection: 7 });
    const scheduler = new GuestScheduler(memory, { quantum: 32 });
    const stack = memory.allocate(0x1000, { tag: "stack" });
    scheduler.createThread({ entry: 0n, stackPointer: stack + 0xff0n });
    const result = scheduler.run({ maxInstructions: 100, syscallHandler: () => ({ value: 0 }) });
    expect(result.reason).toBe("budget");
    expect(result.instructions).toBe(100);
  });
});
