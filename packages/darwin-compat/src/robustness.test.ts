/**
 * Deterministic parser robustness smoke tests.
 *
 * This is not a substitute for coverage-guided fuzzing, but it catches the most
 * common regression: a mutated length or offset escaping the bounds checks and
 * throwing a host `RangeError` instead of a stable compatibility error.
 */

import { describe, expect, it } from "vitest";
import { CompatError } from "./errors.js";
import { parseMachO } from "./macho/parse.js";
import { decodeXpcValue } from "./xpc/codec.js";
import { buildHello } from "./testing/fixtures.js";

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function mutate(source: Uint8Array, random: () => number): Uint8Array {
  const bytes = source.slice();
  const flips = 1 + Math.floor(random() * 8);
  for (let index = 0; index < flips; index += 1) {
    const at = Math.floor(random() * bytes.length);
    bytes[at] = Math.floor(random() * 256);
  }
  const length = Math.max(0, Math.floor(random() * (bytes.length + 1)));
  return bytes.subarray(0, length);
}

describe("parser robustness", () => {
  it("turns mutated Mach-O inputs into stable compatibility errors", () => {
    const source = buildHello().bytes;
    const random = prng(0x5eed_1234);
    let accepted = 0;
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const bytes = mutate(source, random);
      try {
        parseMachO(bytes);
        accepted += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(CompatError);
        expect(typeof (error as CompatError).code).toBe("string");
      }
    }
    // A mutation can still be structurally valid; the point is that nothing
    // crashes outside the compatibility error hierarchy.
    expect(accepted).toBeGreaterThanOrEqual(0);
  });

  it("rejects arbitrary XPC payloads without host exceptions", () => {
    const random = prng(0xc0ffee);
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const length = Math.floor(random() * 64);
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(random() * 256);
      try {
        decodeXpcValue(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(CompatError);
      }
    }
  });
});
