/**
 * CF bridging and a small run loop (RT-008).
 *
 * Toll-free bridging is modelled as identity: an NSString/NSArray/NSDictionary
 * wrapped by CFBridging points at the same semantic value. Type IDs are stable
 * per kind, retain/release are explicit, and the run loop handles timers and
 * named sources with an injectable clock.
 *
 * This is not CoreFoundation's ABI, CFRunLoop's Mach ports, or CFRunLoopSource
 * layout.
 */

import { FoundationError } from "./collections.js";
import { NSArray, NSDictionary, NSString } from "./collections.js";
import type { ObjcObject } from "../objc/runtime.js";

export type CFKind = "string" | "array" | "dictionary" | "object";

export interface CFTypeRef {
  readonly kind: CFKind;
  readonly typeId: number;
  readonly value: unknown;
  retainCount: number;
  deallocated: boolean;
}

const TYPE_IDS: Record<CFKind, number> = {
  string: 1,
  array: 2,
  dictionary: 3,
  object: 4,
};

export class CFBridging {
  private nextId = 1;

  typeID(kind: CFKind): number {
    return TYPE_IDS[kind];
  }

  fromObject(value: NSString | NSArray<unknown> | NSDictionary<unknown> | ObjcObject): CFTypeRef {
    const kind: CFKind =
      value instanceof NSString
        ? "string"
        : value instanceof NSArray
          ? "array"
          : value instanceof NSDictionary
            ? "dictionary"
            : "object";
    return {
      kind,
      typeId: TYPE_IDS[kind],
      value,
      retainCount: 1,
      deallocated: false,
    };
  }

  /** Toll-free: the same semantic object is returned, not a copy. */
  toObject<T>(ref: CFTypeRef): T {
    if (ref.deallocated) throw new FoundationError("use_after_free", "CF ref was released");
    return ref.value as T;
  }

  retain(ref: CFTypeRef): CFTypeRef {
    if (ref.deallocated) throw new FoundationError("use_after_free", "CF ref was released");
    ref.retainCount += 1;
    return ref;
  }

  release(ref: CFTypeRef): boolean {
    if (ref.deallocated) return false;
    ref.retainCount -= 1;
    if (ref.retainCount > 0) return false;
    ref.deallocated = true;
    return true;
  }

  bridgeRetain(value: NSString | NSArray<unknown> | NSDictionary<unknown> | ObjcObject): CFTypeRef {
    return this.fromObject(value);
  }

  bridgeRelease(ref: CFTypeRef): void {
    this.release(ref);
  }

  nextToken(): string {
    return `cf-${this.nextId++}`;
  }
}

export interface CFRunLoopTimer {
  readonly id: number;
  readonly deadline: number;
  readonly intervalMs: number | null;
  readonly callback: () => void;
}

export class CFRunLoop {
  private readonly timers = new Map<number, CFRunLoopTimer>();
  private readonly sources = new Map<string, number>();
  private readonly callbacks = new Map<string, () => void>();
  private nextId = 1;
  private stopped = false;

  constructor(private readonly clock: () => number = Date.now) {}

  schedule(delayMs: number, callback: () => void, intervalMs: number | null = null): number {
    const id = this.nextId++;
    const interval = intervalMs && intervalMs > 0 ? intervalMs : null;
    this.timers.set(id, {
      id,
      deadline: this.clock() + Math.max(0, delayMs),
      intervalMs: interval,
      callback,
    });
    return id;
  }

  cancel(id: number): boolean {
    return this.timers.delete(id);
  }

  addSource(name: string, callback: () => void): void {
    if (name.length === 0) throw new FoundationError("bad_source", "source name cannot be empty");
    this.callbacks.set(name, callback);
    if (!this.sources.has(name)) this.sources.set(name, 0);
  }

  signalSource(name: string): boolean {
    if (!this.sources.has(name)) return false;
    this.sources.set(name, (this.sources.get(name) ?? 0) + 1);
    return true;
  }

  runOnce(now = this.clock()): number {
    if (this.stopped) return 0;
    let fired = 0;
    for (const timer of [...this.timers.values()].sort((a, b) => a.deadline - b.deadline)) {
      if (timer.deadline > now) continue;
      timer.callback();
      fired += 1;
      if (timer.intervalMs) {
        this.timers.set(timer.id, { ...timer, deadline: now + timer.intervalMs });
      } else {
        this.timers.delete(timer.id);
      }
      if (this.stopped) break;
    }
    for (const [name, count] of this.sources) {
      if (count <= 0) continue;
      this.sources.set(name, 0);
      this.callbacks.get(name)?.();
      fired += 1;
    }
    return fired;
  }

  runUntil(predicate: () => boolean, maxIterations = 1000): number {
    let total = 0;
    for (let index = 0; index < maxIterations; index += 1) {
      if (predicate() || this.stopped) break;
      total += this.runOnce();
    }
    return total;
  }

  stop(): void {
    this.stopped = true;
  }

  reset(): void {
    this.stopped = false;
  }

  pendingTimers(): readonly CFRunLoopTimer[] {
    return [...this.timers.values()];
  }
}
