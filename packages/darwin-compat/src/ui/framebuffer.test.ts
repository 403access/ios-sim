import { describe, expect, it } from "vitest";
import { Framebuffer, encodePng, encodePpm, RED_255 } from "./framebuffer.js";

describe("framebuffer", () => {
  it("fills and clips rectangles", () => {
    const buffer = new Framebuffer(4, 4);
    buffer.clear({ r: 0, g: 0, b: 0, a: 255 });
    buffer.fillRect(2, 2, 10, 10, RED_255);
    const pixel = (x: number, y: number) => [
      ...buffer.pixels.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
    ];
    expect(pixel(0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(3, 3)).toEqual([255, 0, 0, 255]);
  });

  it("blends with integer rounding", () => {
    const buffer = new Framebuffer(1, 1);
    buffer.clear({ r: 0, g: 0, b: 0, a: 255 });
    buffer.fillRect(0, 0, 1, 1, { r: 255, g: 255, b: 255, a: 128 });
    expect([...buffer.pixels]).toEqual([128, 128, 128, 255]);
  });

  it("encodes PNG and PPM deterministically", () => {
    const buffer = new Framebuffer(2, 1);
    buffer.clear(RED_255);
    const png = encodePng(2, 1, buffer.pixels);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(2);
    expect(view.getUint32(20)).toBe(1);
    expect(encodePng(2, 1, buffer.pixels)).toEqual(png);

    const ppm = encodePpm(2, 1, buffer.pixels);
    expect(new TextDecoder().decode(ppm.slice(0, 11))).toBe("P6\n2 1\n255\n");
    expect([...ppm.slice(11)]).toEqual([255, 0, 0, 255, 0, 0]);
    expect(buffer.digest()).toHaveLength(64);
  });
});
