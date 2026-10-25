import { describe, expect, it, vi } from "vitest";
import { IosSimApiError, IosSimClient } from "./client.js";

const device = {
  udid: "A",
  name: "iPhone A",
  runtime: "iOS 26.4",
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  state: "Booted",
  isAvailable: true,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("IosSimClient", () => {
  it("adds the token and normalizes the base URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ok: true,
        service: "ios-sim-host",
        version: "0.1.0",
        platform: "darwin",
        backend: "simctl",
        hostname: "host",
        uptimeSeconds: 1,
        capabilities: { input: true, install: true, logs: true, streaming: true },
      }),
    );

    const client = new IosSimClient({
      baseUrl: "http://example.test/",
      token: "secret",
      fetchImpl: fetchMock,
    });
    await client.health();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.test/v1/health",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("returns devices and resolves booted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ devices: [device] }));
    const client = new IosSimClient({ baseUrl: "http://x", fetchImpl: fetchMock });

    await expect(client.listDevices()).resolves.toEqual([device]);
    await expect(client.resolveDevice("booted")).resolves.toEqual(device);
    await expect(client.resolveDevice("iPhone A")).resolves.toEqual(device);
    await expect(client.resolveDevice("A")).resolves.toEqual(device);
  });

  it("reports multiple booted devices", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ devices: [device, { ...device, udid: "B", name: "iPhone B" }] }),
    );
    const client = new IosSimClient({ baseUrl: "http://x", fetchImpl: fetchMock });
    await expect(client.resolveDevice("booted")).rejects.toMatchObject({
      code: "multiple_booted_devices",
    });
  });

  it("maps API errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { code: "no_booted_device", message: "none" } }, 404),
    );
    const client = new IosSimClient({ baseUrl: "http://x", fetchImpl: fetchMock });
    await expect(client.listDevices()).rejects.toBeInstanceOf(IosSimApiError);
    await expect(client.listDevices()).rejects.toMatchObject({
      status: 404,
      code: "no_booted_device",
    });
  });

  it("builds WebSocket and log URLs with the token", () => {
    const client = new IosSimClient({ baseUrl: "https://host:7777", token: "a b" });
    const stream = client.streamUrl("UDID", { fps: 4, format: "jpeg" });
    expect(stream).toContain("wss://host:7777/v1/devices/UDID/stream");
    expect(stream).toContain("fps=4");
    expect(stream).toContain("format=jpeg");
    expect(stream).toContain("token=a+b");

    const logs = client.logsUrl("UDID", { level: "debug" });
    expect(logs).toContain("https://host:7777/v1/devices/UDID/logs");
    expect(logs).toContain("level=debug");
  });

  it("handles 204 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const client = new IosSimClient({ baseUrl: "http://x", fetchImpl: fetchMock });
    await expect(client.shutdownDevice("A")).resolves.toBeUndefined();
  });

  it("rejects invalid display payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        widthPx: 0,
        heightPx: 1,
        scale: 1,
        widthPoints: 0,
        heightPoints: 1,
        format: "jpeg",
      }),
    );
    const client = new IosSimClient({ baseUrl: "http://x", fetchImpl: fetchMock });
    await expect(client.display("A")).rejects.toThrow();
  });
});
