/**
 * Thin Mach-O parser.
 *
 * Design goals:
 * - Never read outside the supplied buffer.
 * - Preserve unknown load commands so inspection stays useful.
 * - Separate decoding from loading: parsing a binary must not allocate images
 *   or execute anything.
 */

import { BinaryReader } from "../binary.js";
import { MachOError } from "../errors.js";
import {
  CPU_TYPE_ARM64,
  LC_BUILD_VERSION,
  LC_CODE_SIGNATURE,
  LC_DYLD_CHAINED_FIXUPS,
  LC_DYLD_EXPORTS_TRIE,
  LC_DYLD_INFO,
  LC_DYLD_INFO_ONLY,
  LC_ENCRYPTION_INFO_64,
  LC_FUNCTION_STARTS,
  LC_ID_DYLIB,
  LC_LAZY_LOAD_DYLIB,
  LC_LOAD_DYLIB,
  LC_LOAD_UPWARD_DYLIB,
  LC_LOAD_WEAK_DYLIB,
  LC_MAIN,
  LC_REEXPORT_DYLIB,
  LC_RPATH,
  LC_SEGMENT_64,
  LC_SOURCE_VERSION,
  LC_SYMTAB,
  LC_UNIXTHREAD,
  LC_UUID,
  LC_ROUTINES_64,
  LC_VERSION_MIN_IPHONEOS,
  LC_VERSION_MIN_MACOSX,
  LC_VERSION_MIN_TVOS,
  LC_VERSION_MIN_WATCHOS,
  LOAD_COMMAND_NAMES,
  MH_MAGIC_64,
  N_EXT,
  N_STAB,
  N_TYPE,
  N_UNDF,
  PLATFORM_NAMES,
  S_ZEROFILL,
  SECTION_TYPE,
} from "./constants.js";
import { parseExportsTrie } from "./exports-trie.js";
import { parseChainedFixups } from "./fixups.js";
import { parseFatHeader, selectSlice } from "./fat.js";
import type {
  BuildVersion,
  DylibReference,
  DyldInfo,
  EncryptionInfo,
  MachHeader,
  MachOImage,
  MachSection,
  MachSegment,
  MachSymbol,
  ParseOptions,
  ParsedMachO,
  SymtabInfo,
  UnixThreadState,
} from "./types.js";

const MAX_LOAD_COMMANDS = 16_384;
const MAX_SYMBOLS = 2_000_000;
const ARM_THREAD_STATE64 = 6;

interface PendingCommand {
  cmd: number;
  cmdsize: number;
  offset: number;
  body: BinaryReader;
}

export function parseMachO(input: Uint8Array, options: ParseOptions = {}): ParsedMachO {
  const fat = parseFatHeader(input);
  let sliceOffset = 0;
  let bytes = input;

  if (fat) {
    const slice = selectSlice(fat, options.arch ?? "arm64");
    sliceOffset = slice.offset;
    bytes = input.subarray(slice.offset, slice.offset + slice.size);
  }

  if (bytes.byteLength < 32) {
    throw new MachOError(
      "truncated_header",
      `Mach-O slice is ${bytes.byteLength} bytes, expected at least 32`,
    );
  }

  const reader = new BinaryReader(bytes, "Mach-O");
  const magic = reader.u32();
  if (magic !== MH_MAGIC_64) {
    if (magic === 0xfeedface || magic === 0xcefaedfe || magic === 0xcffaedfe) {
      throw new MachOError(
        "unsupported_32bit",
        "32-bit Mach-O images are not supported by this layer",
      );
    }
    if (fat) {
      throw new MachOError(
        "fat_slice_not_macho",
        `selected slice at 0x${sliceOffset.toString(16)} is not a Mach-O image`,
      );
    }
    throw new MachOError(
      "bad_magic",
      `expected 64-bit Mach-O magic 0xfeedfacf, got 0x${magic.toString(16)}`,
    );
  }

  const header: MachHeader = {
    magic,
    cpuType: reader.i32(),
    cpuSubtype: reader.i32(),
    fileType: reader.u32(),
    ncmds: reader.u32(),
    sizeofcmds: reader.u32(),
    flags: reader.u32(),
    reserved: reader.u32(),
  };

  if (header.cpuType !== CPU_TYPE_ARM64) {
    throw new MachOError(
      "unsupported_architecture",
      `expected arm64 (0x${CPU_TYPE_ARM64.toString(16)}), got 0x${header.cpuType.toString(16)}`,
    );
  }
  if (header.ncmds > MAX_LOAD_COMMANDS) {
    throw new MachOError(
      "too_many_commands",
      `Mach-O declares ${header.ncmds} load commands (limit ${MAX_LOAD_COMMANDS})`,
    );
  }
  const commandStart = 32;
  const commandEnd = commandStart + header.sizeofcmds;
  if (commandEnd > bytes.byteLength) {
    throw new MachOError(
      "truncated_commands",
      `load commands end at 0x${commandEnd.toString(16)} but the slice is 0x${bytes.byteLength.toString(16)} bytes`,
    );
  }

  const commands: Array<{ cmd: number; cmdsize: number; offset: number; name: string }> = [];
  const segments: MachSegment[] = [];
  const sections: MachSection[] = [];
  const dylibs: DylibReference[] = [];
  const rpaths: string[] = [];
  let symtabInfo: SymtabInfo | null = null;
  let uuid: string | null = null;
  let buildVersion: BuildVersion | null = null;
  let sourceVersion: string | null = null;
  let minimumOsVersion: MachOImage["minimumOsVersion"] = null;
  let main: { entryOffset: number; stackSize: number } | null = null;
  let unixThread: UnixThreadState | null = null;
  let dyldInfo: DyldInfo | null = null;
  let routines: MachOImage["routines"] = null;
  let chainedFixupsOffset: { offset: number; size: number } | null = null;
  let exportsTrieOffset: { offset: number; size: number } | null = null;
  let codeSignature: { dataOffset: number; dataSize: number } | null = null;
  let functionStartsOffset: { offset: number; size: number } | null = null;
  let encryptionInfo: EncryptionInfo | null = null;
  let dylibOrdinal = 0;

  let cursor = commandStart;
  for (let index = 0; index < header.ncmds; index += 1) {
    if (cursor + 8 > commandEnd) {
      throw new MachOError(
        "truncated_command",
        `load command ${index} header runs past sizeofcmds`,
      );
    }
    const commandReader = new BinaryReader(bytes, `load command ${index}`);
    commandReader.seek(cursor);
    const cmd = commandReader.u32();
    const cmdsize = commandReader.u32();
    if (cmdsize < 8) {
      throw new MachOError("bad_command_size", `load command ${index} has cmdsize ${cmdsize}`);
    }
    if (cursor + cmdsize > commandEnd) {
      throw new MachOError(
        "bad_command_size",
        `load command ${index} ends at 0x${(cursor + cmdsize).toString(16)}, past sizeofcmds`,
      );
    }
    const body = new BinaryReader(
      bytes.subarray(cursor + 8, cursor + cmdsize),
      `load command ${index}`,
    );
    commands.push({
      cmd,
      cmdsize,
      offset: cursor,
      name: LOAD_COMMAND_NAMES[cmd] ?? `LC_UNKNOWN_0x${cmd.toString(16)}`,
    });

    switch (cmd) {
      case LC_SEGMENT_64: {
        if (cmdsize < 72)
          throw new MachOError("bad_segment", `LC_SEGMENT_64 ${index} is only ${cmdsize} bytes`);
        const name = body.fixedString(16);
        const vmAddress = body.safeU64("segment vmaddr");
        const vmSize = body.safeU64("segment vmsize");
        const fileOffset = body.safeU64("segment fileoff");
        const fileSize = body.safeU64("segment filesize");
        const maxProtection = body.i32();
        const initialProtection = body.i32();
        const sectionCount = body.u32();
        const flags = body.u32();
        if (sectionCount > 4096) {
          throw new MachOError(
            "too_many_sections",
            `segment ${name} declares ${sectionCount} sections`,
          );
        }
        if (cmdsize !== 72 + sectionCount * 80) {
          throw new MachOError(
            "bad_segment",
            `segment ${name}: cmdsize ${cmdsize} does not match ${sectionCount} sections`,
          );
        }
        if (vmAddress + vmSize > Number.MAX_SAFE_INTEGER) {
          throw new MachOError(
            "segment_too_large",
            `segment ${name} exceeds the safe address range`,
          );
        }
        if (fileSize > 0 && (fileOffset + fileSize > bytes.byteLength || fileSize > vmSize)) {
          throw new MachOError(
            "bad_segment",
            `segment ${name}: file range 0x${fileOffset.toString(16)}+0x${fileSize.toString(16)} is invalid`,
          );
        }
        const segmentSections: MachSection[] = [];
        for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
          const sectionName = body.fixedString(16);
          const segmentName = body.fixedString(16);
          const address = body.safeU64("section address");
          const size = body.safeU64("section size");
          const sectionOffset = body.u32();
          const alignment = body.u32();
          const relocationsOffset = body.u32();
          const relocationCount = body.u32();
          const sectionFlags = body.u32();
          const reserved1 = body.u32();
          const reserved2 = body.u32();
          const reserved3 = body.u32();
          const zeroFill =
            (sectionFlags & SECTION_TYPE) === S_ZEROFILL ||
            (sectionFlags & SECTION_TYPE) === 0x12 /* S_THREAD_LOCAL_ZEROFILL */ ||
            (sectionFlags & SECTION_TYPE) === 0xc; /* S_GB_ZEROFILL */
          if (!zeroFill && size > 0 && sectionOffset + size > bytes.byteLength) {
            throw new MachOError(
              "bad_section",
              `section ${segmentName},${sectionName} exceeds the file (0x${sectionOffset.toString(16)}+0x${size.toString(16)})`,
            );
          }
          const section: MachSection = {
            index: sections.length,
            segmentName,
            name: sectionName,
            address,
            size,
            fileOffset: sectionOffset,
            alignment,
            relocationsOffset,
            relocationCount,
            flags: sectionFlags,
            reserved1,
            reserved2,
            reserved3,
            zeroFill,
          };
          sections.push(section);
          segmentSections.push(section);
        }
        segments.push({
          index: segments.length,
          name,
          vmAddress,
          vmSize,
          fileOffset,
          fileSize,
          maxProtection,
          initialProtection,
          flags,
          sections: segmentSections,
        });
        break;
      }
      case LC_SYMTAB: {
        if (symtabInfo)
          throw new MachOError("duplicate_symtab", "multiple LC_SYMTAB commands are not supported");
        if (cmdsize < 24) throw new MachOError("bad_symtab", "LC_SYMTAB is truncated");
        const symbolOffset = body.u32();
        const symbolCount = body.u32();
        const stringOffset = body.u32();
        const stringSize = body.u32();
        if (symbolCount > MAX_SYMBOLS) {
          throw new MachOError("too_many_symbols", `LC_SYMTAB declares ${symbolCount} symbols`);
        }
        if (symbolOffset + symbolCount * 16 > bytes.byteLength) {
          throw new MachOError("bad_symtab", "symbol table exceeds the file");
        }
        if (stringOffset + stringSize > bytes.byteLength) {
          throw new MachOError("bad_symtab", "string table exceeds the file");
        }
        symtabInfo = { symbolOffset, symbolCount, stringOffset, stringSize };
        break;
      }
      case LC_LOAD_DYLIB:
      case LC_LOAD_WEAK_DYLIB:
      case LC_REEXPORT_DYLIB:
      case LC_LAZY_LOAD_DYLIB:
      case LC_LOAD_UPWARD_DYLIB:
      case LC_ID_DYLIB: {
        if (cmdsize < 24) throw new MachOError("bad_dylib", "dylib load command is truncated");
        const nameOffset = body.u32();
        const timestamp = body.u32();
        const currentVersion = body.u32();
        const compatibilityVersion = body.u32();
        if (nameOffset < 24 || nameOffset >= cmdsize) {
          throw new MachOError(
            "bad_dylib",
            `dylib name offset ${nameOffset} is outside cmdsize ${cmdsize}`,
          );
        }
        const stringReader = new BinaryReader(
          bytes.subarray(cursor + nameOffset, cursor + cmdsize),
          "dylib name",
        );
        const kind =
          cmd === LC_LOAD_DYLIB
            ? "load"
            : cmd === LC_LOAD_WEAK_DYLIB
              ? "weak"
              : cmd === LC_REEXPORT_DYLIB
                ? "reexport"
                : cmd === LC_LAZY_LOAD_DYLIB
                  ? "lazy"
                  : cmd === LC_LOAD_UPWARD_DYLIB
                    ? "upward"
                    : "id";
        const ordinal = kind === "id" ? 0 : ++dylibOrdinal;
        dylibs.push({
          ordinal,
          name: stringReader.cstring(),
          kind,
          timestamp,
          currentVersion,
          compatibilityVersion,
        });
        break;
      }
      case LC_UUID: {
        if (cmdsize < 24) throw new MachOError("bad_uuid", "LC_UUID is truncated");
        const raw = body.bytesOf(16);
        const hex = [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        break;
      }
      case LC_MAIN: {
        if (cmdsize < 24) throw new MachOError("bad_main", "LC_MAIN is truncated");
        main = {
          entryOffset: body.safeU64("LC_MAIN entryoff"),
          stackSize: body.safeU64("LC_MAIN stacksize"),
        };
        break;
      }
      case LC_UNIXTHREAD:
      case 0x4 /* LC_THREAD */: {
        if (cmdsize < 16) throw new MachOError("bad_thread", "thread command is truncated");
        const flavor = body.u32();
        const count = body.u32();
        const stateOffset = cursor + 16;
        let entryPoint = 0;
        let stackPointer = 0;
        if (
          flavor === ARM_THREAD_STATE64 &&
          count >= 68 &&
          stateOffset + 68 * 4 <= cursor + cmdsize
        ) {
          const state = new BinaryReader(bytes, "arm64 thread state");
          state.seek(stateOffset + 31 * 8);
          stackPointer = state.safeU64("thread sp");
          entryPoint = state.safeU64("thread pc");
          if (cmd === LC_UNIXTHREAD) unixThread = { flavor, count, entryPoint, stackPointer };
        } else if (cmd === LC_UNIXTHREAD) {
          unixThread = { flavor, count, entryPoint: 0, stackPointer: 0 };
        }
        break;
      }
      case LC_ROUTINES_64: {
        if (cmdsize < 72) throw new MachOError("bad_routines", "LC_ROUTINES_64 is truncated");
        routines = {
          initAddress: body.safeU64("routines init address"),
          initModule: body.safeU64("routines init module"),
        };
        break;
      }
      case LC_DYLD_INFO:
      case LC_DYLD_INFO_ONLY: {
        if (cmdsize < 48) throw new MachOError("bad_dyld_info", "LC_DYLD_INFO is truncated");
        dyldInfo = {
          rebaseOffset: body.u32(),
          rebaseSize: body.u32(),
          bindOffset: body.u32(),
          bindSize: body.u32(),
          weakBindOffset: body.u32(),
          weakBindSize: body.u32(),
          lazyBindOffset: body.u32(),
          lazyBindSize: body.u32(),
          exportOffset: body.u32(),
          exportSize: body.u32(),
        };
        break;
      }
      case LC_DYLD_CHAINED_FIXUPS: {
        if (cmdsize < 16)
          throw new MachOError("bad_chained_fixups", "LC_DYLD_CHAINED_FIXUPS is truncated");
        chainedFixupsOffset = { offset: body.u32(), size: body.u32() };
        break;
      }
      case LC_DYLD_EXPORTS_TRIE: {
        if (cmdsize < 16)
          throw new MachOError("bad_exports_trie", "LC_DYLD_EXPORTS_TRIE is truncated");
        exportsTrieOffset = { offset: body.u32(), size: body.u32() };
        break;
      }
      case LC_RPATH: {
        if (cmdsize < 12) throw new MachOError("bad_rpath", "LC_RPATH is truncated");
        const pathOffset = body.u32();
        if (pathOffset < 12 || pathOffset >= cmdsize) {
          throw new MachOError(
            "bad_rpath",
            `LC_RPATH path offset ${pathOffset} is outside cmdsize ${cmdsize}`,
          );
        }
        rpaths.push(
          new BinaryReader(
            bytes.subarray(cursor + pathOffset, cursor + cmdsize),
            "rpath",
          ).cstring(),
        );
        break;
      }
      case LC_CODE_SIGNATURE: {
        if (cmdsize < 16)
          throw new MachOError("bad_code_signature", "LC_CODE_SIGNATURE is truncated");
        codeSignature = { dataOffset: body.u32(), dataSize: body.u32() };
        break;
      }
      case LC_FUNCTION_STARTS: {
        if (cmdsize < 16)
          throw new MachOError("bad_function_starts", "LC_FUNCTION_STARTS is truncated");
        functionStartsOffset = { offset: body.u32(), size: body.u32() };
        break;
      }
      case LC_ENCRYPTION_INFO_64: {
        if (cmdsize < 24)
          throw new MachOError("bad_encryption_info", "LC_ENCRYPTION_INFO_64 is truncated");
        encryptionInfo = {
          cryptOffset: body.u32(),
          cryptSize: body.u32(),
          cryptId: body.u32(),
          pad: body.u32(),
        };
        break;
      }
      case LC_BUILD_VERSION: {
        if (cmdsize < 24)
          throw new MachOError("bad_build_version", "LC_BUILD_VERSION is truncated");
        const platform = body.u32();
        const minOs = body.u32();
        const sdk = body.u32();
        const toolCount = body.u32();
        if (24 + toolCount * 8 > cmdsize) {
          throw new MachOError("bad_build_version", "LC_BUILD_VERSION tool list exceeds cmdsize");
        }
        const tools: Array<{ tool: number; version: string }> = [];
        for (let toolIndex = 0; toolIndex < toolCount; toolIndex += 1) {
          tools.push({ tool: body.u32(), version: formatVersion(body.u32()) });
        }
        buildVersion = { platform, minOs: formatVersion(minOs), sdk: formatVersion(sdk), tools };
        break;
      }
      case LC_VERSION_MIN_MACOSX:
      case LC_VERSION_MIN_IPHONEOS:
      case LC_VERSION_MIN_TVOS:
      case LC_VERSION_MIN_WATCHOS: {
        if (cmdsize < 16)
          throw new MachOError("bad_version_min", "version-min command is truncated");
        const version = formatVersion(body.u32());
        body.u32();
        minimumOsVersion = {
          platform:
            cmd === LC_VERSION_MIN_MACOSX
              ? "macos"
              : cmd === LC_VERSION_MIN_IPHONEOS
                ? "ios"
                : cmd === LC_VERSION_MIN_TVOS
                  ? "tvos"
                  : "watchos",
          version,
        };
        break;
      }
      case LC_SOURCE_VERSION: {
        if (cmdsize < 16)
          throw new MachOError("bad_source_version", "LC_SOURCE_VERSION is truncated");
        sourceVersion = formatSourceVersion(body.u64());
        break;
      }
      default:
        break;
    }

    cursor += cmdsize;
  }

  if (cursor !== commandEnd) {
    throw new MachOError(
      "command_size_mismatch",
      `load commands consumed ${cursor - commandStart} bytes, sizeofcmds is ${header.sizeofcmds}`,
    );
  }

  const symbols = symtabInfo ? parseSymbols(bytes, symtabInfo) : [];
  const textSegment = segments.find((segment) => segment.name === "__TEXT") ?? null;
  const preferredBase = Math.min(
    ...segments.filter((segment) => segment.fileSize > 0).map((segment) => segment.vmAddress),
    Number.MAX_SAFE_INTEGER,
  );
  if (preferredBase === Number.MAX_SAFE_INTEGER) {
    throw new MachOError("no_image_segments", "Mach-O has no segment with file-backed contents");
  }

  let chainedFixups = null;
  if (chainedFixupsOffset) {
    const { offset, size } = chainedFixupsOffset;
    if (offset + size > bytes.byteLength) {
      throw new MachOError("fixups_out_of_bounds", "LC_DYLD_CHAINED_FIXUPS exceeds the file");
    }
    chainedFixups = parseChainedFixups(
      bytes,
      offset,
      size,
      segments.map((segment) => ({
        index: segment.index,
        fileOffset: segment.fileOffset,
        fileSize: segment.fileSize,
        vmAddress: segment.vmAddress,
      })),
    );
  }

  let exportsTrie: MachOImage["exportsTrie"] = null;
  const exportSource =
    exportsTrieOffset ??
    (dyldInfo && dyldInfo.exportSize > 0
      ? { offset: dyldInfo.exportOffset, size: dyldInfo.exportSize }
      : null);
  if (exportSource && exportSource.size > 0) {
    if (exportSource.offset + exportSource.size > bytes.byteLength) {
      throw new MachOError("exports_out_of_bounds", "exports trie exceeds the file");
    }
    exportsTrie = {
      dataOffset: exportSource.offset,
      dataSize: exportSource.size,
      exports: parseExportsTrie(bytes, exportSource.offset, exportSource.size),
    };
  }

  let functionStarts: MachOImage["functionStarts"] = null;
  if (functionStartsOffset) {
    const { offset, size } = functionStartsOffset;
    if (offset + size > bytes.byteLength) {
      throw new MachOError("function_starts_out_of_bounds", "LC_FUNCTION_STARTS exceeds the file");
    }
    const base = textSegment?.vmAddress ?? preferredBase;
    const offsets: number[] = [];
    const reader = new BinaryReader(bytes.subarray(offset, offset + size), "function starts");
    let address = base;
    while (reader.remaining > 0) {
      const delta = readUleb(reader);
      if (delta === 0) break;
      address += delta;
      if (address > Number.MAX_SAFE_INTEGER) {
        throw new MachOError(
          "function_starts_overflow",
          "function starts exceed the safe address range",
        );
      }
      offsets.push(address);
    }
    functionStarts = { dataOffset: offset, dataSize: size, offsets };
  }

  if (codeSignature && codeSignature.dataOffset + codeSignature.dataSize > bytes.byteLength) {
    throw new MachOError("code_signature_out_of_bounds", "LC_CODE_SIGNATURE exceeds the file");
  }

  const image: MachOImage = {
    byteLength: bytes.byteLength,
    sliceOffset,
    header,
    commands,
    segments,
    sections,
    dylibs,
    rpaths,
    symbols,
    symtab: symtabInfo,
    uuid,
    buildVersion,
    sourceVersion,
    minimumOsVersion,
    main,
    unixThread,
    dyldInfo,
    routines,
    chainedFixups,
    exportsTrie,
    codeSignature,
    functionStarts,
    encryptionInfo,
    preferredBase,
    textSegment,
    entryOffset:
      main?.entryOffset ??
      (unixThread && unixThread.entryPoint !== 0 ? unixThread.entryPoint : null),
    osVersion: buildVersion?.minOs ?? minimumOsVersion?.version ?? "unknown",
  };

  return { image, fat };
}

function parseSymbols(bytes: Uint8Array, info: SymtabInfo): MachSymbol[] {
  const reader = new BinaryReader(bytes, "symbol table");
  const symbols: MachSymbol[] = [];
  for (let index = 0; index < info.symbolCount; index += 1) {
    reader.seek(info.symbolOffset + index * 16);
    const stringIndex = reader.u32();
    const type = reader.u8();
    const section = reader.u8();
    const description = reader.u16();
    const value = reader.safeU64("symbol value");
    let name = "";
    if (stringIndex !== 0) {
      if (stringIndex >= info.stringSize) {
        throw new MachOError(
          "bad_symbol_string",
          `symbol ${index} string index ${stringIndex} exceeds the string table`,
        );
      }
      const stringReader = new BinaryReader(bytes, "symbol string");
      stringReader.seek(info.stringOffset + stringIndex);
      // The string table is followed by the rest of the file, so cap the scan
      // at the declared table end instead of relying on a later NUL.
      let end = stringReader.position;
      const limit = info.stringOffset + info.stringSize;
      while (end < limit && bytes[end] !== 0) end += 1;
      if (end >= limit) {
        throw new MachOError("unterminated_string", `symbol ${index} name is unterminated`);
      }
      name = new TextDecoder().decode(bytes.subarray(stringReader.position, end));
    }
    symbols.push({
      index,
      name,
      type,
      section,
      description,
      value,
      external: (type & N_EXT) !== 0,
      undefined: (type & N_TYPE) === N_UNDF,
      debug: (type & N_STAB) !== 0,
    });
  }
  return symbols;
}

function readUleb(reader: BinaryReader): number {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = reader.u8();
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new MachOError("integer_overflow", "ULEB value exceeds the safe integer range");
      }
      return Number(value);
    }
    shift += 7n;
  }
  throw new MachOError("integer_overflow", "ULEB value is longer than 10 bytes");
}

export function formatVersion(value: number): string {
  const major = value >>> 16;
  const minor = (value >>> 8) & 0xff;
  const patch = value & 0xff;
  return `${major}.${minor}.${patch}`;
}

export function formatSourceVersion(value: bigint): string {
  const parts = [
    Number((value >> 40n) & 0xffff_ffffn),
    Number((value >> 30n) & 0x3ffn),
    Number((value >> 20n) & 0x3ffn),
    Number((value >> 10n) & 0x3ffn),
    Number(value & 0x3ffn),
  ];
  while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
}

export function platformName(platform: number): string {
  return PLATFORM_NAMES[platform] ?? `platform-${platform}`;
}
