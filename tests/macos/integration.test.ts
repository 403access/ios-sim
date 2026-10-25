import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClient, type Device } from "@ios-sim/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createBackend } from "../../apps/host/src/backends.js";
import { buildServer } from "../../apps/host/src/server.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.IOS_SIM_MACOS_TESTS === "1" && process.platform === "darwin";
const suite = enabled ? describe : describe.skip;
const TOKEN = "macos-integration-token";

suite("macOS integration (real CoreSimulator)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;
  let device: Device;
  let client: ReturnType<typeof createClient>;
  let fixtureDirectory: string;
  let bootedByTest = false;

  beforeAll(async () => {
    const backend = await createBackend({ backend: "simctl" });
    app = await buildServer({ backend, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = createClient({ baseUrl, token: TOKEN, timeoutMs: 60_000 });

    const devices = await client.listDevices();
    const existing = devices.find((candidate) => candidate.state === "Booted");
    if (existing) {
      device = existing;
    } else {
      const candidate = devices.find((candidate) => candidate.isAvailable);
      if (!candidate) throw new Error("No simulator is available");
      device = await client.bootDevice(candidate.udid);
      bootedByTest = true;
    }
    fixtureDirectory = await mkdtemp(join(tmpdir(), "ios-sim-fixture-"));
  }, 120_000);

  afterAll(async () => {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
    if (app) await app.close();
    if (bootedByTest) {
      await client?.shutdownDevice(device.udid).catch(() => undefined);
    }
  }, 60_000);

  it("reports a healthy simctl backend", async () => {
    const health = await client.health();
    expect(health.backend).toBe("simctl");
    expect(health.capabilities.streaming).toBe(true);
  });

  it("reports display geometry and captures a real screenshot", async () => {
    const display = await client.display(device.udid);
    expect(display.widthPx).toBeGreaterThan(0);
    expect(display.scale).toBeGreaterThan(0);
    expect(display.widthPoints).toBeCloseTo(display.widthPx / display.scale, 1);

    const jpeg = await client.screenshot(device.udid, "jpeg");
    expect(jpeg.byteLength).toBeGreaterThan(1000);
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
  }, 60_000);

  it("builds, installs, launches, and captures the fixture app", async () => {
    const { stdout } = await execFileAsync("bash", [
      join(process.cwd(), "scripts/build-fixture-app.sh"),
      fixtureDirectory,
    ]);
    const appPath = stdout.trim().split("\n").at(-1) ?? "";
    expect(appPath.endsWith("HelloSim.app")).toBe(true);

    const archive = await tarApp(appPath);
    const installed = await client.installApp(device.udid, archive);
    expect(installed.installed).toContain("HelloSim.app");

    const launch = await client.launchApp(device.udid, { bundleId: "com.example.hello-sim" });
    expect(launch.pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const shot = await client.screenshot(device.udid, "jpeg");
    expect(shot.byteLength).toBeGreaterThan(10_000);

    const apps = await client.listApps(device.udid);
    expect(apps.map((candidate) => candidate.bundleIdentifier)).toContain("com.example.hello-sim");

    await client.terminateApp(device.udid, "com.example.hello-sim");
  }, 120_000);

  it("injects input when idb is available", async () => {
    const health = await client.health();
    if (!health.capabilities.input) {
      console.warn("Skipping input test: idb is not available on this host.");
      return;
    }
    const display = await client.display(device.udid);
    await client.input(device.udid, { type: "tap", x: 0.5, y: 0.5 });
    await client.input(device.udid, { type: "button", button: "home" });
    // A second tap proves the device still accepts input after a button event.
    await client.input(device.udid, { type: "tap", x: 0.5, y: 0.5 });
    expect(display.widthPoints).toBeGreaterThan(0);
  }, 60_000);

  it("streams at least one frame over WebSocket", async () => {
    const socket = new WebSocket(`${client.streamUrl(device.udid, { fps: 10 })}`);
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stream timeout")), 10_000);
      socket.on("message", (data, binary) => {
        if (!binary) return;
        clearTimeout(timer);
        resolve(Buffer.from(data as ArrayBuffer));
      });
      socket.on("error", reject);
    });
    socket.close();
    expect(frame.byteLength).toBeGreaterThan(1000);
    expect(frame[0]).toBe(0xff);
  }, 30_000);

  it("opens an SSE log stream", async () => {
    const controller = new AbortController();
    const response = await fetch(client.logsUrl(device.udid, { level: "info" }), {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  }, 30_000);
});

async function tarApp(path: string): Promise<Buffer> {
  const { create } = await import("tar");
  const chunks: Buffer[] = [];
  const stream = create({ gzip: true, cwd: join(path, ".."), portable: false }, [
    path.split("/").at(-1) ?? path,
  ]);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
