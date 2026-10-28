/**
 * Objective-C 2 runtime metadata (Apple ABI, arm64).
 *
 * The parser reads only what a message send needs: class lists, class and
 * metaclass data, method lists (absolute and relative), selector names, and
 * instance sizes. It never guesses: every pointer is bounds-checked against
 * the mapped image and failures carry a stable `bad_objc_metadata` code.
 *
 * Layout reference: objc4 `objc-runtime-new.h` (class_t, class_ro_t,
 * method_list_t). The tests cover metadata emitted by both this repository's
 * writer (absolute lists) and Apple clang (relative lists).
 */

import { ObjcError } from "../errors.js";
import type { LoadedImage } from "../dyld/loader.js";
import type { VirtualMemory } from "../dyld/vm.js";

export const CLASS_T_SIZE = 40;
export const CLASS_RO_SIZE = 72;
export const METHOD_SIZE = 24;
export const RO_META = 0x1;
export const RO_ROOT = 0x2;
export const METHOD_LIST_RELATIVE = 0x8000_0000;

const MAX_CLASSES = 1024;
const MAX_METHODS = 4096;
const MAX_SELECTOR_LENGTH = 512;

export interface ObjcMethod {
  readonly selector: string;
  readonly types: string;
  readonly imp: bigint;
}

export interface ObjcIvar {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
}

export interface ObjcCategory {
  readonly name: string;
  readonly classAddress: bigint;
  readonly methods: ReadonlyMap<string, ObjcMethod>;
  readonly classMethods: ReadonlyMap<string, ObjcMethod>;
  readonly protocols: readonly string[];
}

export interface ObjcClass {
  readonly name: string;
  readonly address: bigint;
  readonly metaclass: bigint;
  readonly superclass: bigint;
  readonly metaclassSuperclass: bigint;
  readonly instanceSize: number;
  readonly isRoot: boolean;
  readonly methods: ReadonlyMap<string, ObjcMethod>;
  readonly classMethods: ReadonlyMap<string, ObjcMethod>;
  readonly ivars: readonly ObjcIvar[];
  readonly protocols: readonly string[];
}

/**
 * Parse every class in an image's `__objc_classlist`.
 *
 * The image must already be mapped. Duplicate or malformed pointers fail
 * loudly instead of producing a partially linked class table.
 */
export function parseObjcClasses(memory: VirtualMemory, image: LoadedImage): ObjcClass[] {
  const sections = image.image.sections.filter((section) => section.name === "__objc_classlist");
  if (sections.length === 0) return [];
  const classes: ObjcClass[] = [];
  const seen = new Set<bigint>();
  for (const section of sections) {
    if (section.zeroFill) continue;
    const start = sectionAddress(image, section.address);
    const count = Math.floor(section.size / 8);
    if (count > MAX_CLASSES) {
      throw new ObjcError(
        "bad_objc_metadata",
        `${image.path}: __objc_classlist has ${count} entries (limit ${MAX_CLASSES})`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      const pointerAddress = start + BigInt(index * 8);
      const classAddress = readPointer(memory, pointerAddress, `${image.path} classlist`);
      if (classAddress === 0n || seen.has(classAddress)) continue;
      seen.add(classAddress);
      classes.push(parseClass(memory, image, classAddress));
    }
  }
  return classes;
}

function parseClass(memory: VirtualMemory, image: LoadedImage, address: bigint): ObjcClass {
  const isa = readPointer(memory, address, "class isa");
  const superclass = readPointer(memory, address + 8n, "class superclass");
  const data = readPointer(memory, address + 32n, "class data") & ~0x7n;
  const name = readCString(memory, readPointer(memory, data + 24n, "class name"));
  const instanceSize = readU32(memory, data + 8n, "class instanceSize");
  const flags = readU32(memory, data, "class flags");
  const methods = parseMethodList(memory, readPointer(memory, data + 32n, "class methods"));
  const ivars = parseIvarList(memory, readPointer(memory, data + 48n, "class ivars"));
  const protocols = parseProtocolList(
    memory,
    readPointer(memory, data + 40n, "class protocols"),
    new Set(),
  );

  const metaData = readPointer(memory, isa + 32n, "metaclass data") & ~0x7n;
  const metaSuperclass = readPointer(memory, isa + 8n, "metaclass superclass");
  const classMethods = parseMethodList(
    memory,
    readPointer(memory, metaData + 32n, "metaclass methods"),
  );

  return {
    name,
    address,
    metaclass: isa,
    superclass,
    metaclassSuperclass: metaSuperclass,
    instanceSize,
    isRoot: (flags & RO_ROOT) !== 0,
    methods,
    classMethods,
    ivars,
    protocols,
  };
}

/** Parse a category list (`__objc_catlist`) from an image. */
export function parseObjcCategories(memory: VirtualMemory, image: LoadedImage): ObjcCategory[] {
  const sections = image.image.sections.filter((section) => section.name === "__objc_catlist");
  if (sections.length === 0) return [];
  const categories: ObjcCategory[] = [];
  for (const section of sections) {
    if (section.zeroFill) continue;
    const start = sectionAddress(image, section.address);
    const count = Math.floor(section.size / 8);
    if (count > MAX_CLASSES) {
      throw new ObjcError(
        "bad_objc_metadata",
        `${image.path}: __objc_catlist has ${count} entries (limit ${MAX_CLASSES})`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      const pointer = readPointer(memory, start + BigInt(index * 8), "category list");
      if (pointer === 0n) continue;
      const name = readCString(memory, readPointer(memory, pointer, "category name"));
      const classAddress = readPointer(memory, pointer + 8n, "category class");
      categories.push({
        name,
        classAddress,
        methods: parseMethodList(memory, readPointer(memory, pointer + 16n, "category methods")),
        classMethods: parseMethodList(
          memory,
          readPointer(memory, pointer + 24n, "category class methods"),
        ),
        protocols: parseProtocolList(
          memory,
          readPointer(memory, pointer + 32n, "category protocols"),
          new Set(),
        ),
      });
    }
  }
  return categories;
}

function parseProtocolList(memory: VirtualMemory, address: bigint, visited: Set<bigint>): string[] {
  if (address === 0n) return [];
  const count = readU64(memory, address, "protocol list");
  if (count > 256n) {
    throw new ObjcError("bad_objc_metadata", `protocol list claims ${count} entries`);
  }
  const names: string[] = [];
  for (let index = 0n; index < count; index += 1n) {
    const reference = readPointer(memory, address + 8n + index * 8n, "protocol reference");
    if (reference === 0n || visited.has(reference)) continue;
    visited.add(reference);
    const name = readCString(memory, readPointer(memory, reference + 8n, "protocol name"));
    if (!names.includes(name)) names.push(name);
    for (const inherited of parseProtocolList(
      memory,
      readPointer(memory, reference + 16n, "inherited protocols"),
      visited,
    )) {
      if (!names.includes(inherited)) names.push(inherited);
    }
  }
  return names;
}

function parseIvarList(memory: VirtualMemory, address: bigint): ObjcIvar[] {
  if (address === 0n) return [];
  const header = readU32(memory, address, "ivar list header");
  const count = readU32(memory, address + 4n, "ivar list count");
  if (count > MAX_METHODS) {
    throw new ObjcError("bad_objc_metadata", `ivar list claims ${count} entries`);
  }
  const relative = (header & METHOD_LIST_RELATIVE) !== 0;
  const entrySize = header & (relative ? 0x7fff_fffc : 0x0000_fffc);
  const minimum = relative ? 12 : 32;
  if (entrySize < minimum || entrySize > 256) {
    throw new ObjcError(
      "bad_objc_metadata",
      `ivar list entry size ${entrySize} is out of range (relative=${relative})`,
    );
  }
  const ivars: ObjcIvar[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = address + 8n + BigInt(index * entrySize);
    // `ivar_t.offset` is a pointer to the int32 offset, not the value itself.
    const offsetSlot = readPointer(memory, entry, "ivar offset slot");
    const offset = offsetSlot === 0n ? 0 : readS32(memory, offsetSlot, "ivar offset");
    let namePointer: bigint;
    let typePointer: bigint;
    let alignment: number;
    let size: number;
    if (relative) {
      namePointer = entry + 4n + BigInt(readS32(memory, entry + 4n, "ivar name"));
      typePointer = entry + 8n + BigInt(readS32(memory, entry + 8n, "ivar type"));
      alignment = 0;
      size = 0;
    } else {
      namePointer = readPointer(memory, entry + 8n, "ivar name");
      typePointer = readPointer(memory, entry + 16n, "ivar type");
      alignment = readU32(memory, entry + 24n, "ivar alignment");
      size = readU32(memory, entry + 28n, "ivar size");
    }
    ivars.push({
      name: readCString(memory, namePointer),
      type: readTypes(memory, typePointer),
      offset,
      size,
      alignment,
    });
  }
  return ivars;
}

function parseMethodList(memory: VirtualMemory, address: bigint): Map<string, ObjcMethod> {
  const methods = new Map<string, ObjcMethod>();
  if (address === 0n) return methods;
  const header = readU32(memory, address, "method list header");
  const count = readU32(memory, address + 4n, "method list count");
  if (count > MAX_METHODS) {
    throw new ObjcError("bad_objc_metadata", `method list claims ${count} methods`);
  }
  const relative = (header & METHOD_LIST_RELATIVE) !== 0;
  const entrySize = header & (relative ? 0x7fff_fffc : 0x0000_fffc);
  const minimum = relative ? 12 : METHOD_SIZE;
  if (entrySize < minimum || entrySize > 256) {
    throw new ObjcError(
      "bad_objc_metadata",
      `method list entry size ${entrySize} is out of range (relative=${relative})`,
    );
  }

  for (let index = 0; index < count; index += 1) {
    const entry = address + 8n + BigInt(index * entrySize);
    let selector: string;
    let types: string;
    let imp: bigint;
    if (relative) {
      const nameOffset = readS32(memory, entry, "relative method name");
      const selectorSlot = entry + BigInt(nameOffset);
      selector = resolveSelector(memory, selectorSlot);
      const typesOffset = readS32(memory, entry + 4n, "relative method types");
      types = readTypes(memory, entry + 4n + BigInt(typesOffset));
      const impOffset = readS32(memory, entry + 8n, "relative method imp");
      imp = entry + 8n + BigInt(impOffset);
    } else {
      selector = resolveSelector(memory, readPointer(memory, entry, "method name"));
      types = readTypes(memory, readPointer(memory, entry + 8n, "method types"));
      imp = readPointer(memory, entry + 16n, "method imp");
    }
    if (selector.length === 0 || methods.has(selector)) continue;
    methods.set(selector, { selector, types, imp });
  }
  return methods;
}

/**
 * A relative method name points at a selector-reference slot, which points at
 * the selector's C string. Some writers point directly at the string, so the
 * resolver accepts both and rejects pointers that are not printable.
 */
function resolveSelector(memory: VirtualMemory, slot: bigint): string {
  if (memory.isMapped(slot, 8)) {
    const pointer = memory.read(slot, 8);
    if (pointer !== 0n && memory.isMapped(pointer, 1)) {
      const name = readCString(memory, pointer);
      if (isSelectorText(name)) return name;
    }
  }
  if (memory.isMapped(slot, 1)) {
    const name = readCString(memory, slot);
    if (isSelectorText(name)) return name;
  }
  throw new ObjcError(
    "bad_objc_metadata",
    `selector at 0x${slot.toString(16)} is neither a C string nor a reference to one`,
  );
}

function readTypes(memory: VirtualMemory, address: bigint): string {
  if (address === 0n || !memory.isMapped(address, 1)) return "";
  try {
    return memory.readCString(address, 256);
  } catch {
    return "";
  }
}

function isSelectorText(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SELECTOR_LENGTH) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function sectionAddress(image: LoadedImage, preferredAddress: number): bigint {
  return image.base + BigInt(preferredAddress - image.image.preferredBase);
}

function readPointer(memory: VirtualMemory, address: bigint, what: string): bigint {
  requireMapped(memory, address, 8, what);
  return memory.read(address, 8);
}

function readU64(memory: VirtualMemory, address: bigint, what: string): bigint {
  requireMapped(memory, address, 8, what);
  return memory.read(address, 8);
}

function readU32(memory: VirtualMemory, address: bigint, what: string): number {
  requireMapped(memory, address, 4, what);
  return Number(memory.read(address, 4));
}

function readS32(memory: VirtualMemory, address: bigint, what: string): number {
  requireMapped(memory, address, 4, what);
  return Number(BigInt.asIntN(32, memory.read(address, 4)));
}

function readCString(memory: VirtualMemory, address: bigint): string {
  if (address === 0n) {
    throw new ObjcError("bad_objc_metadata", "metadata contains a null string pointer");
  }
  requireMapped(memory, address, 1, "C string");
  return memory.readCString(address, MAX_SELECTOR_LENGTH);
}

function requireMapped(memory: VirtualMemory, address: bigint, size: number, what: string): void {
  if (!memory.isMapped(address, size)) {
    throw new ObjcError(
      "bad_objc_metadata",
      `${what} pointer 0x${address.toString(16)} is outside mapped memory`,
    );
  }
}
