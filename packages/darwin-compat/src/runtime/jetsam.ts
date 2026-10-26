/**
 * Jetsam and memory-pressure policy (THR-010).
 *
 * This is a policy layer, not an MMU: callers report per-pid footprints and
 * priorities, then ask `applyPressure()` to pick victims. Killing is delegated
 * through a callback so the same policy works with a ProcessTable, the native
 * Mach kernel, or a test double.
 *
 * Policy: warning/critical pressure is delivered to every task; only critical
 * pressure kills, preferring background, then daemons, then foreground, and
 * always the largest footprint within a class. Foreground is killed only when
 * the limit cannot otherwise be met.
 */

export type PressureLevel = "normal" | "warning" | "critical";
export type JetsamPriority = "background" | "daemon" | "foreground";

export interface JetsamTask {
  readonly pid: number;
  footprintBytes: number;
  priority: JetsamPriority;
}

export interface PressureEvent {
  readonly level: PressureLevel;
  readonly pid: number;
  readonly footprintBytes: number;
  readonly limitBytes: number;
  readonly killed: boolean;
}

export interface PressureResult {
  readonly level: PressureLevel;
  readonly killed: readonly number[];
  readonly remainingBytes: number;
  readonly limitBytes: number;
  readonly events: readonly PressureEvent[];
}

export interface JetsamOptions {
  /** Called for each victim; typically exits the process or destroys the task. */
  readonly kill?: (pid: number, level: PressureLevel) => void;
  /** Called for every task when pressure is warning/critical. */
  readonly notify?: (event: PressureEvent) => void;
}

const PRIORITY_ORDER: readonly JetsamPriority[] = ["background", "daemon", "foreground"];

export class Jetsam {
  private readonly tasks = new Map<number, JetsamTask>();
  private readonly options: JetsamOptions;

  constructor(options: JetsamOptions = {}) {
    this.options = options;
  }

  register(pid: number, footprintBytes = 0, priority: JetsamPriority = "foreground"): void {
    if (this.tasks.has(pid)) throw new Error(`jetsam: pid ${pid} is already registered`);
    this.tasks.set(pid, { pid, footprintBytes: Math.max(0, footprintBytes), priority });
  }

  unregister(pid: number): void {
    this.tasks.delete(pid);
  }

  setFootprint(pid: number, footprintBytes: number): void {
    const task = this.require(pid);
    task.footprintBytes = Math.max(0, footprintBytes);
  }

  setPriority(pid: number, priority: JetsamPriority): void {
    this.require(pid).priority = priority;
  }

  totalFootprint(): number {
    let total = 0;
    for (const task of this.tasks.values()) total += task.footprintBytes;
    return total;
  }

  list(): readonly JetsamTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  applyPressure(level: PressureLevel, limitBytes: number): PressureResult {
    const limit = Math.max(0, limitBytes);
    const events: PressureEvent[] = [];
    for (const task of this.tasks.values()) {
      this.options.notify?.({
        level,
        pid: task.pid,
        footprintBytes: task.footprintBytes,
        limitBytes: limit,
        killed: false,
      });
    }
    if (level !== "critical" || this.totalFootprint() <= limit) {
      return {
        level,
        killed: [],
        remainingBytes: this.totalFootprint(),
        limitBytes: limit,
        events,
      };
    }

    const killed: number[] = [];
    for (const priority of PRIORITY_ORDER) {
      const candidates = [...this.tasks.values()]
        .filter((task) => task.priority === priority)
        .sort((a, b) => b.footprintBytes - a.footprintBytes || a.pid - b.pid);
      for (const task of candidates) {
        if (this.totalFootprint() <= limit) break;
        this.tasks.delete(task.pid);
        killed.push(task.pid);
        const event: PressureEvent = {
          level,
          pid: task.pid,
          footprintBytes: task.footprintBytes,
          limitBytes: limit,
          killed: true,
        };
        events.push(event);
        this.options.notify?.(event);
        this.options.kill?.(task.pid, level);
      }
      if (this.totalFootprint() <= limit) break;
    }

    return {
      level,
      killed,
      remainingBytes: this.totalFootprint(),
      limitBytes: limit,
      events,
    };
  }

  private require(pid: number): JetsamTask {
    const task = this.tasks.get(pid);
    if (!task) throw new Error(`jetsam: pid ${pid} is not registered`);
    return task;
  }
}
