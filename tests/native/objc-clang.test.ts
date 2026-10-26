import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DarwinRuntime, MapFileProvider, buildUIKitDemo } from "@ios-sim/darwin-compat";

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
  it("links, loads, dispatches, and renders the same frame as the generated app", () => {
    const build = spawnSync("bash", [join(root, "scripts/build-objc-fixture.sh"), output], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    const app = join(output, "ObjcWindow");
    const result = new DarwinRuntime({ rootDir: output }).run(app);
    expect(result.exitStatus).toBe(0);
    expect(result.frames).toHaveLength(1);
    expect(result.objcClasses).toEqual(
      expect.arrayContaining(["AppDelegate", "UIWindow", "UIView"]),
    );
    expect(result.program.images.map((image) => image.path)).toContain(
      join(output, "libSystemShim.dylib"),
    );

    const demo = buildUIKitDemo();
    const generated = new DarwinRuntime({
      provider: new MapFileProvider(new Map([["/UIKitDemo", demo.built.bytes]])),
      rootDir: output,
    }).run("/UIKitDemo");

    expect(result.frames[0]?.digest).toBe(generated.frames[0]?.digest);
  });
});
