/**
 * pthread-shaped shim for guest threads.
 *
 * This is THR-004's first slice: create/join and mutex/condition primitives on
 * top of GuestScheduler. It is not libc yet; guest code reaches it through the
 * documented syscall numbers below (or tests call the API directly). The
 * remaining once/TLS/libc bindings are THR-004b.
 */

import type { GuestScheduler, GuestThread } from "./scheduler.js";

export const GUEST_PTHREAD_CREATE = 900;
export const GUEST_PTHREAD_JOIN = 901;
export const GUEST_PTHREAD_MUTEX_LOCK = 902;
export const GUEST_PTHREAD_MUTEX_UNLOCK = 903;
export const GUEST_PTHREAD_COND_WAIT = 904;
export const GUEST_PTHREAD_COND_SIGNAL = 905;

interface MutexState {
  owner: number | null;
  readonly waiters: GuestThread[];
}

interface CondState {
  readonly waiters: GuestThread[];
}

export interface PthreadCreateOptions {
  readonly argument?: bigint;
  readonly stackSize?: number;
  readonly label?: string;
}

export class PthreadShim {
  private readonly mutexes = new Map<number, MutexState>();
  private readonly conditions = new Map<number, CondState>();
  private readonly joinWaiters = new Map<number, GuestThread[]>();

  constructor(private readonly scheduler: GuestScheduler) {
    scheduler.setTerminateHandler((thread) => this.threadTerminated(thread));
  }

  create(entry: bigint, options: PthreadCreateOptions = {}): GuestThread {
    const stackSize = options.stackSize ?? 0x4000;
    const stack = this.scheduler.memory.allocate(stackSize, { tag: "guest-thread-stack" });
    return this.scheduler.createThread({
      entry,
      stackPointer: stack + BigInt(stackSize) - 16n,
      argument: options.argument,
      label: options.label,
    });
  }

  join(caller: GuestThread, target: GuestThread): boolean {
    if (target.state === "terminated") return true;
    const waiters = this.joinWaiters.get(target.id) ?? [];
    if (!waiters.includes(caller)) waiters.push(caller);
    this.joinWaiters.set(target.id, waiters);
    this.scheduler.block(caller, `join:${target.id}`);
    return false;
  }

  lock(thread: GuestThread, mutexId = 1): boolean {
    const mutex = this.mutex(mutexId);
    if (mutex.owner === null || mutex.owner === thread.id) {
      mutex.owner = thread.id;
      return true;
    }
    if (!mutex.waiters.includes(thread)) mutex.waiters.push(thread);
    this.scheduler.block(thread, `mutex:${mutexId}`);
    return false;
  }

  unlock(thread: GuestThread, mutexId = 1): boolean {
    const mutex = this.mutexes.get(mutexId);
    if (!mutex || mutex.owner !== thread.id) return false;
    mutex.owner = null;
    const next = mutex.waiters.shift();
    if (next) this.scheduler.unblock(next);
    return true;
  }

  wait(thread: GuestThread, conditionId: number, mutexId = 1): boolean {
    this.unlock(thread, mutexId);
    const condition = this.conditions.get(conditionId) ?? { waiters: [] };
    this.conditions.set(conditionId, condition);
    if (!condition.waiters.includes(thread)) condition.waiters.push(thread);
    this.scheduler.block(thread, `cond:${conditionId}`);
    return false;
  }

  signal(conditionId: number): boolean {
    const condition = this.conditions.get(conditionId);
    const next = condition?.waiters.shift();
    if (!next) return false;
    this.scheduler.unblock(next);
    return true;
  }

  private mutex(id: number): MutexState {
    let mutex = this.mutexes.get(id);
    if (!mutex) {
      mutex = { owner: null, waiters: [] };
      this.mutexes.set(id, mutex);
    }
    return mutex;
  }

  private threadTerminated(thread: GuestThread): void {
    const waiters = this.joinWaiters.get(thread.id);
    if (!waiters) return;
    this.joinWaiters.delete(thread.id);
    for (const waiter of waiters) this.scheduler.unblock(waiter);
  }
}
