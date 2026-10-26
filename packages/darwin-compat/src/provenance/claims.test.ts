import { describe, expect, it } from "vitest";
import { auditClaims, auditRepository, formatClaimFindings } from "./claims.js";

describe("claims audit", () => {
  it("flags false simulator claims", () => {
    const findings = auditClaims(
      [
        "The bridge runs iOS apps on Linux.",
        "This project boots iOS.",
        "It ships an iOS Simulator: yes.",
        "The iOS Simulator runs natively on Linux.",
        "Apple UIKit runs in the window.",
      ].join("\n"),
      "bad.md",
    );
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "runs-ios",
        "ships-simulator",
        "simulator-native-linux",
        "apple-uikit-runs",
      ]),
    );
    expect(findings.length).toBeGreaterThanOrEqual(5);
    expect(formatClaimFindings(findings)).toContain("bad.md:1");
  });

  it("allows negated statements and clean-room wording", () => {
    const findings = auditClaims(
      [
        "This project does not run iOS apps.",
        "The iOS Simulator cannot run natively on Linux.",
        "The clean-room UIKitLite window is not Apple UIKit.",
        "The native track never boots iOS.",
      ].join("\n"),
    );
    expect(findings).toEqual([]);
  });

  it("keeps the repository clean", () => {
    const findings = auditRepository();
    expect(findings, formatClaimFindings(findings)).toEqual([]);
  });
});
