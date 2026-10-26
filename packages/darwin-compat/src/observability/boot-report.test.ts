import { describe, expect, it } from "vitest";
import { ImageLoader, MapFileProvider } from "../dyld/loader.js";
import { buildDependentProgram, buildHello, buildOtherDylib } from "../testing/fixtures.js";
import { bootReport } from "./boot-report.js";

describe("boot report", () => {
  it("reports unresolved symbols with an actionable suggestion", () => {
    const loader = new ImageLoader({
      provider: new MapFileProvider(
        new Map([
          ["/hello", buildDependentProgram().bytes],
          ["/lib/libhelper.dylib", buildOtherDylib().bytes],
        ]),
      ),
      missingSymbols: "zero",
    });
    const program = loader.load("/hello");
    expect(program.missingSymbols).toEqual([{ image: "/hello", symbol: "_helper", ordinal: 1 }]);
    const report = bootReport(program);
    expect(report.ok).toBe(false);
    expect(report.missingSymbols[0]?.suggestion).toContain("dependency ordinal 1");
    expect(report.warnings.join(" ")).toContain("unresolved");
  });

  it("reports missing bootstrap services and succeeds when present", () => {
    const loader = new ImageLoader({
      provider: new MapFileProvider(new Map([["/hello", buildHello().bytes]])),
      missingSymbols: "zero",
    });
    const program = loader.load("/hello");
    const blocked = bootReport(program, { services: ["com.example.absent"] });
    expect(blocked.ok).toBe(false);
    expect(blocked.missingServices[0]?.service).toBe("com.example.absent");
    const ready = bootReport(program, {
      services: ["com.example.absent"],
      availableServices: ["com.example.absent"],
    });
    expect(ready.ok).toBe(true);
    expect(ready.warnings).toEqual([]);
  });

  it("is clean when every symbol and service resolves", () => {
    const loader = new ImageLoader({
      provider: new MapFileProvider(new Map([["/hello", buildHello().bytes]])),
      missingSymbols: "zero",
    });
    const report = bootReport(loader.load("/hello"));
    expect(report).toEqual({
      ok: true,
      images: ["/hello"],
      entitlements: null,
      missingSymbols: [],
      missingServices: [],
      warnings: [],
    });
  });
});
