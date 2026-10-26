import { describe, expect, it } from "vitest";
import { buildDependentProgram, buildHelperDylib, buildHello } from "../testing/fixtures.js";
import { formatLoaderDiagnostic } from "./diagnostics.js";
import { ImageLoader, MapFileProvider } from "./loader.js";

describe("loader diagnostics", () => {
  it("reports a missing file with a concrete next action", () => {
    const report = new ImageLoader({
      provider: new MapFileProvider(new Map()),
    }).diagnose("/missing");
    expect(report.ok).toBe(false);
    expect(report.program).toBeNull();
    expect(report.diagnostic).toMatchObject({
      code: "file_not_found",
      path: "/missing",
      stage: "read",
    });
    expect(report.diagnostic?.suggestion).toContain("FileProvider");
  });

  it("names the unresolved dependency", () => {
    const report = new ImageLoader({
      provider: new MapFileProvider(new Map([["/hello", buildDependentProgram().bytes]])),
    }).diagnose("/hello");
    expect(report.diagnostic).toMatchObject({
      code: "dependency_not_found",
      stage: "dependencies",
      dependency: "/lib/libhelper.dylib",
    });
    expect(report.diagnostic?.suggestion).toContain("@rpath");
  });

  it("distinguishes an executable from a dylib", () => {
    const report = new ImageLoader({
      provider: new MapFileProvider(new Map([["/lib/libhelper.dylib", buildHelperDylib().bytes]])),
    }).diagnose("/lib/libhelper.dylib");
    expect(report.diagnostic).toMatchObject({
      code: "not_executable",
      stage: "entry",
    });
    expect(report.diagnostic?.suggestion).toContain("loadDylib");
  });

  it("returns the loaded program on success and formats a failure", () => {
    const loader = new ImageLoader({
      provider: new MapFileProvider(new Map([["/hello", buildHello().bytes]])),
    });
    const report = loader.diagnose("/hello");
    expect(report.ok).toBe(true);
    expect(report.program?.images).toHaveLength(1);
    expect(report.stats.images).toBe(1);
    expect(report.diagnostic).toBeNull();

    const failure = new ImageLoader({
      provider: new MapFileProvider(new Map()),
    }).diagnose("/nope");
    const text = formatLoaderDiagnostic(failure.diagnostic!);
    expect(text).toContain("loader failed: file_not_found");
    expect(text).toContain("next:");
  });
});
