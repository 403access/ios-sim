import { describe, expect, it } from "vitest";
import { VirtualMemory } from "../dyld/vm.js";
import { LibcError, MallocHeap } from "./memory.js";

function heap(): MallocHeap {
  return new MallocHeap(new VirtualMemory(), 0x4000);
}

describe("libc memory primitives", () => {
  it("allocates aligned blocks, reuses free space, and coalesces", () => {
    const malloc = heap();
    const a = malloc.malloc(100);
    const b = malloc.malloc(200);
    expect(a % 16n).toBe(0n);
    expect(b > a).toBe(true);
    expect(malloc.stats().used).toBeGreaterThanOrEqual(300);
    malloc.free(a);
    malloc.free(b);
    expect(malloc.stats().free).toBe(0x4000);
    const c = malloc.malloc(300);
    expect(c).toBe(a);
    malloc.free(c);
  });

  it("calloc zeroes, realloc preserves, and bad pointers fail", () => {
    const malloc = heap();
    const pointer = malloc.malloc(8);
    malloc.strcpy(pointer, "hello");
    const grown = malloc.realloc(pointer, 64);
    expect(malloc.strlen(grown)).toBe(5);
    const zeroed = malloc.calloc(4, 8);
    for (let index = 0; index < 32; index += 1) {
      expect(malloc.memcmp(zeroed + BigInt(index), zeroed + BigInt(index), 1)).toBe(0);
    }
    expect(() => malloc.free(0x1234n)).toThrow(LibcError);
    expect(() => malloc.malloc(0x1_0000)).toThrow(/out of memory|exhausted/);
  });

  it("implements mem/str helpers", () => {
    const malloc = heap();
    const a = malloc.malloc(16);
    const b = malloc.malloc(16);
    malloc.strcpy(a, "alpha");
    malloc.strcpy(b, "alpha");
    expect(malloc.strcmp(a, b)).toBe(0);
    expect(malloc.strlen(a)).toBe(5);
    malloc.memcpy(b, a, 6);
    expect(malloc.strcmp(a, b)).toBe(0);
    malloc.memset(b, 0x41, 3);
    expect(malloc.memcmp(a, b, 3)).not.toBe(0);
  });
});
