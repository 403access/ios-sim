/**
 * Code-signature superblob parser (LDR-010).
 *
 * This reads Apple's embedded-signature container (`LC_CODE_SIGNATURE`): the
 * superblob index, the CodeDirectory, entitlements, and a signature wrapper.
 * It deliberately does **not** verify hashes, certificates, or the CMS
 * signature. Parsing is bounded and big-endian, matching `cs_blobs.h`.
 *
 * Supported CodeDirectory versions: 0x20001 and later. Fields from later
 * versions are read only when the header is long enough.
 */

import { MachOError } from "../errors.js";
import { parsePlist, type PlistValue } from "../plist/parse.js";

const CSMAGIC_REQUIREMENT = 0xfade0c00;
const CSMAGIC_REQUIREMENTS = 0xfade0c01;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_BLOBWRAPPER = 0xfade0b01;
const CSMAGIC_EMBEDDED_ENTITLEMENTS = 0xfade7171;
const CSMAGIC_EMBEDDED_DER_ENTITLEMENTS = 0xfade7172;

const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_ENTITLEMENTS = 5;
const CSSLOT_DER_ENTITLEMENTS = 7;
const CSSLOT_SIGNATURESLOT = 0x10000;

const MAX_BLOBS = 64;
const MAX_BLOB_SIZE = 64 * 1024 * 1024;

export interface CodeDirectoryInfo {
  readonly version: number;
  readonly flags: number;
  readonly identifier: string;
  readonly teamId: string | null;
  readonly hashType: string;
  readonly hashSize: number;
  readonly pageSize: number;
  readonly codeLimit: bigint;
  readonly codeSlots: number;
  readonly specialSlots: number;
  readonly executableSegment: { base: bigint; limit: bigint; flags: bigint } | null;
}

export interface CodeSignatureBlob {
  readonly type: number;
  readonly magic: number;
  readonly offset: number;
  readonly size: number;
}

export interface CodeSignatureInfo {
  readonly blobs: readonly CodeSignatureBlob[];
  readonly codeDirectory: CodeDirectoryInfo | null;
  readonly entitlements: PlistValue | null;
  readonly entitlementsRaw: string | null;
  readonly hasRequirements: boolean;
  readonly hasSignature: boolean;
  readonly hasDerEntitlements: boolean;
}

interface Reader {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
}

function reader(bytes: Uint8Array, start: number, size: number, label: string): Reader {
  if (start < 0 || size < 0 || start + size > bytes.byteLength) {
    throw new MachOError(
      "code_signature_out_of_bounds",
      `${label} [${start}, ${start + size}) exceeds the file`,
    );
  }
  return { bytes, start, end: start + size };
}

function u8(state: Reader, offset: number, label: string): number {
  if (offset < state.start || offset >= state.end) {
    throw new MachOError("code_signature_truncated", `${label} is truncated`);
  }
  return state.bytes[offset]!;
}

function u32(state: Reader, offset: number, label: string): number {
  if (offset + 4 > state.end) {
    throw new MachOError("code_signature_truncated", `${label} is truncated`);
  }
  return new DataView(state.bytes.buffer, state.bytes.byteOffset, state.bytes.byteLength).getUint32(
    offset,
    false,
  );
}

function u64(state: Reader, offset: number, label: string): bigint {
  if (offset + 8 > state.end) {
    throw new MachOError("code_signature_truncated", `${label} is truncated`);
  }
  return new DataView(
    state.bytes.buffer,
    state.bytes.byteOffset,
    state.bytes.byteLength,
  ).getBigUint64(offset, false);
}

function cstring(state: Reader, offset: number, label: string): string {
  if (offset < state.start || offset >= state.end) {
    throw new MachOError("code_signature_truncated", `${label} starts outside the blob`);
  }
  let end = offset;
  while (end < state.end && state.bytes[end] !== 0) end += 1;
  if (end >= state.end) {
    throw new MachOError("code_signature_truncated", `${label} has no NUL terminator`);
  }
  return new TextDecoder().decode(state.bytes.subarray(offset, end));
}

function blobHeader(
  state: Reader,
  offset: number,
  label: string,
): { magic: number; length: number } {
  const magic = u32(state, offset, label);
  const length = u32(state, offset + 4, label);
  if (length < 8 || offset + length > state.end) {
    throw new MachOError("bad_code_signature_blob", `${label} length ${length} is out of bounds`);
  }
  return { magic, length };
}

export function parseCodeSignature(
  bytes: Uint8Array,
  offset: number,
  size: number,
): CodeSignatureInfo {
  const state = reader(bytes, offset, size, "code signature");
  const magic = u32(state, offset, "superblob magic");
  if (magic !== CSMAGIC_EMBEDDED_SIGNATURE) {
    throw new MachOError(
      "bad_code_signature_magic",
      `expected embedded signature 0x${CSMAGIC_EMBEDDED_SIGNATURE.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  const length = u32(state, offset + 4, "superblob length");
  if (length < 12 || offset + length > state.end) {
    throw new MachOError("bad_code_signature_blob", `superblob length ${length} is out of bounds`);
  }
  const count = u32(state, offset + 8, "superblob count");
  if (count > MAX_BLOBS) {
    throw new MachOError("too_many_signature_blobs", `superblob declares ${count} blobs`);
  }
  const indexStart = offset + 12;
  if (indexStart + count * 8 > offset + length) {
    throw new MachOError("code_signature_truncated", "superblob index is truncated");
  }

  const blobs: CodeSignatureBlob[] = [];
  let codeDirectory: CodeDirectoryInfo | null = null;
  let entitlements: PlistValue | null = null;
  let entitlementsRaw: string | null = null;
  let hasRequirements = false;
  let hasSignature = false;
  let hasDerEntitlements = false;

  for (let index = 0; index < count; index += 1) {
    const type = u32(state, indexStart + index * 8, "blob type");
    const relative = u32(state, indexStart + index * 8 + 4, "blob offset");
    if (relative < 12 || relative >= length) {
      throw new MachOError(
        "bad_code_signature_blob",
        `blob ${index} offset ${relative} is outside the superblob`,
      );
    }
    const blobOffset = offset + relative;
    const header = blobHeader(state, blobOffset, `blob ${index}`);
    if (header.length > MAX_BLOB_SIZE) {
      throw new MachOError("bad_code_signature_blob", `blob ${index} is unreasonably large`);
    }
    blobs.push({ type, magic: header.magic, offset: relative, size: header.length });

    if (type === CSSLOT_CODEDIRECTORY) {
      if (header.magic !== CSMAGIC_CODEDIRECTORY) {
        throw new MachOError("bad_code_signature_blob", "code directory has the wrong magic");
      }
      codeDirectory = parseCodeDirectory(state, blobOffset, header.length);
    } else if (type === CSSLOT_ENTITLEMENTS || header.magic === CSMAGIC_EMBEDDED_ENTITLEMENTS) {
      const textStart = blobOffset + 8;
      const textEnd = blobOffset + header.length;
      const raw = new TextDecoder().decode(
        state.bytes.subarray(textStart, textEnd).filter((byte) => byte !== 0),
      );
      entitlementsRaw = raw;
      try {
        entitlements = parsePlist(raw);
      } catch (error) {
        throw new MachOError("bad_entitlements", "embedded entitlements are not a valid plist", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (
      type === CSSLOT_DER_ENTITLEMENTS ||
      header.magic === CSMAGIC_EMBEDDED_DER_ENTITLEMENTS
    ) {
      hasDerEntitlements = true;
    } else if (type === CSSLOT_SIGNATURESLOT || header.magic === CSMAGIC_BLOBWRAPPER) {
      hasSignature = true;
    } else if (
      type === 2 ||
      header.magic === CSMAGIC_REQUIREMENT ||
      header.magic === CSMAGIC_REQUIREMENTS
    ) {
      hasRequirements = true;
    }
  }

  return {
    blobs,
    codeDirectory,
    entitlements,
    entitlementsRaw,
    hasRequirements,
    hasSignature,
    hasDerEntitlements,
  };
}

function parseCodeDirectory(state: Reader, offset: number, length: number): CodeDirectoryInfo {
  const end = offset + length;
  if (length < 44) {
    throw new MachOError("bad_code_directory", "CodeDirectory is shorter than 44 bytes");
  }
  const version = u32(state, offset + 8, "code directory version");
  const flags = u32(state, offset + 12, "code directory flags");
  const hashOffset = u32(state, offset + 16, "code directory hash offset");
  const identOffset = u32(state, offset + 20, "code directory identifier offset");
  const specialSlots = u32(state, offset + 24, "code directory special slots");
  const codeSlots = u32(state, offset + 28, "code directory code slots");
  const codeLimit = u32(state, offset + 32, "code directory code limit");
  const hashSize = u8(state, offset + 36, "code directory hash size");
  const hashType = u8(state, offset + 37, "code directory hash type");
  const pageSizeByte = u8(state, offset + 39, "code directory page size");
  if (identOffset < 44 || identOffset >= length) {
    throw new MachOError("bad_code_directory", `identifier offset ${identOffset} is out of bounds`);
  }
  if (hashOffset < 44 || hashOffset > length) {
    throw new MachOError("bad_code_directory", `hash offset ${hashOffset} is out of bounds`);
  }
  if (specialSlots > 1_000_000 || codeSlots > 10_000_000) {
    throw new MachOError("bad_code_directory", "CodeDirectory slot count is unreasonable");
  }

  const identifier = cstring(state, offset + identOffset, "code directory identifier");
  let teamId: string | null = null;
  if (version >= 0x20200 && length >= 52) {
    const teamOffset = u32(state, offset + 48, "team identifier offset");
    if (teamOffset >= 44 && teamOffset < length) {
      teamId = cstring(state, offset + teamOffset, "team identifier");
    }
  }

  let executableSegment: CodeDirectoryInfo["executableSegment"] = null;
  if (version >= 0x20400 && length >= 88) {
    executableSegment = {
      base: u64(state, offset + 64, "executable segment base"),
      limit: u64(state, offset + 72, "executable segment limit"),
      flags: u64(state, offset + 80, "executable segment flags"),
    };
  }

  return {
    version,
    flags,
    identifier,
    teamId,
    hashType: hashName(hashType),
    hashSize,
    pageSize: pageSizeByte === 0 ? 1 : 1 << pageSizeByte,
    codeLimit: BigInt(codeLimit),
    codeSlots,
    specialSlots,
    executableSegment,
  };
}

function hashName(type: number): string {
  switch (type) {
    case 1:
      return "sha1";
    case 2:
      return "sha256";
    case 3:
      return "sha256-truncated";
    case 4:
      return "sha384";
    default:
      return `hash-${type}`;
  }
}

export interface BuildCodeSignatureOptions {
  readonly identifier: string;
  readonly teamId?: string;
  readonly entitlements?: string;
  readonly hashType?: 1 | 2 | 3 | 4;
  readonly flags?: number;
  readonly pageSize?: number;
  readonly codeLimit?: number;
  readonly includeSignature?: boolean;
}

/** Build an ad-hoc embedded signature for fixtures (no real CMS). */
export function buildCodeSignature(options: BuildCodeSignatureOptions): Uint8Array {
  const hashType = options.hashType ?? 2;
  const hashSize = hashType === 1 ? 20 : hashType === 2 || hashType === 3 ? 32 : 48;
  const identifier = new TextEncoder().encode(options.identifier);
  const team = options.teamId ? new TextEncoder().encode(options.teamId) : null;
  const identOffset = 52;
  const teamOffset = identOffset + identifier.length + 1;
  const headerSize = team ? teamOffset + (team.length + 1) : identOffset + identifier.length + 1;
  const hashOffset = align(headerSize, 8);
  const length = hashOffset + hashSize;
  const blob = new Uint8Array(length);
  const view = new DataView(blob.buffer);
  view.setUint32(0, CSMAGIC_CODEDIRECTORY, false);
  view.setUint32(4, length, false);
  view.setUint32(8, 0x20200, false);
  view.setUint32(12, options.flags ?? 0, false);
  view.setUint32(16, hashOffset, false);
  view.setUint32(20, identOffset, false);
  view.setUint32(24, 0, false);
  view.setUint32(28, 1, false);
  view.setUint32(32, options.codeLimit ?? 0x1000, false);
  view.setUint8(36, hashSize);
  view.setUint8(37, hashType);
  view.setUint8(38, 0);
  view.setUint8(39, Math.log2(options.pageSize ?? 0x1000));
  view.setUint32(40, 0, false);
  view.setUint32(48, team ? teamOffset : 0, false);
  blob.set(identifier, identOffset);
  if (team) blob.set(team, teamOffset);

  const entitlementBytes = options.entitlements
    ? new TextEncoder().encode(`${options.entitlements}\0`)
    : null;
  const entitlementBlob = entitlementBytes
    ? blobWithMagic(CSMAGIC_EMBEDDED_ENTITLEMENTS, entitlementBytes)
    : null;
  const signatureBlob =
    options.includeSignature === false
      ? null
      : blobWithMagic(CSMAGIC_BLOBWRAPPER, new Uint8Array(8));

  const blobs: Array<{ type: number; bytes: Uint8Array }> = [
    { type: CSSLOT_CODEDIRECTORY, bytes: blob },
  ];
  if (entitlementBlob) blobs.push({ type: CSSLOT_ENTITLEMENTS, bytes: entitlementBlob });
  if (signatureBlob) blobs.push({ type: CSSLOT_SIGNATURESLOT, bytes: signatureBlob });

  const headerBytes = 12 + blobs.length * 8;
  const total = headerBytes + blobs.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const output = new Uint8Array(total);
  const outView = new DataView(output.buffer);
  outView.setUint32(0, CSMAGIC_EMBEDDED_SIGNATURE, false);
  outView.setUint32(4, total, false);
  outView.setUint32(8, blobs.length, false);
  let cursor = headerBytes;
  blobs.forEach((entry, index) => {
    outView.setUint32(12 + index * 8, entry.type, false);
    outView.setUint32(12 + index * 8 + 4, cursor, false);
    output.set(entry.bytes, cursor);
    cursor += entry.bytes.length;
  });
  return output;
}

function blobWithMagic(magic: number, body: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + body.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, magic, false);
  view.setUint32(4, output.length, false);
  output.set(body, 8);
  return output;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
