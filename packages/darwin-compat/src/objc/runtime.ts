/**
 * Clean-room Objective-C runtime core (RT-001).
 *
 * This is a semantic class/selector/method model, not Apple's ABI: it does not
 * lay out `objc_class` bitfields, trampolines, or the arm64 `objc_msgSend`
 * calling convention. It gives the loader/runtime a correct dispatch model
 * that later tasks (message cache, ivars/ARC, categories) can build on.
 *
 * Unknown selectors throw `ObjcError` with a stable code; `nil` receivers
 * return `undefined`, matching messaging nil.
 */

import { CompatError } from "../errors.js";

export type ObjcIMP = (receiver: ObjcObject, selector: string, args: readonly unknown[]) => unknown;

export function isObjcObject(value: unknown): value is ObjcObject {
  return value instanceof ObjcObject;
}

export class ObjcError extends CompatError {
  override name = "ObjcError";
}

export class ObjcClass {
  readonly name: string;
  readonly superclass: ObjcClass | null;
  private readonly methods = new Map<string, ObjcIMP>();
  private readonly ivars: string[] = [];

  constructor(name: string, superclass: ObjcClass | null) {
    this.name = name;
    this.superclass = superclass;
  }

  addMethod(selector: string, implementation: ObjcIMP): void {
    if (selector.length === 0) throw new ObjcError("bad_selector", "selector cannot be empty");
    this.methods.set(selector, implementation);
  }

  addIvar(name: string): void {
    if (this.ivars.includes(name)) {
      throw new ObjcError("duplicate_ivar", `ivar ${name} already exists on ${this.name}`);
    }
    this.ivars.push(name);
  }

  method(selector: string): ObjcIMP | undefined {
    return this.methods.get(selector);
  }

  lookup(selector: string): { implementation: ObjcIMP; owner: ObjcClass } | null {
    for (let cursor: ObjcClass | null = this; cursor; cursor = cursor.superclass) {
      const implementation = cursor.methods.get(selector);
      if (implementation) return { implementation, owner: cursor };
    }
    return null;
  }

  respondsTo(selector: string): boolean {
    return this.lookup(selector) !== null;
  }

  ivarNames(): readonly string[] {
    const names: string[] = [];
    for (let cursor: ObjcClass | null = this; cursor; cursor = cursor.superclass) {
      names.push(...cursor.ivars);
    }
    return names;
  }
}

export class ObjcObject {
  readonly isa: ObjcClass;
  readonly ivars = new Map<string, unknown>();

  constructor(isa: ObjcClass) {
    this.isa = isa;
  }

  get(ivar: string): unknown {
    return this.ivars.get(ivar);
  }

  set(ivar: string, value: unknown): void {
    if (!this.isa.ivarNames().includes(ivar)) {
      throw new ObjcError("unknown_ivar", `${this.isa.name} has no ivar ${ivar}`);
    }
    this.ivars.set(ivar, value);
  }
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
}

export type ObjcForwardHandler = (
  receiver: ObjcObject,
  selector: string,
  args: readonly unknown[],
) => unknown;

export interface DispatchRecord {
  readonly owner: string;
  readonly selector: string;
  readonly calls: number;
}

export interface ObjcProtocol {
  readonly name: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export class ObjcRuntime {
  private readonly classes = new Map<string, ObjcClass>();
  private readonly selectors = new Set<string>();
  private readonly cache = new Map<string, Map<string, ObjcIMP>>();
  private readonly dispatchCounts = new Map<string, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private forwardHandler: ObjcForwardHandler | null = null;
  private readonly categories = new Map<string, string[]>();
  private readonly protocols = new Map<string, ObjcProtocol>();
  private readonly conformances = new Map<string, Set<string>>();

  registerClass(name: string, superclassName?: string): ObjcClass {
    if (name.length === 0) throw new ObjcError("bad_class", "class name cannot be empty");
    if (this.classes.has(name)) {
      throw new ObjcError("duplicate_class", `class ${name} already registered`);
    }
    const superclass = superclassName ? this.requireClass(superclassName) : null;
    const created = new ObjcClass(name, superclass);
    this.classes.set(name, created);
    this.cache.delete(name);
    return created;
  }

  getClass(name: string): ObjcClass | undefined {
    return this.classes.get(name);
  }

  requireClass(name: string): ObjcClass {
    const found = this.classes.get(name);
    if (!found) throw new ObjcError("unknown_class", `class ${name} is not registered`);
    return found;
  }

  addMethod(className: string, selector: string, implementation: ObjcIMP): void {
    const cls = this.requireClass(className);
    this.selectors.add(selector);
    cls.addMethod(selector, implementation);
    this.invalidate(className);
  }

  addIvar(className: string, name: string): void {
    this.requireClass(className).addIvar(name);
  }

  allocate(className: string): ObjcObject {
    return new ObjcObject(this.requireClass(className));
  }

  /** Attach a category; methods override existing ones, later categories win. */
  addCategory(
    className: string,
    categoryName: string,
    methods: Readonly<Record<string, ObjcIMP>>,
  ): void {
    if (categoryName.length === 0)
      throw new ObjcError("bad_category", "category name cannot be empty");
    this.requireClass(className);
    this.categories.set(className, [...(this.categories.get(className) ?? []), categoryName]);
    for (const [selector, implementation] of Object.entries(methods)) {
      this.addMethod(className, selector, implementation);
    }
  }

  categoriesFor(className: string): readonly string[] {
    const inherited: string[] = [];
    for (
      let cursor: ObjcClass | null = this.requireClass(className);
      cursor;
      cursor = cursor.superclass
    ) {
      inherited.push(...(this.categories.get(cursor.name) ?? []));
    }
    return inherited;
  }

  registerProtocol(
    name: string,
    required: readonly string[],
    optional: readonly string[] = [],
  ): ObjcProtocol {
    if (this.protocols.has(name))
      throw new ObjcError("duplicate_protocol", `protocol ${name} exists`);
    const protocol: ObjcProtocol = { name, required: [...required], optional: [...optional] };
    this.protocols.set(name, protocol);
    return protocol;
  }

  addProtocol(className: string, protocolName: string): void {
    this.requireClass(className);
    if (!this.protocols.has(protocolName)) {
      throw new ObjcError("unknown_protocol", `protocol ${protocolName} is not registered`);
    }
    const set = this.conformances.get(className) ?? new Set<string>();
    set.add(protocolName);
    this.conformances.set(className, set);
  }

  conformsTo(className: string, protocolName: string): boolean {
    const protocol = this.protocols.get(protocolName);
    if (!protocol)
      throw new ObjcError("unknown_protocol", `protocol ${protocolName} is not registered`);
    let declared = false;
    for (
      let cursor: ObjcClass | null = this.requireClass(className);
      cursor;
      cursor = cursor.superclass
    ) {
      if (this.conformances.get(cursor.name)?.has(protocolName)) {
        declared = true;
        break;
      }
    }
    if (!declared) return false;
    return protocol.required.every((selector) => this.requireClass(className).respondsTo(selector));
  }

  missingProtocolMethods(className: string, protocolName: string): readonly string[] {
    const protocol = this.protocols.get(protocolName);
    if (!protocol)
      throw new ObjcError("unknown_protocol", `protocol ${protocolName} is not registered`);
    return protocol.required.filter(
      (selector) => !this.requireClass(className).respondsTo(selector),
    );
  }

  selector(name: string): string {
    if (name.length === 0) throw new ObjcError("bad_selector", "selector cannot be empty");
    this.selectors.add(name);
    return name;
  }

  selectorsView(): readonly string[] {
    return [...this.selectors].sort();
  }

  lookup(className: string, selector: string): ObjcIMP | null {
    const cls = this.requireClass(className);
    let cache = this.cache.get(className);
    if (!cache) {
      cache = new Map();
      this.cache.set(className, cache);
    }
    const cached = cache.get(selector);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const found = cls.lookup(selector);
    if (!found) return null;
    cache.set(selector, found.implementation);
    this.cacheMisses += 1;
    return found.implementation;
  }

  cacheStats(): CacheStats {
    let entries = 0;
    for (const cache of this.cache.values()) entries += cache.size;
    return { hits: this.cacheHits, misses: this.cacheMisses, entries };
  }

  setForwardHandler(handler: ObjcForwardHandler | null): void {
    this.forwardHandler = handler;
  }

  respondsTo(receiver: ObjcObject | null, selector: string): boolean {
    if (receiver === null) return false;
    return receiver.isa.respondsTo(selector);
  }

  methodOwner(className: string, selector: string): string | null {
    return this.requireClass(className).lookup(selector)?.owner.name ?? null;
  }

  /** Message a superclass implementation, used by `[super ...]` style dispatch. */
  sendSuper(
    receiver: ObjcObject,
    superclassName: string,
    selector: string,
    ...args: unknown[]
  ): unknown {
    const superclass = this.requireClass(superclassName);
    const found = superclass.lookup(selector);
    if (!found) {
      throw new ObjcError(
        "unrecognized_selector",
        `${superclass.name} does not respond to ${selector}`,
        { class: superclass.name, selector },
      );
    }
    return found.implementation(receiver, selector, args);
  }

  send(receiver: ObjcObject | null, selector: string, ...args: unknown[]): unknown {
    if (receiver === null) return undefined;
    const implementation = this.lookup(receiver.isa.name, selector);
    if (!implementation) {
      if (this.forwardHandler) return this.forwardHandler(receiver, selector, args);
      throw new ObjcError(
        "unrecognized_selector",
        `${receiver.isa.name} does not respond to ${selector}`,
        { class: receiver.isa.name, selector },
      );
    }
    const key = `${receiver.isa.name}:${selector}`;
    this.dispatchCounts.set(key, (this.dispatchCounts.get(key) ?? 0) + 1);
    return implementation(receiver, selector, args);
  }

  dispatchRecord(className: string, selector: string): DispatchRecord | null {
    const key = `${className}:${selector}`;
    const calls = this.dispatchCounts.get(key);
    if (calls === undefined) return null;
    const found = this.requireClass(className).lookup(selector);
    return found ? { owner: found.owner.name, selector, calls } : null;
  }

  private invalidate(className: string): void {
    this.cache.delete(className);
    for (const [name, cls] of this.classes) {
      if (cls.superclass?.name === className) this.invalidate(name);
    }
  }
}
