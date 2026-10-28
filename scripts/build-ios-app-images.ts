/**
 * Build the five replacement dylibs a stock SDK app depends on.
 *
 * The app's LC_LOAD_DYLIB entries name Apple paths. `dependencyOverrides`
 * serves these images from memory instead, so the loader never reads an Apple
 * binary. Symbols still resolve into the host runtime: `ImageLoader` falls back
 * to the ObjcHost symbol table when an ordinal lookup misses.
 *
 * Usage: bun scripts/build-ios-app-images.ts [outputDir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ret, words } from "../packages/darwin-compat/src/arm64/assembler.js";
import { buildMachO } from "../packages/darwin-compat/src/macho/build.js";

export const IOS_APP_IMAGES: ReadonlyArray<string> = [
  "/System/Library/Frameworks/UIKit.framework/UIKit",
  "/System/Library/Frameworks/Foundation.framework/Foundation",
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  "/usr/lib/libobjc.A.dylib",
  "/usr/lib/libSystem.B.dylib",
];

/** Build in memory: install name -> Mach-O bytes. */
export function buildIosAppImages(): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const installName of IOS_APP_IMAGES) {
    const built = buildMachO({
      fileType: "dylib",
      installName,
      text: words(ret()),
      exports: [],
      dependencies: [],
    });
    images.set(installName, built.bytes);
  }
  return images;
}

if (import.meta.main) {
  const directory = resolve(process.argv[2] ?? "fixtures/ios-app/build/frameworks");
  mkdirSync(directory, { recursive: true });
  for (const [installName, bytes] of buildIosAppImages()) {
    const name = installName.split("/").pop()!;
    writeFileSync(join(directory, name), bytes);
    console.log(`wrote ${join(directory, name)} (${installName})`);
  }
}
