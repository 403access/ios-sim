import { describe, expect, it } from "vitest";
import { buildReproManifest, describeReproFile, sha256Hex } from "./repro.js";

describe("repro bundle manifest", () => {
  it("hashes files and sorts them for a stable manifest", () => {
    const a = describeReproFile("b.json", new TextEncoder().encode("b"));
    const b = describeReproFile("a.json", new TextEncoder().encode("a"));
    expect(a.sha256).toHaveLength(64);
    expect(sha256Hex(new TextEncoder().encode("b"))).toBe(a.sha256);
    const manifest = buildReproManifest({
      createdAt: "2026-10-26T00:00:00.000Z",
      sourceRevision: "abc123",
      dirty: false,
      platform: "linux",
      architecture: "x64",
      runtime: "bun",
      runtimeVersion: "1.4.4",
      files: [a, b],
    });
    expect(manifest.files.map((file) => file.path)).toEqual(["a.json", "b.json"]);
    expect(manifest.files[0]?.sha256).toBe(sha256Hex(new TextEncoder().encode("a")));
  });
});
