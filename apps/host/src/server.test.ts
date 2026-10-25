import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MockBackend } from "./backends.js";
import { buildServer } from "./server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

async function setup() {
  const backend = new MockBackend();
  const app = await buildServer({ backend, token: TOKEN });
  return { app, backend };
}

const apps: Array<Awaited<ReturnType<typeof setup>>["app"]> = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

async function listen(app: Awaited<ReturnType<typeof setup>>["app"]) {
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("HTTP API", () => {
  it("keeps health public and protects everything else", async () => {
    const { app } = await setup();
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ backend: "mock", capabilities: { input: true } });

    const denied = await app.inject({ method: "GET", url: "/v1/devices" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("unauthorized");

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/devices",
      headers: auth,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().devices).toHaveLength(2);
  });

  it("lists runtimes", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/runtimes", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ identifier: expect.stringContaining("iOS-26-4") }),
    ]);
  });

  it("creates, boots, shuts down, erases, and deletes", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { ...auth, "content-type": "application/json" },
      payload: { name: "CI Phone" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "CI Phone", state: "Shutdown" });
    const udid = created.json().udid as string;

    const booted = await app.inject({
      method: "POST",
      url: `/v1/devices/${udid}/boot`,
      headers: auth,
    });
    expect(booted.json().state).toBe("Booted");

    for (const [method, path] of [
      ["POST", "shutdown"],
      ["POST", "erase"],
      ["DELETE", ""],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/v1/devices/${udid}${path ? `/${path}` : ""}`,
        headers: auth,
      });
      expect(response.statusCode).toBe(204);
    }
  });

  it("returns display metadata and screenshots", async () => {
    const { app } = await setup();
    const display = await app.inject({
      method: "GET",
      url: "/v1/devices/MOCK-BOOTED/display",
      headers: auth,
    });
    expect(display.json()).toEqual({
      widthPx: 1206,
      heightPx: 2622,
      scale: 3,
      widthPoints: 402,
      heightPoints: 874,
      format: "jpeg",
    });

    const screenshot = await app.inject({
      method: "GET",
      url: "/v1/devices/MOCK-BOOTED/screenshot?format=jpeg",
      headers: auth,
    });
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.headers["content-type"]).toContain("image/jpeg");
    expect(screenshot.rawPayload[0]).toBe(0xff);
    expect(screenshot.rawPayload[1]).toBe(0xd8);
  });

  it("validates normalized input and records it", async () => {
    const { app, backend } = await setup();
    const tap = await app.inject({
      method: "POST",
      url: "/v1/devices/MOCK-BOOTED/input",
      headers: { ...auth, "content-type": "application/json" },
      payload: { type: "tap", x: 0.5, y: 0.25 },
    });
    expect(tap.statusCode).toBe(204);
    expect(backend.state.inputs.get("MOCK-BOOTED")).toEqual([{ type: "tap", x: 0.5, y: 0.25 }]);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/devices/MOCK-BOOTED/input",
      headers: { ...auth, "content-type": "application/json" },
      payload: { type: "tap", x: 1.5, y: 0.25 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_request");
  });

  it("installs a gzip tarball containing a .app", async () => {
    const { app, backend } = await setup();
    const directory = await mkdtemp(join(tmpdir(), "ios-sim-test-app-"));
    try {
      const appDirectory = join(directory, "HelloSim.app");
      await mkdir(appDirectory);
      await writeFile(join(appDirectory, "Info.plist"), "<plist/>");
      const archive = await tarBuffer(directory, ["HelloSim.app"]);

      const response = await app.inject({
        method: "POST",
        url: "/v1/devices/MOCK-BOOTED/apps",
        headers: { ...auth, "content-type": "application/gzip" },
        payload: archive,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().installed).toContain("HelloSim.app");
      expect(backend.state.installs.get("MOCK-BOOTED")).toHaveLength(1);

      const apps = await app.inject({
        method: "GET",
        url: "/v1/devices/MOCK-BOOTED/apps",
        headers: auth,
      });
      expect(apps.json().apps[0]).toMatchObject({ bundleIdentifier: "com.example.hello-sim" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an archive without a .app", async () => {
    const { app } = await setup();
    const directory = await mkdtemp(join(tmpdir(), "ios-sim-test-app-"));
    try {
      await writeFile(join(directory, "readme.txt"), "not an app");
      const archive = await tarBuffer(directory, ["readme.txt"]);
      const response = await app.inject({
        method: "POST",
        url: "/v1/devices/MOCK-BOOTED/apps",
        headers: { ...auth, "content-type": "application/gzip" },
        payload: archive,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("app_bundle_missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("launches and terminates", async () => {
    const { app } = await setup();
    const launch = await app.inject({
      method: "POST",
      url: "/v1/devices/MOCK-BOOTED/launch",
      headers: { ...auth, "content-type": "application/json" },
      payload: { bundleId: "com.example.hello-sim" },
    });
    expect(launch.statusCode).toBe(200);
    expect(launch.json()).toEqual({ pid: 4242 });

    const terminate = await app.inject({
      method: "POST",
      url: "/v1/devices/MOCK-BOOTED/terminate",
      headers: { ...auth, "content-type": "application/json" },
      payload: { bundleId: "com.example.hello-sim" },
    });
    expect(terminate.statusCode).toBe(204);
  });

  it("returns JSON 404s", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/nope", headers: auth });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });
});

describe("WebSocket stream", () => {
  it("sends config then binary JPEG frames", async () => {
    const { app } = await setup();
    const base = await listen(app);
    const url = `${base.replace("http", "ws")}/v1/devices/MOCK-BOOTED/stream?fps=10&token=${TOKEN}`;
    const socket = new WebSocket(url);
    const messages: Array<{ binary: boolean; data: Buffer }> = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stream timeout")), 5000);
      socket.on("message", (data, binary) => {
        messages.push({ binary, data: Buffer.from(data as ArrayBuffer) });
        if (messages.some((message) => message.binary)) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on("error", reject);
    });
    socket.close();

    expect(JSON.parse(messages[0]?.data.toString() ?? "{}")).toMatchObject({
      type: "config",
      fps: 10,
      format: "jpeg",
    });
    const frame = messages.find((message) => message.binary);
    expect(frame?.data[0]).toBe(0xff);
    expect(frame?.data[1]).toBe(0xd8);
  });

  it("closes with 1008 for an invalid token", async () => {
    const { app } = await setup();
    const base = await listen(app);
    const socket = new WebSocket(
      `${base.replace("http", "ws")}/v1/devices/MOCK-BOOTED/stream?token=wrong`,
    );
    const code = await new Promise<number>((resolve, reject) => {
      socket.on("close", (value) => resolve(value));
      socket.on("error", reject);
    });
    expect(code).toBe(1008);
  });
});

describe("SSE logs", () => {
  it("streams NDJSON as SSE data", async () => {
    const { app } = await setup();
    const base = await listen(app);
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/devices/MOCK-BOOTED/logs?token=${TOKEN}`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    const { value } = (await reader?.read()) ?? { value: undefined };
    controller.abort();
    expect(new TextDecoder().decode(value)).toContain("data:");
  });
});

async function tarBuffer(cwd: string, files: string[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = createTar({ gzip: true, cwd, portable: false }, files);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
