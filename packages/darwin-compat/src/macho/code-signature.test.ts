import { describe, expect, it } from "vitest";
import { buildMachO } from "./build.js";
import { buildCodeSignature, parseCodeSignature } from "./code-signature.js";
import { parseMachO } from "./parse.js";

const ENTITLEMENTS =
  '<plist version="1.0"><dict><key>get-task-allow</key><true/><key>application-identifier</key><string>TEAM.com.example.app</string></dict></plist>';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "missing-code";
  }
  return "no-error";
}

describe("embedded code signatures", () => {
  it("parses a superblob, CodeDirectory, and entitlements", () => {
    const blob = buildCodeSignature({
      identifier: "com.example.app",
      teamId: "TEAM123",
      entitlements: ENTITLEMENTS,
      hashType: 2,
      flags: 0x2,
    });
    const signature = parseCodeSignature(blob, 0, blob.length);
    expect(signature.blobs).toHaveLength(3);
    expect(signature.codeDirectory).toMatchObject({
      version: 0x20200,
      flags: 0x2,
      identifier: "com.example.app",
      teamId: "TEAM123",
      hashType: "sha256",
      hashSize: 32,
      pageSize: 0x1000,
      codeSlots: 1,
    });
    expect(signature.entitlements).toEqual({
      "get-task-allow": true,
      "application-identifier": "TEAM.com.example.app",
    });
    expect(signature.hasSignature).toBe(true);
    expect(signature.hasRequirements).toBe(false);
    expect(signature.hasDerEntitlements).toBe(false);
    const custom = buildCodeSignature({ identifier: "com.example.custom", hashType: 99 as never });
    expect(parseCodeSignature(custom, 0, custom.length).codeDirectory?.hashType).toBe("hash-99");
  });

  it("attaches the parsed signature to a Mach-O image", () => {
    const signature = buildCodeSignature({
      identifier: "com.example.tool",
      entitlements: ENTITLEMENTS,
    });
    const built = buildMachO({
      text: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]),
      codeSignature: signature,
    });
    const image = parseMachO(built.bytes).image;
    expect(image.codeSignature).toMatchObject({ dataSize: signature.length });
    expect(image.codeSignatureInfo?.codeDirectory?.identifier).toBe("com.example.tool");
    expect(image.codeSignatureInfo?.entitlements).toMatchObject({ "get-task-allow": true });
  });

  it("returns null when the image is unsigned", () => {
    const built = buildMachO({ text: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]) });
    expect(parseMachO(built.bytes).image.codeSignatureInfo).toBeNull();
  });

  it("recognizes requirements and DER entitlements without XML", () => {
    const blob = buildCodeSignature({
      identifier: "com.example.der",
      includeDerEntitlements: true,
      includeRequirements: true,
      includeSignature: false,
    });
    const signature = parseCodeSignature(blob, 0, blob.length);
    expect(signature.entitlements).toBeNull();
    expect(signature.entitlementsRaw).toBeNull();
    expect(signature.hasDerEntitlements).toBe(true);
    expect(signature.hasRequirements).toBe(true);
    expect(signature.hasSignature).toBe(false);
  });

  it("rejects malformed CodeDirectory offsets and slot counts", () => {
    const blob = buildCodeSignature({ identifier: "com.example.bad" });
    const corrupt = (offset: number, value: number): Uint8Array => {
      const copy = blob.slice();
      new DataView(copy.buffer).setUint32(offset, value, false);
      return copy;
    };
    const cd = parseCodeSignature(blob, 0, blob.length).blobs.find(
      (entry) => entry.type === 0,
    )!.offset;
    expect(() => parseCodeSignature(corrupt(cd + 20, 4), 0, blob.length)).toThrow(/identifier/);
    expect(() => parseCodeSignature(corrupt(cd + 16, 4), 0, blob.length)).toThrow(/hash offset/);
    expect(() => parseCodeSignature(corrupt(cd + 24, 2_000_000), 0, blob.length)).toThrow(
      /slot count/,
    );
  });

  it("rejects malformed superblobs with stable codes", () => {
    const blob = buildCodeSignature({ identifier: "com.example.app", entitlements: ENTITLEMENTS });
    expect(codeOf(() => parseCodeSignature(blob, blob.length - 4, 8))).toBe(
      "code_signature_out_of_bounds",
    );
    const badMagic = Uint8Array.from(blob);
    new DataView(badMagic.buffer).setUint32(0, 0x11223344, false);
    expect(codeOf(() => parseCodeSignature(badMagic, 0, badMagic.length))).toBe(
      "bad_code_signature_magic",
    );
    const badOffset = Uint8Array.from(blob);
    new DataView(badOffset.buffer).setUint32(16, 0xffffff, false);
    expect(codeOf(() => parseCodeSignature(badOffset, 0, badOffset.length))).toBe(
      "bad_code_signature_blob",
    );
    const truncated = blob.subarray(0, 20);
    expect(codeOf(() => parseCodeSignature(truncated, 0, truncated.length))).toBe(
      "bad_code_signature_blob",
    );
  });
});
