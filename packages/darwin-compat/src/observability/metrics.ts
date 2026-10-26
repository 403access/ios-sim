/**
 * Optional loopback metrics endpoint (OBS-007).
 *
 * Binds 127.0.0.1 only, exposes `/metrics` in Prometheus text format and
 * `/healthz`, and optionally requires a bearer token. It is disabled unless a
 * caller starts it; the runtime never opens a socket on its own.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RuntimeStats, type RuntimeStatsSnapshot } from "./stats.js";

export const METRICS_HOST = "127.0.0.1";

export interface MetricsServerOptions {
  readonly port?: number;
  /** Must be 127.0.0.1; other hosts are rejected. */
  readonly host?: string;
  readonly token?: string;
  readonly stats?: RuntimeStats;
  /** Additional gauges sampled per request. */
  readonly extra?: () => Readonly<Record<string, number>>;
}

export interface MetricsEndpoint {
  readonly url: string;
  readonly port: number;
}

export function formatMetrics(
  snapshot: RuntimeStatsSnapshot,
  extra: Readonly<Record<string, number>> = {},
): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(snapshot)) {
    lines.push(`# TYPE ios_sim_native_${name} counter`);
    lines.push(`ios_sim_native_${name} ${value}`);
  }
  for (const [name, value] of Object.entries(extra)) {
    const metric = name.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`# TYPE ios_sim_native_${metric} gauge`);
    lines.push(`ios_sim_native_${metric} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export class MetricsServer {
  private server: Server | null = null;
  private endpoint: MetricsEndpoint | null = null;
  private readonly stats: RuntimeStats;
  private readonly options: MetricsServerOptions;

  constructor(options: MetricsServerOptions = {}) {
    if (options.host && options.host !== METRICS_HOST) {
      throw new Error(`metrics endpoint must bind ${METRICS_HOST}, got ${options.host}`);
    }
    this.options = options;
    this.stats = options.stats ?? new RuntimeStats();
  }

  async start(): Promise<MetricsEndpoint> {
    if (this.server) throw new Error("metrics server is already running");
    const server = createServer((request, response) => {
      if (this.options.token) {
        const header = request.headers.authorization ?? "";
        if (header !== `Bearer ${this.options.token}`) {
          response.writeHead(401, { "content-type": "text/plain" });
          response.end("unauthorized\n");
          return;
        }
      }
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok\n");
        return;
      }
      if (request.method === "GET" && request.url === "/metrics") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        response.end(formatMetrics(this.stats.snapshot(), this.options.extra?.() ?? {}));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, METRICS_HOST, () => resolve());
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    this.endpoint = { url: `http://${METRICS_HOST}:${address.port}`, port: address.port };
    return this.endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  get address(): MetricsEndpoint | null {
    return this.endpoint;
  }
}
