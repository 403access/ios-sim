import { describe, expect, it } from "vitest";
import { VirtualMemory } from "./vm.js";

const PAGE = 0x4000;

describe("virtual memory", () => {
  it("copies a mapping that spans several pages", () => {
    const memory = new VirtualMemory();
    const size = PAGE * 3;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = index & 0xff;
    const address = memory.mapFixed(0x4000_0000n, size, { bytes, protection: 3 });
    for (let index = 0; index < size; index += 1) {
      expect(memory.read(address + BigInt(index), 1)).toBe(BigInt(bytes[index]!));
    }
  });

  it("copies a mapping that starts inside the first page", () => {
    const memory = new VirtualMemory();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const address = memory.mapFixed(0x5000_0100n, 4, { bytes, protection: 3 });
    expect(memory.read(address, 4)).toBe(0x0403_0201n);
    expect(memory.read(0x5000_0000n, 1)).toBe(0n);
  });
});
