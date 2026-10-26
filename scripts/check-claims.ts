#!/usr/bin/env bun
/**
 * Claims audit (LEG-004).
 *
 * Fails when the repository claims that the substrate runs iOS, ships a
 * simulator, runs Apple UIKit, or runs the simulator natively on Linux.
 *
 * Usage:
 *   bun scripts/check-claims.ts
 *   bun scripts/check-claims.ts --json
 */

import {
  auditRepository,
  formatClaimFindings,
} from "../packages/darwin-compat/src/provenance/claims.js";

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const findings = auditRepository();
  if (json) console.log(JSON.stringify({ findings }, null, 2));
  else console.log(formatClaimFindings(findings));
  return findings.length === 0 ? 0 : 1;
}

process.exit(main());
