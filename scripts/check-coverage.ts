#!/usr/bin/env bun
/**
 * Parser coverage gate (QA-007).
 *
 * Reads coverage/coverage-summary.json produced by
 *   bunx vitest run --coverage --coverage.reporter=json-summary
 * and requires aggregate statement coverage >= 90% across Mach-O parsers.
 *
 * Usage:
 *   bun scripts/check-coverage.ts
 *   bun scripts/check-coverage.ts --json
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SummaryEntry {
  statements: { total: number; covered: number; pct: number };
  lines: { pct: number };
  functions: { pct: number };
}

const THRESHOLD = 90;

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const file = resolve("coverage/coverage-summary.json");
  if (!existsSync(file)) {
    console.error("coverage summary is missing; run `bun run test:coverage` first");
    return 1;
  }
  const summary = JSON.parse(readFileSync(file, "utf8")) as Record<string, SummaryEntry>;
  const parsers = Object.entries(summary).filter(
    ([path]) => path.includes("/packages/darwin-compat/src/macho/") && !path.endsWith(".test.ts"),
  );
  if (parsers.length === 0) {
    console.error("coverage summary has no Mach-O parser entries");
    return 1;
  }
  let total = 0;
  let covered = 0;
  const rows = parsers.map(([path, entry]) => {
    total += entry.statements.total;
    covered += entry.statements.covered;
    return {
      file: path.split("darwin-compat/")[1] ?? path,
      statements: entry.statements.pct,
      lines: entry.lines.pct,
      functions: entry.functions.pct,
    };
  });
  const aggregate = total === 0 ? 0 : (covered / total) * 100;
  const passed = aggregate >= THRESHOLD;
  if (json) {
    console.log(
      JSON.stringify({ threshold: THRESHOLD, aggregate, covered, total, rows, passed }, null, 2),
    );
  } else {
    for (const row of rows) {
      console.log(
        `${row.file.padEnd(34)} statements ${row.statements.toFixed(2).padStart(6)}%  lines ${row.lines.toFixed(2).padStart(6)}%`,
      );
    }
    console.log(
      `parser aggregate: ${aggregate.toFixed(2)}% statements (${covered}/${total}), threshold ${THRESHOLD}% ${passed ? "ok" : "FAILED"}`,
    );
  }
  return passed ? 0 : 1;
}

process.exit(main());
