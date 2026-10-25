import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type {
  AppInfo,
  CreateDeviceRequest,
  Device,
  Display,
  LaunchRequest,
  LaunchResponse,
  ScreenshotFormat,
  SimRuntime,
} from "@ios-sim/protocol";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const runtimesResponseSchema = z.object({
  runtimes: z.array(
    z.object({
      identifier: z.string(),
      name: z.string(),
      version: z.string(),
      platform: z.string(),
      isAvailable: z.boolean(),
    }),
  ),
});

const devicesResponseSchema = z.object({
  devices: z.record(
    z.string(),
    z.array(
      z.object({
        udid: z.string(),
        name: z.string(),
        state: z.string(),
        isAvailable: z.boolean().default(true),
        deviceTypeIdentifier: z.string(),
      }),
    ),
  ),
});

const deviceTypesResponseSchema = z.object({
  devicetypes: z.array(
    z.object({
      identifier: z.string(),
      name: z.string(),
      productFamily: z.string(),
      minRuntimeVersionString: z.string().optional(),
      maxRuntimeVersionString: z.string().optional(),
    }),
  ),
});

const appsResponseSchema = z.record(
  z.string(),
  z
    .object({
      CFBundleIdentifier: z.string().optional(),
      CFBundleDisplayName: z.string().optional(),
      CFBundleName: z.string().optional(),
      CFBundleShortVersionString: z.string().optional(),
      CFBundleVersion: z.string().optional(),
      Bundle: z.string().optional(),
      ApplicationType: z.string().optional(),
    })
    .passthrough(),
);

export interface SimctlOptions {
  /** Defaults to `xcrun`, which is the supported way to find simctl. */
  executable?: string;
  /** Defaults to `simctl`; `xcrun` is invoked as `xcrun simctl ...`. */
  subcommandPrefix?: string;
  timeoutMs?: number;
}

export class SimctlError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "SimctlError";
  }
}

export class Simctl {
  private readonly executable: string;
  private readonly prefix: string[];
  private readonly timeoutMs: number;

  constructor(options: SimctlOptions = {}) {
    this.executable = options.executable ?? process.env.IOS_SIM_SIMCTL ?? "xcrun";
    this.prefix = options.subcommandPrefix
      ? [options.subcommandPrefix]
      : this.executable === "xcrun"
        ? ["simctl"]
        : [];
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async run(args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    try {
      return await execFileAsync(this.executable, [...this.prefix, ...args], {
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; message?: string };
      throw new SimctlError(
        detail.message ?? `simctl ${args.join(" ")} failed`,
        detail.stdout ?? "",
        detail.stderr ?? "",
      );
    }
  }

  private async runJson<T>(args: string[], parse: (value: unknown) => T): Promise<T> {
    const { stdout } = await this.run(args);
    return parse(JSON.parse(stdout));
  }

  async listRuntimes(): Promise<SimRuntime[]> {
    const parsed = await this.runJson(["list", "-j", "runtimes"], (value) =>
      runtimesResponseSchema.parse(value),
    );
    return parsed.runtimes.map((runtime) => ({
      identifier: runtime.identifier,
      name: runtime.name,
      version: runtime.version,
      platform: runtime.platform,
      isAvailable: runtime.isAvailable,
    }));
  }

  async listDevices(): Promise<Device[]> {
    const [deviceJson, runtimes] = await Promise.all([
      this.runJson(["list", "-j", "devices"], (value) => devicesResponseSchema.parse(value)),
      this.listRuntimes().catch(() => [] as SimRuntime[]),
    ]);
    return parseDevices(deviceJson, runtimes).filter((device) => device.isAvailable);
  }

  async getDevice(udid: string): Promise<Device> {
    const device = (await this.listDevices()).find((candidate) => candidate.udid === udid);
    if (!device) throw new SimctlError(`Simulator ${udid} not found`, "", "");
    return device;
  }

  async boot(udid: string): Promise<Device> {
    await this.run(["boot", udid]).catch((error: SimctlError) => {
      if (!/current state: Booted/i.test(error.message)) throw error;
    });
    await this.run(["bootstatus", udid, "-b"], { timeoutMs: 180_000 }).catch(() => undefined);
    return this.getDevice(udid);
  }

  async shutdown(udid: string): Promise<void> {
    await this.run(["shutdown", udid]).catch((error: SimctlError) => {
      if (!/current state: Shutdown/i.test(error.message)) throw error;
    });
  }

  async erase(udid: string): Promise<void> {
    await this.shutdown(udid);
    await this.run(["erase", udid]);
  }

  async deleteDevice(udid: string): Promise<void> {
    await this.shutdown(udid);
    await this.run(["delete", udid]);
  }

  async createDevice(request: CreateDeviceRequest): Promise<Device> {
    const runtime = request.runtimeIdentifier ?? (await this.defaultRuntime());
    const deviceType = request.deviceTypeIdentifier ?? (await this.defaultDeviceType(runtime));
    const { stdout } = await this.run(["create", request.name, deviceType, runtime]);
    const udid = stdout.trim();
    return this.getDevice(udid);
  }

  private async defaultRuntime(): Promise<string> {
    const runtimes = (await this.listRuntimes()).filter(
      (runtime) => runtime.isAvailable && runtime.platform === "iOS",
    );
    const latest = runtimes.sort((a, b) => compareVersions(b.version, a.version))[0];
    if (!latest) throw new SimctlError("No available iOS runtimes", "", "");
    return latest.identifier;
  }

  private async defaultDeviceType(runtimeIdentifier: string): Promise<string> {
    const [parsed, runtimes] = await Promise.all([
      this.runJson(["list", "-j", "devicetypes"], (value) =>
        deviceTypesResponseSchema.parse(value),
      ),
      this.listRuntimes(),
    ]);
    const runtimeVersion =
      runtimes.find((runtime) => runtime.identifier === runtimeIdentifier)?.version ?? "0";
    const iphones = parsed.devicetypes.filter((candidate) => candidate.productFamily === "iPhone");
    const compatible = iphones.find(
      (candidate) =>
        (!candidate.minRuntimeVersionString ||
          compareVersions(candidate.minRuntimeVersionString, runtimeVersion) <= 0) &&
        (!candidate.maxRuntimeVersionString ||
          compareVersions(candidate.maxRuntimeVersionString, runtimeVersion) >= 0),
    );
    const chosen = compatible ?? iphones[0];
    if (!chosen) throw new SimctlError("No iPhone device types installed", "", "");
    return chosen.identifier;
  }

  async listApps(udid: string): Promise<AppInfo[]> {
    // `simctl listapps` emits an OpenStep plist, not JSON. Convert it with
    // plutil so the rest of the host can keep using JSON parsers.
    const { stdout } = await this.run(["listapps", udid]);
    const directory = await mkdtemp(join(tmpdir(), "ios-sim-apps-"));
    try {
      const plist = join(directory, "apps.plist");
      await writeFile(plist, stdout);
      const { stdout: json } = await execFileAsync("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        plist,
      ]);
      const parsed = appsResponseSchema.parse(JSON.parse(json));
      return mapApps(parsed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async install(udid: string, appPath: string): Promise<string> {
    await this.run(["install", udid, appPath]);
    return appPath;
  }

  async launch(udid: string, request: LaunchRequest): Promise<LaunchResponse> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(request.environment ?? {})) {
      env[`SIMCTL_CHILD_${key}`] = value;
    }
    // `--console-pty` would keep this request open forever. Console output is
    // available through the logs endpoint instead.
    const args = ["launch", udid, request.bundleId, ...(request.args ?? [])];
    const { stdout } = await this.run(args, { env });
    const pid = parsePid(stdout);
    return { pid };
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    await this.run(["terminate", udid, bundleId]).catch((error: SimctlError) => {
      if (!/not running/i.test(error.message)) throw error;
    });
  }

  async screenshot(udid: string, format: ScreenshotFormat): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), "ios-sim-"));
    const path = join(directory, `screen.${format === "jpeg" ? "jpg" : "png"}`);
    try {
      await this.run(["io", udid, "screenshot", `--type=${format}`, path]);
      return await readFile(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async display(udid: string): Promise<Omit<Display, "format">> {
    const [width, height, scale] = await Promise.all([
      this.getenv(udid, "SIMULATOR_MAINSCREEN_WIDTH"),
      this.getenv(udid, "SIMULATOR_MAINSCREEN_HEIGHT"),
      this.getenv(udid, "SIMULATOR_MAINSCREEN_SCALE"),
    ]);
    const widthPx = Number.parseInt(width, 10);
    const heightPx = Number.parseInt(height, 10);
    const scaleFactor = Number.parseFloat(scale) || 1;
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) {
      throw new SimctlError(`Could not read display size for ${udid}`, width, height);
    }
    return {
      widthPx,
      heightPx,
      scale: scaleFactor,
      widthPoints: widthPx / scaleFactor,
      heightPoints: heightPx / scaleFactor,
    };
  }

  async getenv(udid: string, name: string): Promise<string> {
    const { stdout } = await this.run(["getenv", udid, name]);
    return stdout.trim();
  }

  openLogStream(udid: string, options: { level?: string; predicate?: string } = {}): Readable {
    const args = [...this.prefix, "spawn", udid, "log", "stream", "--style", "ndjson"];
    if (options.level) args.push("--level", options.level);
    if (options.predicate) args.push("--predicate", options.predicate);
    const child = execFile(this.executable, args, {
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    return child.stdout as Readable;
  }
}

export function parseDevices(
  parsed: z.infer<typeof devicesResponseSchema>,
  runtimes: SimRuntime[],
): Device[] {
  const names = new Map(runtimes.map((runtime) => [runtime.identifier, runtime.name]));
  return Object.entries(parsed.devices)
    .flatMap(([runtimeIdentifier, devices]) =>
      devices.map((device) => ({
        udid: device.udid,
        name: device.name,
        runtime: names.get(runtimeIdentifier) ?? runtimeLabel(runtimeIdentifier),
        runtimeIdentifier,
        deviceTypeIdentifier: device.deviceTypeIdentifier,
        state: device.state,
        isAvailable: device.isAvailable,
      })),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.runtime.localeCompare(b.runtime));
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-4` -> `iOS 18.4` */
export function runtimeLabel(identifier: string): string {
  const suffix = identifier.split("SimRuntime.")[1] ?? identifier;
  return suffix.replace(/-/g, " ").replace(/(\d) (\d)/g, "$1.$2");
}

export function parsePid(stdout: string): number {
  const match = stdout.match(/:\s*(\d+)\s*$/m);
  if (!match?.[1]) throw new Error(`Could not parse pid from simctl output: ${stdout.trim()}`);
  return Number.parseInt(match[1], 10);
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function mapApps(parsed: z.infer<typeof appsResponseSchema>): AppInfo[] {
  return Object.entries(parsed).map(([bundleIdentifier, app]) => ({
    bundleIdentifier: app.CFBundleIdentifier ?? bundleIdentifier,
    name: app.CFBundleDisplayName ?? app.CFBundleName ?? bundleIdentifier,
    path: fileUrlToPath(app.Bundle),
    version: app.CFBundleShortVersionString,
    build: app.CFBundleVersion,
  }));
}

function fileUrlToPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("file://") ? decodeURIComponent(value.slice("file://".length)) : value;
}
