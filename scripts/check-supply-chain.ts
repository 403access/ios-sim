#!/usr/bin/env bun
/**
 * Supply-chain gate (REL-006).
 *
 * Checks workspace manifests, the lockfile, .gitignore, and the documented
 * install command. This is not a vulnerability scanner; it is the policy that
 * keeps the research track reproducible and avoids surprise install hooks.
 *
 * Usage:
 *   bun scripts/check-supply-chain.ts
 *   bun scripts/check-supply-chain.ts --json
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditLockfile,
  auditManifests,
  type Manifest,
  type SupplyChainFinding,
} from "../packages/darwin-compat/src/provenance/supply-chain.js";

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const root = resolve(".");
  const findings: SupplyChainFinding[] = [];
  const manifests: Manifest[] = [];
  const packageFiles = ["package.json"];
  for (const group of ["packages", "apps", "docs-site"]) {
    for (const entry of readdirSync(join(root, group))) {
      const file = join(root, group, entry, "package.json");
      if (existsSync(file)) packageFiles.push(join(group, entry, "package.json"));
    }
  }
  for (const file of packageFiles) {
    manifests.push({
      path: file,
      json: JSON.parse(readFileSync(join(root, file), "utf8")),
    });
  }
  findings.push(...auditManifests(manifests));

  const lockPath = join(root, "bun.lock");
  if (!existsSync(lockPath)) {
    findings.push({ path: "bun.lock", rule: "missing-lockfile", message: "bun.lock is required" });
  } else {
    findings.push(...auditLockfile(readFileSync(lockPath, "utf8")));
  }

  const ignore = existsSync(join(root, ".gitignore"))
    ? readFileSync(join(root, ".gitignore"), "utf8")
    : "";
  for (const entry of ["node_modules", "dist", "build"]) {
    if (!new RegExp(`(^|\\n)${entry}/?($|\\n)`, "m").test(ignore)) {
      findings.push({
        path: ".gitignore",
        rule: "missing-ignore",
        message: `${entry} is not ignored`,
      });
    }
  }
  const readme = readFileSync(join(root, "README.md"), "utf8");
  if (!readme.includes("--frozen-lockfile")) {
    findings.push({
      path: "README.md",
      rule: "frozen-install",
      message: "README does not document bun install --frozen-lockfile",
    });
  }

  if (json) console.log(JSON.stringify({ manifests: manifests.length, findings }, null, 2));
  else {
    for (const finding of findings)
      console.error(`${finding.path} [${finding.rule}] ${finding.message}`);
    console.log(
      `supply chain: ${manifests.length} manifests, lockfile, ignore rules, frozen install; ${findings.length} finding(s)`,
    );
  }
  return findings.length === 0 ? 0 : 1;
}

process.exit(main());
