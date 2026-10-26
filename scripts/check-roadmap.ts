#!/usr/bin/env bun
/**
 * Validate the native backlog (DX-006).
 *
 * Usage:
 *   bun scripts/check-roadmap.ts
 *   bun scripts/check-roadmap.ts --json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateRoadmap } from "../packages/darwin-compat/src/provenance/roadmap.js";

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const path = resolve("docs-site/docs/roadmaps/native/backlog.md");
  const report = validateRoadmap(readFileSync(path, "utf8"));
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const problem of report.problems) {
      console.error(`${path}:${problem.line}: ${problem.message}`);
    }
    console.log(
      `roadmap: ${report.scheduledIds.length} scheduled IDs, ${report.readyIds.length} ready rows, ${report.nextIds.length} next, ${report.problems.length} problem(s)`,
    );
  }
  return report.problems.length === 0 ? 0 : 1;
}

process.exit(main());
