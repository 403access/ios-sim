/**
 * Guest clock and Mach timebase (THR-009).
 *
 * Realtime/monotonic nanoseconds come from an injectable source, so tests are
 * deterministic. Sleep is implemented by parking the guest thread on a
 * GuestEventLoop timer; there is no busy wait.
 */

import type { GuestEventLoop } from "./event-loop.js";
import type { GuestThread } from "./scheduler.js";

export const CLOCK_REALTIME = 0;
export const CLOCK_MONOTONIC = 1;

export interface TimebaseInfo {
  readonly numer: number;
  readonly denom: number;
}

export interface GuestClockOptions {
  readonly now?: () => number;
  readonly timebase?: TimebaseInfo;
}

export class GuestClock {
  private readonly source: () => number;
  readonly timebase: TimebaseInfo;
  private readonly startedAt: number;

  constructor(options: GuestClockOptions = {}) {
    this.source = options.now ?? Date.now;
    this.timebase = options.timebase ?? { numer: 1, denom: 1 };
    this.startedAt = this.source();
  }

  /** Nanoseconds for `CLOCK_REALTIME` or `CLOCK_MONOTONIC`. */
  now(clockId = CLOCK_REALTIME): bigint {
    const milliseconds =
      clockId === CLOCK_MONOTONIC ? this.source() - this.startedAt : this.source();
    return BigInt(Math.floor(milliseconds)) * 1_000_000n;
  }

  /** Mach absolute time in timebase ticks (defaults to nanoseconds). */
  absoluteTime(): bigint {
    return (this.now(CLOCK_MONOTONIC) * BigInt(this.timebase.denom)) / BigInt(this.timebase.numer);
  }

  /** Convert absolute time ticks to nanoseconds. */
  absoluteToNanoseconds(ticks: bigint): bigint {
    return (ticks * BigInt(this.timebase.numer)) / BigInt(this.timebase.denom);
  }

  /** Park the thread until the event-loop timer expires. */
  sleep(thread: GuestThread, milliseconds: number, eventLoop: GuestEventLoop): number {
    return eventLoop.scheduleTimer(milliseconds, thread);
  }

  /** Convenience for delay-based tests and timers. */
  deadlineFromNow(milliseconds: number, clockId = CLOCK_MONOTONIC): bigint {
    return this.now(clockId) + BigInt(Math.max(0, milliseconds)) * 1_000_000n;
  }
}
