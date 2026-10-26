/**
 * Process-runtime integration for fork/exec/waitpid (THR-006a).
 *
 * Wires ProcessTable into a guest syscall handler and a per-process Mach task
 * + DarwinSyscallKernel. Fork clones the address space/CPU state; waitpid parks
 * the caller; exec replaces the image and restarts the runner.
 *
 * The process calls use compatibility numbers, not Darwin's syscall numbers:
 * 910 fork, 911 waitpid, 912 exec, 913 setpgid, 914 getpgid, 915 kill.
 */

import { VirtualMemory } from "../dyld/vm.js";
import { ImageLoader, MapFileProvider } from "../dyld/loader.js";
import { MachKernel, type MachTask } from "../mach/kernel.js";
import { DarwinSyscallKernel, type ByteSink } from "../syscall/kernel.js";
import { writeInitialStack } from "./stack.js";
import type { SyscallResult } from "../arm64/cpu.js";
import { GuestScheduler, type GuestThread, type SchedulerRunOptions } from "./scheduler.js";
import { ProcessTable, type ProcessRecord } from "./process-table.js";

export const GUEST_FORK = 910;
export const GUEST_WAITPID = 911;
export const GUEST_EXEC = 912;
export const GUEST_SETPGID = 913;
export const GUEST_GETPGID = 914;
export const GUEST_KILL = 915;

export interface ProgramImage {
  readonly bytes: Uint8Array;
  readonly path: string;
}

export interface ProcessRunOptions {
  readonly maxInstructions?: number;
  readonly deadlineMs?: number;
  readonly onTick?: (now: number) => void;
}

export interface ProcessRuntimeOptions {
  readonly mach?: MachKernel;
  readonly rootDir?: string;
  readonly stdout?: ByteSink;
  readonly stderr?: ByteSink;
}

interface ProcessRuntimeRecord {
  readonly process: ProcessRecord;
  kernel: DarwinSyscallKernel | null;
  readonly images: Map<number, ProgramImage>;
  readonly stdout: ByteSink | undefined;
  readonly stderr: ByteSink | undefined;
}

export interface SpawnOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdout?: ByteSink;
  readonly stderr?: ByteSink;
  readonly stackSize?: number;
}

export class ProcessRuntime {
  readonly table = new ProcessTable();
  readonly mach: MachKernel;
  private readonly rootDir: string;
  private readonly stdout: ByteSink | undefined;
  private readonly stderr: ByteSink | undefined;
  private readonly records = new Map<number, ProcessRuntimeRecord>();
  private readonly pendingWaits = new Map<number, { childPid: number; statusAddress: bigint }>();
  private nextImageId = 1;

  constructor(options: ProcessRuntimeOptions = {}) {
    this.mach = options.mach ?? new MachKernel();
    this.rootDir = options.rootDir ?? process.cwd();
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }

  create(image: ProgramImage, options: { stackSize?: number } = {}): ProcessRuntimeRecord {
    return this.spawn(image, { argv: [image.path], stackSize: options.stackSize });
  }

  /** posix_spawn-shaped entry point: argv/env and stdout/stderr redirection. */
  spawn(image: ProgramImage, options: SpawnOptions = {}): ProcessRuntimeRecord {
    const memory = new VirtualMemory();
    const program = this.loadImage(memory, image);
    const stackSize = Math.max(
      0x4000,
      Math.min(options.stackSize ?? program.stackSize, 64 * 1024 * 1024),
    );
    const stack = memory.allocate(stackSize, { tag: "process-stack" });
    const layout = writeInitialStack(
      memory,
      stack,
      stackSize,
      options.argv ?? [],
      options.env ?? {},
    );
    const scheduler = new GuestScheduler(memory);
    const thread = scheduler.createThread({
      entry: program.entry,
      stackPointer: layout.stackPointer,
      label: "main",
    });
    thread.cpu.writeRegister(0, BigInt(layout.argc));
    thread.cpu.writeRegister(1, layout.argvPointer);
    thread.cpu.writeRegister(2, layout.envpPointer);
    const process = this.table.spawn(memory, scheduler);
    const record: ProcessRuntimeRecord = {
      process,
      kernel: null,
      images: new Map(),
      stdout: options.stdout,
      stderr: options.stderr,
    };
    this.records.set(process.pid, record);
    return record;
  }

  exec(pid: number, image: ProgramImage): void {
    const record = this.require(pid);
    this.table.exec(record.process.pid, { bytes: image.bytes, path: image.path });
    record.kernel = null;
  }

  run(pid: number, options: ProcessRunOptions = {}): number {
    const record = this.require(pid);
    const process = record.process;
    if (process.state !== "running") return process.exitStatus ?? 0;
    const schedulerAtStart = process.scheduler;
    process.scheduler.run({
      maxInstructions: options.maxInstructions ?? 20_000_000,
      deadlineMs: options.deadlineMs,
      onTick: options.onTick,
      syscallHandler: (thread, number, cpu) => this.handle(process, record, thread, number),
    });
    if (process.scheduler !== schedulerAtStart) {
      // exec replaced the scheduler; run the new image from the beginning.
      return this.run(pid, options);
    }
    const terminated = process.scheduler
      .listThreads()
      .filter((thread) => thread.state === "terminated");
    if (terminated.length > 0) {
      const status = record.kernel?.exitStatus ?? terminated[0]!.exitStatus ?? 0;
      this.table.exit(pid, status);
    }
    return process.exitStatus ?? 0;
  }

  waitpid(parentPid: number, childPid: number): { pid: number; status: number } | null {
    return this.table.waitpid(parentPid, childPid);
  }

  private handle(
    process: ProcessRecord,
    record: ProcessRuntimeRecord,
    thread: GuestThread,
    number: number,
  ): SyscallResult {
    const cpu = thread.cpu;
    if (number === GUEST_FORK) {
      const child = this.table.fork(process.pid);
      const childRecord: ProcessRuntimeRecord = {
        process: child,
        kernel: null,
        images: new Map(),
        stdout: record.stdout,
        stderr: record.stderr,
      };
      for (const [id, image] of record.images) childRecord.images.set(id, image);
      this.records.set(child.pid, childRecord);
      return { value: child.pid };
    }
    if (number === GUEST_WAITPID) {
      // A blocked SVC is retried after x0 has been overwritten with the
      // syscall result, so preserve the arguments for the retry.
      const pending = this.pendingWaits.get(thread.id);
      const childPid = pending?.childPid ?? Number(BigInt.asIntN(32, cpu.readRegister(0)));
      const statusAddress = pending?.statusAddress ?? cpu.readRegister(1);
      const result = this.table.waitpid(process.pid, childPid, thread);
      if (result === null) {
        this.pendingWaits.set(thread.id, { childPid, statusAddress });
        return { value: 0, blocked: true };
      }
      this.pendingWaits.delete(thread.id);
      process.memory.write(statusAddress, 4, BigInt(result.status));
      return { value: result.pid };
    }
    if (number === GUEST_EXEC) {
      const imageId = Number(BigInt.asIntN(32, cpu.readRegister(0)));
      const image = record.images.get(imageId);
      if (!image) return { value: -1, error: true };
      this.table.exec(process.pid, { bytes: image.bytes, path: image.path });
      record.kernel = null;
      return { value: 0, halt: true };
    }
    if (number === GUEST_SETPGID) {
      const pgid = Number(BigInt.asIntN(32, cpu.readRegister(0)));
      return { value: this.table.setpgid(process.pid, pgid) ? 0 : -1, error: false };
    }
    if (number === GUEST_GETPGID) {
      return { value: this.table.getpgid(process.pid) ?? -1 };
    }
    if (number === GUEST_KILL) {
      const target = Number(BigInt.asIntN(32, cpu.readRegister(0)));
      const signal = Number(BigInt.asIntN(32, cpu.readRegister(1)));
      return { value: this.table.kill(target, signal) };
    }
    return this.ensureKernel(process, record).handle(number, cpu, thread);
  }

  private loadImage(memory: VirtualMemory, image: ProgramImage) {
    const provider = new MapFileProvider(new Map([[image.path, image.bytes]]));
    return new ImageLoader({ provider, memory }).load(image.path);
  }

  private ensureKernel(process: ProcessRecord, record: ProcessRuntimeRecord): DarwinSyscallKernel {
    if (record.kernel) return record.kernel;
    const task: MachTask = this.mach.createTask(process.pid);
    record.kernel = new DarwinSyscallKernel({
      memory: process.memory,
      mach: this.mach,
      task,
      rootDir: this.rootDir,
      stdout: record.stdout ?? this.stdout,
      stderr: record.stderr ?? this.stderr,
    });
    return record.kernel;
  }

  private require(pid: number): ProcessRuntimeRecord {
    const record = this.records.get(pid);
    if (!record) throw new Error(`unknown process ${pid}`);
    return record;
  }

  registerImage(image: ProgramImage): number {
    const id = this.nextImageId++;
    for (const record of this.records.values()) record.images.set(id, image);
    return id;
  }
}
