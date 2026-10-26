/**
 * Loader diagnostics (LDR-013).
 *
 * The loader already fails with stable codes. This module turns a failure into
 * a report that names the stage, the file, the relevant dependency/symbol, and
 * one concrete next action. It is intentionally a lookup table, not an expert
 * system: every suggestion maps to a documented loader boundary.
 */

import { errorMessage } from "../errors.js";
import type { LoadStats, LoadedProgram } from "./loader.js";

export interface LoaderDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly stage: "read" | "parse" | "dependencies" | "fixups" | "entry" | "symbols" | "load";
  readonly message: string;
  readonly suggestion: string;
  readonly dependency?: string;
  readonly symbol?: string;
}

export interface LoaderReport {
  readonly ok: boolean;
  readonly path: string;
  readonly program: LoadedProgram | null;
  readonly diagnostic: LoaderDiagnostic | null;
  readonly stats: LoadStats;
}

const SUGGESTIONS: Record<string, { stage: LoaderDiagnostic["stage"]; suggestion: string }> = {
  file_not_found: {
    stage: "read",
    suggestion: "check the path and that the FileProvider can read it",
  },
  dependency_not_found: {
    stage: "dependencies",
    suggestion: "add the dylib to searchPaths or fix its @rpath/@loader_path install name",
  },
  not_executable: {
    stage: "entry",
    suggestion: "pass an MH_EXECUTE image to load(); use loadDylib() for MH_DYLIB",
  },
  not_dylib: {
    stage: "load",
    suggestion: "dlopen expects MH_DYLIB; execute the MH_EXECUTE image instead",
  },
  symbol_not_found: {
    stage: "symbols",
    suggestion: "export the symbol, load the image that defines it, or pass externalSymbols",
  },
  address_space_exhausted: {
    stage: "load",
    suggestion: "free address space or load fewer images; slides are capped at 128",
  },
  too_many_images: {
    stage: "load",
    suggestion: "raise maxImages deliberately or split the dependency graph",
  },
  legacy_threaded_bind_unimplemented: {
    stage: "fixups",
    suggestion: "dyld3 threaded binds are not decoded; rebuild with chained fixups",
  },
  bad_code_signature_magic: {
    stage: "parse",
    suggestion: "LC_CODE_SIGNATURE must point at an embedded-signature superblob",
  },
  code_signature_out_of_bounds: {
    stage: "parse",
    suggestion: "the signature range exceeds the file; the image is truncated or corrupt",
  },
};

export function describeLoaderError(error: unknown, path: string): LoaderDiagnostic {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "error";
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? ((error as { details?: Record<string, unknown> }).details ?? {})
      : {};
  const mapping = SUGGESTIONS[code] ?? {
    stage: code.startsWith("legacy_fixups") || code.startsWith("fixup") ? "fixups" : "load",
    suggestion: "inspect the loader error code and the image's load commands",
  };
  return {
    code,
    path,
    stage: mapping.stage,
    message: errorMessage(error),
    suggestion: mapping.suggestion,
    dependency: typeof details.dependency === "string" ? details.dependency : undefined,
    symbol: typeof details.symbol === "string" ? details.symbol : undefined,
  };
}

export function formatLoaderDiagnostic(diagnostic: LoaderDiagnostic): string {
  const lines = [
    `loader failed: ${diagnostic.code}`,
    `  file: ${diagnostic.path}`,
    `  stage: ${diagnostic.stage}`,
    `  reason: ${diagnostic.message}`,
  ];
  if (diagnostic.dependency) lines.push(`  dependency: ${diagnostic.dependency}`);
  if (diagnostic.symbol) lines.push(`  symbol: ${diagnostic.symbol}`);
  lines.push(`  next: ${diagnostic.suggestion}`);
  return lines.join("\n");
}
