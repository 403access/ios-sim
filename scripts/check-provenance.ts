#!/usr/bin/env bun
/**
 * Validate the provenance ledger (LEG-001).
 *
 * Checks required IDs, duplicate/empty entries, and that every evidence path
 * exists. Exit code is non-zero on any problem.
 *
 * Usage:
 *   bun scripts/check-provenance.ts
 *   bun scripts/check-provenance.ts --json
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROVENANCE, validateProvenance } from "../packages/darwin-compat/src/provenance/ledger.js";

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const problems = validateProvenance();
  for (const entry of PROVENANCE) {
    for (const path of entry.evidence) {
      if (!existsSync(resolve(process.cwd(), path))) {
        problems.push({ id: entry.id, message: `missing evidence: ${path}` });
      }
    }
  }
  if (json) console.log(JSON.stringify({ claims: PROVENANCE.length, problems }, null, 2));
  else {
    for (const entry of PROVENANCE) {
      console.log(`${entry.id.padEnd(14)} ${entry.status.padEnd(12)} ${entry.claim}`);
    }
    for (const problem of problems) console.error(`${problem.id}: ${problem.message}`);
    console.log(`provenance: ${PROVENANCE.length} claims, ${problems.length} problem(s)`);
  }
  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
