/**
 * Run the minimal stock-SDK app (`fixtures/ios-app/main.m`) with replacement
 * framework images, without loading an Apple binary.
 *
 * The five dylibs the app links are served from memory by
 * `dependencyOverrides`; their symbols resolve into the host runtime
 * (`ImageLoader` falls back to the ObjcHost symbol table). Frames go to
 * `--out-dir` when given, and digests are printed otherwise.
 *
 * Usage:
 *   bun scripts/spike-ios-symbols.ts          # build the app once
 *   bun scripts/run-ios-app.ts [--tap x,y] [--out-dir dir]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CaptureSink,
  DarwinRuntime,
  MapFileProvider,
  encodePng,
} from "../packages/darwin-compat/src/index.js";
import { buildIosAppImages } from "./build-ios-app-images.js";

const appPath = resolve("fixtures/ios-app/build/SpikeApp");
const args = process.argv.slice(2);
const taps: Array<{ x: number; y: number }> = [];
let outDir: string | null = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--tap" && args[index + 1]) {
    const [x, y] = args[index + 1]!.split(",").map(Number);
    taps.push({ x: x!, y: y! });
    index += 1;
  } else if (args[index] === "--out-dir" && args[index + 1]) {
    outDir = resolve(args[index + 1]!);
    index += 1;
  }
}

let bytes: Uint8Array;
try {
  bytes = new Uint8Array(readFileSync(appPath));
} catch {
  console.error(`skip: ${appPath} is missing; build it with \`bun scripts/spike-ios-symbols.ts\``);
  process.exit(1);
}

const stdout = new CaptureSink();
const stderr = new CaptureSink();
const runtime = new DarwinRuntime({
  provider: new MapFileProvider(new Map([["/SpikeApp", bytes]])),
  rootDir: process.cwd(),
  defaultStdout: stdout,
  defaultStderr: stderr,
});
const result = runtime.run("/SpikeApp", {
  argv: [],
  events: taps,
  dependencyOverrides: buildIosAppImages(),
  stdout,
  stderr,
});

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  result.frames.forEach((frame, index) => {
    writeFileSync(
      join(outDir, `frame-${index}.png`),
      encodePng(frame.width, frame.height, frame.pixels),
    );
  });
}
console.log(`exit ${result.exitStatus} · ${result.instructions} instructions`);
console.log(`images ${result.program.images.length} · frames ${result.frames.length}`);
for (const [index, frame] of result.frames.entries()) {
  console.log(`frame ${index} ${frame.width}x${frame.height} sha256=${frame.digest}`);
}
const log = new TextDecoder().decode(stderr.bytes());
if (log.length > 0) console.log(log.trimEnd());
if (outDir) console.log(`frames written to ${outDir}`);
