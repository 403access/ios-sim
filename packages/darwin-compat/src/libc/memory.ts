/**
 * Guest libc memory and string primitives (RT-010).
 *
 * A small first-fit allocator over a VirtualMemory region plus common memory
 * and string helpers. This is host-side scaffolding for a future libSystem
 * replacement; it does not yet satisfy a real C program linked against Apple's
 * libSystem.
 */

import { CompatError } from "../errors.js";
import type { VirtualMemory } from "../dyld/vm.js";

export class LibcError extends CompatError {
  override name = "LibcError";
}

interface Block {
  readonly address: bigint;
  size: number;
  free: boolean;
}

const HEADER = 16;
const MIN_SPLIT = 16;

export class MallocHeap {
  private readonly memory: VirtualMemory;
  private readonly base: bigint;
  private readonly limit: number;
  private readonly blocks: Block[] = [];

  constructor(memory: VirtualMemory, size = 1024 * 1024) {
    this.memory = memory;
    this.base = memory.allocate(size, { tag: "libc-heap", protection: 3 });
    this.limit = size;
    this.blocks.push({ address: this.base, size, free: true });
    this.writeHeader(this.blocks[0]!);
  }

  malloc(size: number, alignment = 16): bigint {
    if (!Number.isInteger(size) || size < 0) {
      throw new LibcError("bad_size", `malloc size ${size} is invalid`);
    }
    const wanted = align(Math.max(1, size) + HEADER, Math.max(16, alignment));
    for (let index = 0; index < this.blocks.length; index += 1) {
      const block = this.blocks[index]!;
      if (!block.free || block.size < wanted) continue;
      this.split(index, wanted);
      const allocated = this.blocks[index]!;
      allocated.free = false;
      this.writeHeader(allocated);
      return allocated.address + BigInt(HEADER);
    }
    throw new LibcError("out_of_memory", `malloc(${size}) exhausted the ${this.limit}-byte heap`);
  }

  calloc(count: number, size: number, alignment = 16): bigint {
    const pointer = this.malloc(count * size, alignment);
    this.memset(pointer, 0, count * size);
    return pointer;
  }

  free(pointer: bigint): void {
    if (pointer === 0n) return;
    const block = this.blockFor(pointer);
    block.free = true;
    this.writeHeader(block);
    this.coalesce();
  }

  realloc(pointer: bigint, size: number): bigint {
    if (pointer === 0n) return this.malloc(size);
    const block = this.blockFor(pointer);
    if (size <= block.size - HEADER) {
      this.split(this.blocks.indexOf(block), align(Math.max(1, size) + HEADER, 16));
      this.writeHeader(block);
      return pointer;
    }
    const next = this.malloc(size);
    this.memcpy(next, pointer, Math.min(size, block.size - HEADER));
    this.free(pointer);
    return next;
  }

  stats(): { blocks: number; free: number; used: number } {
    let free = 0;
    let used = 0;
    for (const block of this.blocks) {
      if (block.free) free += block.size;
      else used += block.size;
    }
    return { blocks: this.blocks.length, free, used };
  }

  private blockFor(pointer: bigint): Block {
    const address = pointer - BigInt(HEADER);
    const block = this.blocks.find((candidate) => candidate.address === address);
    if (!block || block.free) {
      throw new LibcError("bad_pointer", `free(${pointer}) is not an allocated block`);
    }
    return block;
  }

  private split(index: number, wanted: number): void {
    const block = this.blocks[index]!;
    if (block.size - wanted < MIN_SPLIT) return;
    const remainder: Block = {
      address: block.address + BigInt(wanted),
      size: block.size - wanted,
      free: true,
    };
    block.size = wanted;
    this.blocks.splice(index + 1, 0, remainder);
    this.writeHeader(remainder);
  }

  private coalesce(): void {
    for (let index = 0; index < this.blocks.length - 1; index += 1) {
      const block = this.blocks[index]!;
      const next = this.blocks[index + 1]!;
      if (block.free && next.free) {
        block.size += next.size;
        this.blocks.splice(index + 1, 1);
        this.writeHeader(block);
        index -= 1;
      }
    }
  }

  private writeHeader(block: Block): void {
    this.memory.write(block.address, 8, BigInt(block.size));
    this.memory.write(block.address + 8n, 8, block.free ? 1n : 0n);
  }

  memcpy(destination: bigint, source: bigint, count: number): void {
    const bytes = this.memory.readBytes(source, count);
    this.memory.writeBytes(destination, bytes);
  }

  memset(destination: bigint, value: number, count: number): void {
    this.memory.writeBytes(destination, new Uint8Array(count).fill(value & 0xff));
  }

  memcmp(left: bigint, right: bigint, count: number): number {
    const a = this.memory.readBytes(left, count);
    const b = this.memory.readBytes(right, count);
    for (let index = 0; index < count; index += 1) {
      if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
    }
    return 0;
  }

  strlen(address: bigint): number {
    let length = 0;
    while (this.memory.readBytes(address + BigInt(length), 1)[0] !== 0) length += 1;
    return length;
  }

  strcpy(destination: bigint, source: string): bigint {
    const bytes = new TextEncoder().encode(`${source}\0`);
    this.memory.writeBytes(destination, bytes);
    return destination;
  }

  strcmp(left: bigint, right: bigint): number {
    const length = Math.min(this.strlen(left), this.strlen(right));
    return this.memcmp(left, right, length) || this.strlen(left) - this.strlen(right);
  }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
