/**
 * Minimal PNG decoder for the UIKit proof of concept.
 *
 * It handles the subset a fixture image needs: 8-bit truecolour with or without
 * alpha, no interlacing, and all five scanline filters. It is deliberately
 * small and strict; unknown chunks are skipped and anything outside the subset
 * throws instead of guessing.
 */

import { inflateSync } from "node:zlib";

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, `width * height * 4` bytes. */
  readonly pixels: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_DIMENSION = 4096;

export function decodePng(bytes: Uint8Array): DecodedImage {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("not a PNG file");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let interlace = 0;
  const data: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error("truncated PNG chunk");
    const chunk = bytes.subarray(start, end);
    if (type === "IHDR") {
      width = readU32(chunk, 0);
      height = readU32(chunk, 4);
      if (chunk[8] !== 8) throw new Error(`unsupported PNG bit depth ${chunk[8]}`);
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === "IDAT") {
      data.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`unsupported PNG dimensions ${width}x${height}`);
  }
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array(inflateSync(concat(data)));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data is short");
  const rows = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]!;
    const source = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const line = unfilterRow(filter, source, previous, channels);
    rows.set(line, row * stride);
    previous = line;
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels;
    const to = index * 4;
    pixels[to] = rows[from]!;
    pixels[to + 1] = rows[from + 1]!;
    pixels[to + 2] = rows[from + 2]!;
    pixels[to + 3] = channels === 4 ? rows[from + 3]! : 255;
  }
  return { width, height, pixels };
}

function unfilterRow(
  filter: number,
  source: Uint8Array<ArrayBufferLike>,
  previous: Uint8Array<ArrayBufferLike>,
  channels: number,
): Uint8Array<ArrayBuffer> {
  const line = new Uint8Array(new ArrayBuffer(source.length));
  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index]!;
    const left = index >= channels ? line[index - channels]! : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= channels ? (previous[index - channels] ?? 0) : 0;
    let value: number;
    switch (filter) {
      case 0:
        value = raw;
        break;
      case 1:
        value = raw + left;
        break;
      case 2:
        value = raw + up;
        break;
      case 3:
        value = raw + Math.floor((left + up) / 2);
        break;
      case 4:
        value = raw + paeth(left, up, upLeft);
        break;
      default:
        throw new Error(`unsupported PNG filter ${filter}`);
    }
    line[index] = value & 0xff;
  }
  return line;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
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
