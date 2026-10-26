/**
 * Guest process table (THR-006).
 *
 * This models fork/exec/waitpid and process groups over the cooperative guest
 * runtime. It is a process-model slice, not a POSIX kernel: fork clones the
 * address space and runnable CPU state, exec replaces a process image, and
 * waitpid reaps exited children. Parent/child SIGCHLD uses the THR-005 signal
 * dispatcher.
 */

import { ImageLoader, MapFileProvider } from "../dyld/loader.js";
import { VirtualMemory } from "../dyld/vm.js";
import { SignalDispatcher, SIGCHLD } from "./signals.js";
import {
  GuestScheduler,
  type GuestThread,
  type SchedulerRunOptions,
  type SchedulerResult,
} from "./scheduler.js";

export type ProcessState = "running" | "exited" | "stopped";

export interface ProcessRecord {
  readonly pid: number;
  ppid: number;
  pgid: number;
  memory: VirtualMemory;
  scheduler: GuestScheduler;
  signals: SignalDispatcher;
  state: ProcessState;
  exitStatus: number | null;
  readonly children: Set<number>;
}

export interface WaitResult {
  readonly pid: number;
  readonly status: number;
}

export interface ExecOptions {
  readonly bytes: Uint8Array;
  readonly path?: string;
  readonly argv?: readonly string[];
}

export interface RunResult extends SchedulerResult {
  readonly pid: number;
  readonly status: number;
}

const DEFAULT_STACK = 8 * 1024 * 1024;
const MAX_STACK = 64 * 1024 * 1024;

export class ProcessTable {
  private readonly processes = new Map<number, ProcessRecord>();
  private readonly waiters = new Map<number, GuestThread[]>();
  private nextPid = 1;

  spawn(
    memory: VirtualMemory,
    scheduler: GuestScheduler,
    options: { ppid?: number; pgid?: number } = {},
  ): ProcessRecord {
    const pid = this.nextPid++;
    const parent = options.ppid !== undefined ? this.processes.get(options.ppid) : undefined;
    const process: ProcessRecord = {
      pid,
      ppid: parent?.pid ?? 0,
      pgid: options.pgid ?? parent?.pgid ?? pid,
      memory,
      scheduler,
      signals: new SignalDispatcher(scheduler),
      state: "running",
      exitStatus: null,
      children: new Set(),
    };
    this.processes.set(pid, process);
    if (parent) parent.children.add(pid);
    return process;
  }

  fork(parentPid: number): ProcessRecord {
    const parent = this.require(parentPid);
    const memory = parent.memory.clone();
    const scheduler = parent.scheduler.clone(memory);
    const child = this.spawn(memory, scheduler, { ppid: parent.pid, pgid: parent.pgid });
    child.signals = parent.signals.clone(scheduler);
    for (const thread of scheduler.listThreads()) thread.cpu.writeRegister(0, 0n);
    return child;
  }

  exec(pid: number, options: ExecOptions): void {
    const process = this.require(pid);
    const path = options.path ?? "/exec";
    const memory = new VirtualMemory();
    const loader = new ImageLoader({
      provider: new MapFileProvider(new Map([[path, options.bytes]])),
      memory,
    });
    const program = loader.load(path);
    const stackSize = Math.max(0x4000, Math.min(program.stackSize || DEFAULT_STACK, MAX_STACK));
    const stack = memory.allocate(stackSize, { tag: "exec-stack" });
    const scheduler = new GuestScheduler(memory);
    const thread = scheduler.createThread({
      entry: program.entry,
      stackPointer: stack + BigInt(stackSize) - 16n,
      argument: BigInt(options.argv?.length ?? 0),
      label: "exec-main",
    });
    thread.cpu.writeRegister(1, 0n);
    process.memory = memory;
    process.scheduler = scheduler;
    process.signals = new SignalDispatcher(scheduler);
    process.state = "running";
    process.exitStatus = null;
  }

  run(pid: number, options: SchedulerRunOptions): RunResult {
    const process = this.require(pid);
    if (process.state !== "running") {
      return {
        pid,
        status: process.exitStatus ?? 0,
        instructions: 0,
        switches: 0,
        elapsedMs: 0,
        terminated: 0,
        blocked: 0,
        runnable: 0,
        reason: "idle",
      };
    }
    const result = process.scheduler.run(options);
    const terminated = process.scheduler
      .listThreads()
      .filter((thread) => thread.state === "terminated");
    if (terminated.length > 0) {
      this.exit(pid, terminated[0]!.exitStatus ?? 0);
    }
    return { pid, status: process.exitStatus ?? 0, ...result };
  }

  exit(pid: number, status: number): void {
    const process = this.processes.get(pid);
    if (!process || process.state === "exited") return;
    process.state = "exited";
    process.exitStatus = status & 0xff;
    for (const thread of process.scheduler.listThreads()) {
      if (thread.state !== "terminated") process.scheduler.terminate(thread, process.exitStatus);
    }
    const parent = this.processes.get(process.ppid);
    if (parent) {
      const parentThread = parent.scheduler.listThreads()[0];
      if (parentThread) parent.signals.notifyChildExit(parentThread);
      const waiters = this.waiters.get(parent.pid) ?? [];
      for (const waiter of waiters) parent.scheduler.unblock(waiter);
      this.waiters.delete(parent.pid);
    }
  }

  waitpid(parentPid: number, childPid = -1, caller?: GuestThread): WaitResult | null {
    const parent = this.require(parentPid);
    const child = this.findChild(parent, childPid);
    if (child?.state === "exited") {
      const result = { pid: child.pid, status: child.exitStatus ?? 0 };
      this.reap(parent, child);
      return result;
    }
    if (caller) {
      const waiters = this.waiters.get(parentPid) ?? [];
      if (!waiters.includes(caller)) waiters.push(caller);
      this.waiters.set(parentPid, waiters);
      parent.scheduler.block(caller, `waitpid:${childPid}`);
    }
    return null;
  }

  setpgid(pid: number, pgid: number): boolean {
    const process = this.processes.get(pid);
    if (!process || !this.processes.has(pgid)) return false;
    process.pgid = pgid;
    return true;
  }

  getpgid(pid: number): number | null {
    return this.processes.get(pid)?.pgid ?? null;
  }

  kill(pidOrGroup: number, signal: number): number {
    const targets =
      pidOrGroup < 0
        ? [...this.processes.values()].filter((process) => process.pgid === -pidOrGroup)
        : [this.processes.get(pidOrGroup)].filter((process): process is ProcessRecord =>
            Boolean(process),
          );
    let delivered = 0;
    for (const process of targets) {
      for (const thread of process.scheduler.listThreads()) {
        if (thread.state === "terminated") continue;
        if (process.signals.raise(thread, signal)) delivered += 1;
      }
      if (process.scheduler.listThreads().every((thread) => thread.state === "terminated")) {
        this.exit(process.pid, 128 + signal);
      }
    }
    return delivered;
  }

  get(pid: number): ProcessRecord | undefined {
    return this.processes.get(pid);
  }

  list(): readonly ProcessRecord[] {
    return [...this.processes.values()];
  }

  private require(pid: number): ProcessRecord {
    const process = this.processes.get(pid);
    if (!process) throw new Error(`unknown process ${pid}`);
    return process;
  }

  private findChild(parent: ProcessRecord, childPid: number): ProcessRecord | undefined {
    if (childPid >= 0) {
      const child = this.processes.get(childPid);
      return child && child.ppid === parent.pid ? child : undefined;
    }
    return [...parent.children]
      .map((pid) => this.processes.get(pid))
      .find((child) => child?.state === "exited");
  }

  private reap(parent: ProcessRecord, child: ProcessRecord): void {
    parent.children.delete(child.pid);
    this.processes.delete(child.pid);
  }
}
