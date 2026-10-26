import { describe, expect, it } from "vitest";
import { MapFileProvider } from "../dyld/loader.js";
import { DarwinRuntime } from "../runtime/process.js";
import { buildHello } from "../testing/fixtures.js";
import { RuntimeStats, RUNTIME_COUNTER_NAMES } from "./stats.js";

describe("runtime statistics", () => {
  it("counts processes, images, instructions, syscalls, and output", () => {
    const runtime = new DarwinRuntime({
      provider: new MapFileProvider(new Map([["/hello", buildHello().bytes]])),
    });
    const result = runtime.run("/hello");
    const stats = runtime.stats.snapshot();
    expect(result.exitStatus).toBe(42);
    expect(stats.processesStarted).toBe(1);
    expect(stats.processesExited).toBe(1);
    expect(stats.imagesLoaded).toBe(1);
    expect(stats.instructions).toBe(result.instructions);
    expect(stats.syscalls).toBeGreaterThanOrEqual(2);
    expect(stats.bytesStdout).toBe("hello from darwin\n".length);
    expect(stats.loaderErrors).toBe(0);
    expect(stats.unsupportedSyscalls).toBe(0);
    expect(Object.keys(stats).sort()).toEqual([...RUNTIME_COUNTER_NAMES].sort());
  });

  it("counts loader failures without starting a process", () => {
    const runtime = new DarwinRuntime({ provider: new MapFileProvider(new Map()) });
    expect(() => runtime.run("/missing")).toThrow();
    const stats = runtime.stats.snapshot();
    expect(stats.loaderErrors).toBe(1);
    expect(stats.processesStarted).toBe(0);
    expect(stats.processesExited).toBe(0);
  });

  it("resets and increments counters directly", () => {
    const stats = new RuntimeStats();
    stats.increment("instructions", 7);
    stats.increment("instructions", 3);
    expect(stats.get("instructions")).toBe(10);
    stats.reset();
    expect(stats.snapshot().instructions).toBe(0);
  });
});
