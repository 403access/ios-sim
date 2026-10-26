#!/usr/bin/env bun
/**
 * Deterministic fuzz runner (QA-001).
 *
 * Usage:
 *   bun scripts/fuzz-darwin.ts --iterations 1000000
 *   bun scripts/fuzz-darwin.ts --target macho --seed 1234 --json
 *   bun scripts/fuzz-darwin.ts --target all --iterations 100000
 *
 * Exit code is non-zero when any target produces a non-CompatError (host crash).
 */

import { parseMachO } from "../packages/darwin-compat/src/macho/parse.js";
import {
  buildSyntheticCacheWithImage,
  buildSyntheticSharedCache,
  parseSharedCache,
} from "../packages/darwin-compat/src/dyld/shared-cache.js";
import { parsePlist } from "../packages/darwin-compat/src/plist/parse.js";
import { decodeXpcValue } from "../packages/darwin-compat/src/xpc/codec.js";
import { parseSwiftFields } from "../packages/darwin-compat/src/swift/metadata.js";
import {
  runFuzz,
  type FuzzResult,
  type FuzzTarget,
} from "../packages/darwin-compat/src/testing/fuzz.js";
import {
  buildCollisionDylib,
  buildDependentProgram,
  buildHello,
  buildHelperDylib,
  buildInitializerProgram,
  buildInterposingDylib,
  buildLegacyDependentProgram,
  buildMachPingProgram,
} from "../packages/darwin-compat/src/testing/fixtures.js";

function swiftFieldSeed(): Uint8Array {
  const name = new TextEncoder().encode("name\0$sSS\0");
  const recordSize = 16;
  const dataStart = 16 + recordSize;
  const bytes = new Uint8Array(dataStart + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, recordSize, true);
  view.setUint32(12, 1, true);
  view.setInt32(16, dataStart - 16, true);
  view.setInt32(20, dataStart + 5 - 20, true);
  bytes.set(name, dataStart);
  return bytes;
}

interface Options {
  target: "macho" | "plist" | "xpc" | "cache" | "swift" | "all";
  iterations: number;
  seed: number;
  json: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { target: "all", iterations: 1_000_000, seed: 0x5eed_1234, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--iterations") options.iterations = Number(argv[++index]);
    else if (arg === "--seed") options.seed = Number(argv[++index]);
    else if (arg === "--target") {
      const value = argv[++index];
      if (
        value !== "macho" &&
        value !== "plist" &&
        value !== "xpc" &&
        value !== "cache" &&
        value !== "swift" &&
        value !== "all"
      ) {
        throw new Error(`unknown target ${value}`);
      }
      options.target = value;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
    throw new Error("--iterations must be a positive integer");
  }
  return options;
}

function printHelp(): void {
  console.log(
    "usage: bun scripts/fuzz-darwin.ts [--target macho|plist|xpc|cache|swift|all] [--iterations N] [--seed N] [--json]",
  );
}

function machoCorpus(): Uint8Array[] {
  return [
    buildHello().bytes,
    buildDependentProgram().bytes,
    buildLegacyDependentProgram().bytes,
    buildMachPingProgram().bytes,
    buildHelperDylib().bytes,
    buildInitializerProgram().bytes,
    buildInterposingDylib().bytes,
    buildCollisionDylib("/lib/libfuzz.dylib", 7).bytes,
  ];
}

const targets: Record<
  "macho" | "plist" | "xpc" | "cache" | "swift",
  { target: FuzzTarget; corpus: Uint8Array[] }
> = {
  macho: {
    target: {
      name: "macho",
      run(bytes) {
        const { image } = parseMachO(bytes);
        return `ok:${image.header.fileType}:${image.segments.length}:${image.dylibs.length}:${image.symbols.length}`;
      },
    },
    corpus: machoCorpus(),
  },
  plist: {
    target: {
      name: "plist",
      run(bytes) {
        const value = parsePlist(new TextDecoder().decode(bytes));
        return `ok:${Array.isArray(value) ? "array" : typeof value}`;
      },
    },
    corpus: [
      new TextEncoder().encode(
        '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.example</string></dict></plist>',
      ),
      new TextEncoder().encode(
        '<plist version="1.0"><array><integer>1</integer><true/><data>AA==</data></array></plist>',
      ),
    ],
  },
  cache: {
    target: {
      name: "cache",
      run(bytes) {
        const cache = parseSharedCache(bytes);
        return `ok:${cache.mappings.length}:${cache.images.length}:${cache.subCaches.length}`;
      },
    },
    corpus: [
      buildSyntheticSharedCache(),
      buildSyntheticSharedCache({
        imagePaths: ["/a", "/b"],
        images: [
          { address: 0x180001000n, modTime: 0n, inode: 1n },
          { address: 0x180002000n, modTime: 0n, inode: 2n },
        ],
        subCaches: [{ uuid: "00112233-4455-6677-8899-aabbccddeeff", cacheVMOffset: 0n }],
      }),
      buildSyntheticCacheWithImage("/lib/x", buildHello().bytes),
    ],
  },
  swift: {
    target: {
      name: "swift",
      run(bytes) {
        const fields = parseSwiftFields(bytes);
        return `ok:${fields.length}:${fields[0]?.fields.length ?? 0}`;
      },
    },
    corpus: [swiftFieldSeed()],
  },
  xpc: {
    target: {
      name: "xpc",
      run(bytes) {
        const value = decodeXpcValue(bytes);
        return `ok:${typeof value}`;
      },
    },
    corpus: [Uint8Array.from([0x01, 0x00, 0x00, 0x00]), Uint8Array.from([0x02, 0x00, 0x00, 0x00])],
  },
};

function main(): number {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    return 2;
  }

  const selected =
    options.target === "all" ? (["macho", "plist", "xpc"] as const) : [options.target];
  const results: FuzzResult[] = [];
  for (const name of selected) {
    const entry = targets[name];
    const result = runFuzz({
      target: entry.target,
      corpus: entry.corpus,
      iterations: options.iterations,
      seed: options.seed,
      onProgress: (done, stats) => {
        if (!options.json) {
          console.error(
            `[${name}] ${done}/${options.iterations} accepted=${stats.accepted} coverage=${stats.coverage} crashes=${stats.crashes}`,
          );
        }
      },
    });
    results.push(result);
  }

  if (options.json) {
    console.log(JSON.stringify({ seed: options.seed, results }, null, 2));
  } else {
    for (const result of results) {
      console.log(
        `${result.target}: ${result.iterations} iterations, accepted=${result.accepted}, rejected=${result.rejected}, coverage=${result.coverage}, corpus=${result.corpus}, crashes=${result.crashes}, ${result.elapsedMs}ms`,
      );
      for (const crash of result.crashSamples) {
        console.log(`  crash: ${crash.message}`);
      }
    }
  }
  return results.some((result) => result.crashes > 0) ? 1 : 0;
}

process.exit(main());
