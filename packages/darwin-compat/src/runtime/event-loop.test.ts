import { describe, expect, it } from "vitest";
import { movz, svc, words } from "../arm64/assembler.js";
import { VirtualMemory } from "../dyld/vm.js";
import { GuestEventLoop } from "./event-loop.js";
import { GuestScheduler } from "./scheduler.js";

describe("GuestEventLoop", () => {
  it("parks a timer waiter and wakes at the deadline", () => {
    const memory = new VirtualMemory();
    const scheduler = new GuestScheduler(memory);
    const stack = memory.allocate(0x1000, { tag: "stack" });
    const thread = scheduler.createThread({ entry: 0n, stackPointer: stack + 0xff0n });
    let now = 1000;
    const loop = new GuestEventLoop(scheduler, () => now);
    const timer = loop.scheduleTimer(10, thread);
    expect(thread.state).toBe("blocked");
    expect(loop.tick(now + 5)).toBe(0);
    now += 10;
    expect(loop.tick(now)).toBe(1);
    expect(thread.state).toBe("runnable");
    expect(loop.isTimerFired(timer)).toBe(true);
  });

  it("wakes a source waiter without polling", () => {
    const memory = new VirtualMemory();
    const scheduler = new GuestScheduler(memory);
    const stack = memory.allocate(0x1000, { tag: "stack" });
    const thread = scheduler.createThread({ entry: 0n, stackPointer: stack + 0xff0n });
    const loop = new GuestEventLoop(scheduler, () => 0);
    expect(loop.waitSource(thread, "read")).toBe(false);
    expect(thread.state).toBe("blocked");
    loop.notify("read");
    expect(thread.state).toBe("runnable");
    expect(loop.waitSource(thread, "read")).toBe(true);
  });

  it("integrates with a guest syscall and scheduler tick", () => {
    const memory = new VirtualMemory();
    memory.mapFixed(0n, 0x1000, {
      bytes: words(movz(16, 920), svc(0x80), movz(0, 0), movz(16, 1), svc(0x80)),
      tag: "text",
      protection: 7,
    });
    let now = 0;
    const scheduler = new GuestScheduler(memory);
    const loop = new GuestEventLoop(scheduler, () => now);
    const stack = memory.allocate(0x1000, { tag: "stack" });
    const thread = scheduler.createThread({ entry: 0n, stackPointer: stack + 0xff0n });
    const timers = new Map<number, number>();
    const run = () =>
      scheduler.run({
        maxInstructions: 1000,
        onTick: () => loop.tick(now),
        syscallHandler: (current, number) => {
          if (number === 920) {
            const existing = timers.get(current.id);
            if (existing === undefined) {
              const id = loop.scheduleTimer(10, current);
              timers.set(current.id, id);
              return { value: 0, blocked: true };
            }
            return { value: loop.waitTimer(current, existing) ? 0 : 1 };
          }
          if (number === 1) return { value: 0, halt: true };
          return { value: 0 };
        },
      });

    expect(run().blocked).toBe(1);
    now = 10;
    expect(loop.tick(now)).toBe(1);
    expect(run().terminated).toBe(1);
    expect(thread.state).toBe("terminated");
  });
});
