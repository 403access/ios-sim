/**
 * Generate the tiny PNG used by the native track's UIImageView fixture.
 *
 * The image is four 4x4 quadrants (red, green, blue, half-transparent black),
 * so a scaled draw is easy to assert on and alpha blending is visible. The
 * output is byte-stable and committed under fixtures/objc-window/assets.
 *
 * Usage: bun scripts/make-fixture-image.ts [output]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodePng } from "../packages/darwin-compat/src/ui/framebuffer.js";

const width = 8;
const height = 8;
const pixels = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const at = (y * width + x) * 4;
    const right = x >= width / 2;
    const bottom = y >= height / 2;
    if (!right && !bottom) {
      pixels.set([255, 0, 0, 255], at);
    } else if (right && !bottom) {
      pixels.set([0, 255, 0, 255], at);
    } else if (!right && bottom) {
      pixels.set([0, 0, 255, 255], at);
    } else {
      pixels.set([0, 0, 0, 128], at);
    }
  }
}

const output =
  process.argv[2] ?? join(import.meta.dirname, "../fixtures/objc-window/assets/icon.png");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, encodePng(width, height, pixels));
console.log(`wrote ${output}`);
