/**
 * Ivars, properties, and ARC (RT-003).
 *
 * ARC here is a reference-count model, not compiler-inserted retain/release:
 * `retain`/`release`/`autorelease` are explicit, strong ivars retain their
 * values, and weak ivars are zeroed on dealloc. This is enough to exercise
 * ownership bugs in the runtime without claiming Apple's ABI.
 */

import { ObjcError, isObjcObject, ObjcRuntime, type ObjcObject } from "./runtime.js";

export interface PropertyOptions {
  readonly strong?: boolean;
  readonly weak?: boolean;
}

export class ArcRuntime {
  private readonly counts = new WeakMap<ObjcObject, number>();
  private readonly deallocated = new WeakSet<ObjcObject>();
  private readonly strong = new WeakMap<ObjcObject, Set<ObjcObject>>();
  private readonly weak = new WeakMap<ObjcObject, Array<{ owner: ObjcObject; ivar: string }>>();
  private readonly pool: ObjcObject[] = [];
  private readonly deallocHooks: Array<(object: ObjcObject) => void> = [];

  constructor(readonly objc: ObjcRuntime) {}

  /** Run a hook when an object is deallocated; used by associated objects. */
  onDealloc(hook: (object: ObjcObject) => void): void {
    this.deallocHooks.push(hook);
  }

  init(object: ObjcObject): ObjcObject {
    this.counts.set(object, 1);
    return object;
  }

  retain(object: ObjcObject): ObjcObject {
    if (this.deallocated.has(object)) {
      throw new ObjcError("use_after_free", `object of class ${object.isa.name} was deallocated`);
    }
    this.counts.set(object, (this.counts.get(object) ?? 1) + 1);
    return object;
  }

  release(object: ObjcObject): boolean {
    if (this.deallocated.has(object)) return false;
    const next = (this.counts.get(object) ?? 1) - 1;
    this.counts.set(object, next);
    if (next > 0) return false;
    this.dealloc(object);
    return true;
  }

  retainCount(object: ObjcObject): number {
    return this.counts.get(object) ?? 1;
  }

  autorelease(object: ObjcObject): ObjcObject {
    this.pool.push(object);
    return object;
  }

  drainPool(): number {
    const objects = this.pool.splice(0);
    for (const object of objects) this.release(object);
    return objects.length;
  }

  setStrong(owner: ObjcObject, ivar: string, value: ObjcObject | null): void {
    const previous = owner.get(ivar);
    let refs = this.strong.get(owner);
    if (isObjcObject(previous)) {
      this.release(previous);
      refs?.delete(previous);
    }
    if (value) {
      this.retain(value);
      if (!refs) {
        refs = new Set();
        this.strong.set(owner, refs);
      }
      refs.add(value);
    }
    owner.set(ivar, value);
  }

  setWeak(owner: ObjcObject, ivar: string, value: ObjcObject | null): void {
    owner.set(ivar, value);
    if (!value) return;
    const refs = this.weak.get(value) ?? [];
    refs.push({ owner, ivar });
    this.weak.set(value, refs);
  }

  dealloc(object: ObjcObject): void {
    if (this.deallocated.has(object)) return;
    this.deallocated.add(object);
    for (const ref of this.strong.get(object) ?? []) this.release(ref);
    this.strong.delete(object);
    for (const { owner, ivar } of this.weak.get(object) ?? []) owner.ivars.set(ivar, null);
    this.weak.delete(object);
    object.ivars.clear();
    this.counts.delete(object);
    for (const hook of this.deallocHooks) hook(object);
  }
}

export function synthesizeProperty(
  objc: ObjcRuntime,
  arc: ArcRuntime,
  className: string,
  name: string,
  options: PropertyOptions = {},
): string {
  const ivar = `_${name}`;
  objc.addIvar(className, ivar);
  const setter = `set${name[0]?.toUpperCase() ?? ""}${name.slice(1)}:`;
  objc.addMethod(className, name, (self) => self.get(ivar) ?? null);
  objc.addMethod(className, setter, (self, _selector, args) => {
    const value = (args[0] as ObjcObject | null | undefined) ?? null;
    if (options.weak) arc.setWeak(self, ivar, value);
    else if (options.strong ?? true) arc.setStrong(self, ivar, value);
    else self.set(ivar, value);
    return undefined;
  });
  return `${name}/${setter}`;
}
