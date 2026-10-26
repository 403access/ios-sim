import { describe, expect, it } from "vitest";
import { runSoak } from "./soak.js";
import { loaderSoakCase, machSoakCase, processSoakCase } from "./soak-cases.js";

describe("soak/leak harness", () => {
  it("keeps Mach, loader, and process resources flat under repeated cycles", () => {
    const report = runSoak([machSoakCase(), loaderSoakCase(), processSoakCase()], {
      durationMs: 600,
      intervalMs: 60,
    });
    expect(report.passed).toBe(true);
    for (const result of report.cases) {
      expect(result.steps).toBeGreaterThan(0);
      expect(result.samples.length).toBeGreaterThanOrEqual(2);
      expect(result.last).toEqual(result.first);
    }
  });

  it("fails visibly when a counter grows past its tolerance", () => {
    let counter = 0;
    const report = runSoak(
      [
        {
          name: "leaky",
          step: () => {
            counter += 1;
          },
          sample: () => ({ counter }),
          tolerance: { counter: 1 },
        },
      ],
      { durationMs: 100, intervalMs: 20 },
    );
    expect(report.passed).toBe(false);
    expect(report.cases[0]?.growth.counter).toBeGreaterThan(1);
  });
});
