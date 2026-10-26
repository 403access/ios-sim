/**
 * Blocks and associated objects (RT-005).
 *
 * Blocks are closures with explicit copy/retain/release, and associated
 * objects follow retain/copy/assign policies. Neither is Apple's block layout
 * or `objc_setAssociatedObject` ABI; the goal is to exercise lifetime rules.
 */

import { ObjcError, type ObjcObject } from "./runtime.js";
import type { ArcRuntime } from "./arc.js";

export type BlockBody = (...args: unknown[]) => unknown;

export interface ObjcBlock {
  readonly id: number;
  readonly body: BlockBody;
  readonly captured: ReadonlyMap<string, unknown>;
  retainCount: number;
  deallocated: boolean;
}

export class BlockRuntime {
  private nextId = 1;

  create(body: BlockBody, captured: Record<string, unknown> = {}): ObjcBlock {
    return {
      id: this.nextId++,
      body,
      captured: new Map(Object.entries(captured)),
      retainCount: 1,
      deallocated: false,
    };
  }

  retain(block: ObjcBlock): ObjcBlock {
    if (block.deallocated) throw new ObjcError("use_after_free", `block ${block.id} was released`);
    block.retainCount += 1;
    return block;
  }

  release(block: ObjcBlock): boolean {
    if (block.deallocated) return false;
    block.retainCount -= 1;
    if (block.retainCount > 0) return false;
    block.deallocated = true;
    return true;
  }

  copy(block: ObjcBlock): ObjcBlock {
    this.retain(block);
    return block;
  }

  call(block: ObjcBlock, ...args: unknown[]): unknown {
    if (block.deallocated) throw new ObjcError("use_after_free", `block ${block.id} was released`);
    return block.body(...args);
  }
}

export type AssociationPolicy = "retain" | "copy" | "assign";

interface Association {
  readonly value: unknown;
  readonly policy: AssociationPolicy;
}

export class ObjcAssociations {
  private readonly store = new WeakMap<ObjcObject, Map<string, Association>>();

  constructor(private readonly arc: ArcRuntime) {
    arc.onDealloc((object) => this.purge(object));
  }

  set(object: ObjcObject, key: string, value: unknown, policy: AssociationPolicy = "retain"): void {
    if (key.length === 0) throw new ObjcError("bad_key", "association key cannot be empty");
    let map = this.store.get(object);
    if (!map) {
      map = new Map();
      this.store.set(object, map);
    }
    const previous = map.get(key);
    if (previous?.policy === "retain" && isObject(previous.value)) this.arc.release(previous.value);
    if (policy === "retain" && isObject(value)) this.arc.retain(value);
    map.set(key, { value, policy });
  }

  get(object: ObjcObject, key: string): unknown {
    return this.store.get(object)?.get(key)?.value;
  }

  remove(object: ObjcObject, key: string): void {
    const map = this.store.get(object);
    const previous = map?.get(key);
    if (previous?.policy === "retain" && isObject(previous.value)) this.arc.release(previous.value);
    map?.delete(key);
  }

  purge(object: ObjcObject): void {
    const map = this.store.get(object);
    if (!map) return;
    for (const { value, policy } of map.values()) {
      if (policy === "retain" && isObject(value)) this.arc.release(value);
    }
    this.store.delete(object);
  }
}

function isObject(value: unknown): value is ObjcObject {
  return typeof value === "object" && value !== null && "isa" in value;
}
