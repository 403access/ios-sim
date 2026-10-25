import { Readable } from "node:stream";
import type {
  AppInfo,
  CreateDeviceRequest,
  Device,
  Display,
  InputEvent,
  InstallResponse,
  LaunchRequest,
  LaunchResponse,
  ScreenshotFormat,
  SimRuntime,
} from "@ios-sim/protocol";
import { IdbInput, InputUnavailableError } from "./idb.js";
import { Simctl } from "./simctl.js";

export interface BackendCapabilities {
  input: boolean;
  install: boolean;
  logs: boolean;
  streaming: boolean;
}

export interface LogOptions {
  level?: string;
  predicate?: string;
}

export interface HostBackend {
  readonly name: string;
  capabilities(): BackendCapabilities;
  listDevices(): Promise<Device[]>;
  listRuntimes(): Promise<SimRuntime[]>;
  createDevice(request: CreateDeviceRequest): Promise<Device>;
  bootDevice(udid: string): Promise<Device>;
  shutdownDevice(udid: string): Promise<void>;
  eraseDevice(udid: string): Promise<void>;
  deleteDevice(udid: string): Promise<void>;
  listApps(udid: string): Promise<AppInfo[]>;
  installApp(udid: string, appPath: string): Promise<InstallResponse>;
  launchApp(udid: string, request: LaunchRequest): Promise<LaunchResponse>;
  terminateApp(udid: string, bundleId: string): Promise<void>;
  screenshot(udid: string, format: ScreenshotFormat): Promise<Buffer | Uint8Array>;
  display(udid: string): Promise<Omit<Display, "format">>;
  sendInput(udid: string, event: InputEvent): Promise<void>;
  logs(udid: string, options?: LogOptions): Readable;
}

export class SimctlBackend implements HostBackend {
  readonly name = "simctl";

  constructor(
    private readonly simctl = new Simctl(),
    private readonly input = new IdbInput(),
  ) {}

  capabilities(): BackendCapabilities {
    return {
      input: true, // refined at startup by the factory; sendInput re-checks
      install: true,
      logs: true,
      streaming: true,
    };
  }

  async inputAvailable(): Promise<boolean> {
    return this.input.isAvailable();
  }

  listDevices() {
    return this.simctl.listDevices();
  }

  listRuntimes() {
    return this.simctl.listRuntimes();
  }

  createDevice(request: CreateDeviceRequest) {
    return this.simctl.createDevice(request);
  }

  bootDevice(udid: string) {
    return this.simctl.boot(udid);
  }

  shutdownDevice(udid: string) {
    return this.simctl.shutdown(udid);
  }

  eraseDevice(udid: string) {
    return this.simctl.erase(udid);
  }

  deleteDevice(udid: string) {
    return this.simctl.deleteDevice(udid);
  }

  listApps(udid: string) {
    return this.simctl.listApps(udid);
  }

  async installApp(udid: string, appPath: string): Promise<InstallResponse> {
    await this.simctl.install(udid, appPath);
    return { installed: appPath };
  }

  launchApp(udid: string, request: LaunchRequest) {
    return this.simctl.launch(udid, request);
  }

  terminateApp(udid: string, bundleId: string) {
    return this.simctl.terminate(udid, bundleId);
  }

  screenshot(udid: string, format: ScreenshotFormat) {
    return this.simctl.screenshot(udid, format);
  }

  display(udid: string) {
    return this.simctl.display(udid);
  }

  async sendInput(udid: string, event: InputEvent): Promise<void> {
    const display = { ...(await this.simctl.display(udid)), format: "jpeg" as const };
    await this.input.send(udid, event, display);
  }

  logs(udid: string, options: LogOptions = {}) {
    return this.simctl.openLogStream(udid, options);
  }
}

const MOCK_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);
const MOCK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  "base64",
);

interface MockState {
  devices: Device[];
  apps: Map<string, AppInfo[]>;
  inputs: Map<string, InputEvent[]>;
  installs: Map<string, string[]>;
}

const seed = (): MockState => ({
  devices: [
    {
      udid: "MOCK-BOOTED",
      name: "Mock iPhone",
      runtime: "iOS 26.4",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      state: "Booted",
      isAvailable: true,
    },
    {
      udid: "MOCK-SHUTDOWN",
      name: "Mock iPad",
      runtime: "iOS 26.4",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5",
      state: "Shutdown",
      isAvailable: true,
    },
  ],
  apps: new Map(),
  inputs: new Map(),
  installs: new Map(),
});

export class MockBackend implements HostBackend {
  readonly name = "mock";
  readonly state: MockState;

  constructor(state: MockState = seed()) {
    this.state = state;
  }

  capabilities(): BackendCapabilities {
    return { input: true, install: true, logs: true, streaming: true };
  }

  async listDevices() {
    return this.state.devices.map((device) => ({ ...device }));
  }

  async listRuntimes(): Promise<SimRuntime[]> {
    return [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        name: "iOS 26.4",
        version: "26.4",
        platform: "iOS",
        isAvailable: true,
      },
    ];
  }

  async createDevice(request: CreateDeviceRequest) {
    const device: Device = {
      udid: `MOCK-${this.state.devices.length + 1}`,
      name: request.name,
      runtime: "iOS 26.4",
      runtimeIdentifier: request.runtimeIdentifier ?? "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      deviceTypeIdentifier:
        request.deviceTypeIdentifier ?? "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      state: "Shutdown",
      isAvailable: true,
    };
    this.state.devices.push(device);
    return device;
  }

  private find(udid: string) {
    const device = this.state.devices.find((candidate) => candidate.udid === udid);
    if (!device) throw new Error(`Simulator ${udid} not found`);
    return device;
  }

  async bootDevice(udid: string) {
    const device = this.find(udid);
    device.state = "Booted";
    return device;
  }

  async shutdownDevice(udid: string) {
    this.find(udid).state = "Shutdown";
  }

  async eraseDevice(udid: string) {
    const device = this.find(udid);
    device.state = "Shutdown";
    this.state.apps.delete(udid);
  }

  async deleteDevice(udid: string) {
    this.find(udid);
    this.state.devices = this.state.devices.filter((device) => device.udid !== udid);
  }

  async listApps(udid: string) {
    return this.state.apps.get(udid) ?? [];
  }

  async installApp(udid: string, appPath: string) {
    this.find(udid);
    const apps = this.state.apps.get(udid) ?? [];
    if (!apps.some((app) => app.bundleIdentifier === "com.example.hello-sim")) {
      apps.push({
        bundleIdentifier: "com.example.hello-sim",
        name: "Hello Sim",
        path: appPath,
        version: "1.0",
        build: "1",
      });
    }
    this.state.apps.set(udid, apps);
    const installs = this.state.installs.get(udid) ?? [];
    installs.push(appPath);
    this.state.installs.set(udid, installs);
    return { installed: appPath };
  }

  async launchApp(udid: string, request: LaunchRequest) {
    this.find(udid);
    return { pid: request.bundleId === "com.example.hello-sim" ? 4242 : 4243 };
  }

  async terminateApp(udid: string) {
    this.find(udid);
  }

  async screenshot(_udid: string, format: ScreenshotFormat) {
    return format === "png" ? MOCK_PNG : MOCK_JPEG;
  }

  async display(_udid: string) {
    return {
      widthPx: 1206,
      heightPx: 2622,
      scale: 3,
      widthPoints: 402,
      heightPoints: 874,
    };
  }

  async sendInput(udid: string, event: InputEvent) {
    this.find(udid);
    const events = this.state.inputs.get(udid) ?? [];
    events.push(event);
    this.state.inputs.set(udid, events);
  }

  logs(udid: string): Readable {
    this.find(udid);
    const lines = [
      JSON.stringify({ timestamp: new Date().toISOString(), eventMessage: "mock log line 1" }),
      JSON.stringify({ timestamp: new Date().toISOString(), eventMessage: "mock log line 2" }),
    ];
    return Readable.from(lines.map((line) => `${line}\n`));
  }
}

export interface CreateBackendOptions {
  backend?: "simctl" | "mock";
}

export async function createBackend(options: CreateBackendOptions = {}): Promise<HostBackend> {
  const name = options.backend ?? (process.env.IOS_SIM_BACKEND as "simctl" | "mock" | undefined);
  if (name === "mock") return new MockBackend();
  if (process.platform !== "darwin") {
    throw new Error(
      "The simctl backend only runs on macOS. Use --backend mock for a Linux-only demo.",
    );
  }
  const backend = new SimctlBackend();
  const input = await backend.inputAvailable();
  return {
    ...backend,
    name: "simctl",
    capabilities: () => ({
      input,
      install: true,
      logs: true,
      streaming: true,
    }),
    listDevices: backend.listDevices.bind(backend),
    listRuntimes: backend.listRuntimes.bind(backend),
    createDevice: backend.createDevice.bind(backend),
    bootDevice: backend.bootDevice.bind(backend),
    shutdownDevice: backend.shutdownDevice.bind(backend),
    eraseDevice: backend.eraseDevice.bind(backend),
    deleteDevice: backend.deleteDevice.bind(backend),
    listApps: backend.listApps.bind(backend),
    installApp: backend.installApp.bind(backend),
    launchApp: backend.launchApp.bind(backend),
    terminateApp: backend.terminateApp.bind(backend),
    screenshot: backend.screenshot.bind(backend),
    display: backend.display.bind(backend),
    sendInput: backend.sendInput.bind(backend),
    logs: backend.logs.bind(backend),
  };
}

export { InputUnavailableError };
