import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CaptureSink,
  DarwinRuntime,
  MapFileProvider,
  type ProcessResult,
} from "@ios-sim/darwin-compat";
import { buildIosAppImages } from "../../scripts/build-ios-app-images.js";

const root = join(import.meta.dirname, "../..");
const appPath = join(root, "fixtures/ios-app/build/SpikeApp");
const hasClang = spawnSync("clang", ["--version"], { encoding: "utf8" }).status === 0;
const sdks = hasClang
  ? spawnSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], { encoding: "utf8" })
  : null;
const available = process.platform === "darwin" && hasClang && sdks?.status === 0;
if (!available) {
  console.warn(
    `skip stock-SDK app test: platform=${process.platform}, clang=${hasClang ? "present" : "missing"}, ` +
      "iPhoneSimulator SDK=" +
      (sdks?.status === 0 ? "present" : "missing") +
      "; the shim fixtures still run everywhere",
  );
}

function run(events: Array<{ x: number; y: number }>): ProcessResult {
  const bytes = new Uint8Array(readFileSync(appPath));
  const runtime = new DarwinRuntime({
    provider: new MapFileProvider(new Map([["/SpikeApp", bytes]])),
    rootDir: root,
    defaultStdout: new CaptureSink(),
    defaultStderr: new CaptureSink(),
  });
  return runtime.run("/SpikeApp", {
    argv: [],
    events,
    dependencyOverrides: buildIosAppImages(),
  });
}

function ink(result: ProcessResult, frameIndex: number, top: number, bottom: number): number {
  const frame = result.frames[frameIndex]!;
  let count = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      if (frame.pixels[offset] === 0 && frame.pixels[offset + 1] === 0) count += 1;
    }
  }
  return count;
}

describe.skipIf(!available)("stock SDK app", () => {
  it("runs with replacement images, renders, and handles a tap", () => {
    const build = spawnSync("bun", [join(root, "scripts/spike-ios-symbols.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    const launched = run([]);
    expect(launched.exitStatus).toBe(0);
    // Main image plus the five replacement dylibs.
    expect(launched.program.images).toHaveLength(6);
    expect(launched.program.images.map((image) => image.path)).toEqual(
      expect.arrayContaining(["/System/Library/Frameworks/UIKit.framework/UIKit"]),
    );
    expect(launched.frames).toHaveLength(1);
    expect(new TextDecoder().decode(launched.stderr)).toContain("stock app launching");
    // White background with label ink (y 100..140) and button title ink (y 200..244).
    expect(ink(launched, 0, 100, 140)).toBeGreaterThan(0);
    expect(ink(launched, 0, 200, 244)).toBeGreaterThan(0);

    const tapped = run([{ x: 170, y: 222 }]);
    expect(tapped.exitStatus).toBe(0);
    expect(tapped.frames).toHaveLength(2);
    expect(tapped.frames[1]!.digest).not.toBe(tapped.frames[0]!.digest);
    expect(ink(tapped, 1, 100, 140)).toBeGreaterThan(0);
  });
});
