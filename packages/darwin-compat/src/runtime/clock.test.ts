import { describe, expect, it } from "vitest";
import { VirtualMemory } from "../dyld/vm.js";
import { GuestClock, CLOCK_MONOTONIC, CLOCK_REALTIME, GuestEventLoop } from "./index.js";
import { GuestScheduler } from "./scheduler.js";

describe("GuestClock", () => {
  it("reports realtime, monotonic, and timebase conversions", () => {
    let now = 1000;
    const clock = new GuestClock({ now: () => now, timebase: { numer: 1, denom: 2 } });
    expect(clock.now(CLOCK_REALTIME)).toBe(1_000_000_000n);
    expect(clock.now(CLOCK_MONOTONIC)).toBe(0n);
    now += 10;
    expect(clock.now(CLOCK_MONOTONIC)).toBe(10_000_000n);
    expect(clock.absoluteTime()).toBe(20_000_000n);
    expect(clock.absoluteToNanoseconds(20_000_000n)).toBe(10_000_000n);
    expect(clock.deadlineFromNow(5)).toBe(15_000_000n);
  });

  it("sleeps by parking on an event-loop timer", () => {
    let now = 0;
    const memory = new VirtualMemory();
    const scheduler = new GuestScheduler(memory);
    const loop = new GuestEventLoop(scheduler, () => now);
    const clock = new GuestClock({ now: () => now });
    const stack = memory.allocate(0x1000, { tag: "stack" });
    const thread = scheduler.createThread({ entry: 0n, stackPointer: stack + 0xff0n });
    const timer = clock.sleep(thread, 25, loop);
    expect(thread.state).toBe("blocked");
    now = 25;
    expect(loop.tick(now)).toBe(1);
    expect(thread.state).toBe("runnable");
    expect(loop.isTimerFired(timer)).toBe(true);
  });
});
