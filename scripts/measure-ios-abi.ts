/**
 * Measure the Objective-C ABI facts of the minimal stock-SDK app.
 *
 * This is step 1 of the M1 charter (docs-site/docs/plans/m1-replacement-images.md):
 * every layout number needs provenance. The script reads the app's own
 * `class_ro_t` metadata and reports instance sizes and ivar offsets; it never
 * loads or redistributes Apple code. Numbers that cannot be measured from this
 * image stay in the `unverified` list.
 *
 * Usage: bun scripts/measure-ios-abi.ts [app] [output]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { inspectObjc } from "../packages/darwin-compat/src/objc/inspect.js";

const root = join(import.meta.dirname, "..");
const app = resolve(process.argv[2] ?? join(root, "fixtures/ios-app/build/SpikeApp"));
const output = resolve(process.argv[3] ?? join(root, "fixtures/ios-app/abi.json"));

if (!existsSync(app)) {
  console.error(
    `skip: ${app} is missing; build it first with \`bun scripts/spike-ios-symbols.ts\``,
  );
  process.exit(1);
}

const inspection = inspectObjc(readFileSync(app), app);

interface ClassReport {
  readonly name: string;
  readonly superclass: string | null;
  readonly instanceSize: number;
  readonly ivars: ReadonlyArray<{ name: string; offset: number; type: string }>;
}

const classes: ClassReport[] = inspection.classes
  .filter((klass) => klass.name !== "__NSCFConstantString")
  .map((klass) => ({
    name: klass.name,
    superclass: klass.superclass,
    instanceSize: klass.instanceSize,
    ivars: klass.ivars
      .map((ivar) => ({ name: ivar.name, offset: ivar.offset, type: ivar.type }))
      .sort((left, right) => left.offset - right.offset || left.name.localeCompare(right.name)),
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

/**
 * A subclass's first ivar offset is the aligned instance size of its
 * superclass. For AppDelegate the first ivar sits at 8, so UIResponder is 8
 * bytes; that is a measurement, not a guess.
 */
const derived: Record<string, number> = {};
for (const klass of classes) {
  if (klass.superclass === null || klass.ivars.length === 0) continue;
  const first = Math.min(...klass.ivars.map((ivar) => ivar.offset));
  const current = derived[klass.superclass];
  derived[klass.superclass] = current === undefined ? first : Math.min(current, first);
}

const report = {
  app: "fixtures/ios-app/main.m",
  binary: "fixtures/ios-app/build/SpikeApp (not committed)",
  sdk: "iPhoneSimulator27.1.sdk",
  source: "class_ro_t.instanceSize and ivar_t offsets in the app image",
  classes,
  derivedSuperclassSize: derived,
  unverified: [
    "UIView / UIWindow / UILabel / UIButton / UIViewController instance sizes (no subclasses in this app)",
    "NSString / NSArray / NSDictionary instance sizes (CF-backed; literal layouts are measured separately)",
    "NSObject/CF retain-count layout and weak-table semantics",
    "UIKit's own ivars and method implementations",
  ],
  notes: [
    "Only the app's own classes carry metadata in this image.",
    "Ivar offsets were read through ivar_t.offset pointers after the chained-fixup pass.",
    "The fixture is pinned to the installed Xcode; re-run after an SDK change.",
  ],
} as const;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

console.log(`app: ${app}`);
console.log(`sdk: ${report.sdk}`);
for (const klass of classes) {
  console.log(
    `${klass.name} : ${klass.superclass ?? "(root)"} — ${klass.instanceSize} bytes` +
      (klass.ivars.length > 0
        ? ` · ${klass.ivars.map((ivar) => `${ivar.name}@${ivar.offset}`).join(", ")}`
        : ""),
  );
}
for (const [name, size] of Object.entries(derived)) {
  console.log(`derived: ${name} instance size = ${size} (first subclass ivar offset)`);
}
console.log(`unverified: ${report.unverified.length} areas (see ${output})`);
