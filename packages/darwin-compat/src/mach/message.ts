/**
 * Raw Mach message encoding plus a compact MIG-like codec.
 *
 * Apple's MIG wire format is generated from `.defs` files and is not
 * reimplemented here. The codec is deliberately simple and documented so that
 * fixtures, clients, and servers share one bounded implementation:
 *
 * - every scalar is little-endian and 32-bit aligned;
 * - `u64` occupies eight bytes aligned to four;
 * - strings are `u32 byte length` followed by UTF-8 bytes and 4-byte padding.
 */

import { CompatError, MachError } from "../errors.js";
import type { MachMessage, MachMessageHeader } from "./kernel.js";

export function encodeMachMessage(header: MachMessageHeader, body: Uint8Array): Uint8Array {
  if (header.size !== body.length + 24) {
    throw new MachError(
      "message_size",
      `header size ${header.size} does not match body ${body.length} + 24`,
    );
  }
  const bytes = new Uint8Array(header.size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.bits >>> 0, true);
  view.setUint32(4, header.size >>> 0, true);
  view.setUint32(8, header.remotePort >>> 0, true);
  view.setUint32(12, header.localPort >>> 0, true);
  view.setUint32(16, header.voucherPort >>> 0, true);
  view.setInt32(20, header.id | 0, true);
  bytes.set(body, 24);
  return bytes;
}

export function decodeMachMessage(bytes: Uint8Array): MachMessage {
  if (bytes.length < 24)
    throw new MachError("message_too_small", `Mach message is ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(4, true);
  if (size < 24 || size > bytes.length) {
    throw new MachError(
      "message_size",
      `Mach message header size ${size} is outside the buffer (${bytes.length})`,
    );
  }
  return {
    header: {
      bits: view.getUint32(0, true),
      size,
      remotePort: view.getUint32(8, true),
      localPort: view.getUint32(12, true),
      voucherPort: view.getUint32(16, true),
      id: view.getInt32(20, true),
    },
    body: bytes.subarray(24, size),
  };
}

export const MIG_TYPE_U32 = 0;
export const MIG_TYPE_U64 = 1;
export const MIG_TYPE_STRING = 2;
export const MIG_TYPE_BYTES = 3;

export class MigWriter {
  private readonly chunks: number[] = [];

  get length(): number {
    return this.chunks.length;
  }

  u32(value: number): this {
    this.chunks.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
    return this;
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  u64(value: bigint | number): this {
    const big = BigInt.asUintN(64, typeof value === "bigint" ? value : BigInt(value));
    this.u32(Number(big & 0xffff_ffffn));
    this.u32(Number((big >> 32n) & 0xffff_ffffn));
    return this;
  }

  string(value: string): this {
    const bytes = new TextEncoder().encode(value);
    this.u32(bytes.length);
    this.chunks.push(...bytes);
    return this.pad();
  }

  bytes(value: Uint8Array): this {
    this.u32(value.length);
    this.chunks.push(...value);
    return this.pad();
  }

  /** Append bytes without a length prefix (used for already-encoded replies). */
  raw(value: Uint8Array): this {
    this.chunks.push(...value);
    return this;
  }

  pad(): this {
    while (this.chunks.length % 4 !== 0) this.chunks.push(0);
    return this;
  }

  toUint8Array(): Uint8Array {
    this.pad();
    return Uint8Array.from(this.chunks);
  }
}

export class MigReader {
  private offset: number;

  constructor(
    private readonly data: Uint8Array,
    offset = 0,
  ) {
    this.offset = offset;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  u32(): number {
    this.require(4);
    const value =
      (this.data[this.offset]! |
        (this.data[this.offset + 1]! << 8) |
        (this.data[this.offset + 2]! << 16) |
        (this.data[this.offset + 3]! << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }

  i32(): number {
    return this.u32() | 0;
  }

  u64(): bigint {
    const low = BigInt(this.u32());
    const high = BigInt(this.u32());
    return (high << 32n) | low;
  }

  string(maxLength = 1_000_000): string {
    const length = this.u32();
    if (length > maxLength)
      throw new CompatError(
        "mig_string_too_long",
        `MIG string length ${length} exceeds ${maxLength}`,
      );
    this.require(length);
    const value = new TextDecoder().decode(this.data.subarray(this.offset, this.offset + length));
    this.offset += length;
    this.skipPadding();
    return value;
  }

  bytesOf(maxLength = 16 * 1024 * 1024): Uint8Array {
    const length = this.u32();
    if (length > maxLength)
      throw new CompatError("mig_bytes_too_long", `MIG byte length ${length} exceeds ${maxLength}`);
    this.require(length);
    const value = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    this.skipPadding();
    return value;
  }

  private skipPadding(): void {
    while (this.offset % 4 !== 0) this.offset += 1;
  }

  private require(size: number): void {
    if (this.offset + size > this.data.length) {
      throw new CompatError(
        "mig_out_of_bounds",
        `MIG read of ${size} byte(s) at ${this.offset} exceeds ${this.data.length}`,
      );
    }
  }
}

export const MIG_BOOTSTRAP_SUBSYSTEM = 0x4441_0000;
export const MIG_BOOTSTRAP_LOOKUP = 0;
export const MIG_BOOTSTRAP_REGISTER = 1;
export const MIG_BOOTSTRAP_LIST = 2;
