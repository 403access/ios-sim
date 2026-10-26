/**
 * Guest signal dispatcher (THR-005).
 *
 * Signals are delivered at guest instruction boundaries by redirecting the CPU
 * to a handler; `sigreturn` restores the saved register/PC/SP/NZCV frame. The
 * default actions cover the common Darwin signals, including stop/continue and
 * ignored SIGCHLD/SIGWINCH. Process-group/waitpid interaction is modelled by
 * `notifyChildExit`; the actual fork/exec/waitpid path arrives in THR-006.
 */

import type { Arm64Cpu } from "../arm64/cpu.js";
import type { GuestScheduler, GuestThread } from "./scheduler.js";

export const SIGHUP = 1;
export const SIGINT = 2;
export const SIGQUIT = 3;
export const SIGILL = 4;
export const SIGTRAP = 5;
export const SIGABRT = 6;
export const SIGEMT = 7;
export const SIGFPE = 8;
export const SIGKILL = 9;
export const SIGBUS = 10;
export const SIGSEGV = 11;
export const SIGSYS = 12;
export const SIGPIPE = 13;
export const SIGALRM = 14;
export const SIGTERM = 15;
export const SIGURG = 16;
export const SIGSTOP = 17;
export const SIGTSTP = 18;
export const SIGCONT = 19;
export const SIGCHLD = 20;
export const SIGTTIN = 21;
export const SIGTTOU = 22;
export const SIGIO = 23;
export const SIGXCPU = 24;
export const SIGXFSZ = 25;
export const SIGVTALRM = 26;
export const SIGPROF = 27;
export const SIGWINCH = 28;
export const SIGINFO = 29;
export const SIGUSR1 = 30;
export const SIGUSR2 = 31;

export const SIG_DFL = 0n;
export const SIG_IGN = 1n;

export const GUEST_SIGACTION = 906;
export const GUEST_SIGNAL_RAISE = 907;
export const GUEST_SIGPROCMASK = 908;
export const GUEST_SIGRETURN = 909;

export type SignalAction =
  { kind: "default" } | { kind: "ignore" } | { kind: "handler"; handler: bigint };
export type SignalDefault = "terminate" | "ignore" | "stop" | "continue";

interface SignalFrame {
  readonly registers: BigUint64Array;
  readonly sp: bigint;
  readonly pc: bigint;
  readonly nzcv: number;
}

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  [SIGHUP]: "SIGHUP",
  [SIGINT]: "SIGINT",
  [SIGQUIT]: "SIGQUIT",
  [SIGILL]: "SIGILL",
  [SIGTRAP]: "SIGTRAP",
  [SIGABRT]: "SIGABRT",
  [SIGEMT]: "SIGEMT",
  [SIGFPE]: "SIGFPE",
  [SIGKILL]: "SIGKILL",
  [SIGBUS]: "SIGBUS",
  [SIGSEGV]: "SIGSEGV",
  [SIGSYS]: "SIGSYS",
  [SIGPIPE]: "SIGPIPE",
  [SIGALRM]: "SIGALRM",
  [SIGTERM]: "SIGTERM",
  [SIGURG]: "SIGURG",
  [SIGSTOP]: "SIGSTOP",
  [SIGTSTP]: "SIGTSTP",
  [SIGCONT]: "SIGCONT",
  [SIGCHLD]: "SIGCHLD",
  [SIGTTIN]: "SIGTTIN",
  [SIGTTOU]: "SIGTTOU",
  [SIGIO]: "SIGIO",
  [SIGXCPU]: "SIGXCPU",
  [SIGXFSZ]: "SIGXFSZ",
  [SIGVTALRM]: "SIGVTALRM",
  [SIGPROF]: "SIGPROF",
  [SIGWINCH]: "SIGWINCH",
  [SIGINFO]: "SIGINFO",
  [SIGUSR1]: "SIGUSR1",
  [SIGUSR2]: "SIGUSR2",
};

const DEFAULT_ACTIONS: Readonly<Record<number, SignalDefault>> = {
  [SIGURG]: "ignore",
  [SIGSTOP]: "stop",
  [SIGTSTP]: "stop",
  [SIGTTIN]: "stop",
  [SIGTTOU]: "stop",
  [SIGCONT]: "continue",
  [SIGCHLD]: "ignore",
  [SIGIO]: "ignore",
  [SIGWINCH]: "ignore",
  [SIGINFO]: "ignore",
};

const MAX_SIGNAL_FRAMES = 8;

export class SignalDispatcher {
  private readonly actions = new Map<number, SignalAction>();
  private readonly pending = new Map<number, Set<number>>();
  private readonly blocked = new Map<number, number>();
  private readonly frames = new Map<number, SignalFrame[]>();

  constructor(private readonly scheduler: GuestScheduler) {}

  signalName(signal: number): string {
    return SIGNAL_NAMES[signal] ?? `SIG${signal}`;
  }

  defaultAction(signal: number): SignalDefault {
    return DEFAULT_ACTIONS[signal] ?? "terminate";
  }

  action(thread: GuestThread, signal: number): SignalAction {
    return this.actions.get(signal) ?? { kind: "default" };
  }

  sigaction(thread: GuestThread, signal: number, handler: bigint): boolean {
    if (!isSignal(signal)) return false;
    if (handler === SIG_DFL) this.actions.set(signal, { kind: "default" });
    else if (handler === SIG_IGN) this.actions.set(signal, { kind: "ignore" });
    else this.actions.set(signal, { kind: "handler", handler });
    this.deliver(thread);
    return true;
  }

  sigprocmask(thread: GuestThread, mask: number): void {
    this.blocked.set(thread.id, mask >>> 0);
    this.deliver(thread);
  }

  blockedMask(thread: GuestThread): number {
    return this.blocked.get(thread.id) ?? 0;
  }

  pendingSignals(thread: GuestThread): readonly number[] {
    return [...(this.pending.get(thread.id) ?? [])].sort((a, b) => a - b);
  }

  raise(thread: GuestThread, signal: number): boolean {
    if (!isSignal(signal)) return false;
    if (signal === SIGKILL) {
      for (const target of this.scheduler.listThreads()) {
        if (target.state !== "terminated") this.scheduler.terminate(target, 128 + signal);
      }
      return true;
    }
    if (signal === SIGSTOP) {
      this.scheduler.block(thread, "signal:stop");
      return true;
    }
    if (signal === SIGCONT) {
      this.blocked.delete(thread.id);
      if (thread.state === "blocked") this.scheduler.unblock(thread);
      return true;
    }
    const pending = this.pending.get(thread.id) ?? new Set<number>();
    pending.add(signal);
    this.pending.set(thread.id, pending);
    this.deliver(thread);
    return true;
  }

  kill(target: GuestThread, signal: number): boolean {
    return this.raise(target, signal);
  }

  /** Model the parent-visible SIGCHLD when a child terminates. */
  notifyChildExit(parent: GuestThread): void {
    this.raise(parent, SIGCHLD);
  }

  sigreturn(thread: GuestThread): boolean {
    const stack = this.frames.get(thread.id);
    const frame = stack?.pop();
    if (!frame) return false;
    thread.cpu.registers.set(frame.registers);
    thread.cpu.sp = frame.sp;
    thread.cpu.pc = frame.pc;
    thread.cpu.nzcv = frame.nzcv;
    return true;
  }

  deliver(thread: GuestThread): number | null {
    if (thread.state === "terminated") return null;
    const pending = this.pending.get(thread.id);
    if (!pending || pending.size === 0) return null;
    const mask = this.blockedMask(thread);
    for (const signal of [...pending].sort((a, b) => a - b)) {
      if ((mask & signalBit(signal)) !== 0) continue;
      pending.delete(signal);
      const action = this.action(thread, signal);
      if (action.kind === "ignore" || this.defaultAction(signal) === "ignore") {
        continue;
      }
      if (action.kind === "handler") {
        this.pushFrame(thread);
        thread.cpu.writeRegister(0, BigInt(signal));
        thread.cpu.writeRegister(1, 0n);
        thread.cpu.writeRegister(2, 0n);
        thread.cpu.pc = action.handler;
        return signal;
      }
      const defaultAction = this.defaultAction(signal);
      if (defaultAction === "stop") {
        this.scheduler.block(thread, `signal:${this.signalName(signal)}`);
        return signal;
      }
      if (defaultAction === "continue") {
        this.scheduler.unblock(thread);
        return signal;
      }
      this.scheduler.terminate(thread, 128 + signal);
      return signal;
    }
    if (pending.size === 0) this.pending.delete(thread.id);
    return null;
  }

  private pushFrame(thread: GuestThread): void {
    const stack = this.frames.get(thread.id) ?? [];
    if (stack.length >= MAX_SIGNAL_FRAMES) {
      this.scheduler.terminate(thread, 128 + SIGSEGV);
      return;
    }
    stack.push({
      registers: new BigUint64Array(thread.cpu.registers),
      sp: thread.cpu.sp,
      pc: thread.cpu.pc,
      nzcv: thread.cpu.nzcv,
    });
    this.frames.set(thread.id, stack);
  }
}

function isSignal(signal: number): boolean {
  return Number.isInteger(signal) && signal >= 1 && signal <= 31;
}

export function signalBit(signal: number): number {
  return 1 << (signal - 1);
}
