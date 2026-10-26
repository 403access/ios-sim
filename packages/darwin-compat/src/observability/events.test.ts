import { describe, expect, it } from "vitest";
import { MapFileProvider } from "../dyld/loader.js";
import { DarwinRuntime } from "../runtime/process.js";
import { buildHello } from "../testing/fixtures.js";
import {
  EventRecorder,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  ObservabilityError,
  jsonSafe,
  parseEventStream,
} from "./events.js";

function recorder(): EventRecorder {
  let id = 0;
  return new EventRecorder({
    now: () => new Date("2026-10-26T12:00:00.000Z"),
    nextId: () => `evt-${++id}`,
  });
}

describe("runtime event schema", () => {
  it("emits deterministic versioned JSON and redacts sensitive values", () => {
    const events = recorder();
    events.emit(
      EVENT_TYPES.processStart,
      {
        path: "/hello",
        token: "super-secret",
        entry: 0x1_0000_1000n,
        bytes: Uint8Array.from([1, 2, 3]),
        nested: { password: "nope", ok: true },
      },
      { pid: 42 },
    );
    expect(events.list()).toHaveLength(1);
    expect(events.list()[0]).toEqual({
      version: EVENT_SCHEMA_VERSION,
      id: "evt-1",
      time: "2026-10-26T12:00:00.000Z",
      type: "process.start",
      level: "info",
      pid: 42,
      data: {
        path: "/hello",
        token: "[redacted]",
        entry: "0x100001000",
        bytes: "base64:AQID",
        nested: { password: "[redacted]", ok: true },
      },
    });

    const parsed = JSON.parse(events.toJSON());
    expect(parsed.version).toBe(EVENT_SCHEMA_VERSION);
    expect(parsed.events).toHaveLength(1);
    expect(parseEventStream(events.toNDJSON())).toEqual(events.list());
  });

  it("rejects malformed events with stable codes", () => {
    const code = (value: unknown): string => {
      try {
        EventRecorder.prototype.emit.call(
          new EventRecorder(),
          typeof value === "string" ? value : "test",
          {},
        );
        return "no-error";
      } catch (error) {
        return (error as ObservabilityError).code;
      }
    };
    expect(code("")).toBe("bad_event");

    const events = recorder();
    expect(() => parseEventStream("{not json}")).toThrow(/not JSON/);
    const badVersion = JSON.stringify({
      version: 99,
      id: "x",
      time: "2026-10-26T00:00:00.000Z",
      type: "t",
      level: "info",
      data: {},
    });
    expect(() => parseEventStream(badVersion)).toThrow(/not 1/);
    const badLevel = JSON.stringify({
      version: 1,
      id: "x",
      time: "2026-10-26T00:00:00.000Z",
      type: "t",
      level: "loud",
      data: {},
    });
    expect(() => parseEventStream(badLevel)).toThrow(/unknown event level/);
    expect(events.list()).toHaveLength(0);
  });

  it("caps retained events and converts values safely", () => {
    const events = new EventRecorder({ maxEvents: 2, nextId: () => "id" });
    events.emit("one");
    events.emit("two");
    events.emit("three");
    expect(events.list().map((event) => event.type)).toEqual(["two", "three"]);
    expect(jsonSafe(Number.NaN)).toBe("NaN");
    expect(jsonSafe(undefined)).toBeNull();
    expect(jsonSafe(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("emits process start and exit from the runtime", () => {
    const events = recorder();
    const runtime = new DarwinRuntime({
      provider: new MapFileProvider(new Map([["/hello", buildHello().bytes]])),
    });
    const result = runtime.run("/hello", { events });
    expect(result.exitStatus).toBe(42);
    expect(events.list().map((event) => event.type)).toEqual([
      EVENT_TYPES.processStart,
      EVENT_TYPES.processExit,
    ]);
    expect(events.list()[1]?.data).toMatchObject({ status: 42 });
    expect(events.list()[0]?.data).toMatchObject({ images: ["/hello"], initializers: 0 });
  });
});
