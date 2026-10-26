import { describe, expect, it } from "vitest";
import { architecture, renderArchitecture } from "../scripts/architecture-progress.js";

describe("architecture progress dashboard", () => {
  it("renders every layer and embeds valid data", () => {
    const html = renderArchitecture(architecture);
    expect(html).toContain("Run an unmodified iOS app on a non-Apple host");
    for (const layer of architecture.layers) {
      expect(html).toContain(`data-layer="${layer.id}"`);
      expect(html).toContain(layer.evidence.split(" · ")[0]!);
    }
    expect(html).not.toContain("undefined");
    const match = html.match(
      /<script id="arch-data" type="application\/json">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!.replaceAll("<\\/", "</")) as {
      layers: Array<{ id: string }>;
    };
    expect(parsed.layers.map((layer) => layer.id)).toEqual(
      architecture.layers.map((layer) => layer.id),
    );
  });

  it("keeps every layer measured and evidenced", () => {
    const ids = new Set<string>();
    for (const layer of architecture.layers) {
      expect(ids.has(layer.id), `duplicate layer ${layer.id}`).toBe(false);
      ids.add(layer.id);
      expect(layer.percent).toBeGreaterThanOrEqual(0);
      expect(layer.percent).toBeLessThanOrEqual(100);
      expect(layer.chips.length).toBeGreaterThan(0);
      expect(layer.shipped.length).toBeGreaterThan(0);
      expect(layer.open.length).toBeGreaterThan(0);
      expect(layer.evidence.length).toBeGreaterThan(0);
    }
    expect(architecture.layers.some((layer) => layer.id === "ipa")).toBe(true);
    expect(architecture.milestones.every((milestone) => milestone.done <= milestone.total)).toBe(
      true,
    );
  });
});
