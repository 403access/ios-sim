import { describe, expect, it } from "vitest";
import { nativeWindowArguments, nativeWindowBinaryPath } from "./window.js";

const base = {
  width: 402,
  height: 874,
  color: "1e1e2e",
  title: "UIKitLite Blank Window",
  build: true,
};

describe("native UIKitLite window launcher", () => {
  it("builds the native helper arguments", () => {
    expect(nativeWindowArguments(base)).toEqual([
      "--width",
      "402",
      "--height",
      "874",
      "--color",
      "1e1e2e",
      "--title",
      "UIKitLite Blank Window",
    ]);
  });

  it("rejects invalid dimensions, colors, and titles", () => {
    expect(() => nativeWindowArguments({ ...base, width: 0 })).toThrow(/width/);
    expect(() => nativeWindowArguments({ ...base, height: 20000 })).toThrow(/height/);
    expect(() => nativeWindowArguments({ ...base, color: "nope" })).toThrow(/color/);
    expect(() => nativeWindowArguments({ ...base, title: "" })).toThrow(/title/);
  });

  it("resolves the helper path from the repository", () => {
    expect(nativeWindowBinaryPath()).toMatch(/packages\/uikit-native\/build\/uikit-window$/);
  });
});
