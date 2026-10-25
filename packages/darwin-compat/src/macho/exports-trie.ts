/**
 * `LC_DYLD_EXPORTS_TRIE` decoding.
 *
 * The trie stores exported symbols as a radix tree of bytes. Each node has an
 * optional terminal record followed by a list of `(edge byte, child offset)`
 * entries. Addresses in regular exports are VM offsets from the image base.
 */

import { MachOError } from "../errors.js";
import {
  EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE,
  EXPORT_SYMBOL_FLAGS_KIND_MASK,
  EXPORT_SYMBOL_FLAGS_KIND_REGULAR,
  EXPORT_SYMBOL_FLAGS_KIND_THREAD_LOCAL,
  EXPORT_SYMBOL_FLAGS_REEXPORT,
  EXPORT_SYMBOL_FLAGS_STUB_AND_RESOLVER,
  EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION,
} from "./constants.js";

export interface ExportEntry {
  readonly name: string;
  readonly kind: "regular" | "thread-local" | "absolute" | "reexport";
  readonly flags: number;
  readonly weak: boolean;
  readonly address: number | null;
  readonly stub: number | null;
  readonly reexport: { ordinal: number; name: string } | null;
}

const MAX_NODES = 100_000;

export function parseExportsTrie(
  bytes: Uint8Array,
  dataOffset: number,
  dataSize: number,
): ReadonlyMap<string, ExportEntry> {
  if (dataSize === 0) return new Map();
  const end = dataOffset + dataSize;
  if (dataOffset < 0 || end > bytes.byteLength) {
    throw new MachOError(
      "exports_out_of_bounds",
      `exports trie 0x${dataOffset.toString(16)}+0x${dataSize.toString(16)} is outside the file`,
    );
  }

  const exports = new Map<string, ExportEntry>();
  const stack: Array<{ nodeOffset: number; prefix: string; depth: number }> = [
    { nodeOffset: 0, prefix: "", depth: 0 },
  ];
  const visited = new Set<string>();
  let nodes = 0;

  while (stack.length > 0) {
    const task = stack.pop()!;
    if (nodes++ > MAX_NODES) {
      throw new MachOError("exports_too_large", `exports trie exceeds ${MAX_NODES} nodes`);
    }
    if (task.depth > 1024) {
      throw new MachOError("exports_too_deep", "exports trie exceeds the maximum edge depth");
    }
    const key = `${task.nodeOffset}:${task.prefix}`;
    if (visited.has(key)) {
      throw new MachOError("exports_cycle", `exports trie revisits node ${task.nodeOffset}`);
    }
    visited.add(key);

    let cursor = dataOffset + task.nodeOffset;
    if (cursor < dataOffset || cursor >= end) {
      throw new MachOError(
        "exports_out_of_bounds",
        `exports node 0x${task.nodeOffset.toString(16)} is outside the trie`,
      );
    }

    const terminal = readUleb(bytes, cursor, end);
    cursor = terminal.next;
    if (terminal.value > 0) {
      const flags = readUleb(bytes, cursor, end);
      cursor = flags.next;
      const kindBits = flags.value & EXPORT_SYMBOL_FLAGS_KIND_MASK;
      const weak = (flags.value & EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION) !== 0;

      if ((flags.value & EXPORT_SYMBOL_FLAGS_REEXPORT) !== 0) {
        const ordinal = readUleb(bytes, cursor, end);
        cursor = ordinal.next;
        const imported = readCString(bytes, cursor, end);
        exports.set(task.prefix, {
          name: task.prefix,
          kind: "reexport",
          flags: flags.value,
          weak,
          address: null,
          stub: null,
          reexport: { ordinal: ordinal.value, name: imported.value },
        });
      } else {
        const address = readUleb(bytes, cursor, end);
        cursor = address.next;
        let stub: number | null = null;
        if ((flags.value & EXPORT_SYMBOL_FLAGS_STUB_AND_RESOLVER) !== 0) {
          const resolver = readUleb(bytes, cursor, end);
          cursor = resolver.next;
          stub = resolver.value;
        }
        const kind =
          kindBits === EXPORT_SYMBOL_FLAGS_KIND_REGULAR
            ? "regular"
            : kindBits === EXPORT_SYMBOL_FLAGS_KIND_THREAD_LOCAL
              ? "thread-local"
              : kindBits === EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE
                ? "absolute"
                : null;
        if (!kind) {
          throw new MachOError(
            "unsupported_export_kind",
            `export ${task.prefix} uses unknown kind ${kindBits}`,
          );
        }
        exports.set(task.prefix, {
          name: task.prefix,
          kind,
          flags: flags.value,
          weak,
          address: address.value,
          stub,
          reexport: null,
        });
      }
    }

    if (cursor >= end) {
      throw new MachOError(
        "exports_out_of_bounds",
        `exports node 0x${task.nodeOffset.toString(16)} ends outside the trie`,
      );
    }
    const childCount = bytes[cursor]!;
    cursor += 1;

    const children: Array<{ edge: string; childOffset: number }> = [];
    for (let index = 0; index < childCount; index += 1) {
      const edge = readCString(bytes, cursor, end);
      cursor = edge.next;
      const child = readUleb(bytes, cursor, end);
      cursor = child.next;
      if (child.value !== 0) {
        if (child.value >= dataSize) {
          throw new MachOError(
            "exports_out_of_bounds",
            `export child offset 0x${child.value.toString(16)} is outside the trie`,
          );
        }
        children.push({ edge: edge.value, childOffset: child.value });
      }
    }

    // Push in reverse so the traversal yields deterministic (lexical-ish) order.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      stack.push({
        nodeOffset: child.childOffset,
        prefix: task.prefix + child.edge,
        depth: task.depth + 1,
      });
    }
  }

  return exports;
}

function readUleb(bytes: Uint8Array, offset: number, end: number): { value: number; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  for (let index = 0; index < 10; index += 1) {
    if (cursor >= end) {
      throw new MachOError(
        "exports_out_of_bounds",
        `ULEB at 0x${offset.toString(16)} runs past the trie`,
      );
    }
    const byte = bytes[cursor++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new MachOError(
          "exports_integer_overflow",
          `ULEB at 0x${offset.toString(16)} is too large`,
        );
      }
      return { value: Number(value), next: cursor };
    }
    shift += 7n;
  }
  throw new MachOError(
    "exports_integer_overflow",
    `ULEB at 0x${offset.toString(16)} is longer than 10 bytes`,
  );
}

function readCString(
  bytes: Uint8Array,
  offset: number,
  end: number,
): { value: string; next: number } {
  let cursor = offset;
  while (cursor < end && bytes[cursor] !== 0) cursor += 1;
  if (cursor >= end) {
    throw new MachOError(
      "unterminated_string",
      `exports string at 0x${offset.toString(16)} is unterminated`,
    );
  }
  return {
    value: new TextDecoder().decode(bytes.subarray(offset, cursor)),
    next: cursor + 1,
  };
}
