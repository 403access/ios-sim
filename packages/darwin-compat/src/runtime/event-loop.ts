/**
 * Guest timers and event-loop wakeups (THR-008).
 *
 * A timer or readiness source parks a guest thread; `tick` expires it at the
 * next deadline or when a source becomes ready. There is no polling loop: the
 * scheduler only runs when an event is delivered or another thread is runnable.
 *
 * This is the semantic layer above the native condvar; a future native
 * kqueue/eventfd backend can implement the same source interface.
 */

import type { GuestScheduler, GuestThread } from "./scheduler.js";

export interface TimerEvent {
  readonly id: number;
  readonly firedAt: number;
}

interface TimerState {
  readonly id: number;
  readonly deadline: number;
  readonly thread: GuestThread | null;
  readonly callback: (() => void) | null;
  fired: boolean;
}

interface SourceState {
  ready: boolean;
  readonly waiters: Set<number>;
}

export class GuestEventLoop {
  private readonly timers = new Map<number, TimerState>();
  private readonly sources = new Map<string, SourceState>();
  private nextId = 1;

  constructor(
    private readonly scheduler: GuestScheduler,
    private readonly clock: () => number = Date.now,
  ) {}

  now(): number {
    return this.clock();
  }

  scheduleTimer(delayMs: number, thread?: GuestThread, callback?: () => void): number {
    const delay = Math.max(0, delayMs);
    const id = this.nextId++;
    const timer: TimerState = {
      id,
      deadline: this.clock() + delay,
      thread: thread ?? null,
      callback: callback ?? null,
      fired: false,
    };
    this.timers.set(id, timer);
    if (thread) this.scheduler.block(thread, `timer:${id}`);
    if (delay === 0) this.expire(timer);
    return id;
  }

  cancelTimer(id: number): boolean {
    return this.timers.delete(id);
  }

  isTimerFired(id: number): boolean {
    return this.timers.get(id)?.fired ?? false;
  }

  waitTimer(thread: GuestThread, id: number): boolean {
    const timer = this.timers.get(id);
    if (!timer) return false;
    if (timer.fired || timer.deadline <= this.clock()) {
      timer.fired = true;
      return true;
    }
    this.scheduler.block(thread, `timer:${id}`);
    return false;
  }

  /** Mark a named source ready; wakes all waiters or remembers readiness. */
  notify(name: string): void {
    let source = this.sources.get(name);
    if (!source) {
      source = { ready: false, waiters: new Set() };
      this.sources.set(name, source);
    }
    if (source.waiters.size > 0) {
      for (const threadId of source.waiters) {
        const thread = this.scheduler.listThreads().find((candidate) => candidate.id === threadId);
        if (thread) this.scheduler.unblock(thread);
      }
      source.waiters.clear();
      source.ready = true;
    } else {
      source.ready = true;
    }
  }

  waitSource(thread: GuestThread, name: string): boolean {
    let source = this.sources.get(name);
    if (!source) {
      source = { ready: false, waiters: new Set() };
      this.sources.set(name, source);
    }
    if (source.ready) {
      source.ready = false;
      return true;
    }
    source.waiters.add(thread.id);
    this.scheduler.block(thread, `source:${name}`);
    return false;
  }

  /** Expire due timers and return how many events fired. */
  tick(now = this.clock()): number {
    let fired = 0;
    for (const timer of this.timers.values()) {
      if (!timer.fired && timer.deadline <= now) {
        this.expire(timer);
        fired += 1;
      }
    }
    return fired;
  }

  nextDeadline(): number | null {
    let next: number | null = null;
    for (const timer of this.timers.values()) {
      if (timer.fired) continue;
      if (next === null || timer.deadline < next) next = timer.deadline;
    }
    return next;
  }

  activeTimers(): readonly TimerEvent[] {
    return [...this.timers.values()]
      .filter((timer) => !timer.fired)
      .map((timer) => ({ id: timer.id, firedAt: timer.deadline }));
  }

  private expire(timer: TimerState): void {
    timer.fired = true;
    timer.callback?.();
    if (timer.thread) this.scheduler.unblock(timer.thread);
  }
}
