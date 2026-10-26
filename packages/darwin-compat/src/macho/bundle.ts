/**
 * Bundle, fileset, and dSYM metadata (LDR-012).
 *
 * This is a read-only inventory pass over a small in-memory bundle:
 * `Info.plist`, the executable Mach-O, `LC_FILESET_ENTRY` records, and an
 * optional dSYM companion. It does not execute anything, verify code
 * signatures, or read DWARF line tables.
 */

import { N_OSO } from "./constants.js";
import { parseMachO } from "./parse.js";
import type { MachOImage } from "./types.js";
import { parsePlist, type PlistValue } from "../plist/parse.js";

export interface DebugObject {
  readonly path: string;
  readonly mtime: number;
}

export interface DsymMetadata {
  readonly uuid: string | null;
  readonly objectFiles: readonly DebugObject[];
}

export interface BundleExecutable {
  readonly path: string;
  readonly uuid: string | null;
  readonly filesetEntries: readonly {
    entryId: string;
    vmAddress: string;
    fileOffset: number;
  }[];
}

export interface BundleMetadata {
  readonly bundlePath: string;
  readonly identifier: string | null;
  readonly executableName: string | null;
  readonly version: string | null;
  readonly executable: BundleExecutable | null;
  readonly dsym: (DsymMetadata & { path: string }) | null;
  readonly warnings: readonly string[];
}

export function dsymMetadata(image: MachOImage): DsymMetadata {
  const objectFiles: DebugObject[] = [];
  for (const symbol of image.symbols) {
    if ((symbol.type & 0xfe) !== N_OSO) continue;
    objectFiles.push({ path: symbol.name, mtime: symbol.value });
  }
  return { uuid: image.uuid, objectFiles };
}

export function parseBundle(
  files: Map<string, Uint8Array> | Record<string, Uint8Array>,
): BundleMetadata {
  const map = files instanceof Map ? files : new Map(Object.entries(files));
  const warnings: string[] = [];
  const plistPath = ["Info.plist", "Contents/Info.plist"].find((path) => map.has(path));
  let info: Record<string, PlistValue> = {};
  if (!plistPath) {
    warnings.push("bundle has no Info.plist");
  } else {
    const parsed = parsePlist(map.get(plistPath)!);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`${plistPath} is not a dictionary`);
    } else {
      info = parsed as Record<string, PlistValue>;
    }
  }

  const identifier = stringValue(info.CFBundleIdentifier);
  const executableName = stringValue(info.CFBundleExecutable);
  const version = stringValue(info.CFBundleVersion) ?? stringValue(info.CFBundleShortVersionString);
  const executable = executableName ? findExecutable(map, executableName) : guessExecutable(map);

  let executableMetadata: BundleExecutable | null = null;
  if (!executable) {
    warnings.push("bundle executable was not found");
  } else {
    const { path, bytes } = executable;
    const image = parseMachO(bytes).image;
    executableMetadata = {
      path,
      uuid: image.uuid,
      filesetEntries: image.filesetEntries.map((entry) => ({
        entryId: entry.entryId,
        vmAddress: `0x${entry.vmAddress.toString(16)}`,
        fileOffset: entry.fileOffset,
      })),
    };
  }

  let dsym: (DsymMetadata & { path: string }) | null = null;
  const dsymPath = executableName
    ? `Contents/Resources/DWARF/${executableName}`
    : [...map.keys()].find((path) => path.startsWith("Contents/Resources/DWARF/"));
  if (dsymPath && map.has(dsymPath)) {
    const image = parseMachO(map.get(dsymPath)!).image;
    dsym = { path: dsymPath, ...dsymMetadata(image) };
    if (executableMetadata?.uuid && dsym.uuid && executableMetadata.uuid !== dsym.uuid) {
      warnings.push(
        `dSYM UUID ${dsym.uuid} does not match executable UUID ${executableMetadata.uuid}`,
      );
    }
  }

  return {
    bundlePath: plistPath?.startsWith("Contents/") ? "Contents" : ".",
    identifier,
    executableName,
    version,
    executable: executableMetadata,
    dsym,
    warnings,
  };
}

function findExecutable(
  files: Map<string, Uint8Array>,
  name: string,
): { path: string; bytes: Uint8Array } | null {
  for (const path of [name, `Contents/MacOS/${name}`, `Contents/${name}`]) {
    const bytes = files.get(path);
    if (bytes) return { path, bytes };
  }
  return null;
}

function guessExecutable(
  files: Map<string, Uint8Array>,
): { path: string; bytes: Uint8Array } | null {
  for (const [path, bytes] of files) {
    if (path.endsWith(".plist") || path.includes("/DWARF/")) continue;
    try {
      parseMachO(bytes);
      return { path, bytes };
    } catch {
      // Not a Mach-O; keep looking.
    }
  }
  return null;
}

function stringValue(value: PlistValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}
