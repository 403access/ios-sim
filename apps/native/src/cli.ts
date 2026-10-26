/**
 * `ios-sim-native` — experimental CLI for the Option A research track.
 *
 * It runs a Mach-O in the compatibility layer, inspects images, boots a
 * launchd-style plist, or prints a capability report. It never talks to Apple
 * tooling and never claims to boot the iOS Simulator.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import {
  CaptureSink,
  DarwinRuntime,
  EventRecorder,
  ImageLoader,
  Launchd,
  LoaderError,
  MapFileProvider,
  bootReport,
  buildDemoProgram,
  capabilityReport,
  chromeTraceJSON,
  disassembleRange,
  describeLoaderError,
  formatDisassembly,
  formatFault,
  formatInspectReport,
  formatLoaderDiagnostic,
  inspectMachO,
  parseLaunchdManifest,
  parseMachO,
  type InspectReport,
  type ProcessResult,
} from "@ios-sim/darwin-compat";
import { runNativeWindow } from "./window.js";

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
    .option("--json", "print JSON")
    .option("--disasm", "disassemble __TEXT,__text")
    .option("--disasm-limit <count>", "maximum instructions to decode", parseInteger, 200)
    .action((file: string, options: { json?: boolean; disasm?: boolean; disasmLimit?: number }) => {
      const bytes = readFileSync(file);
      const report = inspectMachO(bytes, file);
      if (options.disasm) {
        const { image } = parseMachO(bytes);
        const section = image.sections.find((entry) => entry.name === "__text");
        if (!section) {
          io.stderr("inspect: image has no __TEXT,__text section\n");
          requestedExit = 1;
          return;
        }
        const instructions = disassembleRange(
          bytes.subarray(section.fileOffset, section.fileOffset + section.size),
          BigInt(section.address),
          options.disasmLimit,
        );
        if (options.json) {
          io.stdout(`${JSON.stringify({ ...report, disassembly: instructions }, null, 2)}\n`);
        } else {
          io.stdout(
            `${formatInspectReport(report)}\n\ndisassembly:\n${formatDisassembly(instructions)}\n`,
          );
        }
        return;
      }
      if (options.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      else io.stdout(`${formatInspectReport(report)}\n`);
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
      if (options.json) {
        io.stdout(`${JSON.stringify(runJson(result), null, 2)}\n`);
      } else {
        io.stdout(new TextDecoder().decode(result.stdout));
        io.stderr(new TextDecoder().decode(result.stderr));
      }
      requestedExit = result.exitStatus;
    });

  program
    .command("trace")
    .description("run a Mach-O and emit runtime events (NDJSON by default)")
    .argument("<file>", "Mach-O executable")
    .option("--chrome", "emit Chrome Trace Event JSON")
    .option("--out <path>", "write the trace to a file instead of stdout")
    .action((file: string, options: { chrome?: boolean; out?: string }) => {
      const absolute = resolve(file);
      const recorder = new EventRecorder();
      const runtime = new DarwinRuntime({ rootDir: dirname(absolute) });
      const result = runtime.run(absolute, {
        argv: [absolute],
        events: recorder,
        stdout: new CaptureSink(),
        stderr: new CaptureSink(),
      });
      const text = options.chrome
        ? `${chromeTraceJSON(recorder.list())}\n`
        : `${recorder.toNDJSON()}\n`;
      if (options.out) writeFileSync(resolve(options.out), text);
      else io.stdout(text);
      if (result.exitStatus !== 0) requestedExit = result.exitStatus;
    });

  program
    .command("why")
    .description("explain why a Mach-O does or does not load")
    .argument("<file>", "Mach-O executable")
    .option("--json", "print JSON")
    .action((file: string, options: { json?: boolean }) => {
      const loader = new ImageLoader({ missingSymbols: "zero" });
      const report = loader.diagnose(file);
      const boot = report.program ? bootReport(report.program) : null;
      if (options.json) {
        io.stdout(`${JSON.stringify({ diagnostic: report.diagnostic, boot }, null, 2)}\n`);
      } else if (!report.ok) {
        io.stderr(`${formatLoaderDiagnostic(report.diagnostic!)}\n`);
      } else {
        io.stdout(`loads: ${report.program?.images.length ?? 0} image(s)\n`);
        if (boot?.missingSymbols.length) {
          io.stdout(`unresolved symbols: ${boot.missingSymbols.length}\n`);
        } else {
          io.stdout("no unresolved symbols or missing services recorded\n");
        }
      }
      if (!report.ok) requestedExit = 1;
    });

  program
    .command("boot")
    .description("report unresolved symbols and missing bootstrap services")
    .argument("<file>", "Mach-O executable")
    .option("--service <name...>", "bootstrap service the program requires")
    .option("--json", "print JSON")
    .action((file: string, options: { service?: string[]; json?: boolean }) => {
      const loader = new ImageLoader({ missingSymbols: "zero" });
      const program = loader.load(resolve(file));
      const report = bootReport(program, { services: options.service ?? [] });
      if (options.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      else {
        io.stdout(`boot report: ${report.ok ? "ok" : "blocked"}\n`);
        io.stdout(`images: ${report.images.join(", ")}\n`);
        for (const missing of report.missingSymbols) {
          io.stdout(`  symbol: ${missing.symbol} (${missing.image}, ordinal ${missing.ordinal})\n`);
          io.stdout(`    next: ${missing.suggestion}\n`);
        }
        for (const missing of report.missingServices) {
          io.stdout(`  service: ${missing.service}\n`);
          io.stdout(`    next: ${missing.suggestion}\n`);
        }
        for (const warning of report.warnings) io.stdout(`  warning: ${warning}\n`);
      }
      if (!report.ok) requestedExit = 1;
    });

  program
    .command("stats")
    .description("run a Mach-O and print runtime counters")
    .argument("<file>", "Mach-O executable")
    .option("--json", "print JSON")
    .action((file: string, options: { json?: boolean }) => {
      const absolute = resolve(file);
      const runtime = new DarwinRuntime({ rootDir: dirname(absolute) });
      const out = new CaptureSink();
      const err = new CaptureSink();
      const result = runtime.run(absolute, { argv: [absolute], stdout: out, stderr: err });
      const stats = {
        ...runtime.stats.snapshot(),
        pid: result.pid,
        exitStatus: result.exitStatus,
        elapsedMs: result.elapsedMs,
      };
      if (options.json) io.stdout(`${JSON.stringify(stats, null, 2)}\n`);
      else {
        io.stdout(`pid ${stats.pid}, exit ${stats.exitStatus}, ${stats.elapsedMs} ms\n`);
        for (const [name, value] of Object.entries(stats)) {
          if (name === "pid" || name === "exitStatus" || name === "elapsedMs") continue;
          io.stdout(`  ${name}: ${value}\n`);
        }
      }
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
    .command("window")
    .description("open the clean-room UIKit-compatible native X11 window (no web view)")
    .option("--width <px>", "window width", parseDimension, 402)
    .option("--height <px>", "window height", parseDimension, 874)
    .option("--color <hex>", "background color as RRGGBB", "1e1e2e")
    .option("--title <text>", "window title", "UIKitLite Blank Window")
    .option("--no-build", "do not build the native helper if it is missing")
    .action(
      async (options: {
        width: number;
        height: number;
        color: string;
        title: string;
        build: boolean;
      }) => {
        requestedExit = await runNativeWindow({
          width: options.width,
          height: options.height,
          color: options.color,
          title: options.title,
          build: options.build,
        });
      },
    );

  program
    .command("doctor")
    .description("report compatibility-layer capabilities and known gaps")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const report = capabilityReport();
      if (options.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      else {
        io.stdout(
          `ios-sim-native ${report.version} on ${report.platform}/${report.architecture}\n`,
        );
        io.stdout(
          `ships an iOS Simulator: ${report.simulator ? "yes" : "no (research layer only)"}\n`,
        );
        io.stdout("features:\n");
        for (const item of report.features) {
          io.stdout(`  ${item.id} [${item.state}]: ${item.detail}\n`);
        }
        io.stdout("blocked:\n");
        for (const item of report.blocked) {
          io.stdout(`  ${item.id}: ${item.detail}\n`);
        }
        io.stdout("notes:\n");
        for (const note of report.notes) io.stdout(`  - ${note}\n`);
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
    if (error instanceof LoaderError) {
      const details = (error.details ?? {}) as Record<string, unknown>;
      const path =
        typeof details.path === "string"
          ? details.path
          : typeof details.from === "string"
            ? details.from
            : "<unknown>";
      io.stderr(`${formatLoaderDiagnostic(describeLoaderError(error, path))}\n`);
      return 1;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "error";
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${code}: ${message}\n`);
    const details =
      typeof error === "object" && error !== null && "details" in error
        ? ((error as { details?: { fault?: unknown } }).details ?? {})
        : {};
    if (details.fault)
      io.stderr(`${formatFault(details.fault as Parameters<typeof formatFault>[0])}\n`);
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
  trace?: boolean;
  traceSyscalls?: boolean;
  json?: boolean;
}

function parseDimension(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16384) {
    throw new Error(`expected a dimension in 1..16384, got ${value}`);
  }
  return parsed;
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
  };
}

export type { InspectReport };
