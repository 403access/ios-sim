import { describe, expect, it } from "vitest";
import { toNormalizedPoint } from "./coordinates.js";

const display = {
  widthPx: 1206,
  heightPx: 2622,
  widthPoints: 402,
  heightPoints: 874,
};

describe("toNormalizedPoint", () => {
  it("converts points", () => {
    expect(toNormalizedPoint(201, 437, "point", display)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("converts pixels", () => {
    expect(toNormalizedPoint(603, 1311, "pixel", display)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("passes normalized coordinates through", () => {
    expect(toNormalizedPoint(0.25, 0.75, "normalized", display)).toEqual({
      x: 0.25,
      y: 0.75,
    });
  });

  it("rejects out-of-bounds coordinates", () => {
    expect(() => toNormalizedPoint(500, 0, "point", display)).toThrow(/outside/);
    expect(() => toNormalizedPoint(-1, 0, "normalized", display)).toThrow(/outside/);
  });

  it("rejects non-finite values and bad units", () => {
    expect(() => toNormalizedPoint(Number.NaN, 0, "point", display)).toThrow(/finite/);
    expect(() => toNormalizedPoint(0, 0, "banana" as "point", display)).toThrow(
      /point, pixel, or normalized/,
    );
  });
});
