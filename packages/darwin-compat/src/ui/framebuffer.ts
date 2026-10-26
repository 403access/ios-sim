/**
 * Deterministic software framebuffer for the UIKit proof of concept.
 *
 * This is not CoreAnimation or Metal: it is an RGBA8 buffer with rectangular
 * fills and PNG/PPM encoders. It exists so a rendered frame is a byte-stable
 * artifact that tests can compare, on any host, without a GPU or a window
 * system. All arithmetic is integer and rounded once, so the same view tree
 * always produces the same digest.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
export const RED_255: Rgba = { r: 255, g: 0, b: 0, a: 255 };

const MAX_DIMENSION = 4096;

export class Framebuffer {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION
    ) {
      throw new Error(`invalid framebuffer size ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
  }

  clear(color: Rgba): void {
    for (let offset = 0; offset < this.pixels.length; offset += 4) {
      this.pixels[offset] = clamp(color.r);
      this.pixels[offset + 1] = clamp(color.g);
      this.pixels[offset + 2] = clamp(color.b);
      this.pixels[offset + 3] = clamp(color.a);
    }
  }

  /** Fill a rectangle, clipped to the buffer, with source-over blending. */
  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: Rgba,
    clip: { x: number; y: number; width: number; height: number } = {
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
    },
  ): void {
    const left = Math.max(0, clip.x, Math.round(x));
    const top = Math.max(0, clip.y, Math.round(y));
    const right = Math.min(this.width, clip.x + clip.width, Math.round(x + width));
    const bottom = Math.min(this.height, clip.y + clip.height, Math.round(y + height));
    if (right <= left || bottom <= top) return;
    const source = { r: clamp(color.r), g: clamp(color.g), b: clamp(color.b), a: clamp(color.a) };
    if (source.a === 0) return;
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const offset = (row * this.width + column) * 4;
        if (source.a === 255) {
          this.pixels[offset] = source.r;
          this.pixels[offset + 1] = source.g;
          this.pixels[offset + 2] = source.b;
          this.pixels[offset + 3] = 255;
        } else {
          blendPixel(this.pixels, offset, source);
        }
      }
    }
  }

  /**
   * Draw an RGBA image into the given rectangle with nearest-neighbour
   * sampling. Source alpha is multiplied by `alpha` before blending.
   */
  drawImage(
    image: { width: number; height: number; pixels: Uint8Array },
    x: number,
    y: number,
    width: number,
    height: number,
    clip: { x: number; y: number; width: number; height: number },
    alpha = 1,
  ): void {
    if (image.width <= 0 || image.height <= 0 || width <= 0 || height <= 0) return;
    if (image.pixels.length !== image.width * image.height * 4) {
      throw new Error("image pixel buffer does not match its dimensions");
    }
    const left = Math.max(0, clip.x, Math.round(x));
    const top = Math.max(0, clip.y, Math.round(y));
    const right = Math.min(this.width, clip.x + clip.width, Math.round(x + width));
    const bottom = Math.min(this.height, clip.y + clip.height, Math.round(y + height));
    if (right <= left || bottom <= top) return;
    for (let row = top; row < bottom; row += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor(((row - y) * image.height) / height));
      for (let column = left; column < right; column += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor(((column - x) * image.width) / width));
        const from = (sourceY * image.width + sourceX) * 4;
        const source = {
          r: image.pixels[from]!,
          g: image.pixels[from + 1]!,
          b: image.pixels[from + 2]!,
          a: image.pixels[from + 3]! * Math.max(0, Math.min(1, alpha)),
        };
        if (source.a === 0) continue;
        const offset = (row * this.width + column) * 4;
        if (source.a >= 255) {
          this.pixels[offset] = source.r;
          this.pixels[offset + 1] = source.g;
          this.pixels[offset + 2] = source.b;
          this.pixels[offset + 3] = 255;
        } else {
          blendPixel(this.pixels, offset, source);
        }
      }
    }
  }

  /** Stable fingerprint of the pixel data. */
  digest(): string {
    return createHash("sha256").update(this.pixels).digest("hex");
  }

  toPpm(): Uint8Array {
    return encodePpm(this.width, this.height, this.pixels);
  }

  toPng(): Uint8Array {
    return encodePng(this.width, this.height, this.pixels);
  }
}

export type FrameEncoding = "png" | "ppm";

/** Encode RGBA8 pixels as a PPM (P6) image. */
export function encodePpm(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height * 4) {
    throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${width * height * 4}`);
  }
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const body = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    body[pixel * 3] = pixels[pixel * 4]!;
    body[pixel * 3 + 1] = pixels[pixel * 4 + 1]!;
    body[pixel * 3 + 2] = pixels[pixel * 4 + 2]!;
  }
  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  return result;
}

/** Encode RGBA8 pixels as a PNG (filter 0, zlib level 9). */
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height * 4) {
    throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${width * height * 4}`);
  }
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const at = row * (width * 4 + 1);
    raw[at] = 0; // filter: none
    raw.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), at + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk("IEND", new Uint8Array()),
  ];
  return concat(parts);
}

function blendPixel(pixels: Uint8Array, offset: number, source: Rgba): void {
  const alpha = source.a / 255;
  const inverse = 1 - alpha;
  pixels[offset] = Math.round(source.r * alpha + pixels[offset]! * inverse);
  pixels[offset + 1] = Math.round(source.g * alpha + pixels[offset + 1]! * inverse);
  pixels[offset + 2] = Math.round(source.b * alpha + pixels[offset + 2]! * inverse);
  pixels[offset + 3] = Math.round(255 * (alpha + (pixels[offset + 3]! / 255) * inverse));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return chunk;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}
