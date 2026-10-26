/**
 * Deterministic, outcome-guided mutation fuzzing (QA-001).
 *
 * JavaScript cannot cheaply read edge coverage from the parsers, so this
 * harness uses *outcome novelty* instead: a target returns a signature such as
 * `ok:2:4:1:120` or `err:bad_segment`, and inputs that produce a new signature
 * join the corpus. That is weaker than edge coverage but deterministic,
 * dependency-free, and good at finding new error paths and bounds bugs.
 *
 * The crash contract is strict: target failures must be `CompatError`s with a
 * stable code. Anything else (RangeError, TypeError, host exception) counts as
 * a crash and is surfaced with the mutated bytes.
 */

import { CompatError } from "../errors.js";

export interface FuzzTarget {
  readonly name: string;
  /** Parse or decode `bytes`; return a short outcome signature. */
  run(bytes: Uint8Array): string;
}

export interface FuzzOptions {
  readonly target: FuzzTarget;
  readonly corpus: readonly Uint8Array[];
  readonly iterations: number;
  readonly seed?: number;
  readonly maxCorpus?: number;
  readonly maxInputBytes?: number;
  readonly onProgress?: (done: number, stats: FuzzStats) => void;
}

export interface FuzzStats {
  readonly target: string;
  readonly iterations: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly crashes: number;
  readonly coverage: number;
  readonly corpus: number;
  readonly elapsedMs: number;
}

export interface FuzzCrash {
  readonly signature: string;
  readonly message: string;
  readonly bytes: Uint8Array;
}

export interface FuzzResult extends FuzzStats {
  readonly crashSamples: readonly FuzzCrash[];
}

const INTERESTING_BYTES = [0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff];

export function prng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function mutate(
  source: Uint8Array,
  random: () => number,
  corpus: readonly Uint8Array[],
  maxInputBytes = 2 * 1024 * 1024,
): Uint8Array {
  let bytes = source.slice(0, maxInputBytes);
  const operations = 1 + Math.floor(random() * 4);
  for (let operation = 0; operation < operations; operation += 1) {
    const choice = Math.floor(random() * 8);
    if (bytes.length === 0) {
      bytes = Uint8Array.from([Math.floor(random() * 256)]);
      continue;
    }
    if (choice === 0) {
      const at = Math.floor(random() * bytes.length);
      bytes[at] = bytes[at]! ^ (1 << Math.floor(random() * 8));
    } else if (choice === 1) {
      const at = Math.floor(random() * bytes.length);
      bytes[at] = INTERESTING_BYTES[Math.floor(random() * INTERESTING_BYTES.length)]!;
    } else if (choice === 2) {
      const at = Math.floor(random() * bytes.length);
      const value = INTERESTING_BYTES[Math.floor(random() * INTERESTING_BYTES.length)]!;
      const width = 1 + Math.floor(random() * 4);
      for (let index = 0; index < width && at + index < bytes.length; index += 1) {
        bytes[at + index] = value;
      }
    } else if (choice === 3) {
      const at = Math.floor(random() * bytes.length);
      const count = 1 + Math.floor(random() * Math.min(64, bytes.length - at));
      const next = new Uint8Array(bytes.length - count);
      next.set(bytes.subarray(0, at));
      next.set(bytes.subarray(at + count), at);
      bytes = next;
    } else if (choice === 4) {
      const at = Math.floor(random() * (bytes.length + 1));
      const count = 1 + Math.floor(random() * 32);
      const next = new Uint8Array(bytes.length + count);
      next.set(bytes.subarray(0, at));
      for (let index = 0; index < count; index += 1) {
        next[at + index] = Math.floor(random() * 256);
      }
      next.set(bytes.subarray(at), at + count);
      bytes = next;
    } else if (choice === 5) {
      bytes = bytes.slice(0, Math.floor(random() * (bytes.length + 1)));
    } else if (choice === 6 && corpus.length > 0) {
      const other = corpus[Math.floor(random() * corpus.length)]!;
      const cut = Math.floor(random() * Math.min(bytes.length, other.length));
      const tail = other.subarray(cut);
      const next = new Uint8Array(cut + tail.length);
      next.set(bytes.subarray(0, cut));
      next.set(tail, cut);
      bytes = next;
    } else {
      const at = Math.floor(random() * bytes.length);
      const count = 1 + Math.floor(random() * Math.min(32, bytes.length - at));
      const insertAt = Math.floor(random() * (bytes.length + 1));
      const next = new Uint8Array(bytes.length + count);
      next.set(bytes.subarray(0, insertAt));
      next.set(bytes.subarray(at, at + count), insertAt);
      next.set(bytes.subarray(insertAt), insertAt + count);
      bytes = next;
    }
    if (bytes.length > maxInputBytes) bytes = bytes.slice(0, maxInputBytes);
  }
  return bytes;
}

export function runFuzz(options: FuzzOptions): FuzzResult {
  const random = prng(options.seed ?? 0x5eed_1234);
  const maxCorpus = options.maxCorpus ?? 512;
  const maxInputBytes = options.maxInputBytes ?? 2 * 1024 * 1024;
  const corpus = options.corpus.filter((entry) => entry.length > 0).map((entry) => entry.slice());
  if (corpus.length === 0) corpus.push(Uint8Array.from([0]));
  const seen = new Set<string>();
  const crashSamples: FuzzCrash[] = [];
  const started = Date.now();
  let accepted = 0;
  let crashes = 0;

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const base = corpus[Math.floor(random() * corpus.length)]!;
    const input = mutate(base, random, corpus, maxInputBytes);
    let signature: string;
    try {
      signature = options.target.run(input);
      accepted += 1;
    } catch (error) {
      if (error instanceof CompatError) {
        signature = `err:${error.code}`;
      } else {
        crashes += 1;
        signature = "crash";
        if (crashSamples.length < 8) {
          crashSamples.push({
            signature,
            message: error instanceof Error ? error.message : String(error),
            bytes: input.slice(),
          });
        }
      }
    }
    if (!seen.has(signature)) {
      seen.add(signature);
      if (corpus.length < maxCorpus) corpus.push(input.slice());
    }
    if (options.onProgress && (iteration + 1) % 100_000 === 0) {
      options.onProgress(iteration + 1, {
        target: options.target.name,
        iterations: iteration + 1,
        accepted,
        rejected: iteration + 1 - accepted - crashes,
        crashes,
        coverage: seen.size,
        corpus: corpus.length,
        elapsedMs: Date.now() - started,
      });
    }
  }

  return {
    target: options.target.name,
    iterations: options.iterations,
    accepted,
    rejected: options.iterations - accepted - crashes,
    crashes,
    coverage: seen.size,
    corpus: corpus.length,
    elapsedMs: Math.max(0, Date.now() - started),
    crashSamples,
  };
}
