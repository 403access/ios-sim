import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVENANCE, REQUIRED_PROVENANCE_IDS, validateProvenance } from "./ledger.js";

describe("provenance ledger", () => {
  it("has unique, complete, required claims", () => {
    expect(validateProvenance()).toEqual([]);
    const ids = new Set(PROVENANCE.map((entry) => entry.id));
    for (const id of REQUIRED_PROVENANCE_IDS) expect(ids.has(id)).toBe(true);
  });

  it("points every evidence path at a real file or directory", () => {
    const missing: string[] = [];
    for (const entry of PROVENANCE) {
      for (const path of entry.evidence) {
        if (!existsSync(resolve(process.cwd(), path))) missing.push(`${entry.id}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("states the Apple-runtime blocker explicitly", () => {
    const blocked = PROVENANCE.filter((entry) => entry.status === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((entry) => /Apple UIKit|CoreSimulator/.test(entry.claim))).toBe(true);
    for (const entry of blocked) expect(entry.limitation).toBeTruthy();
  });
});
