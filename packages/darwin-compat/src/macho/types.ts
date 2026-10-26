/**
 * Typed view of a parsed thin Mach-O image.
 *
 * The parser keeps both a convenient typed projection and the raw load-command
 * list. That matters for a compatibility layer: unknown commands must not
 * prevent inspection, and the loader needs byte offsets while the CLI wants
 * names.
 */

import type { ChainedFixups } from "./fixups.js";
import type { ExportEntry } from "./exports-trie.js";

export interface MachHeader {
  readonly magic: number;
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly fileType: number;
  readonly ncmds: number;
  readonly sizeofcmds: number;
  readonly flags: number;
  readonly reserved: number;
}

export interface MachSection {
  readonly index: number;
  readonly segmentName: string;
  readonly name: string;
  readonly address: number;
  readonly size: number;
  readonly fileOffset: number;
  readonly alignment: number;
  readonly relocationsOffset: number;
  readonly relocationCount: number;
  readonly flags: number;
  readonly reserved1: number;
  readonly reserved2: number;
  readonly reserved3: number;
  /** True when the section occupies zero-filled VM but no file bytes. */
  readonly zeroFill: boolean;
}

export interface MachSegment {
  readonly index: number;
  readonly name: string;
  readonly vmAddress: number;
  readonly vmSize: number;
  readonly fileOffset: number;
  readonly fileSize: number;
  readonly maxProtection: number;
  readonly initialProtection: number;
  readonly flags: number;
  readonly sections: readonly MachSection[];
}

export type DylibKind = "load" | "weak" | "reexport" | "lazy" | "upward" | "id";

export interface DylibReference {
  /** 1-based dependency ordinal used by bind records. `0` for LC_ID_DYLIB. */
  readonly ordinal: number;
  readonly name: string;
  readonly kind: DylibKind;
  readonly timestamp: number;
  readonly currentVersion: number;
  readonly compatibilityVersion: number;
}

export interface MachSymbol {
  readonly index: number;
  readonly name: string;
  readonly type: number;
  readonly section: number;
  readonly description: number;
  readonly value: number;
  readonly external: boolean;
  readonly undefined: boolean;
  readonly debug: boolean;
}

export interface SymtabInfo {
  readonly symbolOffset: number;
  readonly symbolCount: number;
  readonly stringOffset: number;
  readonly stringSize: number;
}

export interface RoutinesInfo {
  /** Preferred VM address of the module initializer. */
  readonly initAddress: number;
  readonly initModule: number;
}

export interface DyldInfo {
  readonly rebaseOffset: number;
  readonly rebaseSize: number;
  readonly bindOffset: number;
  readonly bindSize: number;
  readonly weakBindOffset: number;
  readonly weakBindSize: number;
  readonly lazyBindOffset: number;
  readonly lazyBindSize: number;
  readonly exportOffset: number;
  readonly exportSize: number;
}

export interface BuildVersion {
  readonly platform: number;
  readonly minOs: string;
  readonly sdk: string;
  readonly tools: readonly { tool: number; version: string }[];
}

export interface LinkEditData {
  readonly dataOffset: number;
  readonly dataSize: number;
}

export interface EncryptionInfo {
  readonly cryptOffset: number;
  readonly cryptSize: number;
  readonly cryptId: number;
  readonly pad: number;
}

export interface UnixThreadState {
  readonly flavor: number;
  readonly count: number;
  readonly entryPoint: number;
  readonly stackPointer: number;
}

export interface MachOImage {
  readonly byteLength: number;
  /** Offset of this slice inside the original (possibly fat) file. */
  readonly sliceOffset: number;
  readonly header: MachHeader;
  readonly commands: readonly { cmd: number; cmdsize: number; offset: number; name: string }[];
  readonly segments: readonly MachSegment[];
  readonly sections: readonly MachSection[];
  readonly dylibs: readonly DylibReference[];
  readonly rpaths: readonly string[];
  readonly symbols: readonly MachSymbol[];
  readonly symtab: SymtabInfo | null;
  readonly uuid: string | null;
  readonly buildVersion: BuildVersion | null;
  readonly sourceVersion: string | null;
  readonly minimumOsVersion: {
    platform: "macos" | "ios" | "tvos" | "watchos";
    version: string;
  } | null;
  readonly main: { entryOffset: number; stackSize: number } | null;
  readonly unixThread: UnixThreadState | null;
  readonly dyldInfo: DyldInfo | null;
  readonly routines: RoutinesInfo | null;
  readonly chainedFixups: ChainedFixups | null;
  readonly exportsTrie: {
    dataOffset: number;
    dataSize: number;
    exports: ReadonlyMap<string, ExportEntry>;
  } | null;
  readonly codeSignature: LinkEditData | null;
  readonly functionStarts: {
    dataOffset: number;
    dataSize: number;
    offsets: readonly number[];
  } | null;
  readonly encryptionInfo: EncryptionInfo | null;
  /** Lowest __TEXT-like vm address; used as the image's preferred base. */
  readonly preferredBase: number;
  readonly textSegment: MachSegment | null;
  readonly entryOffset: number | null;
  readonly osVersion: string;
}

export interface FatSlice {
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
  readonly reserved?: number;
}

export interface FatFile {
  readonly magic: number;
  readonly is64: boolean;
  readonly slices: readonly FatSlice[];
}

export interface ParseOptions {
  /** Preferred CPU when a fat file contains more than one architecture. */
  readonly arch?: "arm64" | "arm64e";
}

export interface ParsedMachO {
  readonly image: MachOImage;
  readonly fat: FatFile | null;
}
