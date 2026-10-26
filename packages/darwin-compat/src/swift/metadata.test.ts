import { describe, expect, it } from "vitest";
import {
  SwiftMetadataError,
  parseSwiftFields,
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

function fieldSection(fields: Array<{ name: string; type: string; flags: number }>) {
  const recordSize = 16;
  const header = 16;
  const strings = new TextEncoder().encode(
    fields.map((field) => `${field.name}\0${field.type}\0`).join(""),
  );
  const dataStart = header + fields.length * recordSize;
  const bytes = new Uint8Array(dataStart + strings.length);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 0, true);
  view.setInt32(4, 0, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, recordSize, true);
  view.setUint32(12, fields.length, true);
  let stringOffset = dataStart;
  fields.forEach((field, index) => {
    const at = header + index * recordSize;
    view.setInt32(at, stringOffset - at, true);
    bytes.set(new TextEncoder().encode(field.name), stringOffset);
    stringOffset += field.name.length + 1;
    view.setInt32(at + 4, stringOffset - (at + 4), true);
    bytes.set(new TextEncoder().encode(field.type), stringOffset);
    stringOffset += field.type.length + 1;
    view.setUint32(at + 8, field.flags, true);
  });
  return bytes;
}

describe("Swift 5 metadata", () => {
  it("reads field names and mangled types", () => {
    const fields = parseSwiftFields(
      fieldSection([
        { name: "name", type: "$sSS", flags: 0 },
        { name: "age", type: "$sSi", flags: 1 },
      ]),
      1,
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe(1);
    expect(fields[0]?.fields).toEqual([
      { name: "name", type: "$sSS", flags: 0 },
      { name: "age", type: "$sSi", flags: 1 },
    ]);
    expect(parseSwiftMetadata({ fields: fieldSection([]) }).fields).toHaveLength(1);
  });

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
    expect(parseSwiftMetadata({})).toEqual({ types: [], protocols: [], fields: [] });
  });

  it("rejects malformed sections", () => {
    expect(() => parseSwiftTypes(new Uint8Array(3))).toThrow(SwiftMetadataError);
    expect(() => parseSwiftTypes(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toThrow(/outside/);
    const badName = new Uint8Array(16);
    new DataView(badName.buffer).setInt32(0, 4, true);
    new DataView(badName.buffer).setUint32(4, 1, true);
    new DataView(badName.buffer).setInt32(12, 100, true);
    expect(() => parseSwiftTypes(badName, 1)).toThrow(/outside/);
    const badField = fieldSection([{ name: "x", type: "$sSi", flags: 0 }]);
    new DataView(badField.buffer).setUint16(10, 4, true);
    expect(() => parseSwiftFields(badField, 1)).toThrow(/too small/);
  });
});
