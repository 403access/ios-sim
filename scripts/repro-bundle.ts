#!/usr/bin/env bun
/**
 * Build a reproduction bundle (DX-004).
 *
 * Output: build/repro/ios-sim-native-repro-<rev>.tar.gz containing doctor,
 * versions, corpus hashes, benchmark results, environment metadata, a README,
 * and a manifest with SHA-256 for every file.
 *
 * Usage:
 *   bun scripts/repro-bundle.ts
 *   bun scripts/repro-bundle.ts --json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { capabilityReport } from "../packages/darwin-compat/src/capabilities.js";
import { buildCorpus } from "../packages/darwin-compat/src/testing/corpus.js";
import { runBenchmarks } from "../packages/darwin-compat/src/testing/benchmark.js";
import { standardBenchmarks } from "../packages/darwin-compat/src/testing/benchmarks.js";
import {
  buildReproManifest,
  describeReproFile,
  sha256Hex,
} from "../packages/darwin-compat/src/testing/repro.js";

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString().trim();
}

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const root = resolve(".");
  const revision = git(["rev-parse", "HEAD"]) || "unknown";
  const dirty = git(["status", "--porcelain"]).length > 0;
  const output = join(root, "build/repro");
  mkdirSync(output, { recursive: true });

  const files: Record<string, Uint8Array> = {};
  const write = (name: string, value: unknown): void => {
    files[name] = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  };
  write("doctor.json", capabilityReport());
  write("versions.json", {
    runtimeVersion: "0.1.0",
    bun: (process.versions as { bun?: string }).bun ?? null,
    node: process.versions.node,
  });
  write("environment.json", {
    platform: platform(),
    architecture: arch(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryBytes: totalmem(),
  });
  write(
    "corpus.json",
    buildCorpus().map((testCase) => ({
      name: testCase.name,
      target: testCase.target,
      valid: testCase.valid,
      bytes: testCase.bytes.length,
      sha256: sha256Hex(testCase.bytes),
    })),
  );
  write("bench.json", runBenchmarks(standardBenchmarks(), { scale: 0.1 }));

  files["README.txt"] = new TextEncoder().encode(
    [
      "ios-sim-native reproduction bundle",
      "",
      `revision: ${revision}${dirty ? " (dirty working tree)" : ""}`,
      "",
      "On another host:",
      "  1. bun install --frozen-lockfile",
      "  2. bun run corpus && bun run repro",
      "  3. bun run bench --json > bench.json",
      "  4. bun run doctor --json",
      "",
      "Compare corpus hashes and bench metadata. Timing is machine-dependent;",
      "the manifest and corpus hashes must match.",
      "",
    ].join("\n"),
  );

  const described = Object.entries(files).map(([name, bytes]) => describeReproFile(name, bytes));
  const manifest = buildReproManifest({
    createdAt: new Date().toISOString(),
    sourceRevision: revision,
    dirty,
    platform: platform(),
    architecture: arch(),
    runtime: "bun",
    runtimeVersion: (process.versions as { bun?: string }).bun ?? "unknown",
    files: described,
  });
  files["manifest.json"] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(output, name), bytes);
  const tarball = join(output, `ios-sim-native-repro-${revision.slice(0, 12)}.tar.gz`);
  const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", output, ...Object.keys(files).sort()], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    console.error(tar.stderr.toString());
    return 1;
  }
  writeFileSync(
    join(output, "manifest.sha256"),
    `${sha256Hex(readFileSync(tarball))}  ${tarball}\n`,
  );

  if (json) {
    console.log(
      JSON.stringify({ tarball, manifest, sha256: sha256Hex(readFileSync(tarball)) }, null, 2),
    );
  } else {
    console.log(`repro bundle: ${tarball}`);
    console.log(`  revision: ${revision}${dirty ? " (dirty)" : ""}`);
    console.log(`  files: ${described.length + 1}, sha256:${sha256Hex(readFileSync(tarball))}`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
