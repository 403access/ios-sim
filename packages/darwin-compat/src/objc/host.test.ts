import { join } from "node:path";
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
    rootDir: join(process.cwd(), "fixtures/objc-window"),
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
    expect(result.objcCategories).toEqual(["AppDelegate(Window)", "UIViewController(Lifecycle)"]);
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
    expect(result.program.memory.read(result.program.resolveExport("_activeMarker")!, 8)).toBe(1n);
    expect(result.program.memory.read(result.program.resolveExport("_defaultsMarker")!, 8)).toBe(
      1n,
    );
    expect(result.program.memory.read(result.program.resolveExport("_defaultsInt")!, 8)).toBe(7n);
    expect(result.program.memory.read(result.program.resolveExport("_stringLength")!, 8)).toBe(8n);
    expect(result.program.memory.read(result.program.resolveExport("_stringEqual")!, 8)).toBe(1n);
    expect(result.program.memory.read(result.program.resolveExport("_arrayCount")!, 8)).toBe(2n);
    expect(result.program.memory.read(result.program.resolveExport("_numberValue")!, 8)).toBe(6n);
    expect(result.program.memory.read(result.program.resolveExport("_dictionaryCount")!, 8)).toBe(
      1n,
    );
    expect(result.program.memory.read(result.program.resolveExport("_lifecycleMarker")!, 8)).toBe(
      1n,
    );
    expect(result.program.memory.read(result.program.resolveExport("_willAppearMarker")!, 8)).toBe(
      1n,
    );
    expect(result.program.memory.read(result.program.resolveExport("_didAppearMarker")!, 8)).toBe(
      1n,
    );
    // viewDidLoad ran before viewDidAppear: the latter copies its marker.
    expect(result.program.memory.read(result.program.resolveExport("_appearOrder")!, 8)).toBe(1n);
    expect(result.objcStats.defaultsStores).toBe(2);
    expect(result.objcStats.defaultsReads).toBe(2);
    expect(result.program.memory.read(result.program.resolveExport("_terminateMarker")!, 8)).toBe(
      1n,
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
    expect(at(300, 100)).toEqual([127, 255, 127, 255]);
    expect(at(30, 480)).toEqual([0, 0, 255, 255]);
    let blackPixels = 0;
    for (let y = 400; y < 440; y += 1) {
      for (let x = 20; x < 320; x += 1) {
        if (at(x, y)[0] === 0 && at(x, y)[1] === 0 && at(x, y)[2] === 0) blackPixels += 1;
      }
    }
    expect(blackPixels).toBeGreaterThan(0);
    let firstBlackX = 1000;
    for (let y = 400; y < 440; y += 1) {
      for (let x = 20; x < 320; x += 1) {
        if (at(x, y)[0] === 0 && at(x, y)[1] === 0 && at(x, y)[2] === 0 && x < firstBlackX) {
          firstBlackX = x;
        }
      }
    }
    expect(firstBlackX).toBeGreaterThan(100);
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
    expect(new TextDecoder().decode(result.stderr)).toContain("hello from objc");
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

  it("paints and hit-tests nested views in parent coordinates", () => {
    const result = runDemo([{ x: 40, y: 160 }]);
    expect(result.frames).toHaveLength(3);
    const at = (frameIndex: number, x: number, y: number): number[] => {
      const frame = result.frames[frameIndex]!;
      const offset = (y * frame.width + x) * 4;
      return [...frame.pixels.slice(offset, offset + 4)];
    };
    expect(at(0, 40, 160)).toEqual([255, 0, 0, 255]);
    expect(at(1, 40, 160)).toEqual([0, 0, 255, 255]);
    expect(at(2, 40, 160)).toEqual([0, 255, 0, 255]);
    expect(at(0, 25, 145)).toEqual([128, 128, 128, 255]);
    expect(at(0, 200, 200)).toEqual([255, 0, 0, 255]);
    expect(at(0, 240, 200)).toEqual([255, 255, 255, 255]);
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
    expect(at(1, 30, 30)).toEqual([128, 0, 128, 255]);
    expect(
      result.program.memory.read(result.program.resolveExport("_notificationMarker")!, 8),
    ).toBe(1n);
    expect(result.program.memory.read(result.program.resolveExport("_userInfoValue")!, 8)).toBe(7n);
  });

  it("draws a PNG-backed UIImageView scaled to its frame", () => {
    const result = runDemo();
    const frame = result.frames[0]!;
    const at = (x: number, y: number): number[] => {
      const offset = (y * frame.width + x) * 4;
      return [...frame.pixels.slice(offset, offset + 3)];
    };
    // Four quadrants of the 8x8 fixture: red, green, blue, half-black.
    expect(at(254, 144)).toEqual([255, 0, 0]);
    expect(at(325, 144)).toEqual([0, 255, 0]);
    expect(at(254, 215)).toEqual([0, 0, 255]);
    expect(at(325, 215)).toEqual([127, 127, 127]);
  });

  it("toggles a UISwitch and sends a value-changed action", () => {
    const result = runDemo([{ x: 300, y: 326 }]);
    expect(result.frames).toHaveLength(2);
    const at = (frameIndex: number, x: number, y: number): number[] => {
      const frame = result.frames[frameIndex]!;
      const offset = (y * frame.width + x) * 4;
      return [...frame.pixels.slice(offset, offset + 3)];
    };
    // Off: knob on the left, grey track on the right. On: the reverse.
    expect(at(0, 290, 326)).toEqual([255, 255, 255]);
    expect(at(0, 330, 326)).toEqual([200, 200, 205]);
    expect(at(1, 290, 326)).toEqual([52, 199, 89]);
    expect(at(1, 330, 326)).toEqual([255, 255, 255]);
    expect(result.program.memory.read(result.program.resolveExport("_switchChanges")!, 8)).toBe(1n);
  });

  it("drags a UISlider, updates its value, and sends value-changed actions", () => {
    const result = runDemo([{ fromX: 60, fromY: 572, toX: 300, toY: 572, steps: 4 }]);
    expect(result.frames).toHaveLength(5);
    const at = (frameIndex: number, x: number, y: number): number[] => {
      const frame = result.frames[frameIndex]!;
      const offset = (y * frame.width + x) * 4;
      return [...frame.pixels.slice(offset, offset + 3)];
    };
    // The track fills as the knob moves right.
    expect(at(0, 250, 572)).toEqual([200, 200, 205]);
    expect(at(4, 250, 572)).toEqual([52, 199, 89]);
    expect(result.program.memory.read(result.program.resolveExport("_sliderChanges")!, 8)).toBe(4n);
  });

  it("fires a delayed performSelector: on the virtual clock", () => {
    const idle = runDemo();
    expect(idle.program.memory.read(idle.program.resolveExport("_delayedMarker")!, 8)).toBe(0n);

    const result = runDemo([{ kind: "tick" }]);
    // The callback changes no pixels, so its identical frame is skipped; the
    // tick still moves the view and presents.
    expect(result.frames).toHaveLength(2);
    expect(result.program.memory.read(result.program.resolveExport("_delayedMarker")!, 8)).toBe(1n);
  });

  it("moves the view on ticks and fires timers on the virtual clock", () => {
    const result = runDemo([
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
    ]);
    // Launch, four ticks, and two one-second timer fires (one per two ticks).
    expect(result.frames).toHaveLength(7);
    const redAt = (frameIndex: number, x: number, y: number): boolean => {
      const frame = result.frames[frameIndex]!;
      const offset = (y * frame.width + x) * 4;
      return frame.pixels[offset] === 255 && frame.pixels[offset + 1] === 0;
    };
    expect(redAt(0, 30, 30)).toBe(true);
    expect(redAt(1, 70, 30)).toBe(true);
    // frames 2 and 5 are timer fires: the view stays put, the status strip changes.
    expect(redAt(2, 70, 30)).toBe(true);
    expect(redAt(3, 110, 30)).toBe(true);
    expect(redAt(4, 150, 30)).toBe(true);
    expect(redAt(5, 150, 30)).toBe(true);
    expect(redAt(6, 30, 30)).toBe(true);

    const status = (frameIndex: number): number[] => {
      const frame = result.frames[frameIndex]!;
      const offset = (630 * frame.width + 5) * 4;
      return [...frame.pixels.slice(offset, offset + 3)];
    };
    expect(status(1)).toEqual([255, 255, 255]);
    expect(status(2)).toEqual([0, 255, 0]);
    expect(status(4)).toEqual([0, 255, 0]);
    expect(status(5)).toEqual([255, 128, 0]);
    expect(result.program.memory.read(result.program.resolveExport("_timerFires")!, 8)).toBe(2n);
  });

  it("produces a deterministic frame digest", () => {
    const first = runDemo();
    const second = runDemo();
    expect(first.frames[0]?.digest).toBe(second.frames[0]?.digest);
  });
});
