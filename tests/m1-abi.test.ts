import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface AbiReport {
  readonly classes: ReadonlyArray<{
    readonly name: string;
    readonly superclass: string | null;
    readonly instanceSize: number;
    readonly ivars: ReadonlyArray<{ readonly name: string; readonly offset: number }>;
  }>;
  readonly emittedIvarPlaceholders: Readonly<Record<string, number>>;
  readonly ivarAccess: { readonly mechanism: string; readonly consequence: string };
  readonly needsReferenceRun: readonly string[];
  readonly unverified: readonly string[];
}

const report = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/ios-app/abi.json"), "utf8"),
) as AbiReport;

describe("M1 ABI measurements", () => {
  it("records the app's class layout with provenance", () => {
    const app = report.classes.find((klass) => klass.name === "AppDelegate");
    expect(app).toBeDefined();
    expect(app!.superclass).toBe("UIResponder");
    expect(app!.instanceSize).toBe(24);
    expect(app!.ivars.map((ivar) => ivar.name)).toEqual(["_window", "_label"]);
    expect(app!.ivars.map((ivar) => ivar.offset)).toEqual([8, 16]);
    expect(report.classes.some((klass) => klass.name === "SampleView")).toBe(true);
  });

  it("records ivar offsets as patched slots, not Apple sizes", () => {
    expect(report.emittedIvarPlaceholders.UIResponder).toBe(8);
    expect(report.ivarAccess.mechanism).toMatch(/runtime/);
    expect(report.ivarAccess.consequence).toMatch(/not baked/);
    expect(report.needsReferenceRun.length).toBeGreaterThan(0);
    expect(report.unverified.length).toBeGreaterThan(0);
  });
});
