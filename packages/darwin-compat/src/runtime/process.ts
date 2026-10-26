/**
 * The process runtime that ties the layers together:
 * Mach task + dyld image + AArch64 CPU + Darwin syscalls.
 *
 * Each process gets its own 64-bit address space and file-descriptor table but
 * shares one Mach kernel with the host and other processes. Execution is
 * bounded by both an instruction budget and a wall-clock deadline; a research
 * binary that loops forever fails visibly instead of wedging the CLI.
 */

import { RuntimeError } from "../errors.js";
import { EventRecorder, EVENT_TYPES } from "../observability/events.js";
import { RuntimeStats } from "../observability/stats.js";
import { captureFault } from "../observability/fault.js";
import { writeInitialStack } from "./stack.js";
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { ImageLoader, type FileProvider, type LoadedProgram } from "../dyld/loader.js";
import { MachKernel, type MachTask } from "../mach/kernel.js";
import {
  CaptureSink,
  DarwinSyscallKernel,
  type ByteSink,
  type SyscallTraceEvent,
} from "../syscall/kernel.js";

export interface ProcessOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdout?: ByteSink;
  readonly stderr?: ByteSink;
  readonly stdin?: Uint8Array;
  readonly maxInstructions?: number;
  readonly deadlineMs?: number;
  readonly strictSyscalls?: boolean;
  readonly traceSyscalls?: (event: SyscallTraceEvent) => void;
  readonly traceInstructions?: (pc: bigint, instruction: number, cpu: Arm64Cpu) => void;
  readonly searchPaths?: readonly string[];
  readonly extraRpaths?: readonly string[];
  readonly events?: EventRecorder;
}

export interface RuntimeOptions {
  readonly provider?: FileProvider;
  readonly rootDir?: string;
  readonly mach?: MachKernel;
  readonly defaultStdout?: ByteSink;
  readonly defaultStderr?: ByteSink;
  readonly maxInstructions?: number;
  readonly deadlineMs?: number;
  readonly strictSyscalls?: boolean;
}

export interface ProcessResult {
  readonly pid: number;
  readonly exitStatus: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly instructions: number;
  readonly elapsedMs: number;
  readonly program: LoadedProgram;
  readonly unsupportedSyscalls: ReadonlyMap<number, number>;
  readonly outputSink: ByteSink;
  readonly errorSink: ByteSink;
}

export interface CreateProcessOptions extends ProcessOptions {
  readonly program: string;
}

const DEFAULT_MAX_INSTRUCTIONS = 20_000_000;
const DEFAULT_DEADLINE_MS = 15_000;

export class DarwinRuntime {
  readonly mach: MachKernel;
  readonly stats = new RuntimeStats();
  readonly rootDir: string;
  private readonly provider: FileProvider | undefined;
  private readonly defaultStdout: ByteSink;
  private readonly defaultStderr: ByteSink;
  private readonly maxInstructions: number;
  private readonly deadlineMs: number;
  private readonly strictSyscalls: boolean;
  private nextPid = 100;

  constructor(options: RuntimeOptions = {}) {
    this.mach = options.mach ?? new MachKernel();
    this.rootDir = options.rootDir ?? process.cwd();
    this.provider = options.provider;
    this.defaultStdout = options.defaultStdout ?? new CaptureSink();
    this.defaultStderr = options.defaultStderr ?? new CaptureSink();
    this.maxInstructions = options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.strictSyscalls = options.strictSyscalls ?? true;
  }

  createProcess(options: CreateProcessOptions): DarwinProcess {
    const pid = this.nextPid++;
    const task = this.mach.createTask(pid);
    const memory = new VirtualMemory();
    const loader = new ImageLoader({
      provider: this.provider,
      memory,
      searchPaths: options.searchPaths ?? [],
      extraRpaths: options.extraRpaths ?? [],
    });
    let program: LoadedProgram;
    try {
      program = loader.load(options.program);
    } catch (error) {
      this.stats.increment("loaderErrors");
      throw error;
    }
    this.stats.increment("processesStarted");
    this.stats.increment("imagesLoaded", program.images.length);
    this.stats.increment("fixupBinds", program.stats.binds);
    this.stats.increment("fixupRebases", program.stats.rebases);
    const stackSize = Math.max(0x4000, Math.min(program.stackSize, 64 * 1024 * 1024));
    const stackBase = memory.allocate(stackSize, { tag: "stack", protection: 3 });
    const layout = writeInitialStack(
      memory,
      stackBase,
      stackSize,
      options.argv ?? [],
      options.env ?? {},
    );

    const cpu = new Arm64Cpu({
      onInstruction: options.traceInstructions
        ? (pc, instruction, cpu) => options.traceInstructions?.(pc, instruction, cpu)
        : undefined,
    });
    cpu.reset(program.entry, layout.stackPointer);
    cpu.writeRegister(0, BigInt(layout.argc));
    cpu.writeRegister(1, layout.argvPointer);
    cpu.writeRegister(2, layout.envpPointer);
    cpu.writeRegister(3, 0n);

    const outputSink = options.stdout ?? this.defaultStdout;
    const errorSink = options.stderr ?? this.defaultStderr;
    const syscalls = new DarwinSyscallKernel({
      memory,
      mach: this.mach,
      task,
      rootDir: this.rootDir,
      stdout: outputSink,
      stderr: errorSink,
      stdin: options.stdin,
      strict: options.strictSyscalls ?? this.strictSyscalls,
      trace: (event) => {
        this.stats.increment("syscalls");
        options.traceSyscalls?.(event);
      },
    });

    return new DarwinProcess({
      pid,
      task,
      cpu,
      memory,
      program,
      entry: program.entry,
      stackPointer: layout.stackPointer,
      argc: layout.argc,
      argvPointer: layout.argvPointer,
      envpPointer: layout.envpPointer,
      syscalls,
      outputSink,
      errorSink,
      maxInstructions: options.maxInstructions ?? this.maxInstructions,
      deadlineMs: options.deadlineMs ?? this.deadlineMs,
      events: options.events,
      stats: this.stats,
    });
  }

  run(program: string, options: ProcessOptions = {}): ProcessResult {
    return this.createProcess({ program, ...options }).run();
  }
}

interface ProcessInternals {
  pid: number;
  task: MachTask;
  cpu: Arm64Cpu;
  memory: VirtualMemory;
  program: LoadedProgram;
  entry: bigint;
  stackPointer: bigint;
  argc: number;
  argvPointer: bigint;
  envpPointer: bigint;
  syscalls: DarwinSyscallKernel;
  outputSink: ByteSink;
  errorSink: ByteSink;
  maxInstructions: number;
  deadlineMs: number;
  events?: EventRecorder;
  stats: RuntimeStats;
}

export class DarwinProcess {
  readonly pid: number;
  readonly program: LoadedProgram;
  readonly memory: VirtualMemory;
  readonly task: MachTask;
  private readonly cpu: Arm64Cpu;
  private readonly entry: bigint;
  private readonly stackPointer: bigint;
  private readonly argc: number;
  private readonly argvPointer: bigint;
  private readonly envpPointer: bigint;
  private readonly syscalls: DarwinSyscallKernel;
  private readonly outputSink: ByteSink;
  private readonly errorSink: ByteSink;
  private readonly maxInstructions: number;
  private readonly deadlineMs: number;
  private readonly events: EventRecorder | undefined;
  private readonly stats: RuntimeStats;
  private consumed = false;
  private executed = 0;

  constructor(internals: ProcessInternals) {
    this.pid = internals.pid;
    this.task = internals.task;
    this.cpu = internals.cpu;
    this.memory = internals.memory;
    this.program = internals.program;
    this.entry = internals.entry;
    this.stackPointer = internals.stackPointer;
    this.argc = internals.argc;
    this.argvPointer = internals.argvPointer;
    this.envpPointer = internals.envpPointer;
    this.syscalls = internals.syscalls;
    this.outputSink = internals.outputSink;
    this.errorSink = internals.errorSink;
    this.maxInstructions = internals.maxInstructions;
    this.deadlineMs = internals.deadlineMs;
    this.events = internals.events;
    this.stats = internals.stats;
  }

  run(): ProcessResult {
    if (this.consumed)
      throw new RuntimeError("process_already_ran", `process ${this.pid} has already run`);
    this.consumed = true;
    const started = Date.now();
    this.events?.emit(
      EVENT_TYPES.processStart,
      {
        entry: this.entry,
        images: this.program.images.map((image) => image.path),
        initializers: this.program.initializers.length,
      },
      { pid: this.pid },
    );
    let mainExit: number | null = null;
    try {
      for (const address of this.program.initializers) {
        if (this.syscalls.exitStatus !== null) break;
        this.runAt(address, "initializer", started);
      }
      if (this.syscalls.exitStatus === null) {
        this.resetMain();
        this.runLoop("main", started);
        this.executed += this.cpu.instructions;
        mainExit = this.syscalls.exitStatus ?? this.cpu.exitStatus ?? 0;
      } else {
        mainExit = this.syscalls.exitStatus;
      }
      for (const address of this.program.terminators) {
        this.runAt(address, "terminator", started);
      }
    } finally {
      this.syscalls.mach.destroyTask(this.task);
    }

    const exitStatus = mainExit ?? this.syscalls.exitStatus ?? 0;
    this.stats.increment("processesExited");
    this.stats.increment("instructions", this.executed);
    this.stats.increment(
      "unsupportedSyscalls",
      [...this.syscalls.unsupported.values()].reduce((sum, count) => sum + count, 0),
    );
    this.stats.increment("bytesStdout", sinkBytes(this.outputSink).length);
    this.stats.increment("bytesStderr", sinkBytes(this.errorSink).length);
    this.events?.emit(
      EVENT_TYPES.processExit,
      { status: exitStatus, instructions: this.executed, elapsedMs: Date.now() - started },
      { pid: this.pid },
    );
    return {
      pid: this.pid,
      exitStatus,
      stdout: sinkBytes(this.outputSink),
      stderr: sinkBytes(this.errorSink),
      instructions: this.executed,
      elapsedMs: Date.now() - started,
      program: this.program,
      unsupportedSyscalls: new Map(this.syscalls.unsupported),
      outputSink: this.outputSink,
      errorSink: this.errorSink,
    };
  }

  private resetMain(): void {
    this.cpu.reset(this.entry, this.stackPointer);
    this.cpu.writeRegister(0, BigInt(this.argc));
    this.cpu.writeRegister(1, this.argvPointer);
    this.cpu.writeRegister(2, this.envpPointer);
    this.cpu.writeRegister(3, 0n);
  }

  private runAt(address: bigint, stage: "initializer" | "terminator", started: number): void {
    this.cpu.reset(address, this.stackPointer);
    this.cpu.writeRegister(30, 0n);
    try {
      this.runLoop(stage, started);
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw new RuntimeError(error.code, `${stage} 0x${address.toString(16)}: ${error.message}`, {
          ...error.details,
          stage,
          address: address.toString(16),
        });
      }
      throw error;
    }
    this.executed += this.cpu.instructions;
  }

  private withFault(error: RuntimeError, pc?: bigint): RuntimeError {
    const fault = captureFault(error, this.cpu, this.memory, this.program, pc);
    return new RuntimeError(error.code, error.message, { ...error.details, fault });
  }

  private runLoop(stage: "initializer" | "main" | "terminator", started: number): void {
    while (!this.cpu.halted) {
      const used = this.executed + this.cpu.instructions;
      if (used >= this.maxInstructions) {
        throw this.withFault(
          new RuntimeError(
            "instruction_limit",
            `process ${this.pid} hit the ${this.maxInstructions} instruction limit during ${stage} at pc 0x${this.cpu.pc.toString(16)}`,
            { pid: this.pid, pc: this.cpu.pc.toString(16) },
          ),
        );
      }
      if ((used & 0xfff) === 0 && Date.now() - started > this.deadlineMs) {
        throw this.withFault(
          new RuntimeError(
            "deadline",
            `process ${this.pid} exceeded the ${this.deadlineMs} ms deadline during ${stage} at pc 0x${this.cpu.pc.toString(16)}`,
            { pid: this.pid, pc: this.cpu.pc.toString(16) },
          ),
        );
      }
      const steppingPc = this.cpu.pc;
      try {
        this.cpu.step(this.memory, (number, cpu) => this.syscalls.handle(number, cpu));
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "fault";
        const message = error instanceof Error ? error.message : String(error);
        throw this.withFault(new RuntimeError(code, message, { pid: this.pid }), steppingPc);
      }
    }
  }
}

function sinkBytes(sink: ByteSink): Uint8Array {
  return sink instanceof CaptureSink ? sink.bytes() : new Uint8Array();
}
