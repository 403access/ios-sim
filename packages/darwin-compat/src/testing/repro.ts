/**
 * Repro-bundle manifest helpers (DX-004).
 *
 * A bundle is only useful if another host can verify what it received. Every
 * file carries a SHA-256, and the manifest records the source revision,
 * platform, and runtime version.
 */

import { createHash } from "node:crypto";

export interface ReproFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReproManifest {
  readonly createdAt: string;
  readonly sourceRevision: string;
  readonly dirty: boolean;
  readonly platform: string;
  readonly architecture: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly files: readonly ReproFile[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function describeReproFile(path: string, bytes: Uint8Array): ReproFile {
  return { path, bytes: bytes.length, sha256: sha256Hex(bytes) };
}

export function buildReproManifest(input: {
  createdAt: string;
  sourceRevision: string;
  dirty: boolean;
  platform: string;
  architecture: string;
  runtime: string;
  runtimeVersion: string;
  files: readonly ReproFile[];
}): ReproManifest {
  return {
    ...input,
    files: [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
