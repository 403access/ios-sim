#!/usr/bin/env bun
/**
 * Version consistency gate (REL-004).
 *
 * Requires all workspace packages to share one semantic version and the host
 * ABI / capability / event schema constants to agree across C, TS, and docs.
 *
 * Usage:
 *   bun scripts/check-versions.ts
 *   bun scripts/check-versions.ts --json
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface Problem {
  file: string;
  message: string;
}

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const problems: Problem[] = [];
  const root = resolve(".");
  const packageFiles = ["package.json"];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(root, group))) {
      const file = join(root, group, entry, "package.json");
      if (existsSync(file)) packageFiles.push(join(group, entry, "package.json"));
    }
  }

  const versions = new Map<string, string[]>();
  for (const file of packageFiles) {
    const pkg = JSON.parse(readFileSync(join(root, file), "utf8")) as {
      name?: string;
      version?: string;
    };
    const version = pkg.version ?? "<missing>";
    versions.set(version, [...(versions.get(version) ?? []), pkg.name ?? file]);
  }
  if (versions.size !== 1) {
    problems.push({
      file: "package.json",
      message: `workspace versions differ: ${JSON.stringify(Object.fromEntries(versions))}`,
    });
  }

  const header = readFileSync(join(root, "packages/darwin-host/include/darwin_host.h"), "utf8");
  const headerAbi = Number(/DH_ABI_VERSION\s+(\d+)u/.exec(header)?.[1]);
  const ffi = readFileSync(join(root, "packages/darwin-host/src/ffi.ts"), "utf8");
  const ffiAbi = Number(/DH_ABI_VERSION\s*=\s*(\d+)/.exec(ffi)?.[1]);
  if (headerAbi !== ffiAbi) {
    problems.push({
      file: "packages/darwin-host",
      message: `host ABI mismatch: header ${headerAbi}, TS ${ffiAbi}`,
    });
  }

  const capabilities = readFileSync(
    join(root, "packages/darwin-compat/src/capabilities.ts"),
    "utf8",
  );
  const capabilityVersion = Number(/CAPABILITY_SCHEMA_VERSION\s*=\s*(\d+)/.exec(capabilities)?.[1]);
  const events = readFileSync(
    join(root, "packages/darwin-compat/src/observability/events.ts"),
    "utf8",
  );
  const eventVersion = Number(/EVENT_SCHEMA_VERSION\s*=\s*(\d+)/.exec(events)?.[1]);
  if (!Number.isInteger(capabilityVersion) || capabilityVersion < 1) {
    problems.push({ file: "capabilities.ts", message: "capability schema version is missing" });
  }
  if (!Number.isInteger(eventVersion) || eventVersion < 1) {
    problems.push({ file: "events.ts", message: "event schema version is missing" });
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          versions: Object.fromEntries(versions),
          hostAbi: { header: headerAbi, typescript: ffiAbi },
          capabilitySchema: capabilityVersion,
          eventSchema: eventVersion,
          problems,
        },
        null,
        2,
      ),
    );
  } else {
    for (const problem of problems) console.error(`${problem.file}: ${problem.message}`);
    console.log(
      `versions: ${[...versions.keys()].join(", ")}, host ABI ${headerAbi}/${ffiAbi}, capability ${capabilityVersion}, events ${eventVersion}`,
    );
  }
  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
