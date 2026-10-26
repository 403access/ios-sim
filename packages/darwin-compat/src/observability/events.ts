/**
 * Versioned runtime event schema (OBS-001).
 *
 * Events are deliberately small and JSON-safe: bigint addresses become hex
 * strings, dates become ISO strings, and sensitive keys are redacted before
 * serialization. The schema is versioned independently of the host ABI so a
 * trace consumer can reject an incompatible stream instead of guessing.
 */

import { CompatError } from "../errors.js";

export const EVENT_SCHEMA_VERSION = 1;

export type EventLevel = "debug" | "info" | "warn" | "error";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface RuntimeEvent {
  readonly version: typeof EVENT_SCHEMA_VERSION;
  readonly id: string;
  /** ISO-8601 timestamp. */
  readonly time: string;
  readonly type: string;
  readonly level: EventLevel;
  readonly pid?: number;
  readonly thread?: number;
  readonly data: { readonly [key: string]: JsonValue };
}

export const EVENT_TYPES = {
  processStart: "process.start",
  processExit: "process.exit",
  imageLoad: "image.load",
  loaderError: "loader.error",
  syscallUnsupported: "syscall.unsupported",
  machMessage: "mach.message",
  symbolMissing: "symbol.missing",
  memoryPressure: "memory.pressure",
} as const;

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const REDACT_KEYS = /token|secret|password|credential|entitlement/i;

export class ObservabilityError extends CompatError {
  override name = "ObservabilityError";
}

export interface EventOptions {
  readonly level?: EventLevel;
  readonly pid?: number;
  readonly thread?: number;
  /** Injectable clock/id source for deterministic tests. */
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

export interface RecorderOptions {
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly maxEvents?: number;
}

/** Convert arbitrary runtime values into the JSON-safe schema domain. */
export function jsonSafe(value: unknown, key = ""): JsonValue {
  if (REDACT_KEYS.test(key)) return "[redacted]";
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `base64:${Buffer.from(value).toString("base64")}`;
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      out[entryKey] = jsonSafe(entryValue, entryKey);
    }
    return out;
  }
  return String(value);
}

export class EventRecorder {
  private readonly events: RuntimeEvent[] = [];
  private sequence = 0;
  private readonly now: () => Date;
  private readonly nextId: () => string;
  private readonly maxEvents: number;

  constructor(options: RecorderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => `evt-${this.sequence + 1}`);
    this.maxEvents = Math.max(1, options.maxEvents ?? 100_000);
  }

  emit(
    type: string,
    data: Record<string, unknown> = {},
    options: Omit<EventOptions, "now" | "nextId"> = {},
  ): RuntimeEvent {
    if (type.length === 0) {
      throw new ObservabilityError("bad_event", "event type cannot be empty");
    }
    const event: RuntimeEvent = {
      version: EVENT_SCHEMA_VERSION,
      id: this.nextId(),
      time: this.now().toISOString(),
      type,
      level: options.level ?? "info",
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.thread !== undefined ? { thread: options.thread } : {}),
      data: jsonSafe(data) as { readonly [key: string]: JsonValue },
    };
    validateEvent(event);
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    return event;
  }

  list(): readonly RuntimeEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }

  toJSON(): string {
    return JSON.stringify({
      version: EVENT_SCHEMA_VERSION,
      events: this.events,
    });
  }

  toNDJSON(): string {
    return this.events.map((event) => JSON.stringify(event)).join("\n");
  }
}

export function validateEvent(value: unknown): RuntimeEvent {
  if (typeof value !== "object" || value === null) {
    throw new ObservabilityError("bad_event", "event must be an object");
  }
  const event = value as Partial<RuntimeEvent>;
  if (event.version !== EVENT_SCHEMA_VERSION) {
    throw new ObservabilityError(
      "bad_event_version",
      `event version ${String(event.version)} is not ${EVENT_SCHEMA_VERSION}`,
    );
  }
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new ObservabilityError("bad_event_id", "event id must be a non-empty string");
  }
  if (typeof event.type !== "string" || event.type.length === 0) {
    throw new ObservabilityError("bad_event_type", "event type must be a non-empty string");
  }
  if (typeof event.time !== "string" || Number.isNaN(Date.parse(event.time))) {
    throw new ObservabilityError("bad_event_time", "event time must be an ISO timestamp");
  }
  if (typeof event.level !== "string" || !LEVELS.has(event.level)) {
    throw new ObservabilityError("bad_event_level", `unknown event level ${String(event.level)}`);
  }
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
    throw new ObservabilityError("bad_event_data", "event data must be an object");
  }
  return event as RuntimeEvent;
}

/** Parse an NDJSON event stream, rejecting the first malformed line. */
export function parseEventStream(text: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ObservabilityError("bad_event_json", `event line ${index + 1} is not JSON`);
    }
    events.push(validateEvent(parsed));
  }
  return events;
}
