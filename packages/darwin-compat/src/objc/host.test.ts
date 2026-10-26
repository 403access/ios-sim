import { describe, expect, it } from "vitest";
import { DarwinRuntime } from "../runtime/process.js";
import { CaptureSink } from "../syscall/kernel.js";
import { MapFileProvider } from "../dyld/loader.js";
import type { InputEvent } from "./host.js";
import { buildUIKitDemo, DEMO_SCREEN, DEMO_VIEW_RECT } from "./build-ui-demo.js";

function runDemo(events?: readonly InputEvent[]) {
  const demo = buildUIKitDemo();
  const runtime = new DarwinRuntime({
    provider: new MapFileProvider(new Map([["/UIKitDemo", demo.built.bytes]])),
    rootDir: process.cwd(),
    defaultStdout: new CaptureSink(),
    defaultStderr: new CaptureSink(),
  });
  return runtime.run("/UIKitDemo", { argv: [], events });
}

describe("ObjC UIKit demo", () => {
  it("runs a generated ObjC app and renders one frame", () => {
    const result = runDemo();
    expect(result.exitStatus).toBe(0);
    expect(result.frames).toHaveLength(1);
    expect(result.objcClasses).toEqual(
      expect.arrayContaining(["NSObject", "UIView", "UIWindow", "AppDelegate"]),
    );
    expect(result.objcCategories).toEqual(["AppDelegate(Window)"]);
    expect(result.objcProtocols).toContain("TapView:Tappable");

    // The category supplies the delegate method and +initialize increments the
    // marker exactly once before the first message.
    const marker = result.program.resolveExport("_initializeMarker");
    expect(marker).not.toBeNull();
    expect(result.program.memory.read(marker!, 8)).toBe(1n);

    // +load ran once before main.
    const loadMarker = result.program.resolveExport("_loadMarker");
    expect(loadMarker).not.toBeNull();
    expect(result.program.memory.read(loadMarker!, 8)).toBe(1n);

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

  it("delivers a scripted tap to the view and renders each state", () => {
    const result = runDemo([{ x: 30, y: 30 }]);
    expect(result.exitStatus).toBe(0);
    expect(result.frames).toHaveLength(3);
    const colors = result.frames.map((frame) => {
      const offset = (30 * frame.width + 30) * 4;
      return [frame.pixels[offset]!, frame.pixels[offset + 1]!, frame.pixels[offset + 2]!];
    });
    expect(colors).toEqual([
      [255, 0, 0],
      [0, 0, 255],
      [0, 255, 0],
    ]);
    expect(new Set(result.frames.map((frame) => frame.digest)).size).toBe(3);
    expect(result.objcStats.allocations).toBeGreaterThanOrEqual(3);
    expect(result.objcStats.retains).toBeGreaterThanOrEqual(1);
    expect(result.objcStats.autoreleases).toBeGreaterThanOrEqual(1);
  });

  it("delivers moved samples for a drag", () => {
    const result = runDemo([{ fromX: 30, fromY: 30, toX: 60, toY: 60, steps: 3 }]);
    expect(result.frames).toHaveLength(4);
    const colors = result.frames.map((frame) => {
      const offset = (30 * frame.width + 30) * 4;
      return [frame.pixels[offset]!, frame.pixels[offset + 1]!, frame.pixels[offset + 2]!];
    });
    expect(colors).toEqual([
      [255, 0, 0],
      [0, 0, 255],
      [255, 255, 0],
      [0, 255, 0],
    ]);
  });

  it("produces a deterministic frame digest", () => {
    const first = runDemo();
    const second = runDemo();
    expect(first.frames[0]?.digest).toBe(second.frames[0]?.digest);
  });
});
