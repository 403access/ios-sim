/**
 * Error types shared by every compatibility layer.
 *
 * The native track uses stable error codes instead of free-form messages so the
 * CLI, tests, and future integrations can assert on behaviour without parsing
 * prose. Codes are part of the internal ABI.
 */

export type ErrorDetails = Record<string, unknown>;

export class CompatError extends Error {
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "CompatError";
    this.code = code;
    this.details = details;
  }
}

export class MachOError extends CompatError {
  override name = "MachOError";
}

export class Arm64Error extends CompatError {
  override name = "Arm64Error";
}

export class MachError extends CompatError {
  override name = "MachError";
}

export class XpcError extends CompatError {
  override name = "XpcError";
}

export class SyscallError extends CompatError {
  override name = "SyscallError";
}

export class LoaderError extends CompatError {
  override name = "LoaderError";
}

export class LaunchdError extends CompatError {
  override name = "LaunchdError";
}

export class PlistError extends CompatError {
  override name = "PlistError";
}

export class RuntimeError extends CompatError {
  override name = "RuntimeError";
}

export class ObjcError extends CompatError {
  override name = "ObjcError";
}

export class UiError extends CompatError {
  override name = "UiError";
}

/** Narrow an unknown thrown value into a printable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
