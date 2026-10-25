/**
 * Sparse paged virtual memory for the compatibility runtime.
 *
 * iOS uses 16 KiB pages. Representing memory as a map of pages (instead of one
 * huge ArrayBuffer) keeps a 64-bit address space cheap and makes a mapped /
 * unmapped fault explicit. This is user-space bookkeeping only: it is not an
 * MMU, and permissions are recorded for introspection rather than enforced by
 * the host CPU.
 */

import { CompatError } from "../errors.js";

export const IOS_PAGE_SIZE = 0x4000;
const PAGE_SHIFT = 14n;
const MAX_ADDRESS = 0x0000_7fff_ffff_ffffn;

export interface MemoryRegion {
  readonly start: bigint;
  readonly end: bigint;
  readonly protection: number;
  readonly tag: string;
}

export class VirtualMemory {
  readonly pageSize: number;
  private readonly pages = new Map<bigint, Uint8Array>();
  private readonly regions: MemoryRegion[] = [];
  private nextAddress: bigint;
  private used = 0;
  private readonly limit: number;

  constructor(options: { pageSize?: number; base?: bigint; limitBytes?: number } = {}) {
    this.pageSize = options.pageSize ?? IOS_PAGE_SIZE;
    this.nextAddress = options.base ?? 0x2_0000_0000n;
    this.limit = options.limitBytes ?? 512 * 1024 * 1024;
  }

  get usedBytes(): number {
    return this.used;
  }

  get regionsView(): readonly MemoryRegion[] {
    return this.regions;
  }

  allocate(
    size: number,
    options: { alignment?: number; tag?: string; protection?: number } = {},
  ): bigint {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new CompatError("bad_allocation", `allocation size ${size} is invalid`);
    }
    const alignment = BigInt(options.alignment ?? this.pageSize);
    let aligned = ((this.nextAddress + alignment - 1n) / alignment) * alignment;
    const span = BigInt(size);
    // Fixed mappings (images, MAP_FIXED) may sit above the heap cursor. Advance
    // to the first free page rather than overwriting them.
    while (this.overlaps(aligned, aligned + span)) aligned += BigInt(this.pageSize);
    const start = this.mapFixed(aligned, size, {
      tag: options.tag ?? "heap",
      protection: options.protection ?? 3,
    });
    this.nextAddress = start + BigInt(size);
    return start;
  }

  mapFixed(
    address: bigint,
    size: number,
    options: { tag?: string; protection?: number; bytes?: Uint8Array } = {},
  ): bigint {
    if (address < 0n || address + BigInt(size) > MAX_ADDRESS) {
      throw new CompatError(
        "bad_address",
        `cannot map ${size} byte(s) at 0x${address.toString(16)}`,
      );
    }
    const pageCount = Math.ceil(size / this.pageSize);
    if (this.used + pageCount * this.pageSize > this.limit) {
      throw new CompatError(
        "memory_limit",
        `mapping ${size} byte(s) would exceed the ${this.limit} byte memory limit`,
        { used: this.used, size, limit: this.limit },
      );
    }
    for (let index = 0; index < pageCount; index += 1) {
      const page = (address >> PAGE_SHIFT) + BigInt(index);
      let data = this.pages.get(page);
      if (!data) {
        data = new Uint8Array(this.pageSize);
        this.pages.set(page, data);
        this.used += this.pageSize;
      }
      if (options.bytes) {
        const pageStart = page << PAGE_SHIFT;
        const from = address > pageStart ? address - pageStart : 0n;
        const pageEnd = pageStart + BigInt(this.pageSize);
        const mappingEnd = address + BigInt(size);
        const to = pageEnd < mappingEnd ? pageEnd : mappingEnd;
        const length = Number(to - from);
        if (length > 0) {
          const sourceOffset = Number(pageStart + from - address);
          data.set(options.bytes.subarray(sourceOffset, sourceOffset + length), Number(from));
        }
      }
    }
    this.regions.push({
      start: address,
      end: address + BigInt(size),
      protection: options.protection ?? 3,
      tag: options.tag ?? "mapped",
    });
    return address;
  }

  unmap(address: bigint, size: number): void {
    if (address % BigInt(this.pageSize) !== 0n || size % this.pageSize !== 0) {
      throw new CompatError("unaligned_unmap", "unmap requires page-aligned address and size");
    }
    const pageCount = size / this.pageSize;
    for (let index = 0; index < pageCount; index += 1) {
      const page = (address >> PAGE_SHIFT) + BigInt(index);
      if (this.pages.delete(page)) this.used -= this.pageSize;
    }
    const end = address + BigInt(size);
    const remaining: MemoryRegion[] = [];
    for (const region of this.regions) {
      if (region.end <= address || region.start >= end) {
        remaining.push(region);
        continue;
      }
      if (region.start < address) remaining.push({ ...region, end: address });
      if (region.end > end) remaining.push({ ...region, start: end });
    }
    this.regions.length = 0;
    this.regions.push(...remaining);
  }

  isMapped(address: bigint, size = 1): boolean {
    if (size <= 0 || address < 0n) return false;
    const first = address >> PAGE_SHIFT;
    const last = (address + BigInt(size) - 1n) >> PAGE_SHIFT;
    for (let page = first; page <= last; page += 1n) {
      if (!this.pages.has(page)) return false;
    }
    return true;
  }

  /** True when any recorded mapping intersects `[start, end)`. */
  overlaps(start: bigint, end: bigint): boolean {
    if (end <= start) return false;
    return this.regions.some((region) => start < region.end && end > region.start);
  }

  private pageAt(
    address: bigint,
    size: number,
  ): { page: Uint8Array; offset: number; pageIndex: bigint } {
    if (address < 0n || address + BigInt(size) > MAX_ADDRESS) {
      throw new CompatError(
        "memory_fault",
        `address 0x${address.toString(16)} is outside the address space`,
      );
    }
    const pageIndex = address >> PAGE_SHIFT;
    const page = this.pages.get(pageIndex);
    if (!page) {
      throw new CompatError(
        "memory_fault",
        `unmapped read/write at 0x${address.toString(16)} (${size} byte(s))`,
        {
          address: address.toString(16),
          size,
        },
      );
    }
    return { page, offset: Number(address - (pageIndex << PAGE_SHIFT)), pageIndex };
  }

  read(address: bigint, size: number): bigint {
    if (size <= 0 || size > 8) {
      throw new CompatError("bad_read", `unsupported read size ${size}`);
    }
    if (!this.isMapped(address, size)) {
      throw new CompatError(
        "memory_fault",
        `unmapped read at 0x${address.toString(16)} (${size} byte(s))`,
        {
          address: address.toString(16),
          size,
        },
      );
    }
    let value = 0n;
    for (let index = 0; index < size; index += 1) {
      const at = address + BigInt(index);
      const { page, offset } = this.pageAt(at, 1);
      value |= BigInt(page[offset]!) << BigInt(index * 8);
    }
    return value;
  }

  write(address: bigint, size: number, value: bigint): void {
    if (size <= 0 || size > 8) {
      throw new CompatError("bad_write", `unsupported write size ${size}`);
    }
    if (!this.isMapped(address, size)) {
      throw new CompatError(
        "memory_fault",
        `unmapped write at 0x${address.toString(16)} (${size} byte(s))`,
        {
          address: address.toString(16),
          size,
        },
      );
    }
    const normalized = BigInt.asUintN(size * 8, value);
    for (let index = 0; index < size; index += 1) {
      const at = address + BigInt(index);
      const { page, offset } = this.pageAt(at, 1);
      page[offset] = Number((normalized >> BigInt(index * 8)) & 0xffn);
    }
  }

  readBytes(address: bigint, size: number): Uint8Array {
    if (size < 0) throw new CompatError("bad_read", `negative read size ${size}`);
    if (size === 0) return new Uint8Array();
    if (!this.isMapped(address, Math.max(size, 1))) {
      throw new CompatError(
        "memory_fault",
        `unmapped read at 0x${address.toString(16)} (${size} byte(s))`,
        {
          address: address.toString(16),
          size,
        },
      );
    }
    const result = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      const at = address + BigInt(index);
      const { page, offset } = this.pageAt(at, 1);
      result[index] = page[offset]!;
    }
    return result;
  }

  writeBytes(address: bigint, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (!this.isMapped(address, bytes.length)) {
      throw new CompatError(
        "memory_fault",
        `unmapped write at 0x${address.toString(16)} (${bytes.length} byte(s))`,
      );
    }
    for (let index = 0; index < bytes.length; index += 1) {
      const at = address + BigInt(index);
      const { page, offset } = this.pageAt(at, 1);
      page[offset] = bytes[index]!;
    }
  }

  readCString(address: bigint, maxLength = 4096): string {
    const bytes: number[] = [];
    for (let index = 0; index < maxLength; index += 1) {
      const value = Number(this.read(address + BigInt(index), 1));
      if (value === 0) return new TextDecoder().decode(Uint8Array.from(bytes));
      bytes.push(value);
    }
    throw new CompatError(
      "string_too_long",
      `C string at 0x${address.toString(16)} exceeds ${maxLength} bytes`,
    );
  }

  writeCString(address: bigint, value: string): number {
    const bytes = new TextEncoder().encode(value);
    this.writeBytes(address, bytes);
    this.write(address + BigInt(bytes.length), 1, 0n);
    return bytes.length + 1;
  }

  /** Copy a zero-filled region into an existing mapping (segment BSS). */
  zero(address: bigint, size: number): void {
    for (let index = 0; index < size; index += 1) this.write(address + BigInt(index), 1, 0n);
  }
}
