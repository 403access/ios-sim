/**
 * `ios-sim-native` — experimental CLI for the Option A research track.
 *
 * It runs a Mach-O in the compatibility layer, inspects images, boots a
 * launchd-style plist, or prints a capability report. It never talks to Apple
 * tooling and never claims to boot the iOS Simulator.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import {
  CaptureSink,
  DarwinRuntime,
  Launchd,
  MapFileProvider,
  buildDemoProgram,
  buildUIKitDemo,
  describeUIKitDemo,
  encodePng,
  encodePpm,
  formatInspectReport,
  formatObjcInspection,
  inspectMachO,
  inspectObjc,
  parseLaunchdManifest,
  type InputEvent,
  type InspectReport,
  type ProcessResult,
} from "@ios-sim/darwin-compat";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

let requestedExit = 0;

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  requestedExit = 0;
  const program = new Command();
  program
    .name("ios-sim-native")
    .description("Option A Darwin compatibility layer research tool")
    .version("0.1.0")
    .exitOverride();
  program.configureOutput({
    writeOut: (text) => io.stdout(text),
    writeErr: (text) => io.stderr(text),
  });

  program
    .command("inspect")
    .description("parse a Mach-O and print segments, dependencies, exports, and fixups")
    .argument("<file>", "Mach-O file")
    .option("--objc", "include Objective-C classes, categories, protocols, and ivars")
    .option("--json", "print JSON")
    .action((file: string, options: { objc?: boolean; json?: boolean }) => {
      const bytes = readFileSync(file);
      const report = inspectMachO(bytes, file);
      const objc = options.objc ? inspectObjc(bytes, file) : null;
      if (options.json) {
        io.stdout(`${JSON.stringify(objc ? { ...report, objc } : report, null, 2)}\n`);
      } else {
        io.stdout(`${formatInspectReport(report)}\n`);
        if (objc) io.stdout(`${formatObjcInspection(objc)}\n`);
      }
    });

  program
    .command("run")
    .description("load and execute an arm64 Mach-O inside the compatibility layer")
    .argument("<file>", "Mach-O executable")
    .option("--arg <value...>", "argument(s) passed to the process")
    .option("--env <pair...>", "environment entries as KEY=VALUE")
    .option("--stdin <text>", "bytes available on file descriptor 0")
    .option("--root <dir>", "jail root for file syscalls (defaults to the binary's directory)")
    .option("--max-instructions <count>", "instruction budget", parseInteger, 20_000_000)
    .option("--timeout <ms>", "wall-clock deadline", parseInteger, 15_000)
    .option("--no-strict-syscalls", "return ENOSYS instead of failing on unimplemented syscalls")
    .option("--trace", "trace instructions to stderr")
    .option("--trace-syscalls", "trace syscalls to stderr")
    .option("--no-objc", "disable the Objective-C framework shim")
    .option("--out <file>", "write the last captured frame (.png or .ppm)")
    .option("--out-dir <dir>", "write every captured frame as frame-<n>.png")
    .option("--tap <x,y>", "scripted tap event (repeatable)", collectTap, [])
    .option("--drag <x1,y1,x2,y2[,steps]>", "scripted drag (repeatable)", collectDrag, [])
    .option("--tick <count>", "send N ticks to the application delegate", parseInteger, 0)
    .option("--json", "print JSON result")
    .action((file: string, options: RunOptions) => {
      const absolute = resolve(file);
      const root = options.root ? resolve(options.root) : dirname(absolute);
      const environment = parseEnvironment(options.env ?? []);
      const stdout = new CaptureSink();
      const stderr = new CaptureSink();
      const runtime = new DarwinRuntime({
        rootDir: root,
        maxInstructions: options.maxInstructions,
        deadlineMs: options.timeout,
        strictSyscalls: options.strictSyscalls,
      });
      const result = runtime.run(absolute, {
        argv: [absolute, ...(options.arg ?? [])],
        env: environment,
        stdin: options.stdin ? new TextEncoder().encode(options.stdin) : undefined,
        stdout,
        stderr,
        objc: options.objc,
        traceInstructions: options.trace
          ? (pc, instruction, cpu) =>
              io.stderr(
                `pc=0x${pc.toString(16)} insn=0x${instruction.toString(16).padStart(8, "0")} x0=0x${cpu.readRegister(0).toString(16)}\n`,
              )
          : undefined,
        traceSyscalls: options.traceSyscalls
          ? (event) =>
              io.stderr(
                `pid=${event.pid} syscall=${event.name} args=[${event.args.map((arg) => `0x${arg.toString(16)}`).join(",")}] result=${event.result.value}\n`,
              )
          : undefined,
      });
      writeFrames(result.frames, options);
      if (options.json) {
        io.stdout(`${JSON.stringify(runJson(result), null, 2)}\n`);
      } else {
        io.stdout(new TextDecoder().decode(result.stdout));
        io.stderr(new TextDecoder().decode(result.stderr));
        if (result.frames.length > 0) io.stdout(`${frameSummary(result.frames.at(-1)!)}\n`);
      }
      requestedExit = result.exitStatus;
    });

  program
    .command("demo")
    .description("run the built-in generated hello-world Mach-O")
    .option("--json", "print JSON result")
    .action((options: { json?: boolean }) => {
      const built = buildDemoProgram();
      const runtime = new DarwinRuntime({
        provider: new MapFileProvider(new Map([["/demo", built.bytes]])),
        rootDir: process.cwd(),
      });
      const result = runtime.run("/demo");
      if (options.json) io.stdout(`${JSON.stringify(runJson(result), null, 2)}\n`);
      else {
        io.stdout(new TextDecoder().decode(result.stdout));
        io.stderr(new TextDecoder().decode(result.stderr));
      }
      requestedExit = result.exitStatus;
    });

  program
    .command("uikit-demo")
    .description("run the generated ObjC/UIKit proof-of-concept app and capture a frame")
    .option("--out <file>", "write the last frame (.png or .ppm)")
    .option("--out-dir <dir>", "write every frame as frame-<n>.png")
    .option("--tap <x,y>", "scripted tap event (repeatable)", collectTap, [])
    .option("--drag <x1,y1,x2,y2[,steps]>", "scripted drag (repeatable)", collectDrag, [])
    .option("--tick <count>", "send N ticks to the application delegate", parseInteger, 0)
    .option("--json", "print JSON")
    .action(
      (options: {
        out?: string;
        outDir?: string;
        tap: TapPoint[];
        drag: DragInput[];
        tick: number;
        json?: boolean;
      }) => {
        const demo = buildUIKitDemo();
        const runtime = new DarwinRuntime({
          provider: new MapFileProvider(new Map([["/UIKitDemo", demo.built.bytes]])),
          // The demo loads UIImage assets from the fixture directory.
          rootDir: join(import.meta.dirname, "../../../fixtures/objc-window"),
        });
        const result = runtime.run("/UIKitDemo", {
          events: inputEvents(options.tap, options.drag, options.tick),
        });
        const frame = result.frames.at(-1);
        if (!frame) {
          throw new Error("the demo app did not present a frame");
        }
        writeFrames(result.frames, options);
        if (options.json) {
          io.stdout(
            `${JSON.stringify({ ...runJson(result), image: describeUIKitDemo(demo) }, null, 2)}\n`,
          );
        } else {
          for (const [index, captured] of result.frames.entries()) {
            io.stdout(`${frameSummary(captured, index)}\n`);
          }
          io.stdout(`classes: ${result.objcClasses.join(", ")}\n`);
        }
        requestedExit = result.exitStatus;
      },
    );

  program
    .command("launchd")
    .description("boot launchd-style jobs from an XML plist")
    .argument("<plist>", "job plist")
    .option("--root <dir>", "jail root for jobs (defaults to the plist's directory)")
    .option("--max-restarts <count>", "KeepAlive restart budget", parseInteger, 2)
    .option("--json", "print JSON")
    .action((file: string, options: { root?: string; maxRestarts: number; json?: boolean }) => {
      const absolute = resolve(file);
      const root = options.root ? resolve(options.root) : dirname(absolute);
      const jobs = parseLaunchdManifest(readFileSync(absolute), {
        baseDir: root,
        sourcePath: absolute,
      });
      const runtime = new DarwinRuntime({ rootDir: root });
      const launchd = new Launchd(runtime, { maxRestarts: options.maxRestarts });
      launchd.addJobs(jobs);
      const result = launchd.boot();
      if (options.json) {
        io.stdout(
          `${JSON.stringify(
            {
              services: result.services,
              jobs: result.jobs.map((status) => ({
                label: status.label,
                state: status.state,
                runs: status.runs,
                exitStatus: status.exitStatus,
                stdout: new TextDecoder().decode(status.stdout),
                stderr: new TextDecoder().decode(status.stderr),
                error: status.error,
              })),
            },
            null,
            2,
          )}\n`,
        );
      } else {
        for (const status of result.jobs) {
          io.stdout(
            `${status.label}: ${status.state} (runs=${status.runs}, exit=${status.exitStatus ?? "none"})\n`,
          );
          if (status.stdout.length > 0) io.stdout(new TextDecoder().decode(status.stdout));
          if (status.stderr.length > 0) io.stderr(new TextDecoder().decode(status.stderr));
          if (status.error) io.stderr(`${status.label}: ${status.error}\n`);
        }
        if (result.services.length > 0) io.stdout(`services: ${result.services.join(", ")}\n`);
      }
      const failed = result.jobs.some((status) => status.state === "failed");
      requestedExit = failed ? 1 : 0;
    });

  program
    .command("doctor")
    .description("report compatibility-layer capabilities and known gaps")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const report = doctorReport();
      if (options.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      else {
        io.stdout(
          `ios-sim-native ${report.version} on ${report.platform}/${report.architecture}\n`,
        );
        io.stdout(
          `ships an iOS Simulator: ${report.simulator ? "yes" : "no (research layer only)"}\n`,
        );
        io.stdout("implemented:\n");
        for (const item of report.implemented) io.stdout(`  - ${item}\n`);
        io.stdout("not implemented:\n");
        for (const item of report.notImplemented) io.stdout(`  - ${item}\n`);
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      io.stderr(`${error.message}\n`);
      return error.exitCode === 0 ? 1 : error.exitCode;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "error";
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${code}: ${message}\n`);
    return 1;
  }
  return requestedExit & 0xff;
}

interface RunOptions {
  arg?: string[];
  env?: string[];
  stdin?: string;
  root?: string;
  maxInstructions: number;
  timeout: number;
  strictSyscalls: boolean;
  objc: boolean;
  out?: string;
  outDir?: string;
  tap: TapPoint[];
  trace?: boolean;
  traceSyscalls?: boolean;
  json?: boolean;
}

interface TapPoint {
  x: number;
  y: number;
}

interface DragInput {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  steps?: number;
}

function inputEvents(
  taps: readonly TapPoint[],
  drags: readonly DragInput[],
  ticks: number,
): InputEvent[] {
  return [...taps, ...drags, ...Array.from({ length: ticks }, () => ({ kind: "tick" as const }))];
}

function collectDrag(value: string, previous: DragInput[]): DragInput[] {
  const parts = value.split(",").map(Number);
  if (parts.length < 4 || parts.length > 5 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`expected --drag x1,y1,x2,y2[,steps], got ${value}`);
  }
  return [
    ...previous,
    {
      fromX: parts[0]!,
      fromY: parts[1]!,
      toX: parts[2]!,
      toY: parts[3]!,
      steps: parts[4],
    },
  ];
}

function collectTap(value: string, previous: TapPoint[]): TapPoint[] {
  const [rawX, rawY, ...rest] = value.split(",");
  const x = Number(rawX);
  const y = Number(rawY);
  if (rest.length > 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`expected --tap x,y, got ${value}`);
  }
  return [...previous, { x, y }];
}

function writeFrames(
  frames: readonly { width: number; height: number; pixels: Uint8Array }[],
  options: { out?: string; outDir?: string },
): void {
  if (frames.length === 0) return;
  if (options.out) writeFrame(frames.at(-1), options.out);
  if (options.outDir) {
    const directory = resolve(options.outDir);
    mkdirSync(directory, { recursive: true });
    frames.forEach((frame, index) => {
      writeFrame(frame, join(directory, `frame-${index}.png`));
    });
  }
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`expected a positive integer, got ${value}`);
  return parsed;
}

function parseEnvironment(entries: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index <= 0) throw new Error(`environment entry ${entry} is not KEY=VALUE`);
    environment[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return environment;
}

function runJson(result: ProcessResult) {
  return {
    pid: result.pid,
    exitStatus: result.exitStatus,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    instructions: result.instructions,
    elapsedMs: result.elapsedMs,
    images: result.program.images.map((image) => ({
      path: image.path,
      base: `0x${image.base.toString(16)}`,
    })),
    fixups: result.program.stats,
    unsupportedSyscalls: Object.fromEntries(result.unsupportedSyscalls),
    objcClasses: result.objcClasses,
    objcCategories: result.objcCategories,
    objcProtocols: result.objcProtocols,
    objcStats: result.objcStats,
    frames: result.frames.map((frame) => ({
      width: frame.width,
      height: frame.height,
      digest: frame.digest,
    })),
  };
}

function writeFrame(
  frame: { width: number; height: number; pixels: Uint8Array } | undefined,
  file: string,
): void {
  if (!frame) throw new Error("no frame was captured; nothing to write");
  const target = resolve(file);
  const bytes = target.toLowerCase().endsWith(".ppm")
    ? encodePpm(frame.width, frame.height, frame.pixels)
    : encodePng(frame.width, frame.height, frame.pixels);
  writeFileSync(target, bytes);
}

function frameSummary(
  frame: { width: number; height: number; digest: string },
  index?: number,
): string {
  const prefix = index === undefined ? "frame" : `frame ${index}`;
  return `${prefix} ${frame.width}x${frame.height} sha256=${frame.digest}`;
}

function doctorReport() {
  return {
    service: "ios-sim-native",
    version: "0.1.0",
    bun: (process.versions as { bun?: string }).bun ?? null,
    platform: process.platform,
    architecture: process.arch,
    simulator: false,
    implemented: [
      "Mach-O 64-bit parsing, fat slices, exports trie, chained and legacy fixups",
      "user-space dyld loading with dependency lookup, slides, and binds/rebases",
      "AArch64 integer and scalar floating-point interpreter with syscall traps",
      "Mach port rights, messages, reply ports, bootstrap service registry, MIG-lite",
      "XPC-style typed codec and request/reply over Mach",
      "Darwin syscall subset with a jailed file layer and anonymous mmap",
      "launchd-style plist jobs, MachServices, RunAtLoad, bounded KeepAlive",
      "Objective-C 2 metadata, dispatch, protocols, categories, refcounts, and a host UIKit shim",
      "deterministic PNG/PPM frames, scripted taps/drags/ticks, and touch callbacks",
      "generated arm64 fixture program executed end-to-end on Linux/macOS",
    ],
    notImplemented: [
      "dyld shared cache, lazy binding, initializers, dlopen, threaded binds",
      "code signing, entitlements, TCC/privacy database, keychain, device identity",
      "Apple UIKit/AppKit, Metal, IOSurface, CoreAnimation, accessibility",
      "CoreSimulator XPC services, launchd_sim, SpringBoard, jetsam, APFS disk images",
      "Apple framework replacements (Foundation is not provided)",
      "running any Apple binary or the iOS Simulator itself",
    ],
    notes: [
      "This is a research substrate, not a simulator.",
      "The CLI never loads Apple binaries; use your own arm64 Mach-O or the demo.",
    ],
  };
}

export type { InspectReport };
