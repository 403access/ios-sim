/**
 * Guest kqueue/kevent semantics (THR-008 extension).
 *
 * This is a semantic queue, not a native kernel object: filters are registered
 * in guest memory, readiness is signalled by the syscall layer, and timers use
 * the wall clock. It gives event-loop code a real kqueue-shaped API without
 * claiming Darwin's exact blocking/interruption behaviour.
 */

import { CompatError } from "../errors.js";

export class KqueueError extends CompatError {
  override name = "KqueueError";
}

export const EVFILT_READ = -1;
export const EVFILT_WRITE = -2;
export const EVFILT_TIMER = -7;
export const EVFILT_USER = -10;

export const EV_ADD = 0x0001;
export const EV_DELETE = 0x0002;
export const EV_ENABLE = 0x0004;
export const EV_DISABLE = 0x0008;
export const EV_ONESHOT = 0x0010;
export const EV_CLEAR = 0x0020;
export const EV_EOF = 0x8000;
export const EV_ERROR = 0x4000;

export interface KqueueEvent {
  readonly ident: number;
  readonly filter: number;
  readonly flags: number;
  readonly fflags: number;
  readonly data: bigint;
  readonly udata: bigint;
}

interface QueueEntry {
  event: KqueueEvent;
  ready: boolean;
  readonly deadline: number | null;
  readonly oneshot: boolean;
}

export class Kqueue {
  private readonly entries = new Map<string, QueueEntry>();

  add(event: KqueueEvent, now = Date.now()): void {
    const key = `${event.filter}:${event.ident}`;
    if ((event.flags & EV_DELETE) !== 0) {
      this.entries.delete(key);
      return;
    }
    if ((event.flags & EV_DISABLE) !== 0) return;
    const existing = this.entries.get(key);
    const deadline =
      event.filter === EVFILT_TIMER ? now + Number(event.data) : (existing?.deadline ?? null);
    this.entries.set(key, {
      event: { ...event, flags: event.flags & ~EV_ONESHOT },
      ready: existing?.ready ?? false,
      deadline,
      oneshot: (event.flags & EV_ONESHOT) !== 0,
    });
  }

  remove(filter: number, ident: number): boolean {
    return this.entries.delete(`${filter}:${ident}`);
  }

  signal(filter: number, ident: number): void {
    const entry = this.entries.get(`${filter}:${ident}`);
    if (entry) entry.ready = true;
  }

  poll(now = Date.now(), max = Number.MAX_SAFE_INTEGER): KqueueEvent[] {
    const output: KqueueEvent[] = [];
    for (const [key, entry] of this.entries) {
      const timerReady = entry.deadline !== null && now >= entry.deadline;
      if (!entry.ready && !timerReady) continue;
      output.push({ ...entry.event });
      if (entry.oneshot) this.entries.delete(key);
      else if (timerReady && entry.deadline !== null) {
        this.entries.set(key, { ...entry, ready: false, deadline: now + Number(entry.event.data) });
      } else if (entry.ready) {
        entry.ready = false;
      }
      if (output.length >= max) break;
    }
    return output;
  }

  size(): number {
    return this.entries.size;
  }
}
