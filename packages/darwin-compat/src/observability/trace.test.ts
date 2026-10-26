import { describe, expect, it } from "vitest";
import { EventRecorder, EVENT_TYPES } from "./events.js";
import { chromeTraceJSON, exportChromeTrace } from "./trace.js";

function recorder(): EventRecorder {
  let index = 0;
  let id = 0;
  const times = [
    "2026-10-26T12:00:00.000Z",
    "2026-10-26T12:00:00.010Z",
    "2026-10-26T12:00:00.025Z",
  ];
  return new EventRecorder({
    now: () => new Date(times[Math.min(index++, times.length - 1)]!),
    nextId: () => `evt-${++id}`,
  });
}

describe("Chrome trace export", () => {
  it("turns process start/exit into a complete slice and other events into instants", () => {
    const events = recorder();
    events.emit(EVENT_TYPES.processStart, { image: "/hello" }, { pid: 7 });
    events.emit(EVENT_TYPES.syscallUnsupported, { syscall: 999 }, { pid: 7 });
    events.emit(EVENT_TYPES.processExit, { status: 0 }, { pid: 7 });

    const trace = exportChromeTrace(events.list());
    expect(trace.displayTimeUnit).toBe("ms");
    expect(trace.traceEvents).toHaveLength(2);
    const slice = trace.traceEvents.find((event) => event.ph === "X");
    expect(slice).toMatchObject({ name: "process", pid: 7, ts: 0, dur: 25_000 });
    const instant = trace.traceEvents.find((event) => event.ph === "i");
    expect(instant).toMatchObject({ name: "syscall.unsupported", ts: 10_000, s: "t" });
    expect(instant?.args).toMatchObject({ syscall: 999, id: "evt-2" });
  });

  it("closes an unmatched process start with zero duration", () => {
    const events = recorder();
    events.emit(EVENT_TYPES.processStart, { image: "/hello" }, { pid: 3 });
    const trace = exportChromeTrace(events.list());
    expect(trace.traceEvents[0]).toMatchObject({ ph: "X", dur: 0, pid: 3 });
    expect(trace.traceEvents[0]?.args).toMatchObject({ exit: null });
  });

  it("emits valid JSON with metadata", () => {
    const events = recorder();
    events.emit(EVENT_TYPES.imageLoad, { path: "/a" }, { pid: 1 });
    const parsed = JSON.parse(chromeTraceJSON(events.list()));
    expect(parsed.metadata).toEqual({ source: "ios-sim-native", eventCount: 1 });
    expect(parsed.traceEvents).toHaveLength(1);
  });
});
