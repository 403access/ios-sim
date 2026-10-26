import { describe, expect, it } from "vitest";
import { EventRecorder, EVENT_TYPES } from "./events.js";
import { filterEvents, matchesType, parseList, summarizeEvents } from "./trace-filter.js";

function events(): EventRecorder {
  const recorder = new EventRecorder({
    nextId: (() => {
      let i = 0;
      return () => `e${++i}`;
    })(),
  });
  recorder.emit(EVENT_TYPES.processStart, {}, { pid: 1, level: "info" });
  recorder.emit(EVENT_TYPES.syscallUnsupported, { syscall: 1 }, { pid: 1, level: "warn" });
  recorder.emit(EVENT_TYPES.processExit, {}, { pid: 1, level: "info" });
  recorder.emit(EVENT_TYPES.imageLoad, {}, { pid: 2, level: "debug" });
  return recorder;
}

describe("trace filtering", () => {
  it("matches exact and wildcard type patterns", () => {
    expect(matchesType("process.start", ["process.*"])).toBe(true);
    expect(matchesType("process.start", ["process.start"])).toBe(true);
    expect(matchesType("process.start", ["syscall.*"])).toBe(false);
    expect(matchesType("anything", undefined)).toBe(true);
    expect(parseList("a, b,,c")).toEqual(["a", "b", "c"]);
  });

  it("filters by type, level, pid, and limit", () => {
    const recorder = events();
    expect(
      filterEvents(recorder.list(), { types: ["process.*"] }).map((event) => event.type),
    ).toEqual(["process.start", "process.exit"]);
    expect(filterEvents(recorder.list(), { levels: ["warn"] })).toHaveLength(1);
    expect(filterEvents(recorder.list(), { pid: 2 })).toHaveLength(1);
    expect(filterEvents(recorder.list(), { limit: 2 })).toHaveLength(2);
  });

  it("summarizes kept events against the total", () => {
    const recorder = events();
    const kept = filterEvents(recorder.list(), { pid: 1 });
    expect(summarizeEvents(recorder.list(), kept)).toMatchObject({
      total: 4,
      kept: 3,
      byType: { "process.start": 1, "syscall.unsupported": 1, "process.exit": 1 },
      byLevel: { info: 2, warn: 1 },
    });
  });
});
