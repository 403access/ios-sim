import {
  type AppInfo,
  appListSchema,
  type CreateDeviceRequest,
  type Device,
  type Display,
  deviceListSchema,
  deviceSchema,
  displaySchema,
  errorSchema,
  type Health,
  healthSchema,
  type InputEvent,
  type InstallResponse,
  installResponseSchema,
  type LaunchRequest,
  type LaunchResponse,
  launchResponseSchema,
  runtimeSchema,
  type ScreenshotFormat,
  type SimRuntime,
} from "./schemas.js";

export class IosSimApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "IosSimApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface StreamOptions {
  fps?: number;
  format?: ScreenshotFormat;
}

type HeaderInit = ConstructorParameters<typeof Headers>[0];

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export class IosSimClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = trimSlash(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private headers(extra?: HeaderInit): Headers {
    const headers = new Headers(extra);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    return headers;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await this.toError(response);
    if (response.status === 204) return undefined as T;
    return parse(await response.json());
  }

  private async toError(response: Response): Promise<IosSimApiError> {
    const text = await response.text().catch(() => "");
    try {
      const parsed = errorSchema.parse(JSON.parse(text));
      return new IosSimApiError(
        response.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.details,
      );
    } catch {
      return new IosSimApiError(
        response.status,
        `http_${response.status}`,
        text || response.statusText,
      );
    }
  }

  async health(): Promise<Health> {
    return this.request("/v1/health", { method: "GET" }, (value) => healthSchema.parse(value));
  }

  async listDevices(): Promise<Device[]> {
    return this.request("/v1/devices", { method: "GET" }, (value) =>
      deviceListSchema.parse(value),
    ).then((result) => result.devices);
  }

  async listRuntimes(): Promise<SimRuntime[]> {
    return this.request("/v1/runtimes", { method: "GET" }, (value) =>
      runtimeSchema.array().parse(value),
    );
  }

  async resolveDevice(selector = "booted"): Promise<Device> {
    const devices = await this.listDevices();
    if (selector === "booted") {
      const booted = devices.filter((device) => device.state === "Booted");
      if (booted.length === 1) return booted[0] as Device;
      if (booted.length === 0) {
        throw new IosSimApiError(404, "no_booted_device", "No simulator is booted on the host.");
      }
      throw new IosSimApiError(
        409,
        "multiple_booted_devices",
        `Multiple simulators are booted; pass --device with one of: ${booted
          .map((device) => `${device.name} (${device.udid})`)
          .join(", ")}`,
      );
    }
    const match =
      devices.find((device) => device.udid.toLowerCase() === selector.toLowerCase()) ??
      devices.find((device) => device.name === selector);
    if (!match) {
      throw new IosSimApiError(404, "device_not_found", `No simulator matches "${selector}".`);
    }
    return match;
  }

  async createDevice(request: CreateDeviceRequest): Promise<Device> {
    return this.request(
      "/v1/devices",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      (value) => deviceSchema.parse(value),
    );
  }

  async bootDevice(udid: string): Promise<Device> {
    return this.request(
      `/v1/devices/${encodeURIComponent(udid)}/boot`,
      { method: "POST" },
      (value) => deviceSchema.parse(value),
    );
  }

  async shutdownDevice(udid: string): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(udid)}/shutdown`,
      { method: "POST" },
      () => undefined,
    );
  }

  async eraseDevice(udid: string): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(udid)}/erase`,
      { method: "POST" },
      () => undefined,
    );
  }

  async deleteDevice(udid: string): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(udid)}`,
      { method: "DELETE" },
      () => undefined,
    );
  }

  async listApps(udid: string): Promise<AppInfo[]> {
    return this.request(
      `/v1/devices/${encodeURIComponent(udid)}/apps`,
      { method: "GET" },
      (value) => appListSchema.parse(value),
    ).then((result) => result.apps);
  }

  async installApp(udid: string, archive: Uint8Array): Promise<InstallResponse> {
    return this.request(
      `/v1/devices/${encodeURIComponent(udid)}/apps`,
      {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: archive,
      },
      (value) => installResponseSchema.parse(value),
    );
  }

  async launchApp(udid: string, request: LaunchRequest): Promise<LaunchResponse> {
    return this.request(
      `/v1/devices/${encodeURIComponent(udid)}/launch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      (value) => launchResponseSchema.parse(value),
    );
  }

  async terminateApp(udid: string, bundleId: string): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(udid)}/terminate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleId }),
      },
      () => undefined,
    );
  }

  async display(udid: string): Promise<Display> {
    return this.request(
      `/v1/devices/${encodeURIComponent(udid)}/display`,
      { method: "GET" },
      (value) => displaySchema.parse(value),
    );
  }

  async screenshot(udid: string, format: ScreenshotFormat = "jpeg"): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/devices/${encodeURIComponent(udid)}/screenshot?format=${format}`,
      { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!response.ok) throw await this.toError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async input(udid: string, event: InputEvent): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(udid)}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      },
      () => undefined,
    );
  }

  streamUrl(udid: string, options: StreamOptions = {}): string {
    const url = new URL(`${this.baseUrl}/v1/devices/${encodeURIComponent(udid)}/stream`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (options.fps) url.searchParams.set("fps", String(options.fps));
    if (options.format) url.searchParams.set("format", options.format);
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }

  logsUrl(udid: string, options: { level?: string; predicate?: string } = {}): string {
    const url = new URL(`${this.baseUrl}/v1/devices/${encodeURIComponent(udid)}/logs`);
    if (options.level) url.searchParams.set("level", options.level);
    if (options.predicate) url.searchParams.set("predicate", options.predicate);
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }

  /** URL of the built-in browser client, suitable for `xdg-open`. */
  webUrl(udid?: string): string {
    const url = new URL(this.baseUrl);
    if (udid) url.searchParams.set("device", udid);
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }
}

export const createClient = (options: ClientOptions) => new IosSimClient(options);
