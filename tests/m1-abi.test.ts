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
  readonly derivedSuperclassSize: Readonly<Record<string, number>>;
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
  });

  it("derives UIResponder's size and keeps unverified areas explicit", () => {
    expect(report.derivedSuperclassSize.UIResponder).toBe(8);
    expect(report.unverified.length).toBeGreaterThan(0);
    expect(report.unverified.join(" ")).toMatch(/UIView/);
  });
});
