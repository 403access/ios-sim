/**
 * XPC-style object model and bounded binary codec.
 *
 * The wire format is **not** Apple's XPC encoding. It is a documented,
 * versioned subset that gives the research track a typed RPC layer today and a
 * place to swap in a byte-compatible encoder later. Values are:
 *
 * | Type       | Encoding                                             |
 * | ---------- | ---------------------------------------------------- |
 * | null/bool  | type byte only                                       |
 * | int64      | type byte + 8-byte little-endian two's complement    |
 * | uint64     | type byte + 8-byte little-endian unsigned            |
 * | double     | type byte + IEEE-754 binary64                        |
 * | string     | type byte + u32 length + UTF-8                       |
 * | data       | type byte + u32 length + bytes                       |
 * | uuid       | type byte + 16 bytes                                 |
 * | date       | type byte + int64 milliseconds since epoch           |
 * | array      | type byte + u32 count + values                       |
 * | dictionary | type byte + u32 count + (string key, value) pairs     |
 */

import { XpcError } from "../errors.js";

export const XPC_MAGIC = 0x5844_4331; // "XDC1"
export const XPC_VERSION = 1;
export const XPC_MAX_BYTES = 8 * 1024 * 1024;
export const XPC_MAX_DEPTH = 64;
export const XPC_MAX_ELEMENTS = 1_000_000;

export interface XpcUuid {
  readonly uuid: string;
}

export type XpcValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Date
  | XpcUuid
  | XpcValue[]
  | { [key: string]: XpcValue };

const enum XpcType {
  Null = 0,
  False = 1,
  True = 2,
  Int64 = 3,
  Uint64 = 4,
  Double = 5,
  String = 6,
  Data = 7,
  Uuid = 8,
  Date = 9,
  Array = 10,
  Dictionary = 11,
}

class Writer {
  private readonly chunks: number[] = [];
  get length(): number {
    return this.chunks.length;
  }
  u8(value: number): void {
    this.chunks.push(value & 0xff);
  }
  u16(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
  }
  u32(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
    this.u8(value >>> 16);
    this.u8(value >>> 24);
  }
  u64(value: bigint): void {
    const big = BigInt.asUintN(64, value);
    this.u32(Number(big & 0xffff_ffffn));
    this.u32(Number((big >> 32n) & 0xffff_ffffn));
  }
  f64(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    for (const byte of bytes) this.u8(byte);
  }
  bytes(value: Uint8Array): void {
    for (const byte of value) this.u8(byte);
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export function encodeXpcValue(value: XpcValue): Uint8Array {
  const writer = new Writer();
  encodeValue(writer, value, 0);
  if (writer.length > XPC_MAX_BYTES)
    throw new XpcError("xpc_too_large", `encoded XPC value exceeds ${XPC_MAX_BYTES} bytes`);
  return writer.toUint8Array();
}

function encodeValue(writer: Writer, value: XpcValue, depth: number): void {
  if (depth > XPC_MAX_DEPTH)
    throw new XpcError("xpc_too_deep", `XPC value exceeds depth ${XPC_MAX_DEPTH}`);
  if (value === null) {
    writer.u8(XpcType.Null);
  } else if (value === false) {
    writer.u8(XpcType.False);
  } else if (value === true) {
    writer.u8(XpcType.True);
  } else if (typeof value === "bigint") {
    if (value < 0n) {
      writer.u8(XpcType.Int64);
      writer.u64(BigInt.asUintN(64, value));
    } else if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      writer.u8(XpcType.Int64);
      writer.u64(value);
    } else {
      writer.u8(XpcType.Uint64);
      writer.u64(value);
    }
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new XpcError("xpc_non_finite", "XPC numbers must be finite");
    if (Number.isInteger(value) && Number.isSafeInteger(value) && !Object.is(value, -0)) {
      writer.u8(value < 0 ? XpcType.Int64 : XpcType.Uint64);
      writer.u64(BigInt(value));
    } else {
      writer.u8(XpcType.Double);
      writer.f64(value);
    }
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > XPC_MAX_BYTES)
      throw new XpcError("xpc_too_large", "XPC string is too large");
    writer.u8(XpcType.String);
    writer.u32(bytes.length);
    writer.bytes(bytes);
  } else if (value instanceof Uint8Array) {
    if (value.length > XPC_MAX_BYTES) throw new XpcError("xpc_too_large", "XPC data is too large");
    writer.u8(XpcType.Data);
    writer.u32(value.length);
    writer.bytes(value);
  } else if (value instanceof Date) {
    writer.u8(XpcType.Date);
    writer.u64(BigInt(Math.trunc(value.getTime())));
  } else if (isUuid(value)) {
    writer.u8(XpcType.Uuid);
    writer.bytes(parseUuid(value.uuid));
  } else if (Array.isArray(value)) {
    if (value.length > XPC_MAX_ELEMENTS)
      throw new XpcError("xpc_too_large", "XPC array is too large");
    writer.u8(XpcType.Array);
    writer.u32(value.length);
    for (const item of value) encodeValue(writer, item, depth + 1);
  } else if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > XPC_MAX_ELEMENTS)
      throw new XpcError("xpc_too_large", "XPC dictionary is too large");
    writer.u8(XpcType.Dictionary);
    writer.u32(keys.length);
    for (const key of keys.sort()) {
      assertSafeKey(key);
      encodeValue(writer, key, depth + 1);
      encodeValue(writer, (value as Record<string, XpcValue>)[key]!, depth + 1);
    }
  } else {
    throw new XpcError("xpc_unsupported", `cannot encode XPC value of type ${typeof value}`);
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get position(): number {
    return this.offset;
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  u8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }
  u16(): number {
    this.require(2);
    const value = this.bytes[this.offset]! | (this.bytes[this.offset + 1]! << 8);
    this.offset += 2;
    return value;
  }
  u32(): number {
    this.require(4);
    const value =
      (this.bytes[this.offset]! |
        (this.bytes[this.offset + 1]! << 8) |
        (this.bytes[this.offset + 2]! << 16) |
        (this.bytes[this.offset + 3]! << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }
  u64(): bigint {
    const low = BigInt(this.u32());
    const high = BigInt(this.u32());
    return (high << 32n) | low;
  }
  f64(): number {
    this.require(8);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    const value = view.getFloat64(0, true);
    this.offset += 8;
    return value;
  }
  bytesOf(length: number): Uint8Array {
    if (length < 0) throw new XpcError("xpc_bad_length", `negative XPC length ${length}`);
    this.require(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  private require(size: number): void {
    if (this.offset + size > this.bytes.length) {
      throw new XpcError(
        "xpc_truncated",
        `XPC read of ${size} byte(s) at ${this.offset} exceeds ${this.bytes.length}`,
      );
    }
  }
}

export function decodeXpcValue(bytes: Uint8Array): XpcValue {
  if (bytes.length > XPC_MAX_BYTES)
    throw new XpcError("xpc_too_large", `XPC value exceeds ${XPC_MAX_BYTES} bytes`);
  const reader = new Reader(bytes);
  const value = decodeValue(reader, 0);
  if (reader.remaining !== 0)
    throw new XpcError(
      "xpc_trailing_bytes",
      `${reader.remaining} trailing byte(s) after XPC value`,
    );
  return value;
}

function decodeValue(reader: Reader, depth: number): XpcValue {
  if (depth > XPC_MAX_DEPTH)
    throw new XpcError("xpc_too_deep", `XPC value exceeds depth ${XPC_MAX_DEPTH}`);
  const type = reader.u8();
  switch (type) {
    case XpcType.Null:
      return null;
    case XpcType.False:
      return false;
    case XpcType.True:
      return true;
    case XpcType.Int64: {
      const value = BigInt.asIntN(64, reader.u64());
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value;
    }
    case XpcType.Uint64: {
      const value = reader.u64();
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    case XpcType.Double:
      return reader.f64();
    case XpcType.String: {
      const length = reader.u32();
      if (length > XPC_MAX_BYTES)
        throw new XpcError("xpc_too_large", `XPC string length ${length} is too large`);
      return new TextDecoder("utf-8", { fatal: true }).decode(reader.bytesOf(length));
    }
    case XpcType.Data: {
      const length = reader.u32();
      if (length > XPC_MAX_BYTES)
        throw new XpcError("xpc_too_large", `XPC data length ${length} is too large`);
      return reader.bytesOf(length);
    }
    case XpcType.Uuid:
      return { uuid: formatUuid(reader.bytesOf(16)) };
    case XpcType.Date:
      return new Date(Number(BigInt.asIntN(64, reader.u64())));
    case XpcType.Array: {
      const count = reader.u32();
      if (count > XPC_MAX_ELEMENTS)
        throw new XpcError("xpc_too_large", `XPC array count ${count} is too large`);
      const result: XpcValue[] = [];
      for (let index = 0; index < count; index += 1) result.push(decodeValue(reader, depth + 1));
      return result;
    }
    case XpcType.Dictionary: {
      const count = reader.u32();
      if (count > XPC_MAX_ELEMENTS)
        throw new XpcError("xpc_too_large", `XPC dictionary count ${count} is too large`);
      const result: Record<string, XpcValue> = {};
      for (let index = 0; index < count; index += 1) {
        const key = decodeValue(reader, depth + 1);
        if (typeof key !== "string")
          throw new XpcError("xpc_bad_key", "XPC dictionary keys must be strings");
        assertSafeKey(key);
        result[key] = decodeValue(reader, depth + 1);
      }
      return result;
    }
    default:
      throw new XpcError("xpc_unknown_type", `unknown XPC type ${type}`);
  }
}

function assertSafeKey(key: string): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new XpcError("xpc_unsafe_key", `XPC dictionary key ${key} is not allowed`);
  }
}

export function isUuid(value: XpcValue): value is XpcUuid {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date) &&
    !Array.isArray(value) &&
    typeof (value as XpcUuid).uuid === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((value as XpcUuid).uuid)
  );
}

function parseUuid(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (hex.length !== 32) throw new XpcError("xpc_bad_uuid", `UUID ${value} is not 16 bytes`);
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte))
      throw new XpcError("xpc_bad_uuid", `UUID ${value} contains non-hex characters`);
    bytes[index] = byte;
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
