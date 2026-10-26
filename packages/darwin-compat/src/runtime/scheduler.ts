/**
 * Cooperative guest-thread scheduler.
 *
 * This is the THR-002 layer above the native thread lifecycle objects. It owns
 * one AArch64 CPU state per guest thread, shares the process address space, and
 * round-robins runnable threads by instruction quantum. It is deliberately
 * deterministic: no wall-clock preemption, no host threads in the scheduler.
 *
 * Blocking syscalls can call `block()` and another thread can `unblock()` the
 * waiter. THR-003 will connect this to the native Mach blocking path.
 */

import type { Arm64Cpu, SyscallHandler, SyscallResult } from "../arm64/cpu.js";
import { Arm64Cpu as Arm64CpuClass } from "../arm64/cpu.js";
import type { VirtualMemory } from "../dyld/vm.js";

export type GuestThreadState = "runnable" | "running" | "blocked" | "terminated";

export interface GuestThreadOptions {
  readonly entry: bigint;
  readonly stackPointer: bigint;
  readonly label?: string;
  readonly quantum?: number;
  /** Initial x0 value (a pthread-style argument pointer). */
  readonly argument?: bigint;
}

export interface GuestThread {
  readonly id: number;
  readonly label: string;
  readonly cpu: Arm64Cpu;
  state: GuestThreadState;
  quantum: number;
  blockedReason: string | null;
  exitStatus: number | null;
}

export interface SchedulerSwitchEvent {
  readonly threadId: number;
  readonly reason: "start" | "quantum" | "blocked" | "unblocked" | "terminated" | "yield";
}

export interface SchedulerOptions {
  readonly quantum?: number;
  readonly onSwitch?: (event: SchedulerSwitchEvent) => void;
  readonly onTerminate?: (thread: GuestThread) => void;
}

export interface SchedulerRunOptions {
  readonly maxInstructions: number;
  readonly deadlineMs?: number;
  readonly syscallHandler: (thread: GuestThread, number: number, cpu: Arm64Cpu) => SyscallResult;
  /** Called periodically so blocking bridges can expire deadlines. */
  readonly onTick?: (now: number) => void;
}

export interface SchedulerResult {
  readonly instructions: number;
  readonly switches: number;
  readonly elapsedMs: number;
  readonly terminated: number;
  readonly blocked: number;
  readonly runnable: number;
  readonly reason: "idle" | "budget" | "deadline";
}

const DEFAULT_QUANTUM = 64;
const DEADLINE_CHECK_MASK = 0xfff;

export class GuestScheduler {
  readonly memory: VirtualMemory;
  private readonly threads = new Map<number, GuestThread>();
  private readonly queue: GuestThread[] = [];
  private readonly defaultQuantum: number;
  private readonly onSwitch: SchedulerOptions["onSwitch"];
  private terminateHandler: SchedulerOptions["onTerminate"];
  private nextId = 1;
  private switches = 0;
  private current: GuestThread | null = null;

  constructor(memory: VirtualMemory, options: SchedulerOptions = {}) {
    this.memory = memory;
    this.defaultQuantum = Math.max(1, options.quantum ?? DEFAULT_QUANTUM);
    this.onSwitch = options.onSwitch;
    this.terminateHandler = options.onTerminate;
  }

  setTerminateHandler(handler: SchedulerOptions["onTerminate"]): void {
    this.terminateHandler = handler;
  }

  createThread(options: GuestThreadOptions): GuestThread {
    const cpu = new Arm64CpuClass();
    cpu.reset(options.entry, options.stackPointer);
    if (options.argument !== undefined) cpu.writeRegister(0, options.argument);
    const thread: GuestThread = {
      id: this.nextId++,
      label: options.label ?? `thread-${this.nextId}`,
      cpu,
      state: "runnable",
      quantum: Math.max(1, options.quantum ?? this.defaultQuantum),
      blockedReason: null,
      exitStatus: null,
    };
    this.threads.set(thread.id, thread);
    this.queue.push(thread);
    return thread;
  }

  /** Clone threads/CPU state into a new address space (process fork). */
  clone(memory: VirtualMemory): GuestScheduler {
    const copy = new GuestScheduler(memory, {
      quantum: this.defaultQuantum,
      onSwitch: this.onSwitch,
    });
    copy.nextId = this.nextId;
    copy.switches = this.switches;
    for (const thread of this.threads.values()) {
      const cloned: GuestThread = {
        id: thread.id,
        label: thread.label,
        cpu: thread.cpu.clone(),
        state: thread.state === "running" ? "runnable" : thread.state,
        quantum: thread.quantum,
        blockedReason: thread.blockedReason,
        exitStatus: thread.exitStatus,
      };
      copy.threads.set(cloned.id, cloned);
      if (cloned.state === "runnable") copy.queue.push(cloned);
    }
    return copy;
  }

  listThreads(): readonly GuestThread[] {
    return [...this.threads.values()];
  }

  currentThread(): GuestThread | null {
    return this.current;
  }

  block(thread: GuestThread, reason = "blocked"): void {
    if (thread.state === "terminated" || thread.state === "blocked") return;
    thread.state = "blocked";
    thread.blockedReason = reason;
    this.removeFromQueue(thread);
    if (this.current === thread) this.onSwitch?.({ threadId: thread.id, reason: "blocked" });
  }

  unblock(thread: GuestThread): void {
    if (thread.state !== "blocked") return;
    thread.state = "runnable";
    thread.blockedReason = null;
    if (!this.queue.includes(thread)) this.queue.push(thread);
    this.onSwitch?.({ threadId: thread.id, reason: "unblocked" });
  }

  terminate(thread: GuestThread, status: number | null = null): void {
    if (thread.state === "terminated") return;
    thread.state = "terminated";
    thread.exitStatus = status ?? thread.cpu.exitStatus;
    this.removeFromQueue(thread);
    this.terminateHandler?.(thread);
    if (this.current === thread) this.onSwitch?.({ threadId: thread.id, reason: "terminated" });
  }

  yieldCurrent(): void {
    if (this.current !== null && this.current.state === "running") {
      this.current.state = "runnable";
      this.onSwitch?.({ threadId: this.current.id, reason: "yield" });
    }
  }

  run(options: SchedulerRunOptions): SchedulerResult {
    if (options.maxInstructions <= 0) {
      throw new Error(`maxInstructions must be positive, got ${options.maxInstructions}`);
    }
    const started = Date.now();
    let instructions = 0;
    let reason: SchedulerResult["reason"] = "idle";

    while (this.queue.length > 0) {
      const thread = this.queue.shift()!;
      if (thread.state !== "runnable") continue;
      thread.state = "running";
      this.current = thread;
      this.switches += 1;
      this.onSwitch?.({ threadId: thread.id, reason: "start" });

      const slice = Math.min(thread.quantum, options.maxInstructions - instructions);
      for (let step = 0; step < slice; step += 1) {
        if (thread.state !== "running") break;
        if (thread.cpu.halted) {
          this.terminate(thread, thread.cpu.exitStatus);
          break;
        }
        let blocked = false;
        thread.cpu.step(this.memory, (number, cpu) => {
          const result = options.syscallHandler(thread, number, cpu);
          blocked = result.blocked === true;
          return result;
        });
        instructions += 1;
        if (blocked) {
          // The CPU has already advanced past SVC. Rewind so the call is retried
          // after the bridge unblocks this thread.
          thread.cpu.pc -= 4n;
          break;
        }
        if (thread.cpu.halted) {
          this.terminate(thread, thread.cpu.exitStatus);
          break;
        }
        if ((instructions & DEADLINE_CHECK_MASK) === 0) {
          options.onTick?.(Date.now());
        }
        if ((instructions & DEADLINE_CHECK_MASK) === 0 && options.deadlineMs !== undefined) {
          if (Date.now() - started > options.deadlineMs) {
            reason = "deadline";
            if (thread.state === "running") thread.state = "runnable";
            this.current = null;
            return this.result(instructions, started, reason);
          }
        }
      }

      if (thread.state === "running") {
        thread.state = "runnable";
        this.queue.push(thread);
        this.onSwitch?.({ threadId: thread.id, reason: "quantum" });
      }
      this.current = null;

      if (instructions >= options.maxInstructions) {
        reason = "budget";
        break;
      }
    }

    return this.result(instructions, started, reason);
  }

  private result(
    instructions: number,
    started: number,
    reason: SchedulerResult["reason"],
  ): SchedulerResult {
    const threads = this.listThreads();
    return {
      instructions,
      switches: this.switches,
      elapsedMs: Date.now() - started,
      terminated: threads.filter((thread) => thread.state === "terminated").length,
      blocked: threads.filter((thread) => thread.state === "blocked").length,
      runnable: threads.filter((thread) => thread.state === "runnable").length,
      reason,
    };
  }

  private removeFromQueue(thread: GuestThread): void {
    const index = this.queue.indexOf(thread);
    if (index >= 0) this.queue.splice(index, 1);
  }
}
