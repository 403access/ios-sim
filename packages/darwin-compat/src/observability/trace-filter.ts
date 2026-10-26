/**
 * Trace filtering (DX-002).
 *
 * Filters are applied before export so a trace file stays small. Type patterns
 * support a trailing `*` (for example `process.*`), levels are exact, and
 * pid/thread restrict to one stream.
 */

import type { EventLevel, RuntimeEvent } from "./events.js";

export interface TraceFilter {
  readonly types?: readonly string[];
  readonly levels?: readonly EventLevel[];
  readonly pid?: number;
  readonly thread?: number;
  readonly limit?: number;
}

export interface TraceSummary {
  readonly total: number;
  readonly kept: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly byLevel: Readonly<Record<string, number>>;
}

export function matchesType(type: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern,
  );
}

export function filterEvents(
  events: readonly RuntimeEvent[],
  filter: TraceFilter = {},
): RuntimeEvent[] {
  const kept = events.filter((event) => {
    if (!matchesType(event.type, filter.types)) return false;
    if (filter.levels && filter.levels.length > 0 && !filter.levels.includes(event.level))
      return false;
    if (filter.pid !== undefined && event.pid !== filter.pid) return false;
    if (filter.thread !== undefined && event.thread !== filter.thread) return false;
    return true;
  });
  return filter.limit !== undefined ? kept.slice(0, Math.max(0, filter.limit)) : kept;
}

export function summarizeEvents(
  events: readonly RuntimeEvent[],
  kept: readonly RuntimeEvent[],
): TraceSummary {
  const byType: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  for (const event of kept) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    byLevel[event.level] = (byLevel[event.level] ?? 0) + 1;
  }
  return { total: events.length, kept: kept.length, byType, byLevel };
}

export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
