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
      expect.arrayContaining(["NSObject", "UIView", "UIWindow", "BaseView", "AppDelegate"]),
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

    // TapView inherits from BaseView; both +initialize methods run, root first.
    const baseInit = result.program.resolveExport("_baseInitMarker");
    const tapInit = result.program.resolveExport("_tapInitMarker");
    const initOrder = result.program.resolveExport("_initOrder");
    expect(result.program.memory.read(baseInit!, 8)).toBe(1n);
    expect(result.program.memory.read(tapInit!, 8)).toBe(1n);
    expect(result.program.memory.read(initOrder!, 8)).toBe(2n);

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
    expect(result.objcStats.associations).toBeGreaterThanOrEqual(1);
    expect(result.objcStats.weakZeroings).toBeGreaterThanOrEqual(1);
    expect(result.objcStats.weakLoads).toBeGreaterThanOrEqual(1);
    expect(result.objcStats.messages).toBeGreaterThan(0);
    expect(result.objcStats.hostDispatches).toBeGreaterThan(0);
    expect(result.objcStats.guestDispatches).toBeGreaterThan(0);
    expect(result.objcStats.deallocs).toBeGreaterThanOrEqual(1);
    expect(result.objcStats.poolPushes).toBeGreaterThanOrEqual(1);
    expect(result.objcStats.poolPops).toBeGreaterThanOrEqual(1);
    const deallocMarker = result.program.resolveExport("_deallocMarker");
    expect(result.program.memory.read(deallocMarker!, 8)).toBe(1n);
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

  it("dispatches a UIButton target/action", () => {
    const result = runDemo([{ x: 30, y: 320 }]);
    expect(result.frames).toHaveLength(2);
    const at = (frameIndex: number, x: number, y: number): number[] => {
      const frame = result.frames[frameIndex]!;
      const offset = (y * frame.width + x) * 4;
      return [...frame.pixels.slice(offset, offset + 4)];
    };
    expect(at(0, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(at(1, 30, 30)).toEqual([255, 128, 0, 255]);
  });

  it("moves the view on ticks", () => {
    const result = runDemo([
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
    ]);
    expect(result.frames).toHaveLength(5);
    const redAt = (frameIndex: number, x: number, y: number): boolean => {
      const frame = result.frames[frameIndex]!;
      const offset = (y * frame.width + x) * 4;
      return frame.pixels[offset] === 255 && frame.pixels[offset + 1] === 0;
    };
    expect(redAt(0, 30, 30)).toBe(true);
    expect(redAt(1, 30, 30)).toBe(false);
    expect(redAt(1, 70, 30)).toBe(true);
    expect(redAt(2, 110, 30)).toBe(true);
    expect(redAt(3, 150, 30)).toBe(true);
    expect(redAt(4, 30, 30)).toBe(true);
  });

  it("produces a deterministic frame digest", () => {
    const first = runDemo();
    const second = runDemo();
    expect(first.frames[0]?.digest).toBe(second.frames[0]?.digest);
  });
});
