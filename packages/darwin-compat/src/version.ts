/**
 * Version policy (REL-004).
 *
 * Compatibility rules are intentionally simple:
 * - semantic versions may differ in patch; major/minor must match;
 * - host ABI, capability schema, and event schema are exact integers;
 * - mismatch throws with the expected/actual values instead of warning.
 */

import { CompatError } from "./errors.js";

export const RUNTIME_VERSION = "0.1.0";
export const HOST_ABI_VERSION = 1;

export interface VersionPolicy {
  readonly component: string;
  readonly expected: number | string;
  readonly actual: number | string;
}

export function assertCompatibleVersion(component: string, expected: string, actual: string): void {
  const want = parseSemver(expected);
  const have = parseSemver(actual);
  if (want.major !== have.major || want.minor !== have.minor) {
    throw new CompatError(
      "version_mismatch",
      `${component} version ${actual} is incompatible with ${expected} (major/minor must match)`,
      { component, expected, actual },
    );
  }
}

export function assertExactVersion(component: string, expected: number, actual: number): void {
  if (expected !== actual) {
    throw new CompatError(
      "version_mismatch",
      `${component} version ${actual} does not match the required ${expected}`,
      { component, expected, actual },
    );
  }
}

export function checkVersionPolicy(policy: VersionPolicy): void {
  if (typeof policy.expected === "number" && typeof policy.actual === "number") {
    assertExactVersion(policy.component, policy.expected, policy.actual);
    return;
  }
  assertCompatibleVersion(policy.component, String(policy.expected), String(policy.actual));
}

function parseSemver(value: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) {
    throw new CompatError("bad_version", `"${value}" is not a semantic version`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
