/**
 * Actionable boot report (OBS-003).
 *
 * A failed boot is usually one of two things: an unresolved dynamic symbol or
 * a missing Mach bootstrap service. This report collects both without hiding
 * the rest of the image graph, and pairs each entry with a concrete next step.
 */

import type { LoadedProgram, MissingSymbol } from "../dyld/loader.js";
import type { PlistValue } from "../plist/parse.js";

export interface MissingService {
  readonly service: string;
  readonly suggestion: string;
}

export interface BootReport {
  readonly ok: boolean;
  readonly images: readonly string[];
  readonly entitlements: PlistValue | null;
  readonly missingSymbols: readonly (MissingSymbol & { suggestion: string })[];
  readonly missingServices: readonly MissingService[];
  readonly warnings: readonly string[];
}

export interface BootReportOptions {
  /** Services the program expects to find through bootstrap. */
  readonly services?: readonly string[];
  /** Services currently registered; defaults to none. */
  readonly availableServices?: readonly string[];
}

export function bootReport(program: LoadedProgram, options: BootReportOptions = {}): BootReport {
  const available = new Set(options.availableServices ?? []);
  const missingSymbols = program.missingSymbols.map((entry) => ({
    ...entry,
    suggestion: symbolSuggestion(entry),
  }));
  const missingServices = (options.services ?? [])
    .filter((service) => !available.has(service))
    .map((service) => ({
      service,
      suggestion: `register "${service}" with the bootstrap server or add a provider before launch`,
    }));
  const warnings: string[] = [];
  if (program.missingSymbols.length > 0) {
    warnings.push("the program was loaded with unresolved symbols bound to null");
  }
  if (missingServices.length > 0) {
    warnings.push("one or more bootstrap services are absent");
  }
  return {
    ok: missingSymbols.length === 0 && missingServices.length === 0,
    images: program.images.map((image) => image.path),
    entitlements: program.main.image.codeSignatureInfo?.entitlements ?? null,
    missingSymbols,
    missingServices,
    warnings,
  };
}

function symbolSuggestion(entry: MissingSymbol): string {
  if (entry.ordinal > 0) {
    return `dependency ordinal ${entry.ordinal} does not export "${entry.symbol}"; load the defining image or pass externalSymbols`;
  }
  if (entry.ordinal === -1) {
    return `the main executable does not export "${entry.symbol}"`;
  }
  return `no image in the flat namespace exports "${entry.symbol}"`;
}
