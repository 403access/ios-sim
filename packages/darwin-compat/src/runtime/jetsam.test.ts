import { describe, expect, it } from "vitest";
import { Jetsam, type PressureEvent } from "./jetsam.js";

describe("jetsam policy", () => {
  it("notifies on warning pressure without killing", () => {
    const events: PressureEvent[] = [];
    const killed: number[] = [];
    const jetsam = new Jetsam({
      notify: (event) => events.push(event),
      kill: (pid) => killed.push(pid),
    });
    jetsam.register(1, 100, "background");
    jetsam.register(2, 200, "daemon");
    jetsam.register(3, 50, "foreground");
    const result = jetsam.applyPressure("warning", 100);
    expect(result.killed).toEqual([]);
    expect(result.remainingBytes).toBe(350);
    expect(events).toHaveLength(3);
    expect(killed).toEqual([]);
  });

  it("kills background, then daemons, and keeps foreground when possible", () => {
    const killed: number[] = [];
    const jetsam = new Jetsam({ kill: (pid) => killed.push(pid) });
    jetsam.register(1, 100, "background");
    jetsam.register(2, 200, "daemon");
    jetsam.register(3, 50, "foreground");
    const result = jetsam.applyPressure("critical", 220);
    expect(result.killed).toEqual([1, 2]);
    expect(killed).toEqual([1, 2]);
    expect(result.remainingBytes).toBe(50);
    expect(jetsam.list().map((task) => task.pid)).toEqual([3]);
  });

  it("kills foreground only when the limit cannot otherwise be met", () => {
    const jetsam = new Jetsam();
    jetsam.register(10, 300, "foreground");
    jetsam.register(11, 200, "foreground");
    const result = jetsam.applyPressure("critical", 100);
    expect(result.killed).toEqual([10, 11]);
    expect(result.remainingBytes).toBe(0);
  });

  it("tracks footprint and priority updates", () => {
    const jetsam = new Jetsam();
    jetsam.register(1, 10, "foreground");
    jetsam.setFootprint(1, 400);
    jetsam.setPriority(1, "background");
    expect(jetsam.totalFootprint()).toBe(400);
    expect(jetsam.list()[0]).toEqual({ pid: 1, footprintBytes: 400, priority: "background" });
    jetsam.unregister(1);
    expect(jetsam.totalFootprint()).toBe(0);
  });
});
