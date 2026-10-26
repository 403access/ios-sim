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
import { Arm64Cpu } from "../arm64/cpu.js";
import { VirtualMemory } from "../dyld/vm.js";
import { ImageLoader, type FileProvider, type LoadedProgram } from "../dyld/loader.js";
import { MachKernel, type MachTask } from "../mach/kernel.js";
import { ObjcHost, type CapturedFrame, type TapEvent } from "../objc/host.js";
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
  /** Install the Objective-C framework shim (default: true). */
  readonly objc?: boolean;
  readonly screen?: { readonly width: number; readonly height: number };
  readonly events?: readonly TapEvent[];
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
  readonly frames: readonly CapturedFrame[];
  readonly objcClasses: readonly string[];
  readonly objcCategories: readonly string[];
  readonly objcProtocols: readonly string[];
}

export interface CreateProcessOptions extends ProcessOptions {
  readonly program: string;
}

const DEFAULT_MAX_INSTRUCTIONS = 20_000_000;
const DEFAULT_DEADLINE_MS = 15_000;

export class DarwinRuntime {
  readonly mach: MachKernel;
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
    const objc =
      options.objc === false
        ? null
        : new ObjcHost({
            memory,
            width: options.screen?.width,
            height: options.screen?.height,
            events: options.events,
          });
    const loader = new ImageLoader({
      provider: this.provider,
      memory,
      searchPaths: options.searchPaths ?? [],
      extraRpaths: options.extraRpaths ?? [],
      externalSymbols: objc?.symbols,
    });
    const program = loader.load(options.program);
    objc?.attach(program);
    const stackSize = Math.max(0x4000, Math.min(program.stackSize, 64 * 1024 * 1024));
    const stackBase = memory.allocate(stackSize, { tag: "stack", protection: 3 });
    const layout = writeStack(memory, stackBase, stackSize, options.argv ?? [], options.env ?? {});

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
    const loadStub = objc?.prepareLoads(program.entry) ?? null;
    if (loadStub !== null) cpu.pc = loadStub;

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
      trace: options.traceSyscalls,
    });

    return new DarwinProcess({
      pid,
      task,
      cpu,
      memory,
      program,
      syscalls,
      objc,
      outputSink,
      errorSink,
      maxInstructions: options.maxInstructions ?? this.maxInstructions,
      deadlineMs: options.deadlineMs ?? this.deadlineMs,
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
  syscalls: DarwinSyscallKernel;
  objc: ObjcHost | null;
  outputSink: ByteSink;
  errorSink: ByteSink;
  maxInstructions: number;
  deadlineMs: number;
}

export class DarwinProcess {
  readonly pid: number;
  readonly program: LoadedProgram;
  readonly memory: VirtualMemory;
  readonly task: MachTask;
  private readonly cpu: Arm64Cpu;
  private readonly syscalls: DarwinSyscallKernel;
  private readonly objc: ObjcHost | null;
  private readonly outputSink: ByteSink;
  private readonly errorSink: ByteSink;
  private readonly maxInstructions: number;
  private readonly deadlineMs: number;
  private consumed = false;

  constructor(internals: ProcessInternals) {
    this.pid = internals.pid;
    this.task = internals.task;
    this.cpu = internals.cpu;
    this.memory = internals.memory;
    this.program = internals.program;
    this.syscalls = internals.syscalls;
    this.objc = internals.objc;
    this.outputSink = internals.outputSink;
    this.errorSink = internals.errorSink;
    this.maxInstructions = internals.maxInstructions;
    this.deadlineMs = internals.deadlineMs;
  }

  run(): ProcessResult {
    if (this.consumed)
      throw new RuntimeError("process_already_ran", `process ${this.pid} has already run`);
    this.consumed = true;
    const started = Date.now();
    try {
      while (!this.cpu.halted) {
        if (this.cpu.instructions >= this.maxInstructions) {
          throw new RuntimeError(
            "instruction_limit",
            `process ${this.pid} hit the ${this.maxInstructions} instruction limit at pc 0x${this.cpu.pc.toString(16)}`,
            { pid: this.pid, pc: this.cpu.pc.toString(16) },
          );
        }
        if ((this.cpu.instructions & 0xfff) === 0 && Date.now() - started > this.deadlineMs) {
          throw new RuntimeError(
            "deadline",
            `process ${this.pid} exceeded the ${this.deadlineMs} ms deadline at pc 0x${this.cpu.pc.toString(16)}`,
            { pid: this.pid, pc: this.cpu.pc.toString(16) },
          );
        }
        this.cpu.step(this.memory, (number, cpu) => {
          const trapped = this.objc?.handle(number, cpu);
          return trapped ?? this.syscalls.handle(number, cpu);
        });
      }
    } finally {
      this.syscalls.mach.destroyTask(this.task);
    }

    const exitStatus = this.syscalls.exitStatus ?? this.cpu.exitStatus ?? 0;
    return {
      pid: this.pid,
      exitStatus,
      stdout: sinkBytes(this.outputSink),
      stderr: sinkBytes(this.errorSink),
      instructions: this.cpu.instructions,
      elapsedMs: Date.now() - started,
      program: this.program,
      unsupportedSyscalls: new Map(this.syscalls.unsupported),
      outputSink: this.outputSink,
      errorSink: this.errorSink,
      frames: this.objc?.frames ?? [],
      objcClasses: this.objc ? [...this.objc.classes.keys()] : [],
      objcCategories: this.objc?.categories ?? [],
      objcProtocols: this.objc?.protocolSummary() ?? [],
    };
  }
}

function sinkBytes(sink: ByteSink): Uint8Array {
  return sink instanceof CaptureSink ? sink.bytes() : new Uint8Array();
}

interface StackLayout {
  readonly argc: number;
  readonly argvPointer: bigint;
  readonly envpPointer: bigint;
  readonly stackPointer: bigint;
}

/**
 * Build a Darwin-like initial stack: strings first, then argv pointers, a null
 * terminator, envp pointers, and a null terminator. Registers also carry the
 * values because this layer's entry ABI is documented as `x0=argc`, `x1=argv`,
 * `x2=envp` (a real dyld would call a libSystem `start` instead).
 */
function writeStack(
  memory: VirtualMemory,
  stackBase: bigint,
  stackSize: number,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): StackLayout {
  const envEntries = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  let cursor = stackBase + BigInt(stackSize);
  const strings: bigint[] = [];
  const pushString = (value: string): bigint => {
    const bytes = new TextEncoder().encode(value);
    cursor -= BigInt(bytes.length + 1);
    if (cursor < stackBase)
      throw new RuntimeError("stack_overflow", "argv/env exceed the process stack");
    memory.writeBytes(cursor, bytes);
    memory.write(cursor + BigInt(bytes.length), 1, 0n);
    return cursor;
  };

  const argvPointers: bigint[] = [];
  for (const value of argv) argvPointers.push(pushString(value));
  const envpPointers: bigint[] = [];
  for (const value of envEntries) envpPointers.push(pushString(value));

  cursor &= ~0xfn;
  const pointerCount = 1 + argvPointers.length + 1 + envpPointers.length + 1;
  cursor -= BigInt(pointerCount * 8);
  if (cursor < stackBase)
    throw new RuntimeError("stack_overflow", "argv/env pointer table exceeds the process stack");
  cursor &= ~0xfn;
  if (cursor < stackBase)
    throw new RuntimeError("stack_overflow", "argv/env pointer table exceeds the process stack");
  const table = cursor;
  let at = table;
  memory.write(at, 8, BigInt(argvPointers.length));
  at += 8n;
  const argvPointer = at;
  for (const pointer of argvPointers) {
    memory.write(at, 8, pointer);
    at += 8n;
  }
  memory.write(at, 8, 0n);
  at += 8n;
  const envpPointer = at;
  for (const pointer of envpPointers) {
    memory.write(at, 8, pointer);
    at += 8n;
  }
  memory.write(at, 8, 0n);

  return { argc: argvPointers.length, argvPointer, envpPointer, stackPointer: table };
}
