#!/usr/bin/env bun
/**
 * Run the QA-004 performance baseline.
 *
 * Usage:
 *   bun scripts/bench.ts
 *   bun scripts/bench.ts --scale 0.2 --json
 *
 * Exit code is non-zero when a case exceeds its wall-clock budget.
 */

import {
  formatBenchmarkReport,
  runBenchmarks,
} from "../packages/darwin-compat/src/testing/benchmark.js";
import { standardBenchmarks } from "../packages/darwin-compat/src/testing/benchmarks.js";

function main(): number {
  const args = process.argv.slice(2);
  let scale = 1;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--scale") scale = Number(args[++index]);
    else {
      console.error(`unknown argument ${args[index]}`);
      return 2;
    }
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    console.error("--scale must be a positive number");
    return 2;
  }

  const report = runBenchmarks(standardBenchmarks(), {
    scale,
    onResult: json
      ? undefined
      : (result) =>
          console.error(
            `${result.name}: ${result.totalMs}ms (${result.microsecondsPerOp}us/op) ${result.passed ? "ok" : "OVER"}`,
          ),
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatBenchmarkReport(report));
  return report.passed ? 0 : 1;
}

process.exit(main());
