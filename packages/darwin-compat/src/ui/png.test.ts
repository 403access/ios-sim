import { describe, expect, it } from "vitest";
import { encodePng } from "./framebuffer.js";
import { decodePng } from "./png.js";

function quadrants(): Uint8Array {
  const width = 4;
  const height = 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const right = x >= 2;
      const bottom = y >= 2;
      pixels.set(
        !right && !bottom
          ? [255, 0, 0, 255]
          : right && !bottom
            ? [0, 255, 0, 255]
            : !right && bottom
              ? [0, 0, 255, 255]
              : [0, 0, 0, 128],
        at,
      );
    }
  }
  return pixels;
}

describe("PNG decoding", () => {
  it("round-trips RGBA pixels produced by the encoder", () => {
    const pixels = quadrants();
    const decoded = decodePng(encodePng(4, 4, pixels));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  it("rejects bytes that are not a PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a PNG/);
  });
});
