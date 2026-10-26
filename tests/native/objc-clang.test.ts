import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DarwinRuntime,
  MapFileProvider,
  buildUIKitDemo,
  type InputEvent,
} from "@ios-sim/darwin-compat";

const root = join(import.meta.dirname, "../..");
const output = mkdtempSync(join(tmpdir(), "objc-clang-"));
afterAll(() => rmSync(output, { recursive: true, force: true }));

const hasClang = spawnSync("clang", ["--version"], { encoding: "utf8" }).status === 0;
const available = process.platform === "darwin" && hasClang;
if (!available) {
  console.warn(
    `skip real-clang ObjC test: platform=${process.platform}, clang=${hasClang ? "present" : "missing"}; ` +
      "the generated ObjC fixture still runs everywhere",
  );
}

describe.skipIf(!available)("real clang ObjC app", () => {
  it("renders the same tap, drag, and tick sequences as the generated app", () => {
    const build = spawnSync("bash", [join(root, "scripts/build-objc-fixture.sh"), output], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    const scenarios: Array<{ label: string; events: InputEvent[]; frameCount: number }> = [
      { label: "tap", events: [{ x: 30, y: 30 }], frameCount: 3 },
      {
        label: "drag",
        events: [{ fromX: 30, fromY: 30, toX: 60, toY: 60, steps: 3 }],
        frameCount: 4,
      },
      {
        label: "ticks",
        events: [{ kind: "tick" }, { kind: "tick" }, { kind: "tick" }, { kind: "tick" }],
        frameCount: 5,
      },
    ];

    const demo = buildUIKitDemo();
    for (const scenario of scenarios) {
      const generated = new DarwinRuntime({
        provider: new MapFileProvider(new Map([["/UIKitDemo", demo.built.bytes]])),
        rootDir: output,
      }).run("/UIKitDemo", { events: scenario.events });
      expect(generated.frames, scenario.label).toHaveLength(scenario.frameCount);

      for (const name of ["ObjcWindow", "ObjcWindowLegacy"]) {
        const label = `${name}/${scenario.label}`;
        const result = new DarwinRuntime({ rootDir: output }).run(join(output, name), {
          events: scenario.events,
        });
        expect(result.exitStatus, label).toBe(0);
        expect(result.frames, label).toHaveLength(scenario.frameCount);
        expect(result.objcClasses, label).toEqual(
          expect.arrayContaining(["AppDelegate", "UIWindow", "UIView", "BaseView", "TapView"]),
        );
        expect(result.objcProtocols, label).toContain("TapView:Tappable");
        expect(result.objcStats.allocations, label).toBeGreaterThan(0);
        if (scenario.label !== "ticks") {
          expect(result.objcStats.associations, label).toBeGreaterThan(0);
          expect(result.objcStats.weakZeroings, label).toBeGreaterThan(0);
          expect(result.objcStats.weakLoads, label).toBeGreaterThan(0);
          expect(result.objcStats.retains + result.objcStats.releases, label).toBeGreaterThan(0);
        }
        expect(
          result.program.images.map((image) => image.path),
          label,
        ).toContain(join(output, "libSystemShim.dylib"));
        expect(
          result.frames.map((frame) => frame.digest),
          label,
        ).toEqual(generated.frames.map((frame) => frame.digest));
      }
    }
  });
});
