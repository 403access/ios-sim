/**
 * Structured Mach-O inspection used by `ios-sim-native inspect`.
 *
 * The report is JSON-safe: addresses and 64-bit values are strings so nothing
 * is silently rounded, and it names the compatibility boundaries it observes
 * (shared cache absent, code signature present but unverified, and so on).
 */

import { parseMachO, platformName } from "./macho/parse.js";
import { parseLegacyFixups, type LegacyFixups } from "./macho/legacy.js";
import type { MachOImage } from "./macho/types.js";

export interface InspectReport {
  readonly file: string;
  readonly bytes: number;
  readonly sliceOffset: number;
  readonly uuid: string | null;
  readonly architecture: string;
  readonly fileType: number;
  readonly flags: string;
  readonly platform: string | null;
  readonly minimumOs: string | null;
  readonly sdk: string | null;
  readonly preferredBase: string;
  readonly entry: {
    fileOffset: number | null;
    vmAddress: string | null;
    unixThread: string | null;
  };
  readonly commandCount: number;
  readonly segments: readonly {
    name: string;
    vmAddress: string;
    vmSize: number;
    fileOffset: number;
    fileSize: number;
    protection: string;
    sections: readonly {
      name: string;
      address: string;
      size: number;
      flags: string;
      zeroFill: boolean;
    }[];
  }[];
  readonly dylibs: readonly { ordinal: number; kind: string; name: string }[];
  readonly rpaths: readonly string[];
  readonly imports: readonly { name: string; ordinal: number; weak: boolean }[];
  readonly fixups: {
    binds: readonly { symbol: string; segment: number; location: string; addend: string }[];
    rebases: number;
    pointerFormats: readonly number[];
  };
  readonly exports: readonly {
    name: string;
    address: string | null;
    kind: string;
    weak: boolean;
    reexport: string | null;
  }[];
  readonly symbols: { total: number; definedExternal: number; undefined: number };
  readonly codeSignature: { present: boolean; bytes: number };
  readonly warnings: readonly string[];
}

export function inspectMachO(bytes: Uint8Array, file = "<memory>"): InspectReport {
  const { image } = parseMachO(bytes);
  const slice = bytes.subarray(image.sliceOffset, image.sliceOffset + image.byteLength);
  let legacy: LegacyFixups | null = null;
  let legacyWarning: string | null = null;
  if (!image.chainedFixups && image.dyldInfo) {
    try {
      legacy = parseLegacyFixups(slice, image);
    } catch (error) {
      legacyWarning = `legacy fixups could not be decoded: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  const entryVm = computeEntry(image);
  const warnings: string[] = [];
  if (image.encryptionInfo && image.encryptionInfo.cryptId !== 0) {
    warnings.push("image is encrypted; the loader does not decrypt Mach-O segments");
  }
  if (image.codeSignature)
    warnings.push("code signature is present but not verified by this layer");
  if (
    image.dyldInfo &&
    (image.dyldInfo.bindSize > 0 || image.dyldInfo.lazyBindSize > 0) &&
    !image.chainedFixups
  ) {
    warnings.push("legacy dyld bind opcodes are present; only chained fixups are implemented");
  }
  if (image.symbols.some((symbol) => symbol.name.startsWith("___chkstk_darwin"))) {
    warnings.push("uses stack probing helpers from libSystem, which is not provided");
  }

  return {
    file,
    bytes: bytes.length,
    sliceOffset: image.sliceOffset,
    uuid: image.uuid,
    architecture: "arm64",
    fileType: image.header.fileType,
    flags: flagsToString(image.header.flags),
    platform: image.buildVersion ? platformName(image.buildVersion.platform) : null,
    minimumOs: image.osVersion === "unknown" ? null : image.osVersion,
    sdk: image.buildVersion?.sdk ?? null,
    preferredBase: hex(image.preferredBase),
    entry: {
      fileOffset: image.main?.entryOffset ?? null,
      vmAddress: entryVm === null ? null : hex(entryVm),
      unixThread: image.unixThread ? hex(image.unixThread.entryPoint) : null,
    },
    commandCount: image.commands.length,
    segments: image.segments.map((segment) => ({
      name: segment.name,
      vmAddress: hex(segment.vmAddress),
      vmSize: segment.vmSize,
      fileOffset: segment.fileOffset,
      fileSize: segment.fileSize,
      protection: protection(segment.maxProtection, segment.initialProtection),
      sections: segment.sections.map((section) => ({
        name: section.name,
        address: hex(section.address),
        size: section.size,
        flags: `0x${section.flags.toString(16)}`,
        zeroFill: section.zeroFill,
      })),
    })),
    dylibs: image.dylibs.map((dylib) => ({
      ordinal: dylib.ordinal,
      kind: dylib.kind,
      name: dylib.name,
    })),
    rpaths: image.rpaths,
    imports: image.chainedFixups
      ? image.chainedFixups.imports.map((entry) => ({
          name: entry.name,
          ordinal: entry.ordinal,
          weak: entry.weak,
        }))
      : uniqueLegacyImports(legacy),
    fixups: {
      binds: image.chainedFixups
        ? image.chainedFixups.fixups
            .filter((fixup) => fixup.kind === "bind")
            .map((fixup) => ({
              symbol: fixup.symbol,
              segment: fixup.segmentIndex,
              location: hex(fixup.location),
              addend: fixup.addend.toString(),
            }))
        : (legacy?.binds.map((bind) => ({
            symbol: bind.symbol,
            segment: bind.segmentIndex,
            location: hex(bind.offset),
            addend: bind.addend.toString(),
          })) ?? []),
      rebases: image.chainedFixups
        ? image.chainedFixups.fixups.filter((fixup) => fixup.kind === "rebase").length
        : (legacy?.rebases.length ?? 0),
      pointerFormats: image.chainedFixups?.pointerFormats ?? [],
    },
    exports: [...(image.exportsTrie?.exports.values() ?? [])].map((entry) => ({
      name: entry.name,
      address:
        entry.address === null
          ? null
          : hex(entry.kind === "absolute" ? entry.address : image.preferredBase + entry.address),
      kind: entry.kind,
      weak: entry.weak,
      reexport: entry.reexport
        ? `${entry.reexport.name} (ordinal ${entry.reexport.ordinal})`
        : null,
    })),
    symbols: {
      total: image.symbols.length,
      definedExternal: image.symbols.filter(
        (symbol) => symbol.external && !symbol.undefined && !symbol.debug,
      ).length,
      undefined: image.symbols.filter((symbol) => symbol.undefined).length,
    },
    codeSignature: {
      present: image.codeSignature !== null,
      bytes: image.codeSignature?.dataSize ?? 0,
    },
    warnings,
  };
}

export function formatInspectReport(report: InspectReport): string {
  const lines: string[] = [];
  lines.push(`${report.file}`);
  lines.push(
    `  ${report.architecture} Mach-O, ${report.bytes} bytes, ${report.commandCount} load commands`,
  );
  lines.push(
    `  uuid ${report.uuid ?? "none"}  platform ${report.platform ?? "unknown"}  min ${report.minimumOs ?? "unknown"}  sdk ${report.sdk ?? "unknown"}`,
  );
  lines.push(
    `  preferred base ${report.preferredBase}  entry ${report.entry.vmAddress ?? report.entry.unixThread ?? "none"}`,
  );
  lines.push("  segments:");
  for (const segment of report.segments) {
    lines.push(
      `    ${segment.name.padEnd(12)} vm ${segment.vmAddress} ${segment.vmSize.toString().padStart(8)} file ${segment.fileOffset.toString().padStart(6)} ${segment.fileSize.toString().padStart(8)} ${segment.protection}`,
    );
    for (const section of segment.sections) {
      lines.push(
        `      ${section.name} ${section.address} size ${section.size}${section.zeroFill ? " (zero-fill)" : ""}`,
      );
    }
  }
  if (report.dylibs.length > 0) {
    lines.push("  dependencies:");
    for (const dylib of report.dylibs)
      lines.push(`    ${dylib.ordinal}. ${dylib.name} (${dylib.kind})`);
  }
  if (report.rpaths.length > 0) {
    lines.push("  rpaths:");
    for (const rpath of report.rpaths) lines.push(`    ${rpath}`);
  }
  lines.push(`  exports: ${report.exports.length}, imports: ${report.imports.length}`);
  for (const entry of report.exports.slice(0, 50)) {
    lines.push(
      `    ${entry.name} ${entry.address ?? "reexport"} ${entry.kind}${entry.weak ? " weak" : ""}${entry.reexport ? ` -> ${entry.reexport}` : ""}`,
    );
  }
  if (report.exports.length > 50) lines.push(`    … ${report.exports.length - 50} more`);
  lines.push(`  fixups: ${report.fixups.binds.length} binds, ${report.fixups.rebases} rebases`);
  for (const bind of report.fixups.binds.slice(0, 50)) {
    lines.push(
      `    bind ${bind.symbol} at segment ${bind.segment} offset ${bind.location} addend ${bind.addend}`,
    );
  }
  lines.push(
    `  symbols: ${report.symbols.total} total, ${report.symbols.definedExternal} defined external, ${report.symbols.undefined} undefined`,
  );
  lines.push(
    `  code signature: ${report.codeSignature.present ? `${report.codeSignature.bytes} bytes (unverified)` : "absent"}`,
  );
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}

function computeEntry(image: MachOImage): number | null {
  if (image.main) {
    for (const segment of image.segments) {
      if (
        image.main.entryOffset >= segment.fileOffset &&
        image.main.entryOffset < segment.fileOffset + segment.fileSize
      ) {
        return segment.vmAddress + (image.main.entryOffset - segment.fileOffset);
      }
    }
    return null;
  }
  if (image.unixThread && image.unixThread.entryPoint !== 0) return image.unixThread.entryPoint;
  return null;
}

function uniqueLegacyImports(
  legacy: LegacyFixups | null,
): Array<{ name: string; ordinal: number; weak: boolean }> {
  if (!legacy) return [];
  const seen = new Set<string>();
  const imports: Array<{ name: string; ordinal: number; weak: boolean }> = [];
  for (const bind of legacy.binds) {
    const key = `${bind.symbol}:${bind.ordinal}`;
    if (seen.has(key)) continue;
    seen.add(key);
    imports.push({ name: bind.symbol, ordinal: bind.ordinal, weak: bind.weak });
  }
  return imports;
}

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function protection(max: number, initial: number): string {
  return `${prot(max) ?? "-"}/${prot(initial) ?? "-"}`;
}

function prot(value: number): string {
  const flags = [value & 4 ? "x" : "", value & 2 ? "w" : "", value & 1 ? "r" : ""].join("");
  return flags || "-";
}

function flagsToString(flags: number): string {
  if (flags === 0) return "0";
  return `0x${flags.toString(16)}`;
}
