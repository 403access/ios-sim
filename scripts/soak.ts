#!/usr/bin/env bun
/**
 * Run the QA-006 resource soak.
 *
 * Usage:
 *   bun scripts/soak.ts --seconds 30
 *   bun scripts/soak.ts --hours 24 --interval-ms 60000 --json
 *
 * Exit code is non-zero when any counter grows past its tolerance. A 24-hour
 * run uses the same code; nothing special is enabled for long runs.
 */

import { runSoak } from "../packages/darwin-compat/src/testing/soak.js";
import { standardSoakCases } from "../packages/darwin-compat/src/testing/soak-cases.js";

function main(): number {
  const args = process.argv.slice(2);
  let durationMs = 60_000;
  let intervalMs = 5000;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--seconds") durationMs = Number(args[++index]) * 1000;
    else if (arg === "--hours") durationMs = Number(args[++index]) * 3_600_000;
    else if (arg === "--interval-ms") intervalMs = Number(args[++index]);
    else {
      console.error(`unknown argument ${arg}`);
      return 2;
    }
  }
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    console.error("duration and interval must be positive");
    return 2;
  }

  const report = runSoak(standardSoakCases(), { durationMs, intervalMs });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `soak: ${durationMs}ms, interval ${intervalMs}ms, ${report.passed ? "flat" : "LEAK"}`,
    );
    for (const result of report.cases) {
      console.log(
        `  ${result.name}: ${result.steps} steps, growth=${JSON.stringify(result.growth)}, ${result.passed ? "ok" : "OVER"}`,
      );
    }
  }
  return report.passed ? 0 : 1;
}

process.exit(main());
