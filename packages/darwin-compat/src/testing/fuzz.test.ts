import { describe, expect, it } from "vitest";
import { parseMachO } from "../macho/parse.js";
import { buildHello, buildHelperDylib } from "./fixtures.js";
import { mutate, prng, runFuzz } from "./fuzz.js";

const target = {
  name: "macho",
  run(bytes: Uint8Array) {
    const { image } = parseMachO(bytes);
    return `ok:${image.header.fileType}:${image.segments.length}:${image.dylibs.length}`;
  },
};

describe("deterministic fuzz harness", () => {
  it("varies inputs deterministically and grows coverage", () => {
    const first = runFuzz({
      target,
      corpus: [buildHello().bytes, buildHelperDylib().bytes],
      iterations: 5000,
      seed: 7,
    });
    const second = runFuzz({
      target,
      corpus: [buildHello().bytes, buildHelperDylib().bytes],
      iterations: 5000,
      seed: 7,
    });
    expect(first.crashes).toBe(0);
    expect(first.coverage).toBeGreaterThan(3);
    expect(first.corpus).toBeGreaterThan(2);
    expect(second.accepted).toBe(first.accepted);
    expect(second.coverage).toBe(first.coverage);
    expect(second.corpus).toBe(first.corpus);
  });

  it("reports non-CompatError failures as crashes", () => {
    const result = runFuzz({
      target: {
        name: "hostile",
        run() {
          throw new TypeError("host bug");
        },
      },
      corpus: [Uint8Array.from([1, 2, 3])],
      iterations: 10,
    });
    expect(result.crashes).toBe(10);
    expect(result.crashSamples[0]?.message).toContain("host bug");
  });

  it("mutates without exceeding the input cap", () => {
    const random = prng(99);
    const corpus = [buildHello().bytes];
    for (let index = 0; index < 200; index += 1) {
      const bytes = mutate(corpus[0]!, random, corpus, 4096);
      expect(bytes.length).toBeLessThanOrEqual(4096);
    }
  });
});
