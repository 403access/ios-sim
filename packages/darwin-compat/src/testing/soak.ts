/**
 * Bounded soak/leak harness (QA-006).
 *
 * The harness repeatedly executes a step and samples resource counters. It
 * reports the first/last sample and fails when growth exceeds the per-metric
 * tolerance. A 24-hour soak uses the same code with `durationMs: 86_400_000`;
 * the unit test runs a short version so CI stays fast.
 *
 * Samples are deliberately counter-based (object tables, mapped bytes), not
 * heap size: JS GC makes heap-used a noisy leak signal, while an unbounded
 * Mach table or image cache is the failure this project actually cares about.
 */

export type SoakMetrics = Readonly<Record<string, number>>;

export interface SoakCase {
  readonly name: string;
  /** One unit of work, repeated until the duration elapses. */
  step(): void;
  /** Current resource counters for this case. */
  sample(): SoakMetrics;
  /** Allowed last-minus-first growth per metric. Defaults to 0. */
  readonly tolerance?: SoakMetrics;
}

export interface SoakSample {
  readonly elapsedMs: number;
  readonly metrics: SoakMetrics;
}

export interface SoakCaseReport {
  readonly name: string;
  readonly steps: number;
  readonly first: SoakMetrics;
  readonly last: SoakMetrics;
  readonly growth: SoakMetrics;
  readonly tolerances: SoakMetrics;
  readonly passed: boolean;
  readonly samples: readonly SoakSample[];
}

export interface SoakReport {
  readonly durationMs: number;
  readonly intervalMs: number;
  readonly cases: readonly SoakCaseReport[];
  readonly passed: boolean;
}

export interface SoakOptions {
  readonly durationMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export function runSoak(cases: readonly SoakCase[], options: SoakOptions = {}): SoakReport {
  const durationMs = Math.max(0, options.durationMs ?? 1000);
  const intervalMs = Math.max(1, options.intervalMs ?? 100);
  const now = options.now ?? (() => Date.now());
  const reports: SoakCaseReport[] = [];

  for (const soakCase of cases) {
    const started = now();
    let lastSampleAt = started;
    let steps = 0;
    let first: SoakMetrics | null = null;
    let last: SoakMetrics = {};
    const samples: SoakSample[] = [];

    while (now() - started < durationMs) {
      soakCase.step();
      steps += 1;
      const elapsed = now() - started;
      if (elapsed - lastSampleAt >= intervalMs || first === null) {
        lastSampleAt = elapsed;
        last = soakCase.sample();
        if (first === null) first = last;
        samples.push({ elapsedMs: elapsed, metrics: last });
      }
    }
    if (first === null) {
      first = soakCase.sample();
      last = first;
      samples.push({ elapsedMs: 0, metrics: first });
    }

    const tolerances = soakCase.tolerance ?? {};
    const growth: Record<string, number> = {};
    let passed = true;
    for (const key of Object.keys(last)) {
      const delta = (last[key] ?? 0) - (first[key] ?? 0);
      growth[key] = delta;
      if (delta > (tolerances[key] ?? 0)) passed = false;
    }
    reports.push({ name: soakCase.name, steps, first, last, growth, tolerances, passed, samples });
  }

  return {
    durationMs,
    intervalMs,
    cases: reports,
    passed: reports.every((report) => report.passed),
  };
}
