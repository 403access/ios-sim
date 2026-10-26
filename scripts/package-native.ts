#!/usr/bin/env bun
/**
 * Build and pack the native artifacts (REL-003).
 *
 * Produces:
 *   build/packages/*.tgz
 *   build/packages/manifest.json (name, version, bytes, sha256)
 *
 * `ios-sim-native` is the installable CLI; `@ios-sim/darwin-compat` is its
 * runtime dependency. No Apple binaries or SDK files are included.
 *
 * Usage:
 *   bun scripts/package-native.ts
 *   bun scripts/package-native.ts --json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

interface Artifact {
  name: string;
  version: string;
  file: string;
  bytes: number;
  sha256: string;
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with ${result.exitCode}`);
  }
}

function pack(directory: string, destination: string): string {
  const before = new Set(readdirSync(destination).filter((file) => file.endsWith(".tgz")));
  run(["bun", "pm", "pack", "--destination", destination], directory);
  const created = readdirSync(destination).filter(
    (file) => file.endsWith(".tgz") && !before.has(file),
  );
  if (created.length === 0) throw new Error(`no new tarball produced in ${destination}`);
  return join(destination, created.sort()[created.length - 1]!);
}

function main(): number {
  const json = process.argv.slice(2).includes("--json");
  const root = resolve(".");
  const destination = join(root, "build/packages");
  mkdirSync(destination, { recursive: true });

  const packages = [
    {
      directory: join(root, "packages/darwin-compat"),
      name: "@ios-sim/darwin-compat",
      version: "0.1.0",
    },
    { directory: join(root, "apps/native"), name: "@ios-sim/native", version: "0.1.0" },
  ];
  for (const entry of packages) {
    run(["bun", "run", "--cwd", entry.directory, "build"], root);
  }

  const artifacts: Artifact[] = [];
  for (const entry of packages) {
    const tarball = pack(entry.directory, destination);
    const bytes = readFileSync(tarball);
    artifacts.push({
      name: entry.name,
      version: entry.version,
      file: basename(tarball),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const manifest = { generatedAt: new Date().toISOString(), artifacts };
  writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (json) console.log(JSON.stringify(manifest, null, 2));
  else {
    for (const artifact of artifacts) {
      console.log(
        `${artifact.name}@${artifact.version}  ${artifact.bytes} bytes  sha256:${artifact.sha256}`,
      );
    }
    console.log(`manifest -> ${join(destination, "manifest.json")}`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
