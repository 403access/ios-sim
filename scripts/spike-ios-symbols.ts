/**
 * Measure what a stock-SDK UIKit app needs from Apple's frameworks.
 *
 * This is the evidence-gathering step of the binary-compatibility spike: it
 * compiles fixtures/ios-app/main.m against the local iOS Simulator SDK, then
 * groups the undefined symbols the binary carries. The report is written to
 * fixtures/ios-app/build/ (git-ignored); no Apple binary is committed and no
 * Apple runtime is executed.
 *
 * Usage: bun scripts/spike-ios-symbols.ts [outputDir]
 *
 * Needs macOS with Xcode. Prints a skip reason and exits 1 elsewhere, matching
 * the repository's other Apple-tooling scripts.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = join(root, "fixtures/ios-app/main.m");
const outputDir = process.argv[2] ?? join(root, "fixtures/ios-app/build");

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

if (process.platform !== "darwin") {
  console.error(
    `skip: the stock-SDK symbol spike needs macOS plus Xcode (platform=${process.platform})`,
  );
  process.exit(1);
}
const sdk = spawnSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], {
  encoding: "utf8",
});
if (sdk.status !== 0 || sdk.stdout.trim() === "") {
  console.error("skip: the iPhoneSimulator SDK is not installed (xcrun --sdk iphonesimulator)");
  process.exit(1);
}
const sdkPath = sdk.stdout.trim();

mkdirSync(outputDir, { recursive: true });
const binary = join(outputDir, "SpikeApp");

run("xcrun", [
  "--sdk",
  "iphonesimulator",
  "clang",
  "-target",
  "arm64-apple-ios17.0-simulator",
  "-isysroot",
  sdkPath,
  "-fobjc-arc",
  "-fblocks",
  "-framework",
  "UIKit",
  "-framework",
  "Foundation",
  source,
  "-o",
  binary,
]);

const undefinedSymbols = run("nm", ["-u", binary])
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("_"))
  .map((line) => line.replace(/\s+\(.*\)$/, ""))
  .sort();

const classes = undefinedSymbols.filter((symbol) => symbol.startsWith("_OBJC_CLASS_$_"));
const protocols = undefinedSymbols.filter((symbol) => symbol.startsWith("_OBJC_PROTOCOL_$_"));
const runtime = undefinedSymbols.filter((symbol) => symbol.startsWith("_objc_"));
const blocks = undefinedSymbols.filter(
  (symbol) => symbol.startsWith("__Block_") || symbol.startsWith("__NSConcrete"),
);
const constants = undefinedSymbols.filter(
  (symbol) => /^_k[A-Z]/.test(symbol) || symbol.startsWith("_UI"),
);
const other = undefinedSymbols.filter(
  (symbol) =>
    !classes.includes(symbol) &&
    !protocols.includes(symbol) &&
    !runtime.includes(symbol) &&
    !blocks.includes(symbol) &&
    !constants.includes(symbol),
);

const report = {
  generated: new Date().toISOString(),
  sdk: sdkPath,
  source: "fixtures/ios-app/main.m",
  counts: {
    total: undefinedSymbols.length,
    objectiveCClasses: classes.length,
    protocols: protocols.length,
    objcRuntime: runtime.length,
    blocksRuntime: blocks.length,
    uiConstants: constants.length,
    other: other.length,
  },
  objectiveCClasses: classes,
  objcRuntime: runtime,
  blocksRuntime: blocks,
  uiConstants: constants.slice(0, 40),
  other: other.slice(0, 80),
};

writeFileSync(join(outputDir, "symbols.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`sdk: ${sdkPath}`);
console.log(`binary: ${binary}`);
console.log(`undefined symbols: ${report.counts.total}`);
console.log(`  Objective-C classes: ${report.counts.objectiveCClasses}`);
console.log(`  protocols:           ${report.counts.protocols}`);
console.log(`  objc runtime:        ${report.counts.objcRuntime}`);
console.log(`  blocks runtime:      ${report.counts.blocksRuntime}`);
console.log(`  UIKit constants:     ${report.counts.uiConstants}`);
console.log(`  other:               ${report.counts.other}`);
console.log("");
console.log("classes:");
for (const name of classes) console.log(`  ${name}`);
console.log("");
console.log("objc runtime:");
for (const name of runtime) console.log(`  ${name}`);
if (blocks.length > 0) {
  console.log("");
  console.log("blocks runtime:");
  for (const name of blocks) console.log(`  ${name}`);
}
console.log("");
console.log(`report: ${join(outputDir, "symbols.json")}`);
