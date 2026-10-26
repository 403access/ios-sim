#!/usr/bin/env bun
/**
 * Materialize the generated Mach-O corpus (QA-003).
 *
 * Output: build/corpus/<name>.bin plus manifest.json. The bytes are generated
 * from this repository's builder; nothing Apple-owned is written.
 *
 * Usage:
 *   bun scripts/build-corpus.ts
 *   bun scripts/build-corpus.ts --out /tmp/corpus
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCorpus, runCorpus } from "../packages/darwin-compat/src/testing/corpus.js";

function main(): number {
  const args = process.argv.slice(2);
  let out = resolve("build/corpus");
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--out") out = resolve(args[++index]!);
    else {
      console.error(`unknown argument ${args[index]}`);
      return 2;
    }
  }

  const cases = buildCorpus();
  const report = runCorpus(cases);
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`${failure.name}: ${failure.message}`);
    return 1;
  }

  mkdirSync(out, { recursive: true });
  const manifest = cases.map((testCase) => {
    const file = `${testCase.name}.bin`;
    writeFileSync(join(out, file), testCase.bytes);
    return {
      name: testCase.name,
      file,
      target: testCase.target,
      tags: testCase.tags,
      valid: testCase.valid,
      expectedCode: testCase.expectedCode ?? null,
      bytes: testCase.bytes.length,
    };
  });
  writeFileSync(
    join(out, "manifest.json"),
    `${JSON.stringify({ generatedBy: "scripts/build-corpus.ts", cases: manifest }, null, 2)}\n`,
  );
  console.log(
    `corpus: ${report.total} cases (${report.valid} valid, ${report.invalid} invalid), ${report.loadCommands.length} load commands, formats ${report.pointerFormats.join(",")} -> ${out}`,
  );
  return 0;
}

process.exit(main());
