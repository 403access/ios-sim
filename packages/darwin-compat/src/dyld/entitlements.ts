/**
 * Entitlement policy hooks (LDR-011).
 *
 * Entitlements are parsed by the code-signature reader but not verified. This
 * layer applies a caller-supplied policy: required keys, denied keys, and
 * optional expected values. It is deliberately a policy hook, not a TCC or
 * sandbox implementation.
 */

import type { PlistValue } from "../plist/parse.js";
import type { CodeSignatureInfo } from "../macho/code-signature.js";

export interface EntitlementPolicy {
  readonly require?: readonly string[];
  readonly deny?: readonly string[];
  readonly requireValue?: Readonly<Record<string, PlistValue>>;
  readonly allowUnsigned?: boolean;
}

export interface EntitlementResult {
  readonly allowed: boolean;
  readonly entitlements: PlistValue | null;
  readonly missing: readonly string[];
  readonly denied: readonly string[];
  readonly mismatched: readonly string[];
  readonly reason: string | null;
}

export function entitlementValue(
  entitlements: PlistValue | null,
  path: string,
): PlistValue | undefined {
  if (entitlements === null || typeof entitlements !== "object" || Array.isArray(entitlements)) {
    return undefined;
  }
  const direct = (entitlements as Record<string, PlistValue>)[path];
  if (direct !== undefined) return direct;
  let current: PlistValue | undefined = entitlements as PlistValue;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, PlistValue>)[part];
  }
  return current;
}

export function evaluateEntitlements(
  signature: CodeSignatureInfo | null,
  policy: EntitlementPolicy = {},
): EntitlementResult {
  const entitlements = signature?.entitlements ?? null;
  if (!signature) {
    return {
      allowed: policy.allowUnsigned === true,
      entitlements: null,
      missing: [],
      denied: [],
      mismatched: [],
      reason: policy.allowUnsigned === true ? null : "image is unsigned",
    };
  }
  const missing = (policy.require ?? []).filter(
    (path) => entitlementValue(entitlements, path) === undefined,
  );
  const denied = (policy.deny ?? []).filter(
    (path) => entitlementValue(entitlements, path) !== undefined,
  );
  const mismatched = Object.entries(policy.requireValue ?? {})
    .filter(
      ([path, expected]) =>
        JSON.stringify(entitlementValue(entitlements, path)) !== JSON.stringify(expected),
    )
    .map(([path]) => path);
  const allowed = missing.length === 0 && denied.length === 0 && mismatched.length === 0;
  return {
    allowed,
    entitlements,
    missing,
    denied,
    mismatched,
    reason: allowed ? null : "entitlement policy rejected the image",
  };
}
