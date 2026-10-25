#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createClient, DEFAULT_FPS, type Device, IosSimApiError } from "@ios-sim/protocol";
import { Command } from "commander";
import { create as createTar } from "tar";
import WebSocket from "ws";
import { resolveConnection, saveClientConfig } from "./config.js";
import { type CoordinateUnit, toNormalizedPoint } from "./coordinates.js";
import { formatBytes, printTable } from "./output.js";

const VERSION = "0.1.0";

const program = new Command()
  .name("ios-sim")
  .description("Control an iOS Simulator on a Mac from Linux, macOS, or Windows.")
  .version(VERSION)
  .option("--url <url>", "host URL (env IOS_SIM_URL)")
  .option("--token <token>", "access token (env IOS_SIM_TOKEN)")
  .option("--device <selector>", "device UDID, name, or booted (env IOS_SIM_DEVICE)")
  .option("--json", "machine-readable output")
  .option("--timeout <ms>", "request timeout in milliseconds", "30000");

interface CommonOptions {
  url?: string;
  token?: string;
  device?: string;
  json?: boolean;
  timeout?: string;
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--url <url>", "host URL (env IOS_SIM_URL)")
    .option("--token <token>", "access token (env IOS_SIM_TOKEN)")
    .option("--device <selector>", "device UDID, name, or booted (env IOS_SIM_DEVICE)")
    .option("--json", "machine-readable output")
    .option("--timeout <ms>", "request timeout in milliseconds");
}

function context(command: Command) {
  const local = command.opts<CommonOptions>();
  const global = program.opts<CommonOptions>();
  const connection = resolveConnection({
    url: local.url ?? global.url,
    token: local.token ?? global.token,
  });
  const timeout = Number.parseInt(local.timeout ?? global.timeout ?? "30000", 10);
  return {
    ...connection,
    device: local.device ?? global.device ?? connection.device,
    json: Boolean(local.json ?? global.json),
    timeout: Number.isFinite(timeout) ? timeout : 30_000,
  };
}

function clientFor(command: Command) {
  const options = context(command);
  return {
    client: createClient({
      baseUrl: options.url,
      token: options.token,
      timeoutMs: options.timeout,
    }),
    options,
  };
}

function print(command: Command, value: unknown, human: () => void) {
  if (context(command).json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    human();
  }
}

async function deviceFor(
  client: ReturnType<typeof createClient>,
  selector: string,
): Promise<Device> {
  return client.resolveDevice(selector);
}

function handle(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    if (error instanceof IosSimApiError && error.code === "unauthorized") {
      process.stderr.write(
        "error: unauthorized. Pass --token or run `ios-sim connect <url> --token <token>`.\n",
      );
    } else {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}

function stateMarker(device: Device): string {
  return `${device.name} (${device.state})`;
}

program
  .command("doctor")
  .description("check connectivity, capabilities, and available simulators")
  .action((_options, command: Command) =>
    handle(async () => {
      const { client, options } = clientFor(command);
      const [health, devices] = await Promise.all([client.health(), client.listDevices()]);
      print(command, { health, devices }, () => {
        process.stdout.write(
          `${[
            `host:      ${options.url}`,
            `backend:   ${health.backend} on ${health.platform} (${health.hostname})`,
            `version:   ${health.version}`,
            `input:     ${health.capabilities.input ? "ready" : "unavailable (install idb on the host)"}`,
            `devices:   ${devices.length} (${devices.filter((device) => device.state === "Booted").length} booted)`,
            ...(devices.length
              ? [
                  "",
                  printTable(
                    devices.map((device) => ({
                      name: device.name,
                      runtime: device.runtime,
                      state: device.state,
                      udid: device.udid,
                    })),
                    [
                      { key: "name", label: "NAME" },
                      { key: "runtime", label: "RUNTIME" },
                      { key: "state", label: "STATE" },
                      { key: "udid", label: "UDID" },
                    ],
                  ),
                ]
              : ["", "No simulators found. Create one in Xcode on the host."]),
          ].join("\n")}\n`,
        );
      });
    }),
  );

addCommonOptions(
  program
    .command("connect")
    .argument("<url>", "host URL, for example http://mac-mini.local:7777")
    .description("verify a host and save it as the default"),
).action((url: string, _options, command: Command) =>
  handle(async () => {
    const { options } = clientFor(command);
    const target = createClient({ baseUrl: url, token: options.token, timeoutMs: options.timeout });
    const health = await target.health();
    const path = saveClientConfig({ url, token: options.token });
    print(command, { url, tokenSaved: Boolean(options.token), health, path }, () => {
      process.stdout.write(
        `Connected to ${url} (${health.backend}, ${health.capabilities.input ? "input ready" : "view only"}).\nSaved ${path}\n`,
      );
    });
  }),
);

addCommonOptions(program.command("devices").alias("ls").description("list simulators")).action(
  (_options, command: Command) =>
    handle(async () => {
      const { client } = clientFor(command);
      const devices = await client.listDevices();
      print(command, { devices }, () => {
        if (devices.length === 0) {
          process.stdout.write("No simulators.\n");
          return;
        }
        process.stdout.write(
          `${printTable(
            devices.map((device) => ({
              name: device.name,
              runtime: device.runtime,
              state: device.state,
              udid: device.udid,
            })),
            [
              { key: "name", label: "NAME" },
              { key: "runtime", label: "RUNTIME" },
              { key: "state", label: "STATE" },
              { key: "udid", label: "UDID" },
            ],
          )}\n`,
        );
      });
    }),
);

addCommonOptions(
  program
    .command("boot")
    .argument("[selector]", "UDID, name, or booted")
    .description("boot a simulator and wait until it is ready"),
).action((selector: string | undefined, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const target = selector ?? options.device;
    let device: Device;
    if (target === "booted") {
      const devices = await client.listDevices();
      device =
        devices.find((candidate) => candidate.state === "Booted") ??
        devices.find((candidate) => candidate.state === "Shutdown") ??
        (() => {
          throw new Error("No simulator is available to boot.");
        })();
    } else {
      device = await deviceFor(client, target);
    }
    const booted = await client.bootDevice(device.udid);
    print(command, booted, () => process.stdout.write(`Booted ${stateMarker(booted)}.\n`));
  }),
);

for (const name of ["shutdown", "erase", "delete"] as const) {
  addCommonOptions(
    program
      .command(name)
      .argument("[selector]", "UDID, name, or booted")
      .description(
        name === "shutdown"
          ? "shut a simulator down"
          : name === "erase"
            ? "erase all content and settings"
            : "delete a simulator",
      ),
  ).action((selector: string | undefined, _options, command: Command) =>
    handle(async () => {
      const { client, options } = clientFor(command);
      const target = selector ?? options.device;
      if (name === "delete" && !selector && target === "booted") {
        throw new Error("Pass a device selector to delete; refusing to delete the booted device.");
      }
      const device = await deviceFor(client, target);
      if (name === "shutdown") await client.shutdownDevice(device.udid);
      if (name === "erase") await client.eraseDevice(device.udid);
      if (name === "delete") await client.deleteDevice(device.udid);
      print(command, { ok: true, udid: device.udid }, () =>
        process.stdout.write(
          `${name === "shutdown" ? "Shut down" : name === "erase" ? "Erased" : "Deleted"} ${device.name}.\n`,
        ),
      );
    }),
  );
}

addCommonOptions(
  program
    .command("create")
    .argument("<name>")
    .option(
      "--runtime <identifier>",
      "runtime identifier, for example com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    )
    .option("--device-type <identifier>", "device type identifier")
    .description("create a new simulator on the host"),
).action((name: string, _options, command: Command) =>
  handle(async () => {
    const { client } = clientFor(command);
    const local = command.opts<{ runtime?: string; deviceType?: string }>();
    const device = await client.createDevice({
      name,
      runtimeIdentifier: local.runtime,
      deviceTypeIdentifier: local.deviceType,
    });
    print(command, device, () =>
      process.stdout.write(`Created ${device.name} (${device.udid}).\n`),
    );
  }),
);

addCommonOptions(
  program.command("apps").argument("[selector]").description("list installed applications"),
).action((selector: string | undefined, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, selector ?? options.device);
    const apps = await client.listApps(device.udid);
    print(command, { apps }, () => {
      process.stdout.write(
        apps.length
          ? `${printTable(
              apps.map((app) => ({
                name: app.name,
                id: app.bundleIdentifier,
                version: app.version ?? "",
              })),
              [
                { key: "name", label: "NAME" },
                { key: "id", label: "BUNDLE ID" },
                { key: "version", label: "VERSION" },
              ],
            )}\n`
          : "No user applications installed.\n",
      );
    });
  }),
);

addCommonOptions(
  program
    .command("install")
    .argument("<app>", "path to a simulator .app directory")
    .description("upload and install a .app bundle"),
).action((appPath: string, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const info = await stat(appPath).catch(() => undefined);
    if (!info?.isDirectory() || !appPath.endsWith(".app")) {
      throw new Error("install expects a .app directory (the simulator build, not an .ipa).");
    }
    const archive = await tarDirectory(appPath);
    const result = await client.installApp(device.udid, archive);
    print(command, result, () =>
      process.stdout.write(
        `Installed ${basename(appPath)} (${formatBytes(archive.byteLength)}) on ${device.name}.\n`,
      ),
    );
  }),
);

addCommonOptions(
  program
    .command("launch")
    .argument("<bundleId>")
    .option("--arg <value>", "launch argument (repeatable)", collect, [])
    .option("--env <KEY=VALUE>", "environment variable (repeatable)", collect, [])
    .description("launch an installed application"),
).action((bundleId: string, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const local = command.opts<{ arg: string[]; env: string[] }>();
    const environment: Record<string, string> = {};
    for (const entry of local.env) {
      const [key, ...rest] = entry.split("=");
      if (!key || rest.length === 0) throw new Error(`Invalid --env "${entry}". Use KEY=VALUE.`);
      environment[key] = rest.join("=");
    }
    const result = await client.launchApp(device.udid, {
      bundleId,
      args: local.arg,
      environment,
    });
    print(command, result, () =>
      process.stdout.write(`Launched ${bundleId} with pid ${result.pid}.\n`),
    );
  }),
);

addCommonOptions(
  program
    .command("terminate")
    .argument("<bundleId>")
    .description("terminate a running application"),
).action((bundleId: string, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    await client.terminateApp(device.udid, bundleId);
    print(command, { ok: true }, () => process.stdout.write(`Terminated ${bundleId}.\n`));
  }),
);

addCommonOptions(
  program
    .command("screenshot")
    .argument("[file]", "output path, or - for stdout")
    .option("--format <format>", "jpeg or png", "jpeg")
    .description("capture one frame"),
).action((file: string | undefined, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const local = command.opts<{ format: "jpeg" | "png" }>();
    if (local.format !== "jpeg" && local.format !== "png")
      throw new Error("--format must be jpeg or png.");
    const image = await client.screenshot(device.udid, local.format);
    const output = file ?? `simulator-${Date.now()}.${local.format === "jpeg" ? "jpg" : "png"}`;
    if (output === "-") {
      process.stdout.write(Buffer.from(image));
      return;
    }
    await writeFile(output, image);
    print(command, { file: output, bytes: image.byteLength }, () =>
      process.stdout.write(`Wrote ${output} (${formatBytes(image.byteLength)}).\n`),
    );
  }),
);

addCommonOptions(
  program
    .command("tap")
    .argument("<x>", "x coordinate")
    .argument("<y>", "y coordinate")
    .option("--unit <unit>", "point, pixel, or normalized", "point")
    .description("tap the screen"),
).action((x: string, y: string, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const local = command.opts<{ unit: CoordinateUnit }>();
    const display = await client.display(device.udid);
    const point = toNormalizedPoint(Number(x), Number(y), local.unit, display);
    await client.input(device.udid, { type: "tap", ...point });
    print(command, { ok: true, ...point }, () =>
      process.stdout.write(`Tapped ${x},${y} (${local.unit}).\n`),
    );
  }),
);

addCommonOptions(
  program
    .command("swipe")
    .argument("<x1>")
    .argument("<y1>")
    .argument("<x2>")
    .argument("<y2>")
    .option("--unit <unit>", "point, pixel, or normalized", "point")
    .option("--duration <ms>", "swipe duration in milliseconds", "300")
    .description("swipe between two points"),
).action((x1: string, y1: string, x2: string, y2: string, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const local = command.opts<{ unit: CoordinateUnit; duration: string }>();
    const display = await client.display(device.udid);
    await client.input(device.udid, {
      type: "swipe",
      from: toNormalizedPoint(Number(x1), Number(y1), local.unit, display),
      to: toNormalizedPoint(Number(x2), Number(y2), local.unit, display),
      durationMs: Number.parseInt(local.duration, 10) || 300,
    });
    print(command, { ok: true }, () => process.stdout.write("Swiped.\n"));
  }),
);

addCommonOptions(program.command("text").argument("<text>").description("type text")).action(
  (text: string, _options, command: Command) =>
    handle(async () => {
      const { client, options } = clientFor(command);
      const device = await deviceFor(client, options.device);
      await client.input(device.udid, { type: "text", text });
      print(command, { ok: true }, () => process.stdout.write("Typed text.\n"));
    }),
);

addCommonOptions(
  program.command("key").argument("<key>").description("press a keycode (idb key name)"),
).action((key: string, _options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    await client.input(device.udid, { type: "key", key });
    print(command, { ok: true }, () => process.stdout.write(`Pressed ${key}.\n`));
  }),
);

addCommonOptions(
  program
    .command("button")
    .argument("<button>", "home, lock, side, or siri")
    .description("press a hardware button"),
).action((button: string, _options, command: Command) =>
  handle(async () => {
    if (!["home", "lock", "side", "siri"].includes(button)) {
      throw new Error("button must be one of: home, lock, side, siri.");
    }
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    await client.input(device.udid, {
      type: "button",
      button: button as "home" | "lock" | "side" | "siri",
    });
    print(command, { ok: true }, () => process.stdout.write(`Pressed ${button}.\n`));
  }),
);

addCommonOptions(
  program
    .command("stream")
    .option("--out <directory>", "directory for saved JPEG frames", "ios-sim-frames")
    .option("--fps <fps>", "frames per second", String(DEFAULT_FPS))
    .option("--duration <seconds>", "stop after N seconds", "0")
    .description("stream frames to disk (Ctrl+C to stop)"),
).action((_options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const local = command.opts<{ out: string; fps: string; duration: string }>();
    const fps = Math.max(1, Math.min(10, Number.parseInt(local.fps, 10) || DEFAULT_FPS));
    const duration = Number.parseFloat(local.duration) || 0;
    await mkdir(local.out, { recursive: true });
    const socket = new WebSocket(client.streamUrl(device.udid, { fps, format: "jpeg" }));
    let frames = 0;
    let streamError: string | undefined;
    const writes: Array<Promise<void>> = [];
    const done = new Promise<void>((resolve, reject) => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary) {
          const text = data.toString();
          try {
            const message = JSON.parse(text) as { type?: string; message?: string };
            if (message.type === "error") {
              streamError = message.message ?? "unknown stream error";
              process.stderr.write(`stream error: ${streamError}\n`);
            }
          } catch {
            // ignore non-JSON control frames
          }
          return;
        }
        frames += 1;
        const file = join(local.out, `frame-${String(frames).padStart(5, "0")}.jpg`);
        writes.push(writeFile(file, data as Buffer));
      });
      socket.on("error", (error) => reject(error));
      socket.on("close", () => resolve());
    });
    const timer = duration > 0 ? setTimeout(() => socket.close(), duration * 1000) : undefined;
    const interrupt = () => socket.close();
    process.once("SIGINT", interrupt);
    try {
      await done;
      await Promise.all(writes);
    } finally {
      if (timer) clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
    }
    if (streamError) throw new Error(streamError);
    print(command, { frames, directory: local.out }, () =>
      process.stdout.write(`Saved ${frames} frames to ${local.out}.\n`),
    );
  }),
);

addCommonOptions(
  program.command("open").description("open the browser-based simulator viewer"),
).action((_options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device).catch(() => undefined);
    const url = client.webUrl(device?.udid);
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => process.stdout.write(`${url}\n`));
    child.unref();
    print(command, { url }, () => process.stdout.write(`Opened ${url}\n`));
  }),
);

addCommonOptions(
  program
    .command("logs")
    .option("--level <level>", "debug, info, notice, error, fault", "info")
    .option("--predicate <predicate>", "NSPredicate filter")
    .description("follow device logs (Ctrl+C to stop)"),
).action((_options, command: Command) =>
  handle(async () => {
    const { client, options } = clientFor(command);
    const device = await deviceFor(client, options.device);
    const local = command.opts<{ level: string; predicate?: string }>();
    const controller = new AbortController();
    try {
      const response = await fetch(client.logsUrl(device.udid, local), {
        headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`log stream failed: ${response.status}`);
      process.once("SIGINT", () => controller.abort());
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) process.stdout.write(`${formatLogLine(data)}\n`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  }),
);

program.configureOutput({
  outputError: (message, write) => write(`error: ${message}`),
});

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function tarDirectory(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = createTar({ gzip: true, cwd: dirname(path), portable: false }, [basename(path)]);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function formatLogLine(data: string): string {
  try {
    const entry = JSON.parse(data) as {
      timestamp?: string;
      eventMessage?: string;
      processImagePath?: string;
    };
    const time = entry.timestamp ? `${entry.timestamp} ` : "";
    const process = entry.processImagePath ? `[${basename(entry.processImagePath)}] ` : "";
    return `${time}${process}${entry.eventMessage ?? data}`;
  } catch {
    return data;
  }
}
