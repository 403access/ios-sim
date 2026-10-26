import { describe, expect, it } from "vitest";
import {
  SwiftMetadataError,
  parseSwiftMetadata,
  parseSwiftProtocols,
  parseSwiftTypes,
} from "./metadata.js";

function typeSection(
  kind: number,
  name: string,
  options: { parent?: number; flags?: number } = {},
) {
  const nameBytes = new TextEncoder().encode(`${name}\0`);
  const descriptor = 4;
  const nameOffset = descriptor + 12;
  const bytes = new Uint8Array(Math.ceil((nameOffset + nameBytes.length) / 4) * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, descriptor - 0, true); // relative pointer from slot 0 to descriptor
  view.setUint32(descriptor, (options.flags ?? 0) | kind, true);
  view.setInt32(descriptor + 4, options.parent ?? 0, true);
  view.setInt32(descriptor + 8, nameOffset - (descriptor + 8), true);
  bytes.set(nameBytes, nameOffset);
  return bytes;
}

function protocolSection(name: string, requirements: number) {
  const nameBytes = new TextEncoder().encode(`${name}\0`);
  const descriptor = 4;
  const nameOffset = descriptor + 16;
  const bytes = new Uint8Array(Math.ceil((nameOffset + nameBytes.length) / 4) * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, descriptor, true);
  view.setUint32(descriptor, 0, true);
  view.setInt32(descriptor + 4, 0, true);
  view.setInt32(descriptor + 8, nameOffset - (descriptor + 8), true);
  view.setUint16(descriptor + 12, requirements, true);
  bytes.set(nameBytes, nameOffset);
  return bytes;
}

describe("Swift 5 metadata", () => {
  it("reads type kinds, names, parents, and flags", () => {
    const types = parseSwiftTypes(typeSection(1, "$s4Test4UserV"), 1);
    expect(types[0]).toMatchObject({ kind: "struct", name: "$s4Test4UserV", hasParent: false });
    const flags = 0x0001_0000 | 0x0010_0000 | 0;
    expect(parseSwiftTypes(typeSection(0, "$s4Test5ThingC", { flags }), 1)[0]).toMatchObject({
      kind: "class",
      generic: true,
      resilient: true,
    });
    expect(parseSwiftTypes(typeSection(2, "$s4Test4KindO"), 1)[0]?.kind).toBe("enum");
    expect(parseSwiftTypes(typeSection(9, "$s4Test3OddO"), 1)[0]?.kind).toBe("unknown");
  });

  it("reads protocol names and requirement counts", () => {
    const protocols = parseSwiftProtocols(protocolSection("$s4Test8DrawableM", 3), 1);
    expect(protocols[0]).toMatchObject({ name: "$s4Test8DrawableM", requirements: 3 });
    expect(
      parseSwiftMetadata({ protocols: protocolSection("$s4Test1PM", 0), protocolCount: 1 })
        .protocols,
    ).toHaveLength(1);
    expect(parseSwiftMetadata({})).toEqual({ types: [], protocols: [] });
  });

  it("rejects malformed sections", () => {
    expect(() => parseSwiftTypes(new Uint8Array(3))).toThrow(SwiftMetadataError);
    expect(() => parseSwiftTypes(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toThrow(/outside/);
    const badName = new Uint8Array(16);
    new DataView(badName.buffer).setInt32(0, 4, true);
    new DataView(badName.buffer).setUint32(4, 1, true);
    new DataView(badName.buffer).setInt32(12, 100, true);
    expect(() => parseSwiftTypes(badName, 1)).toThrow(/outside/);
  });
});
