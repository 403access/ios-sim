/**
 * Fat/universal Mach-O header parsing.
 *
 * Universal binaries store architecture slices back to back. Everything in the
 * fat header is big-endian, unlike the little-endian Mach-O slices it points
 * at. Bounds are checked before any slice is handed to the thin parser.
 */

import { MachOError } from "../errors.js";
import {
  CPU_SUBTYPE_ARM64E,
  CPU_SUBTYPE_MASK,
  CPU_TYPE_ARM64,
  FAT_MAGIC,
  FAT_MAGIC_64,
} from "./constants.js";
import type { FatFile, FatSlice } from "./types.js";

export function parseFatHeader(bytes: Uint8Array): FatFile | null {
  if (bytes.byteLength < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return null;
  const is64 = magic === FAT_MAGIC_64;
  const count = view.getUint32(4, false);
  if (count === 0)
    throw new MachOError("fat_empty", "universal binary declares zero architecture slices");
  if (count > 64)
    throw new MachOError("fat_too_many_slices", `universal binary declares ${count} slices`);
  const entrySize = is64 ? 32 : 20;
  const headerEnd = 8 + count * entrySize;
  if (headerEnd > bytes.byteLength) {
    throw new MachOError("fat_truncated", "universal binary header is truncated");
  }

  const slices: FatSlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 8 + index * entrySize;
    const cpuType = view.getInt32(at, false);
    const cpuSubtype = view.getInt32(at + 4, false);
    const offset = is64 ? Number(view.getBigUint64(at + 8, false)) : view.getUint32(at + 8, false);
    const size = is64 ? Number(view.getBigUint64(at + 16, false)) : view.getUint32(at + 12, false);
    const alignment = is64 ? view.getUint32(at + 24, false) : view.getUint32(at + 16, false);
    const reserved = is64 ? view.getUint32(at + 28, false) : undefined;

    if (offset > bytes.byteLength || size > bytes.byteLength || offset + size > bytes.byteLength) {
      throw new MachOError(
        "fat_slice_out_of_bounds",
        `slice ${index} (${size} bytes at ${offset}) exceeds the file (${bytes.byteLength} bytes)`,
      );
    }
    if (alignment > 31) {
      throw new MachOError(
        "fat_bad_alignment",
        `slice ${index} alignment 2^${alignment} is not plausible`,
      );
    }
    slices.push({ cpuType, cpuSubtype, offset, size, alignment, reserved });
  }

  return { magic, is64, slices };
}

export function isArm64(cpuType: number, cpuSubtype: number): boolean {
  return cpuType === CPU_TYPE_ARM64;
}

export function isArm64e(cpuType: number, cpuSubtype: number): boolean {
  return (
    cpuType === CPU_TYPE_ARM64 && (cpuSubtype & ~CPU_SUBTYPE_MASK & 0xff) === CPU_SUBTYPE_ARM64E
  );
}

/** Choose the preferred arm64 slice from a fat file. */
export function selectSlice(fat: FatFile, arch: "arm64" | "arm64e" = "arm64"): FatSlice {
  const armSlices = fat.slices.filter((slice) => isArm64(slice.cpuType, slice.cpuSubtype));
  if (armSlices.length === 0) {
    throw new MachOError(
      "unsupported_architecture",
      `universal binary has no arm64 slice (found ${fat.slices.map((slice) => `0x${slice.cpuType.toString(16)}`).join(", ")})`,
    );
  }
  if (arch === "arm64e") {
    const arm64e = armSlices.find((slice) => isArm64e(slice.cpuType, slice.cpuSubtype));
    if (!arm64e)
      throw new MachOError("unsupported_architecture", "universal binary has no arm64e slice");
    return arm64e;
  }
  return armSlices.find((slice) => !isArm64e(slice.cpuType, slice.cpuSubtype)) ?? armSlices[0]!;
}
