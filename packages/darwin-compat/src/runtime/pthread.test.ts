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
import { PthreadShim } from "./pthread.js";

const DATA_ADDRESS = 0x1000n;

function workerProgram(iterations: number): Uint8Array {
  return words(
    adrp(9, Number(DATA_ADDRESS), 0),
    addImm(9, 9, Number(DATA_ADDRESS) & 0xfff),
    movz(1, 0),
    movz(16, 902),
    svc(0x80),
    ldrUnsigned(0, 9, 0, 2),
    addImm(0, 0, 1, { sf: false }),
    strUnsigned(0, 9, 0, 2),
    movz(16, 903),
    svc(0x80),
    addImm(1, 1, 1),
    cmpImm(1, iterations),
    bCond("ne", -36),
    movz(0, 0),
    movz(16, 1),
    svc(0x80),
  );
}

describe("PthreadShim", () => {
  it("runs eight guest workers under a mutex", () => {
    const memory = new VirtualMemory();
    memory.mapFixed(0n, 0x1000, { bytes: workerProgram(10), tag: "text", protection: 7 });
    memory.mapFixed(DATA_ADDRESS, 0x1000, { tag: "data", protection: 3 });
    const scheduler = new GuestScheduler(memory, { quantum: 32 });
    const shim = new PthreadShim(scheduler);
    const workers = Array.from({ length: 8 }, (_, index) =>
      shim.create(0n, { label: `worker-${index}` }),
    );

    const result = scheduler.run({
      maxInstructions: 100_000,
      syscallHandler: (thread, number) => {
        if (number === 902) {
          return shim.lock(thread, 1) ? { value: 0 } : { value: 0, blocked: true };
        }
        if (number === 903) {
          shim.unlock(thread, 1);
          return { value: 0 };
        }
        if (number === 1) return { value: 0, halt: true };
        return { value: 0 };
      },
    });

    expect(result.terminated).toBe(8);
    expect(memory.read(DATA_ADDRESS, 4)).toBe(80n);
    expect(workers.every((worker) => worker.state === "terminated")).toBe(true);
  });

  it("blocks a joiner until the target terminates", () => {
    const memory = new VirtualMemory();
    const scheduler = new GuestScheduler(memory);
    const shim = new PthreadShim(scheduler);
    const caller = shim.create(0n, { label: "caller" });
    const target = shim.create(0n, { label: "target" });

    expect(shim.join(caller, target)).toBe(false);
    expect(caller.state).toBe("blocked");
    scheduler.terminate(target, 0);
    expect(caller.state).toBe("runnable");
    expect(shim.join(caller, target)).toBe(true);
  });

  it("wakes a condition waiter", () => {
    const memory = new VirtualMemory();
    const scheduler = new GuestScheduler(memory);
    const shim = new PthreadShim(scheduler);
    const waiter = shim.create(0n);
    expect(shim.wait(waiter, 7, 1)).toBe(false);
    expect(waiter.state).toBe("blocked");
    expect(shim.signal(7)).toBe(true);
    expect(waiter.state).toBe("runnable");
  });
});
