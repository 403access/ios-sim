/**
 * Performance baseline suite (QA-004).
 *
 * Every benchmark records machine metadata and a generous wall-clock budget.
 * Budgets are regression tripwires for CI, not claims about simulator
 * performance: a faster host will beat them, a slower one must be reported
 * with its metadata rather than silently failing.
 */

import { cpus, arch, platform, release, totalmem } from "node:os";

export interface MachineMetadata {
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly cpu: string;
  readonly cores: number;
  readonly memoryBytes: number;
  readonly runtime: string;
  readonly runtimeVersion: string;
}

export interface BenchmarkCase {
  readonly name: string;
  readonly iterations: number;
  readonly budgetMs: number;
  run(): void;
}

export interface BenchmarkResult {
  readonly name: string;
  readonly iterations: number;
  readonly totalMs: number;
  readonly microsecondsPerOp: number;
  readonly budgetMs: number;
  readonly passed: boolean;
}

export interface BenchmarkReport {
  readonly machine: MachineMetadata;
  readonly startedAt: string;
  readonly scale: number;
  readonly results: readonly BenchmarkResult[];
  readonly passed: boolean;
}

export interface BenchmarkOptions {
  /** Multiply every case's iteration count; tests use a small scale. */
  readonly scale?: number;
  /** Optional per-case progress hook. */
  readonly onResult?: (result: BenchmarkResult) => void;
}

export function machineMetadata(): MachineMetadata {
  const cpuList = cpus();
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpuList[0]?.model ?? "unknown",
    cores: cpuList.length,
    memoryBytes: totalmem(),
    runtime: "bun",
    runtimeVersion: (process.versions as Record<string, string | undefined>).bun ?? process.version,
  };
}

export function runBenchmarks(
  cases: readonly BenchmarkCase[],
  options: BenchmarkOptions = {},
): BenchmarkReport {
  const scale = Math.max(0.001, options.scale ?? 1);
  const results: BenchmarkResult[] = [];
  for (const benchmark of cases) {
    const iterations = Math.max(1, Math.round(benchmark.iterations * scale));
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) benchmark.run();
    const totalMs = performance.now() - started;
    const result: BenchmarkResult = {
      name: benchmark.name,
      iterations,
      totalMs: Math.round(totalMs * 1000) / 1000,
      microsecondsPerOp: Math.round((totalMs * 1000 * 1000) / iterations) / 1000,
      budgetMs: benchmark.budgetMs,
      passed: totalMs <= benchmark.budgetMs,
    };
    results.push(result);
    options.onResult?.(result);
  }
  return {
    machine: machineMetadata(),
    startedAt: new Date().toISOString(),
    scale,
    results,
    passed: results.every((result) => result.passed),
  };
}

export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines = [
    `machine: ${report.machine.cpu} (${report.machine.cores} cores, ${Math.round(report.machine.memoryBytes / 1024 / 1024 / 1024)} GiB)`,
    `platform: ${report.machine.platform}/${report.machine.arch} ${report.machine.release}`,
    `runtime: ${report.machine.runtime} ${report.machine.runtimeVersion}`,
    `started: ${report.startedAt} (scale ${report.scale})`,
    "",
    "benchmark                 iterations      total ms    us/op    budget    status",
  ];
  for (const result of report.results) {
    lines.push(
      `${result.name.padEnd(24)} ${String(result.iterations).padStart(10)} ${String(result.totalMs).padStart(13)} ${String(result.microsecondsPerOp).padStart(8)} ${String(result.budgetMs).padStart(8)}    ${result.passed ? "ok" : "OVER"}`,
    );
  }
  return lines.join("\n");
}
