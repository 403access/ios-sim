/**
 * Clean-room Foundation containers (RT-006).
 *
 * These are semantic NSString/NSArray/NSDictionary equivalents, not Apple's
 * class clusters or ABI. They exist so guest-facing code has predictable
 * string and collection behaviour with stable bounds errors.
 */

import { CompatError } from "../errors.js";

export class FoundationError extends CompatError {
  override name = "FoundationError";
}

export class NSString {
  protected text: string;

  constructor(value = "") {
    this.text = value;
  }

  static from(value: string): NSString {
    return new NSString(value);
  }

  length(): number {
    return this.text.length;
  }

  characterAt(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.text.length) {
      throw new FoundationError(
        "out_of_bounds",
        `character index ${index} is outside ${this.text.length}`,
      );
    }
    return this.text[index]!;
  }

  substring(from: number, to = this.text.length): NSString {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.text.length
    ) {
      throw new FoundationError(
        "bad_range",
        `range ${from}..${to} is invalid for length ${this.text.length}`,
      );
    }
    return new NSString(this.text.slice(from, to));
  }

  concat(other: NSString | string): NSString {
    return new NSString(this.text + (other instanceof NSString ? other.toString() : other));
  }

  isEqual(other: NSString | string): boolean {
    return this.text === (other instanceof NSString ? other.toString() : other);
  }

  toString(): string {
    return this.text;
  }
}

export class NSMutableString extends NSString {
  append(value: NSString | string): this {
    this.text += value instanceof NSString ? value.toString() : value;
    return this;
  }

  set(value: string): this {
    this.text = value;
    return this;
  }
}

export class NSArray<T> {
  protected items: T[];

  constructor(items: readonly T[] = []) {
    this.items = [...items];
  }

  static from<T>(items: readonly T[]): NSArray<T> {
    return new NSArray(items);
  }

  count(): number {
    return this.items.length;
  }

  objectAt(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) {
      throw new FoundationError(
        "out_of_bounds",
        `array index ${index} is outside ${this.items.length}`,
      );
    }
    return this.items[index]!;
  }

  contains(value: T): boolean {
    return this.items.includes(value);
  }

  toArray(): T[] {
    return [...this.items];
  }

  map<U>(fn: (value: T, index: number) => U): NSArray<U> {
    return new NSArray(this.items.map(fn));
  }
}

export class NSMutableArray<T> extends NSArray<T> {
  add(value: T): this {
    this.items.push(value);
    return this;
  }

  insert(value: T, index: number): this {
    if (!Number.isInteger(index) || index < 0 || index > this.items.length) {
      throw new FoundationError(
        "out_of_bounds",
        `insert index ${index} is outside ${this.items.length}`,
      );
    }
    this.items.splice(index, 0, value);
    return this;
  }

  removeAt(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) {
      throw new FoundationError(
        "out_of_bounds",
        `array index ${index} is outside ${this.items.length}`,
      );
    }
    return this.items.splice(index, 1)[0]!;
  }
}

export class NSDictionary<V> {
  protected readonly entries = new Map<string, V>();

  constructor(entries: Readonly<Record<string, V>> | ReadonlyMap<string, V> = {}) {
    const source = entries instanceof Map ? entries : Object.entries(entries);
    for (const [key, value] of source) this.entries.set(key, value);
  }

  count(): number {
    return this.entries.size;
  }

  objectForKey(key: string): V | undefined {
    return this.entries.get(key);
  }

  allKeys(): string[] {
    return [...this.entries.keys()];
  }

  toObject(): Record<string, V> {
    return Object.fromEntries(this.entries);
  }
}

export class NSMutableDictionary<V> extends NSDictionary<V> {
  setObject(key: string, value: V): this {
    if (key.length === 0) throw new FoundationError("bad_key", "dictionary key cannot be empty");
    this.entries.set(key, value);
    return this;
  }

  removeObject(key: string): boolean {
    return this.entries.delete(key);
  }
}
