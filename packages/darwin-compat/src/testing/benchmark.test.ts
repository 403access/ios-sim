import { describe, expect, it } from "vitest";
import { formatBenchmarkReport, machineMetadata, runBenchmarks } from "./benchmark.js";
import { standardBenchmarks } from "./benchmarks.js";

describe("performance baseline", () => {
  it("records machine metadata and passes generous budgets at a small scale", () => {
    const report = runBenchmarks(standardBenchmarks(), { scale: 0.01 });
    expect(report.machine.platform.length).toBeGreaterThan(0);
    expect(report.machine.arch.length).toBeGreaterThan(0);
    expect(report.machine.cores).toBeGreaterThan(0);
    expect(report.machine.memoryBytes).toBeGreaterThan(0);
    expect(report.machine.runtimeVersion.length).toBeGreaterThan(0);
    expect(report.results).toHaveLength(12);
    expect(report.passed).toBe(true);
    for (const result of report.results) {
      expect(result.iterations).toBeGreaterThan(0);
      expect(result.microsecondsPerOp).toBeGreaterThan(0);
      expect(result.passed).toBe(true);
    }
    const text = formatBenchmarkReport(report);
    expect(text).toContain("machine:");
    expect(text).toContain("scheduler-64-threads");
  });

  it("reports a budget failure instead of hiding it", () => {
    const report = runBenchmarks(
      [
        {
          name: "too-slow",
          iterations: 1,
          budgetMs: 0,
          run: () => {
            const until = performance.now() + 1;
            while (performance.now() < until) {
              // Spin deliberately.
            }
          },
        },
      ],
      { scale: 1 },
    );
    expect(report.passed).toBe(false);
    expect(report.results[0]?.passed).toBe(false);
  });

  it("builds metadata without a target run", () => {
    const machine = machineMetadata();
    expect(machine.runtime).toBe("bun");
    expect(machine.cpu.length).toBeGreaterThan(0);
  });
});
