import { describe, expect, it } from "vitest";
import { DarwinRuntime } from "../runtime/process.js";
import { CaptureSink } from "../syscall/kernel.js";
import { MapFileProvider } from "../dyld/loader.js";
import { buildUIKitDemo, DEMO_SCREEN, DEMO_VIEW_RECT } from "./build-ui-demo.js";

function runDemo() {
  const demo = buildUIKitDemo();
  const runtime = new DarwinRuntime({
    provider: new MapFileProvider(new Map([["/UIKitDemo", demo.built.bytes]])),
    rootDir: process.cwd(),
    defaultStdout: new CaptureSink(),
    defaultStderr: new CaptureSink(),
  });
  return runtime.run("/UIKitDemo", { argv: [] });
}

describe("ObjC UIKit demo", () => {
  it("runs a generated ObjC app and renders one frame", () => {
    const result = runDemo();
    expect(result.exitStatus).toBe(0);
    expect(result.frames).toHaveLength(1);
    expect(result.objcClasses).toEqual(
      expect.arrayContaining(["NSObject", "UIView", "UIWindow", "AppDelegate"]),
    );

    const frame = result.frames[0]!;
    expect(frame.width).toBe(DEMO_SCREEN.width);
    expect(frame.height).toBe(DEMO_SCREEN.height);
    const at = (x: number, y: number): [number, number, number, number] => {
      const offset = (y * frame.width + x) * 4;
      return [
        frame.pixels[offset]!,
        frame.pixels[offset + 1]!,
        frame.pixels[offset + 2]!,
        frame.pixels[offset + 3]!,
      ];
    };
    expect(at(30, 30)).toEqual([255, 0, 0, 255]);
    expect(at(10, 10)).toEqual([255, 255, 255, 255]);
    expect(at(DEMO_VIEW_RECT.x - 1, DEMO_VIEW_RECT.y - 1)).toEqual([255, 255, 255, 255]);
  });

  it("produces a deterministic frame digest", () => {
    const first = runDemo();
    const second = runDemo();
    expect(first.frames[0]?.digest).toBe(second.frames[0]?.digest);
  });
});
