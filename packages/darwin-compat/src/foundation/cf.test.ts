import { describe, expect, it } from "vitest";
import { NSArray, NSDictionary, NSString } from "./collections.js";
import { CFBridging, CFRunLoop } from "./cf.js";

describe("CF bridging and run loop", () => {
  it("bridges toll-free and tracks retain/release", () => {
    const bridging = new CFBridging();
    const string = NSString.from("hello");
    const ref = bridging.bridgeRetain(string);
    expect(ref.kind).toBe("string");
    expect(ref.typeId).toBe(bridging.typeID("string"));
    expect(bridging.toObject<NSString>(ref)).toBe(string);
    bridging.retain(ref);
    expect(bridging.release(ref)).toBe(false);
    expect(bridging.release(ref)).toBe(true);
    expect(ref.deallocated).toBe(true);
    expect(() => bridging.toObject(ref)).toThrow(/released/);
    const array = bridging.fromObject(NSArray.from([1, 2]));
    const dictionary = bridging.fromObject(new NSDictionary({ a: 1 }));
    expect([array.typeId, dictionary.typeId]).toEqual([2, 3]);
  });

  it("fires timers in deadline order and repeats intervals", () => {
    let now = 100;
    const loop = new CFRunLoop(() => now);
    const order: string[] = [];
    loop.schedule(20, () => order.push("late"));
    loop.schedule(5, () => order.push("early"));
    loop.schedule(10, () => order.push("repeat"), 10);
    expect(loop.runOnce(now)).toBe(0);
    now = 105;
    expect(loop.runOnce(now)).toBe(1);
    expect(order).toEqual(["early"]);
    now = 110;
    expect(loop.runOnce(now)).toBe(1);
    expect(order).toEqual(["early", "repeat"]);
    now = 120;
    expect(loop.runOnce(now)).toBe(2);
    expect(order.filter((entry) => entry === "repeat")).toHaveLength(2);
    expect(order).toContain("late");
    expect(loop.pendingTimers().map((timer) => timer.intervalMs)).toEqual([10]);
  });

  it("wakes named sources, stops, and rejects bad source names", () => {
    const loop = new CFRunLoop(() => 0);
    let woke = 0;
    loop.addSource("read", () => {
      woke += 1;
    });
    expect(loop.signalSource("read")).toBe(true);
    expect(loop.runOnce()).toBe(1);
    expect(woke).toBe(1);
    expect(loop.runOnce()).toBe(0);
    expect(loop.signalSource("missing")).toBe(false);
    expect(() => loop.addSource("", () => {})).toThrow(/empty/);
    loop.schedule(0, () => loop.stop());
    loop.runOnce();
    expect(loop.runOnce()).toBe(0);
    loop.reset();
    expect(loop.runOnce()).toBe(0);
  });
});
