/**
 * Runtime counters (OBS-002).
 *
 * Counters are process-local, monotonic until `reset()`, and intentionally
 * cheap: a Map of numbers, no timers or sampling thread. The doctor/stats CLI
 * prints a snapshot so a run can be compared without attaching a profiler.
 */

export const RUNTIME_COUNTER_NAMES = [
  "processesStarted",
  "processesExited",
  "imagesLoaded",
  "instructions",
  "syscalls",
  "unsupportedSyscalls",
  "loaderErrors",
  "fixupBinds",
  "fixupRebases",
  "bytesStdout",
  "bytesStderr",
] as const;

export type RuntimeCounterName = (typeof RUNTIME_COUNTER_NAMES)[number];

export type RuntimeStatsSnapshot = Readonly<Record<RuntimeCounterName, number>>;

export class RuntimeStats {
  private readonly counters = new Map<RuntimeCounterName, number>();

  increment(name: RuntimeCounterName, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  get(name: RuntimeCounterName): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): RuntimeStatsSnapshot {
    const out = {} as Record<RuntimeCounterName, number>;
    for (const name of RUNTIME_COUNTER_NAMES) out[name] = this.get(name);
    return out;
  }

  reset(): void {
    this.counters.clear();
  }
}
