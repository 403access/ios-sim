import { describe, expect, it } from "vitest";
import { MetricsServer, METRICS_HOST, formatMetrics } from "./metrics.js";
import { RuntimeStats } from "./stats.js";

describe("loopback metrics endpoint", () => {
  it("serves Prometheus counters on 127.0.0.1 only", async () => {
    const stats = new RuntimeStats();
    stats.increment("processesStarted", 2);
    stats.increment("instructions", 42);
    const metrics = new MetricsServer({ stats, extra: () => ({ "queue.depth": 3 }) });
    const endpoint = await metrics.start();
    try {
      expect(endpoint.url.startsWith(`http://${METRICS_HOST}:`)).toBe(true);
      const response = await fetch(`${endpoint.url}/metrics`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("ios_sim_native_processesStarted 2");
      expect(text).toContain("ios_sim_native_instructions 42");
      expect(text).toContain("ios_sim_native_queue_depth 3");
      expect((await fetch(`${endpoint.url}/healthz`)).status).toBe(200);
      expect((await fetch(`${endpoint.url}/nope`)).status).toBe(404);
    } finally {
      await metrics.stop();
    }
  });

  it("requires a bearer token when configured", async () => {
    const metrics = new MetricsServer({ token: "secret" });
    const endpoint = await metrics.start();
    try {
      expect((await fetch(`${endpoint.url}/metrics`)).status).toBe(401);
      const response = await fetch(`${endpoint.url}/metrics`, {
        headers: { authorization: "Bearer secret" },
      });
      expect(response.status).toBe(200);
    } finally {
      await metrics.stop();
    }
  });

  it("rejects non-loopback hosts and formats metrics without extra values", () => {
    expect(() => new MetricsServer({ host: "0.0.0.0" })).toThrow(/must bind 127.0.0.1/);
    const text = formatMetrics({ processesStarted: 1, imagesLoaded: 2 } as never);
    expect(text).toContain("ios_sim_native_processesStarted 1");
    expect(text.trim().split("\n")).toHaveLength(4);
  });
});
