/**
 * Generated Mach-O corpus (QA-003).
 *
 * The corpus is produced from the repository's own builder, never from Apple
 * binaries. It covers every load command the parser understands, each chained
 * pointer format, each legacy dyld stream, signature blobs, filesets, and a
 * matching set of malformed images with expected stable error codes.
 *
 * `scripts/build-corpus.ts` materializes it under `build/corpus` for CI or
 * manual inspection; tests call `buildCorpus()` directly.
 */

import { BinaryWriter } from "../binary.js";
import { CompatError } from "../errors.js";
import {
  CPU_SUBTYPE_ARM64_ALL,
  CPU_TYPE_ARM64,
  FAT_MAGIC,
  N_EXT,
  N_OSO,
} from "../macho/constants.js";
import { buildChainedFixups, buildMachO } from "../macho/build.js";
import { buildCodeSignature } from "../macho/code-signature.js";
import { encodeLegacyBinds, encodeLegacyRebases } from "../macho/legacy-fixups.js";
import { parseCodeSignature } from "../macho/code-signature.js";
import { parseChainedFixups } from "../macho/fixups.js";
import { parseFatHeader } from "../macho/fat.js";
import { parseMachO } from "../macho/parse.js";
import { parseLegacyBinds, parseLegacyRebases } from "../macho/legacy-fixups.js";

export type CorpusTarget = "macho" | "chained" | "legacy" | "signature" | "fat";

export interface CorpusCase {
  readonly name: string;
  readonly target: CorpusTarget;
  readonly tags: readonly string[];
  readonly bytes: Uint8Array;
  readonly valid: boolean;
  readonly expectedCode?: string;
  readonly offset?: number;
}

export interface CorpusFailure {
  readonly name: string;
  readonly message: string;
}

export interface CorpusReport {
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
  readonly failures: readonly CorpusFailure[];
  readonly loadCommands: readonly string[];
  readonly pointerFormats: readonly number[];
  readonly legacyOpcodes: readonly string[];
}

const TEXT = Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]);
const UUID = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

export function buildCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const add = (
    name: string,
    target: CorpusTarget,
    tags: readonly string[],
    bytes: Uint8Array,
    valid = true,
    expectedCode?: string,
    offset?: number,
  ): void => {
    cases.push({ name, target, tags, bytes, valid, expectedCode, offset });
  };

  const hello = buildMachO({
    text: TEXT,
    cstring: "hello\n",
    uuid: UUID,
    symbols: [{ name: "_start", value: 0x100001000 }],
    exports: [{ name: "_start", address: 0x100001000 }],
  });
  add("execute-minimal", "macho", ["MH_EXECUTE", "LC_MAIN", "LC_UUID"], hello.bytes);

  const dylib = buildMachO({
    fileType: "dylib",
    installName: "/usr/lib/libfixture.dylib",
    text: TEXT,
    dependencies: [
      { name: "/usr/lib/libSystem.B.dylib" },
      { name: "/usr/lib/libweak.dylib", weak: true },
    ],
    symbols: [
      { name: "_exported", value: 0x100001000 },
      { name: "_missing", value: 0, undefined: true },
    ],
    exports: [{ name: "_exported", address: 0x100001000 }],
  });
  add(
    "dylib-dependencies",
    "macho",
    ["MH_DYLIB", "LC_ID_DYLIB", "LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_SYMTAB"],
    dylib.bytes,
  );

  const chained = buildMachO({
    text: TEXT,
    data: new Uint8Array(0x4000),
    dependencies: [{ name: "/usr/lib/libfixture.dylib" }],
    fixups: [
      { kind: "bind", offset: 0, symbol: "_exported", ordinal: 1 },
      { kind: "rebase", offset: 8, target: 0x100001000 },
    ],
  });
  add("chained-fixups", "macho", ["LC_DYLD_CHAINED_FIXUPS", "LC_DYLD_EXPORTS_TRIE"], chained.bytes);

  const legacy = buildMachO({
    text: TEXT,
    data: new Uint8Array(0x4000),
    dependencies: [{ name: "/usr/lib/libfixture.dylib" }],
    legacyFixups: [
      { kind: "bind", offset: 0, symbol: "_exported", ordinal: 1 },
      { kind: "rebase", offset: 8, target: 0x100001000 },
    ],
    legacyLazyFixups: [{ kind: "bind", offset: 16, symbol: "_exported", ordinal: 1 }],
    legacyWeakFixups: [{ kind: "bind", offset: 24, symbol: "_missing", ordinal: 1 }],
  });
  add(
    "legacy-all-streams",
    "macho",
    ["LC_DYLD_INFO_ONLY", "rebases", "binds", "lazy", "weak"],
    legacy.bytes,
  );

  const init = buildMachO({
    text: TEXT,
    moduleInitFunctions: [0x100001000],
    moduleTermFunctions: [0x100001000],
  });
  add("module-init-term", "macho", ["__mod_init_func", "__mod_term_func"], init.bytes);

  const interpose = buildMachO({
    text: TEXT,
    interpositions: [{ replacement: 0x100001000, replaced: 0x100001004 }],
  });
  add("interpose", "macho", ["__interpose"], interpose.bytes);

  const signature = buildCodeSignature({
    identifier: "com.example.fixture",
    teamId: "TEAM123",
    entitlements: '<plist version="1.0"><dict><key>get-task-allow</key><true/></dict></plist>',
  });
  const signed = buildMachO({
    text: TEXT,
    codeSignature: signature,
    filesetEntries: [{ vmAddress: 0x100000000, fileOffset: 0x4000, entryId: "com.apple.kernel" }],
    symbols: [
      { name: "/tmp/fixture.o", value: 1_700_000_000, sectionIndex: 0, type: N_OSO | N_EXT },
    ],
  });
  add("signed-fileset", "macho", ["LC_CODE_SIGNATURE", "LC_FILESET_ENTRY"], signed.bytes);

  const fat = buildFat(hello.bytes);
  add("fat-arm64", "fat", ["FAT_MAGIC"], fat);

  // Chained pointer formats (payload only).
  for (const [format, word] of [
    [2, 0x100001000n],
    [6, 0x1000n],
    [1, (1n << 63n) | 0x1234n],
    [9, (1n << 63n) | 0x1234n],
    [12, (1n << 63n) | 0x1234n],
  ] as const) {
    add(
      `chained-format-${format}`,
      "chained",
      [`PTR_${format}`],
      chainedPayload(word, format),
      true,
      undefined,
      0x1000,
    );
  }
  add(
    "chained-format-unknown",
    "chained",
    ["PTR_99"],
    chainedPayload(1n, 99),
    false,
    "unsupported_pointer_format",
    0x1000,
  );

  // Legacy streams.
  add(
    "legacy-rebase-opcodes",
    "legacy",
    ["rebase"],
    encodeLegacyRebases([{ segmentIndex: 0, segmentOffset: 0 }]),
  );
  add(
    "legacy-bind-opcodes",
    "legacy",
    ["bind"],
    encodeLegacyBinds([{ segmentIndex: 0, segmentOffset: 0, symbol: "_x", ordinal: 1 }]),
  );
  add(
    "legacy-invalid-opcode",
    "legacy",
    ["invalid-opcode"],
    Uint8Array.from([0xf0]),
    false,
    "legacy_fixups_unknown_opcode",
  );

  // Signature blobs.
  add("signature-superblob", "signature", ["CSMAGIC_EMBEDDED_SIGNATURE"], signature);
  add(
    "signature-bad-magic",
    "signature",
    ["bad-magic"],
    corruptU32(signature, 0, 0x11223344),
    false,
    "bad_code_signature_magic",
  );

  // Malformed full images.
  add(
    "invalid-magic",
    "macho",
    ["bad-magic"],
    corruptU32(hello.bytes, 0, 0xdeadbeef),
    false,
    "bad_magic",
  );
  add(
    "invalid-truncated-header",
    "macho",
    ["truncated"],
    hello.bytes.subarray(0, 16),
    false,
    "truncated_header",
  );
  add(
    "invalid-command-size",
    "macho",
    ["bad-command-size"],
    corruptU32(hello.bytes, 36, 0),
    false,
    "bad_command_size",
  );
  add(
    "invalid-fat-slice",
    "fat",
    ["bad-slice"],
    corruptU32(fat, 16, 0xffff_ffff),
    false,
    "fat_slice_out_of_bounds",
  );

  return cases;
}

function runCase(testCase: CorpusCase): string[] {
  const loadCommands: string[] = [];
  const pointerFormats: number[] = [];
  const legacyOpcodes: string[] = [];
  const segments = [
    { index: 0, fileOffset: 0, fileSize: 0x4000, vmSize: 0x4000, vmAddress: 0x100000000 },
  ];
  switch (testCase.target) {
    case "macho": {
      const { image } = parseMachO(testCase.bytes);
      loadCommands.push(...image.commands.map((command) => command.name));
      if (image.chainedFixups) pointerFormats.push(...image.chainedFixups.pointerFormats);
      if (image.codeSignatureInfo) legacyOpcodes.push("code-signature");
      if (image.filesetEntries.length > 0) legacyOpcodes.push("fileset");
      if (image.sections.some((section) => section.name === "__mod_init_func")) {
        legacyOpcodes.push("mod-init");
      }
      if (image.sections.some((section) => section.name === "__interpose")) {
        legacyOpcodes.push("interpose");
      }
      break;
    }
    case "chained": {
      const offset = testCase.offset ?? 0;
      const fixups = parseChainedFixups(
        testCase.bytes,
        offset,
        testCase.bytes.length - offset,
        segments,
      );
      pointerFormats.push(...fixups.pointerFormats);
      break;
    }
    case "legacy": {
      try {
        const rebases = parseLegacyRebases(testCase.bytes, 0, testCase.bytes.length, segments);
        if (rebases.length > 0) legacyOpcodes.push("rebase");
      } catch {
        const binds = parseLegacyBinds(testCase.bytes, 0, testCase.bytes.length, segments);
        if (binds.length > 0) legacyOpcodes.push("bind");
      }
      break;
    }
    case "signature": {
      parseCodeSignature(testCase.bytes, 0, testCase.bytes.length);
      break;
    }
    case "fat": {
      const fat = parseFatHeader(testCase.bytes);
      if (fat) legacyOpcodes.push("FAT_MAGIC");
      break;
    }
  }
  return [...loadCommands, ...pointerFormats.map(String), ...legacyOpcodes];
}

export function runCorpus(cases: readonly CorpusCase[] = buildCorpus()): CorpusReport {
  const failures: CorpusFailure[] = [];
  const loadCommands = new Set<string>();
  const pointerFormats = new Set<number>();
  const legacyOpcodes = new Set<string>();
  let valid = 0;
  let invalid = 0;

  for (const testCase of cases) {
    try {
      const coverage = runCase(testCase);
      for (const item of coverage) {
        if (/^\d+$/.test(item)) pointerFormats.add(Number(item));
        else if (item.startsWith("LC_") || item === "FAT_MAGIC") loadCommands.add(item);
        else legacyOpcodes.add(item);
      }
      if (!testCase.valid) {
        failures.push({ name: testCase.name, message: "expected failure but parsed" });
      } else {
        valid += 1;
      }
    } catch (error) {
      if (!(error instanceof CompatError)) {
        failures.push({
          name: testCase.name,
          message: `host error: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (testCase.valid) {
        failures.push({ name: testCase.name, message: `${error.code}: ${error.message}` });
      } else if (testCase.expectedCode && error.code !== testCase.expectedCode) {
        failures.push({
          name: testCase.name,
          message: `expected ${testCase.expectedCode}, got ${error.code}`,
        });
      } else {
        invalid += 1;
      }
    }
  }

  return {
    total: cases.length,
    valid,
    invalid,
    failures,
    loadCommands: [...loadCommands].sort(),
    pointerFormats: [...pointerFormats].sort((a, b) => a - b),
    legacyOpcodes: [...legacyOpcodes].sort(),
  };
}

function chainedPayload(word: bigint, pointerFormat: number): Uint8Array {
  const header = new BinaryWriter();
  header.u32(0);
  header.u32(28);
  header.u32(60);
  header.u32(64);
  header.u32(1);
  header.u32(1);
  header.u32(0);
  header.u32(1);
  header.u32(8);
  header.u32(24);
  header.u16(0x4000);
  header.u16(pointerFormat);
  header.u64(0);
  header.u32(0);
  header.u16(1);
  header.u16(0);
  header.u32(1);
  header.cstring("_symbol");
  const bytes = new Uint8Array(0x4000);
  bytes.set(header.toUint8Array(), 0x1000);
  new DataView(bytes.buffer).setBigUint64(0, word, true);
  return bytes;
}

function corruptU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

function buildFat(slice: Uint8Array): Uint8Array {
  const header = new Uint8Array(8 + 20);
  const view = new DataView(header.buffer);
  view.setUint32(0, FAT_MAGIC, false);
  view.setUint32(4, 1, false);
  view.setInt32(8, CPU_TYPE_ARM64, false);
  view.setInt32(12, CPU_SUBTYPE_ARM64_ALL, false);
  view.setUint32(16, 4096, false);
  view.setUint32(20, slice.length, false);
  view.setUint32(24, 12, false);
  const output = new Uint8Array(4096 + slice.length);
  output.set(header, 0);
  output.set(slice, 4096);
  return output;
}
