import { describe, expect, it } from "vitest";
import { RUNTIME_CONFORMANCE_COUNT, runtimeConformanceCases } from "./suite.js";

describe("runtime conformance suite", () => {
  it("passes all 200 deterministic cases", () => {
    const cases = runtimeConformanceCases();
    expect(cases).toHaveLength(RUNTIME_CONFORMANCE_COUNT);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(RUNTIME_CONFORMANCE_COUNT);
    let passed = 0;
    for (const entry of cases) {
      expect(entry.run(), entry.id).toBe(true);
      passed += 1;
    }
    expect(passed).toBe(RUNTIME_CONFORMANCE_COUNT);
  });
});
