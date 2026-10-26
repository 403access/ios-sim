/**
 * Tiny bitmap font for the UIKit shim's label renderer.
 *
 * Uppercase ASCII and digits are 3×5 pixels (plus a one-pixel advance gap);
 * lowercase is folded to uppercase. This is deliberately not a real font: it
 * exists so `UILabel` can prove text reaches the framebuffer without pulling
 * in CoreText, FreeType, or a font binary.
 */

import { BLACK, type Framebuffer, type Rgba } from "./framebuffer.js";

const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;
const ADVANCE = 4;
const LINE_HEIGHT = 6;

const GLYPHS: Record<string, readonly string[]> = {
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["011", "100", "100", "100", "011"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["011", "100", "101", "101", "011"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "010"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "101", "101"],
  O: ["010", "101", "101", "101", "010"],
  P: ["110", "101", "110", "100", "100"],
  Q: ["010", "101", "101", "111", "011"],
  R: ["110", "101", "110", "101", "101"],
  S: ["011", "100", "010", "001", "110"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "3": ["110", "001", "010", "001", "110"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "110", "001", "110"],
  "6": ["011", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "100", "100"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "110"],
  " ": ["000", "000", "000", "000", "000"],
  ".": ["000", "000", "000", "000", "010"],
  ",": ["000", "000", "000", "010", "100"],
  ":": ["000", "010", "000", "010", "000"],
  "-": ["000", "000", "111", "000", "000"],
  "/": ["001", "001", "010", "100", "100"],
  "!": ["010", "010", "010", "000", "010"],
  "?": ["110", "001", "010", "000", "010"],
};

export interface TextOptions {
  readonly scale?: number;
  readonly color?: Rgba;
}

/** Draw one line of text at `(x, y)` (top-left of the first glyph). */
export function drawText(
  framebuffer: Framebuffer,
  x: number,
  y: number,
  text: string,
  options: TextOptions = {},
): void {
  const scale = Math.max(1, Math.min(8, Math.round(options.scale ?? 2)));
  const color = options.color ?? BLACK;
  let cursorX = Math.round(x);
  let cursorY = Math.round(y);
  for (const character of text) {
    if (character === "\n") {
      cursorX = Math.round(x);
      cursorY += LINE_HEIGHT * scale;
      continue;
    }
    const glyph = GLYPHS[character.toUpperCase()];
    if (glyph) {
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          if (glyph[row]![column] !== "1") continue;
          framebuffer.fillRect(
            cursorX + column * scale,
            cursorY + row * scale,
            scale,
            scale,
            color,
          );
        }
      }
    }
    cursorX += ADVANCE * scale;
  }
}

/** Width in pixels of a single line at `scale`. */
export function textWidth(text: string, scale = 2): number {
  return Math.max(0, text.length * ADVANCE * scale - scale);
}
