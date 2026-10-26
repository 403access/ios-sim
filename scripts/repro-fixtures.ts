#!/usr/bin/env bun
/**
 * Reproducible fixture check (REL-002).
 *
 * Builds the generated corpus twice in the same process and compares SHA-256
 * hashes. Any nondeterminism (timestamps, random UUIDs, hash-map order) shows
 * up as a mismatch. Output: build/corpus.sha256.
 *
 * Usage:
 *   bun scripts/repro-fixtures.ts
 *   bun scripts/repro-fixtures.ts --json
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildCorpus } from "../packages/darwin-compat/src/testing/corpus.js";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const first = buildCorpus();
  const second = buildCorpus();
  if (first.length !== second.length) {
    console.error(`corpus length changed: ${first.length} vs ${second.length}`);
    return 1;
  }

  const mismatches: string[] = [];
  const manifest: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const a = first[index]!;
    const b = second[index]!;
    const hashA = hash(a.bytes);
    const hashB = hash(b.bytes);
    manifest.push(`${hashA}  ${a.name}.bin`);
    if (a.name !== b.name || hashA !== hashB) {
      mismatches.push(`${a.name}: ${hashA} != ${hashB}`);
    }
  }

  if (json) {
    console.log(JSON.stringify({ cases: first.length, mismatches }, null, 2));
  } else if (mismatches.length > 0) {
    for (const mismatch of mismatches) console.error(mismatch);
  } else {
    const out = resolve("build/corpus.sha256");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${manifest.join("\n")}\n`);
    console.log(`reproducible: ${first.length} fixtures, SHA-256 manifest -> ${out}`);
  }
  return mismatches.length === 0 ? 0 : 1;
}

process.exit(main());
