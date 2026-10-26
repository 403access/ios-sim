import { describe, expect, it } from "vitest";
import { buildMachO } from "../macho/build.js";
import { buildCodeSignature } from "../macho/code-signature.js";
import { ImageLoader, MapFileProvider } from "./loader.js";
import { entitlementValue, evaluateEntitlements } from "./entitlements.js";

const ENTITLEMENTS =
  '<plist version="1.0"><dict><key>get-task-allow</key><true/>' +
  "<key>com.apple.security.app-sandbox</key><true/>" +
  "<key>application-identifier</key><string>TEAM.com.example</string></dict></plist>";

function signed(entitlements = ENTITLEMENTS) {
  return buildMachO({
    text: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]),
    codeSignature: buildCodeSignature({ identifier: "com.example.app", entitlements }),
  }).bytes;
}

describe("entitlement policy hooks", () => {
  it("reads nested entitlement values", () => {
    const entitlements = {
      "com.apple.security.app-sandbox": true,
      nested: { value: 1 },
    };
    expect(entitlementValue(entitlements, "com.apple.security.app-sandbox")).toBe(true);
    expect(entitlementValue(entitlements, "nested.value")).toBe(1);
    expect(entitlementValue(entitlements, "missing.key")).toBeUndefined();
  });

  it("accepts a signed image that satisfies require/requireValue", () => {
    const loader = new ImageLoader({
      provider: new MapFileProvider(new Map([["/signed", signed()]])),
      entitlementPolicy: {
        require: ["get-task-allow", "com.apple.security.app-sandbox"],
        requireValue: { "application-identifier": "TEAM.com.example" },
      },
    });
    const program = loader.load("/signed");
    expect(program.main.image.codeSignatureInfo?.entitlements).toMatchObject({
      "get-task-allow": true,
    });
    const result = evaluateEntitlements(program.main.image.codeSignatureInfo, {
      require: ["get-task-allow"],
    });
    expect(result.allowed).toBe(true);
  });

  it("denies missing, forbidden, mismatched, and unsigned images", () => {
    const policy = { require: ["missing-key"] };
    expect(
      evaluateEntitlements({ entitlements: { "get-task-allow": true } } as never, policy),
    ).toMatchObject({ allowed: false, missing: ["missing-key"] });
    expect(
      evaluateEntitlements({ entitlements: { "get-task-allow": true } } as never, {
        deny: ["get-task-allow"],
      }),
    ).toMatchObject({ allowed: false, denied: ["get-task-allow"] });
    expect(
      evaluateEntitlements({ entitlements: { "get-task-allow": true } } as never, {
        requireValue: { "get-task-allow": false },
      }),
    ).toMatchObject({ allowed: false, mismatched: ["get-task-allow"] });
    expect(evaluateEntitlements(null, {})).toMatchObject({
      allowed: false,
      reason: "image is unsigned",
    });
    expect(evaluateEntitlements(null, { allowUnsigned: true }).allowed).toBe(true);
  });

  it("fails the loader with entitlement_denied", () => {
    try {
      new ImageLoader({
        provider: new MapFileProvider(new Map([["/signed", signed()]])),
        entitlementPolicy: { require: ["not-present"] },
      }).load("/signed");
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toMatchObject({
        code: "entitlement_denied",
        details: { missing: ["not-present"] },
      });
    }
    expect(() =>
      new ImageLoader({
        provider: new MapFileProvider(
          new Map([
            ["/plain", buildMachO({ text: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]) }).bytes],
          ]),
        ),
      }).load("/plain"),
    ).not.toThrow();
  });
});
