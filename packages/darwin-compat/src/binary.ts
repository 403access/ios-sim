/**
 * Bounds-checked little-endian readers and writers.
 *
 * Apple's on-disk formats are little-endian on every platform this project
 * targets. Every read is checked: a corrupt Mach-O or plist must produce a
 * {@link MachOError}/{@link CompatError} instead of reading past a buffer.
 */

import { CompatError } from "./errors.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export class BinaryReader {
  readonly bytes: Uint8Array;
  readonly label: string;
  private offset = 0;

  constructor(bytes: Uint8Array, label = "buffer") {
    this.bytes = bytes;
    this.label = label;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  seek(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.bytes.byteLength) {
      throw this.bounds("seek", offset, 0);
    }
    this.offset = offset;
  }

  skip(count: number): void {
    this.seek(this.offset + count);
  }

  private bounds(what: string, offset: number, size: number): CompatError {
    return new CompatError(
      "buffer_out_of_bounds",
      `${this.label}: ${what} needs ${size} byte(s) at 0x${offset.toString(16)}, buffer is ${this.bytes.byteLength} byte(s)`,
      { label: this.label, offset, size, length: this.bytes.byteLength },
    );
  }

  private require(size: number): number {
    const start = this.offset;
    if (start + size > this.bytes.byteLength) throw this.bounds("read", start, size);
    this.offset += size;
    return start;
  }

  u8(): number {
    return this.bytes[this.require(1)]!;
  }

  u16(): number {
    const at = this.require(2);
    return this.bytes[at]! | (this.bytes[at + 1]! << 8);
  }

  u32(): number {
    const at = this.require(4);
    return (
      (this.bytes[at]! |
        (this.bytes[at + 1]! << 8) |
        (this.bytes[at + 2]! << 16) |
        (this.bytes[at + 3]! << 24)) >>>
      0
    );
  }

  i32(): number {
    const at = this.require(4);
    return (
      this.bytes[at]! |
      (this.bytes[at + 1]! << 8) |
      (this.bytes[at + 2]! << 16) |
      (this.bytes[at + 3]! << 24)
    );
  }

  u64(): bigint {
    const low = BigInt(this.u32());
    const high = BigInt(this.u32());
    return (high << 32n) | low;
  }

  /** Read a u64 that must fit in a JavaScript safe integer. */
  safeU64(what = "value"): number {
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CompatError(
        "integer_not_safe",
        `${this.label}: ${what} 0x${value.toString(16)} exceeds JavaScript's safe integer range`,
        { label: this.label, value: value.toString() },
      );
    }
    return Number(value);
  }

  fixedString(length: number): string {
    const at = this.require(length);
    let end = at;
    const limit = at + length;
    while (end < limit && this.bytes[end] !== 0) end += 1;
    return textDecoder.decode(this.bytes.subarray(at, end));
  }

  cstring(maxLength = 4096): string {
    const start = this.offset;
    let end = start;
    while (end < this.bytes.byteLength && this.bytes[end] !== 0) {
      end += 1;
      if (end - start > maxLength) {
        throw new CompatError(
          "string_too_long",
          `${this.label}: string exceeds ${maxLength} bytes`,
        );
      }
    }
    if (end >= this.bytes.byteLength) {
      throw new CompatError(
        "unterminated_string",
        `${this.label}: unterminated C string at 0x${start.toString(16)}`,
      );
    }
    this.offset = end + 1;
    return textDecoder.decode(this.bytes.subarray(start, end));
  }

  bytesOf(length: number): Uint8Array {
    const at = this.require(length);
    return this.bytes.subarray(at, at + length);
  }

  slice(start: number, length: number): Uint8Array {
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0) {
      throw new CompatError("invalid_slice", `${this.label}: invalid slice ${start}+${length}`);
    }
    if (start + length > this.bytes.byteLength) {
      throw new CompatError(
        "buffer_out_of_bounds",
        `${this.label}: slice ${start}+${length} exceeds buffer ${this.bytes.byteLength}`,
        { start, length, size: this.bytes.byteLength },
      );
    }
    return this.bytes.subarray(start, start + length);
  }
}

export class BinaryWriter {
  private readonly chunks: number[] = [];
  private readonly patchPoints: Array<{ offset: number; size: number; value: number }> = [];

  get length(): number {
    return this.chunks.length;
  }

  u8(value: number): this {
    this.chunks.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.u8(value);
    this.u8(value >>> 8);
    return this;
  }

  u32(value: number): this {
    this.u8(value);
    this.u8(value >>> 8);
    this.u8(value >>> 16);
    this.u8(value >>> 24);
    return this;
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  u64(value: bigint | number): this {
    const big = typeof value === "bigint" ? BigInt.asUintN(64, value) : BigInt(value);
    this.u32(Number(big & 0xffff_ffffn));
    this.u32(Number((big >> 32n) & 0xffff_ffffn));
    return this;
  }

  bytes(value: Uint8Array): this {
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  ascii(value: string): this {
    for (const char of value) this.u8(char.charCodeAt(0));
    return this;
  }

  utf8(value: string): this {
    return this.bytes(textEncoder.encode(value));
  }

  cstring(value: string): this {
    this.utf8(value);
    this.u8(0);
    return this;
  }

  zeros(count: number): this {
    for (let index = 0; index < count; index += 1) this.chunks.push(0);
    return this;
  }

  align(alignment: number, fill = 0): this {
    if (alignment <= 0) return this;
    while (this.chunks.length % alignment !== 0) this.chunks.push(fill);
    return this;
  }

  /** Reserve a little-endian u32 to be filled in by {@link patchU32}. */
  reserveU32(): number {
    const offset = this.chunks.length;
    this.u32(0);
    return offset;
  }

  patchU32(offset: number, value: number): void {
    if (offset + 4 > this.chunks.length) {
      throw new CompatError("patch_out_of_bounds", `patch at ${offset} is outside the writer`);
    }
    this.chunks[offset] = value & 0xff;
    this.chunks[offset + 1] = (value >>> 8) & 0xff;
    this.chunks[offset + 2] = (value >>> 16) & 0xff;
    this.chunks[offset + 3] = (value >>> 24) & 0xff;
    this.patchPoints.push({ offset, size: 4, value });
  }

  patchU64(offset: number, value: bigint | number): void {
    if (offset + 8 > this.chunks.length) {
      throw new CompatError("patch_out_of_bounds", `patch at ${offset} is outside the writer`);
    }
    const big = BigInt.asUintN(64, typeof value === "bigint" ? value : BigInt(value));
    for (let index = 0; index < 8; index += 1) {
      this.chunks[offset + index] = Number((big >> BigInt(index * 8)) & 0xffn);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export function readU16LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) {
    throw new CompatError(
      "buffer_out_of_bounds",
      `u16 at 0x${offset.toString(16)} is outside the buffer`,
    );
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

export function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}
