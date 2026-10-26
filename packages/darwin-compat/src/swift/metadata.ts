/**
 * Swift 5 metadata parsing (RT-009).
 *
 * Reads the relative-pointer structures in `__swift5_types` and
 * `__swift5_proto`: context descriptors, type kinds, and mangled names. This
 * makes metadata inspectable, but it does **not** implement the Swift runtime,
 * generic metadata instantiation, or a Swift ABI entry point.
 */

import { CompatError } from "../errors.js";

export class SwiftMetadataError extends CompatError {
  override name = "SwiftMetadataError";
}

export type SwiftTypeKind = "class" | "struct" | "enum" | "unknown";

export interface SwiftTypeDescriptor {
  readonly kind: SwiftTypeKind;
  readonly name: string;
  readonly flags: number;
  readonly hasParent: boolean;
  readonly generic: boolean;
  readonly resilient: boolean;
}

export interface SwiftProtocolDescriptor {
  readonly name: string;
  readonly flags: number;
  readonly requirements: number;
}

export interface SwiftMetadata {
  readonly types: readonly SwiftTypeDescriptor[];
  readonly protocols: readonly SwiftProtocolDescriptor[];
}

const CONTEXT_KIND_MASK = 0x1f;
const CONTEXT_GENERIC = 0x0001_0000;
const CONTEXT_RESILIENT = 0x0010_0000;

function reader(bytes: Uint8Array, offset: number, size: number, label: string) {
  if (offset < 0 || size < 0 || offset + size > bytes.byteLength) {
    throw new SwiftMetadataError("swift_out_of_bounds", `${label} exceeds the section`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function relative(bytes: Uint8Array, field: number, label: string): number {
  const view = reader(bytes, field, 4, label);
  const delta = view.getInt32(field, true);
  const target = field + delta;
  if (target < 0 || target >= bytes.byteLength) {
    throw new SwiftMetadataError("swift_bad_relative", `${label} points outside the section`);
  }
  return target;
}

function cstring(bytes: Uint8Array, offset: number, label: string): string {
  if (offset < 0 || offset >= bytes.byteLength) {
    throw new SwiftMetadataError(
      "swift_out_of_bounds",
      `${label} name offset is outside the section`,
    );
  }
  let end = offset;
  while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
  if (end >= bytes.byteLength) {
    throw new SwiftMetadataError("swift_bad_name", `${label} name is unterminated`);
  }
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function kindOf(flags: number): SwiftTypeKind {
  const kind = flags & CONTEXT_KIND_MASK;
  return kind === 0 ? "class" : kind === 1 ? "struct" : kind === 2 ? "enum" : "unknown";
}

export function parseSwiftTypes(
  bytes: Uint8Array,
  pointerCount = bytes.length / 4,
): SwiftTypeDescriptor[] {
  if (bytes.length % 4 !== 0) {
    throw new SwiftMetadataError("swift_bad_section", "type section is not 4-byte aligned");
  }
  const view = reader(bytes, 0, bytes.length, "type section");
  const types: SwiftTypeDescriptor[] = [];
  if (pointerCount < 0 || pointerCount * 4 > bytes.length) {
    throw new SwiftMetadataError("swift_bad_section", "type pointer count is out of bounds");
  }
  for (let slot = 0; slot < pointerCount; slot += 1) {
    const index = slot * 4;
    const descriptor = relative(bytes, index, `type slot ${slot}`);
    if (descriptor + 12 > bytes.length) {
      throw new SwiftMetadataError(
        "swift_out_of_bounds",
        `type descriptor ${index / 4} is truncated`,
      );
    }
    const flags = view.getUint32(descriptor, true);
    const parent = view.getInt32(descriptor + 4, true);
    const name = cstring(bytes, relative(bytes, descriptor + 8, "type name"), "type");
    types.push({
      kind: kindOf(flags),
      name,
      flags,
      hasParent: parent !== 0,
      generic: (flags & CONTEXT_GENERIC) !== 0,
      resilient: (flags & CONTEXT_RESILIENT) !== 0,
    });
  }
  return types;
}

export function parseSwiftProtocols(
  bytes: Uint8Array,
  pointerCount = bytes.length / 4,
): SwiftProtocolDescriptor[] {
  if (bytes.length % 4 !== 0) {
    throw new SwiftMetadataError("swift_bad_section", "protocol section is not 4-byte aligned");
  }
  const view = reader(bytes, 0, bytes.length, "protocol section");
  const protocols: SwiftProtocolDescriptor[] = [];
  if (pointerCount < 0 || pointerCount * 4 > bytes.length) {
    throw new SwiftMetadataError("swift_bad_section", "protocol pointer count is out of bounds");
  }
  for (let slot = 0; slot < pointerCount; slot += 1) {
    const index = slot * 4;
    const descriptor = relative(bytes, index, `protocol slot ${slot}`);
    if (descriptor + 16 > bytes.length) {
      throw new SwiftMetadataError(
        "swift_out_of_bounds",
        `protocol descriptor ${index / 4} is truncated`,
      );
    }
    const flags = view.getUint32(descriptor, true);
    const name = cstring(bytes, relative(bytes, descriptor + 8, "protocol name"), "protocol");
    const requirements = view.getUint16(descriptor + 12, true);
    protocols.push({ name, flags, requirements });
  }
  return protocols;
}

export function parseSwiftMetadata(input: {
  types?: Uint8Array;
  protocols?: Uint8Array;
  typeCount?: number;
  protocolCount?: number;
}): SwiftMetadata {
  return {
    types: input.types ? parseSwiftTypes(input.types, input.typeCount) : [],
    protocols: input.protocols ? parseSwiftProtocols(input.protocols, input.protocolCount) : [],
  };
}
