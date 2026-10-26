import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_SCHEMA_VERSION,
  capabilityReport,
  validateCapabilityReport,
} from "./capabilities.js";

describe("capability doctor", () => {
  it("produces a valid report that explicitly does not ship a simulator", () => {
    const report = capabilityReport();
    expect(validateCapabilityReport(report)).toEqual([]);
    expect(report.schemaVersion).toBe(CAPABILITY_SCHEMA_VERSION);
    expect(report.simulator).toBe(false);
    expect(report.features.length).toBeGreaterThan(15);
    expect(report.features.find((entry) => entry.id === "apple.simulator")).toEqual({
      id: "apple.simulator",
      state: "no",
      detail: "no CoreSimulator/launchd_sim/SpringBoard boot",
    });
    expect(report.blocked.some((entry) => /Apple runtime|CoreSimulator/.test(entry.detail))).toBe(
      true,
    );
  });

  it("rejects malformed or over-claiming reports", () => {
    const report = capabilityReport();
    expect(validateCapabilityReport({ ...report, schemaVersion: 99 })).toContainEqual({
      path: "schemaVersion",
      message: "must be 1",
    });
    expect(validateCapabilityReport({ ...report, simulator: true })).toContainEqual({
      path: "simulator",
      message: "must be false for the research track",
    });
    expect(
      validateCapabilityReport({
        ...report,
        features: [{ id: "x", state: "maybe", detail: "" }],
      }).map((problem) => problem.path),
    ).toEqual(
      expect.arrayContaining([
        "features[0].state",
        "features[0].detail",
        "features.apple.simulator",
      ]),
    );
    expect(
      validateCapabilityReport({
        ...report,
        features: [...CAPABILITIES, CAPABILITIES[0]!],
      }).map((problem) => problem.message),
    ).toContain("duplicate id");
  });

  it("ships a JSON Schema with the same required fields and states", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "packages/darwin-compat/schema/capability-report.schema.json"),
        "utf8",
      ),
    ) as {
      required: string[];
      properties: { simulator: { const: boolean }; schemaVersion: { const: number } };
      $defs: { entry: { properties: { state: { enum: string[] } } } };
    };
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "service",
        "simulator",
        "features",
        "blocked",
        "notes",
      ]),
    );
    expect(schema.properties.simulator.const).toBe(false);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.$defs.entry.properties.state.enum).toEqual(["yes", "partial", "no"]);
  });
});
