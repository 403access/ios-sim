/**
 * Chrome Trace Event export (OBS-004).
 *
 * Runtime events are exported as the Chrome `traceEvents` JSON format:
 * process start/exit become complete (`ph: "X"`) slices, everything else is an
 * instant (`ph: "i"`). Timestamps are microseconds from the first event.
 *
 * The format is intentionally lossless for the fields Chrome renders while
 * keeping the original event id/type in `args`.
 */

import { EVENT_TYPES, type RuntimeEvent } from "./events.js";

export interface ChromeTraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ph: "X" | "i" | "M";
  readonly ts: number;
  readonly pid: number;
  readonly tid: number;
  readonly dur?: number;
  readonly s?: "t";
  readonly args: Record<string, unknown>;
}

export interface ChromeTrace {
  readonly traceEvents: readonly ChromeTraceEvent[];
  readonly displayTimeUnit: "ms";
  readonly metadata: {
    readonly source: "ios-sim-native";
    readonly eventCount: number;
  };
}

export function exportChromeTrace(events: readonly RuntimeEvent[]): ChromeTrace {
  const first = events[0] ? Date.parse(events[0].time) : Date.now();
  const startByPid = new Map<number, { ts: number; event: RuntimeEvent }>();
  const traceEvents: ChromeTraceEvent[] = [];
  for (const event of events) {
    const pid = event.pid ?? 0;
    const tid = event.thread ?? 0;
    const ts = Math.max(0, (Date.parse(event.time) - first) * 1000);
    if (event.type === EVENT_TYPES.processStart) {
      startByPid.set(pid, { ts, event });
      continue;
    }
    if (event.type === EVENT_TYPES.processExit) {
      const start = startByPid.get(pid);
      startByPid.delete(pid);
      traceEvents.push({
        name: "process",
        cat: "process",
        ph: "X",
        ts: start?.ts ?? ts,
        dur: Math.max(0, ts - (start?.ts ?? ts)),
        pid,
        tid,
        args: {
          start: start?.event.data ?? {},
          exit: event.data,
        },
      });
      continue;
    }
    traceEvents.push({
      name: event.type,
      cat: event.type.split(".")[0] ?? "event",
      ph: "i",
      s: "t",
      ts,
      pid,
      tid,
      args: { id: event.id, level: event.level, ...event.data },
    });
  }

  // Close unmatched process starts so a truncated trace still renders.
  for (const [pid, start] of startByPid) {
    traceEvents.push({
      name: "process",
      cat: "process",
      ph: "X",
      ts: start.ts,
      dur: 0,
      pid,
      tid: 0,
      args: { start: start.event.data, exit: null },
    });
  }

  traceEvents.sort((a, b) => a.ts - b.ts);
  return {
    traceEvents,
    displayTimeUnit: "ms",
    metadata: { source: "ios-sim-native", eventCount: events.length },
  };
}

export function chromeTraceJSON(events: readonly RuntimeEvent[]): string {
  return JSON.stringify(exportChromeTrace(events), null, 2);
}
