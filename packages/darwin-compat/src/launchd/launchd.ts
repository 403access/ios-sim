/**
 * launchd-style job model.
 *
 * This is a user-space scheduler, not `launchd_sim`. It implements the parts
 * the research track can exercise deterministically: plist parsing, label
 * uniqueness, MachServices registration, RunAtLoad, KeepAlive with a bounded
 * restart budget, and captured stdout/stderr. Sockets, XPC event streams,
 * on-demand launch, watchdog, sessions, and jetsam are out of scope.
 */

import { isAbsolute, resolve } from "node:path";
import { LaunchdError, PlistError } from "../errors.js";
import type { PlistValue } from "../plist/parse.js";
import { parsePlist } from "../plist/parse.js";
import type { MachTask } from "../mach/kernel.js";
import { BootstrapServer } from "../mach/bootstrap.js";
import type { DarwinRuntime, ProcessOptions, ProcessResult } from "../runtime/process.js";
import { CaptureSink } from "../syscall/kernel.js";

export interface LaunchdJob {
  readonly label: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly runAtLoad: boolean;
  readonly keepAlive: boolean;
  readonly machServices: readonly string[];
  readonly throttleInterval: number;
  readonly workingDirectory: string | null;
  readonly standardOutPath: string | null;
  readonly standardErrorPath: string | null;
  readonly sourcePath: string | null;
}

export type JobState = "pending" | "running" | "succeeded" | "failed" | "stopped";

export interface JobStatus {
  readonly label: string;
  state: JobState;
  runs: number;
  exitStatus: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  error: string | null;
}

export interface LaunchdBootResult {
  readonly services: readonly string[];
  readonly jobs: readonly JobStatus[];
}

export interface LaunchdOptions {
  readonly maxRestarts?: number;
  readonly failFast?: boolean;
}

export function parseLaunchdManifest(
  source: string | Uint8Array | PlistValue,
  options: { baseDir?: string; sourcePath?: string } = {},
): LaunchdJob[] {
  const value =
    typeof source === "string" || source instanceof Uint8Array ? parsePlist(source) : source;
  if (!isDictionary(value))
    throw new PlistError("launchd_root", "launchd manifest root must be a dictionary");
  const label = requiredString(value, "Label");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(label) || label.includes("..")) {
    throw new PlistError("launchd_label", `launchd label ${label} is invalid`);
  }

  const programValue = optionalString(value, "Program");
  const argumentValue = value.ProgramArguments;
  let args: string[] = [];
  if (argumentValue !== undefined) {
    if (!Array.isArray(argumentValue) || !argumentValue.every((item) => typeof item === "string")) {
      throw new PlistError("launchd_arguments", "ProgramArguments must be an array of strings");
    }
    args = argumentValue as string[];
  }
  const program = programValue ?? args[0];
  if (!program)
    throw new PlistError(
      "launchd_program",
      `job ${label} has neither Program nor ProgramArguments`,
    );
  const baseDir = options.baseDir ?? process.cwd();
  const resolvedProgram = isAbsolute(program) ? program : resolve(baseDir, program);
  const argv = args.length > 0 ? [...args] : [resolvedProgram];
  if (argv.length > 0 && argv[0] === program) argv[0] = resolvedProgram;

  const environmentValue = value.EnvironmentVariables;
  const environment: Record<string, string> = {};
  if (environmentValue !== undefined) {
    if (!isDictionary(environmentValue))
      throw new PlistError("launchd_environment", "EnvironmentVariables must be a dictionary");
    for (const [key, item] of Object.entries(environmentValue)) {
      if (typeof item !== "string")
        throw new PlistError("launchd_environment", `environment value ${key} must be a string`);
      environment[key] = item;
    }
  }

  const machServices: string[] = [];
  const servicesValue = value.MachServices;
  if (servicesValue !== undefined) {
    if (!isDictionary(servicesValue))
      throw new PlistError("launchd_services", "MachServices must be a dictionary");
    for (const key of Object.keys(servicesValue)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(key) || key.includes("..")) {
        throw new PlistError("launchd_services", `Mach service name ${key} is invalid`);
      }
      machServices.push(key);
    }
  }

  const runAtLoad = optionalBoolean(value, "RunAtLoad") ?? false;
  const keepAlive = optionalBoolean(value, "KeepAlive") ?? false;
  const throttleInterval = optionalNumber(value, "ThrottleInterval") ?? 10;
  if (throttleInterval < 0)
    throw new PlistError("launchd_throttle", "ThrottleInterval must be non-negative");

  return [
    {
      label,
      program: resolvedProgram,
      args: argv.slice(1),
      environment,
      runAtLoad,
      keepAlive,
      machServices,
      throttleInterval,
      workingDirectory: optionalString(value, "WorkingDirectory") ?? null,
      standardOutPath: optionalString(value, "StandardOutPath") ?? null,
      standardErrorPath: optionalString(value, "StandardErrorPath") ?? null,
      sourcePath: options.sourcePath ?? null,
    },
  ];
}

export class Launchd {
  private readonly runtime: DarwinRuntime;
  private readonly maxRestarts: number;
  private readonly failFast: boolean;
  private readonly jobs = new Map<string, LaunchdJob>();
  private readonly statuses = new Map<string, JobStatus>();
  private readonly servicePorts = new Map<
    string,
    { task: MachTask; portId: number; portName: number }
  >();
  private hostTask: MachTask | null = null;

  constructor(runtime: DarwinRuntime, options: LaunchdOptions = {}) {
    this.runtime = runtime;
    this.maxRestarts = options.maxRestarts ?? 2;
    this.failFast = options.failFast ?? false;
  }

  addJobs(jobs: readonly LaunchdJob[]): void {
    for (const job of jobs) {
      if (this.jobs.has(job.label))
        throw new LaunchdError("duplicate_label", `job ${job.label} is already registered`);
      this.jobs.set(job.label, job);
      this.statuses.set(job.label, {
        label: job.label,
        state: "pending",
        runs: 0,
        exitStatus: null,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        error: null,
      });
    }
  }

  listJobs(): readonly LaunchdJob[] {
    return [...this.jobs.values()];
  }

  listServices(): readonly string[] {
    return [...this.servicePorts.keys()].sort();
  }

  boot(): LaunchdBootResult {
    this.ensureHostTask();
    new BootstrapServer(this.runtime.mach).listen();
    for (const job of this.jobs.values()) {
      for (const service of job.machServices) {
        this.registerService(service);
      }
    }
    const results: JobStatus[] = [];
    for (const job of this.jobs.values()) {
      if (!job.runAtLoad) {
        results.push(this.statuses.get(job.label)!);
        continue;
      }
      const status = this.runJob(job);
      results.push(status);
      if (status.state === "failed" && this.failFast) break;
    }
    return { services: this.listServices(), jobs: results };
  }

  start(label: string): JobStatus {
    const job = this.jobs.get(label);
    if (!job) throw new LaunchdError("unknown_job", `no job labelled ${label}`);
    return this.runJob(job);
  }

  stop(label: string): JobStatus {
    const status = this.statuses.get(label);
    if (!status) throw new LaunchdError("unknown_job", `no job labelled ${label}`);
    if (status.state === "running")
      throw new LaunchdError("job_running", `job ${label} is still running`);
    status.state = "stopped";
    return status;
  }

  status(label: string): JobStatus | undefined {
    return this.statuses.get(label);
  }

  statusesView(): readonly JobStatus[] {
    return [...this.statuses.values()];
  }

  /** Port name a job can use, e.g. for a future `bootstrap_lookup` shim. */
  servicePort(service: string): { task: MachTask; portName: number } | null {
    const entry = this.servicePorts.get(service);
    return entry ? { task: entry.task, portName: entry.portName } : null;
  }

  private ensureHostTask(): MachTask {
    if (!this.hostTask) {
      this.hostTask = this.runtime.mach.createTask(1);
    }
    return this.hostTask;
  }

  private registerService(service: string): void {
    if (this.servicePorts.has(service)) return;
    const task = this.ensureHostTask();
    const { name, portId } = this.runtime.mach.insertReceiveRight(task, `launchd:${service}`);
    try {
      this.runtime.mach.registerService(service, portId);
    } catch (error) {
      throw new LaunchdError(
        "service_registration",
        `cannot register ${service}: ${String(error)}`,
      );
    }
    this.servicePorts.set(service, { task, portId, portName: name });
  }

  private runJob(job: LaunchdJob): JobStatus {
    const status = this.statuses.get(job.label);
    if (!status) throw new LaunchdError("unknown_job", `no status for ${job.label}`);
    status.state = "running";
    status.error = null;
    let attempt = 0;
    do {
      attempt += 1;
      status.runs += 1;
      const out = new CaptureSink();
      const err = new CaptureSink();
      const options: ProcessOptions = {
        argv: [job.program, ...job.args],
        env: job.environment,
        stdout: out,
        stderr: err,
      };
      try {
        const result: ProcessResult = this.runtime.run(job.program, options);
        status.exitStatus = result.exitStatus;
        const previousOut = status.stdout;
        const previousErr = status.stderr;
        status.stdout = concat(previousOut, out.bytes());
        status.stderr = concat(previousErr, err.bytes());
        if (result.exitStatus !== 0) {
          status.state = "failed";
          status.error = `exited with status ${result.exitStatus}`;
        } else {
          status.state = "succeeded";
        }
      } catch (error) {
        status.state = "failed";
        status.error = error instanceof Error ? error.message : String(error);
        status.stdout = concat(status.stdout, out.bytes());
        status.stderr = concat(status.stderr, err.bytes());
        break;
      }
    } while (job.keepAlive && status.state === "failed" && attempt <= this.maxRestarts);
    return status;
  }
}

function isDictionary(value: PlistValue): value is { [key: string]: PlistValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function requiredString(dict: { [key: string]: PlistValue }, key: string): string {
  const value = dict[key];
  if (typeof value !== "string") throw new PlistError("launchd_field", `${key} must be a string`);
  return value;
}

function optionalString(dict: { [key: string]: PlistValue }, key: string): string | undefined {
  const value = dict[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PlistError("launchd_field", `${key} must be a string`);
  return value;
}

function optionalBoolean(dict: { [key: string]: PlistValue }, key: string): boolean | undefined {
  const value = dict[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new PlistError("launchd_field", `${key} must be a boolean`);
  return value;
}

function optionalNumber(dict: { [key: string]: PlistValue }, key: string): number | undefined {
  const value = dict[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PlistError("launchd_field", `${key} must be a number`);
  return value;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (b.length === 0) return a;
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
