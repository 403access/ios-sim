/**
 * Mach-O constants used by the parser, loader, and fixture builder.
 *
 * Values come from `<mach-o/loader.h>`, `<mach-o/fixup-chains.h>`, and
 * `<mach-o/arm64.h>` in the macOS SDK. Only the subset needed by this research
 * track is reproduced here; unknown commands are preserved and skipped safely.
 */

export const MH_MAGIC = 0xfeedface;
export const MH_MAGIC_64 = 0xfeedfacf;
export const MH_CIGAM = 0xcefaedfe;
export const MH_CIGAM_64 = 0xcffaedfe;
export const FAT_MAGIC = 0xcafebabe;
export const FAT_CIGAM = 0xbebafeca;
export const FAT_MAGIC_64 = 0xcafebabf;
export const FAT_CIGAM_64 = 0xbfbafeca;

export const CPU_ARCH_ABI64 = 0x01000000;
export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM64 = 0x0100000c;
export const CPU_SUBTYPE_MASK = 0xff000000;
export const CPU_SUBTYPE_ARM64_ALL = 0;
export const CPU_SUBTYPE_ARM64_V8 = 1;
export const CPU_SUBTYPE_ARM64E = 2;

export const MH_OBJECT = 0x1;
export const MH_EXECUTE = 0x2;
export const MH_FVMLIB = 0x3;
export const MH_CORE = 0x4;
export const MH_PRELOAD = 0x5;
export const MH_DYLIB = 0x6;
export const MH_DYLINKER = 0x7;
export const MH_BUNDLE = 0x8;
export const MH_DYLIB_STUB = 0x9;
export const MH_DSYM = 0xa;
export const MH_KEXT_BUNDLE = 0xb;
export const MH_FILESET = 0xc;

export const MH_NOUNDEFS = 0x1;
export const MH_DYLDLINK = 0x4;
export const MH_TWOLEVEL = 0x80;
export const MH_PIE = 0x200000;
export const MH_HAS_TLV_DESCRIPTORS = 0x800000;

export const LC_REQ_DYLD = 0x80000000;

/**
 * Build a `LC_REQ_DYLD` command value. JavaScript bitwise OR produces a signed
 * 32-bit result, which would make `0x80000028 | 0` compare unequal to the
 * unsigned value read from a file. Adding then coercing avoids that trap.
 */
const dyldCommand = (value: number): number => (LC_REQ_DYLD + value) >>> 0;

export const LC_SEGMENT = 0x1;
export const LC_SYMTAB = 0x2;
export const LC_SYMSEG = 0x3;
export const LC_THREAD = 0x4;
export const LC_UNIXTHREAD = 0x5;
export const LC_LOADFVMLIB = 0x6;
export const LC_IDFVMLIB = 0x7;
export const LC_IDENT = 0x8;
export const LC_FVMFILE = 0x9;
export const LC_PREPAGE = 0xa;
export const LC_DYSYMTAB = 0xb;
export const LC_LOAD_DYLIB = 0xc;
export const LC_ID_DYLIB = 0xd;
export const LC_LOAD_DYLINKER = 0xe;
export const LC_ID_DYLINKER = 0xf;
export const LC_PREBOUND_DYLIB = 0x10;
export const LC_ROUTINES = 0x11;
export const LC_SUB_FRAMEWORK = 0x12;
export const LC_SUB_UMBRELLA = 0x13;
export const LC_SUB_CLIENT = 0x14;
export const LC_SUB_LIBRARY = 0x15;
export const LC_TWOLEVEL_HINTS = 0x16;
export const LC_PREBIND_CKSUM = 0x17;
export const LC_LOAD_WEAK_DYLIB = dyldCommand(0x18);
export const LC_SEGMENT_64 = 0x19;
export const LC_ROUTINES_64 = 0x1a;
export const LC_UUID = 0x1b;
export const LC_RPATH = dyldCommand(0x1c);
export const LC_CODE_SIGNATURE = 0x1d;
export const LC_SEGMENT_SPLIT_INFO = 0x1e;
export const LC_REEXPORT_DYLIB = dyldCommand(0x1f);
export const LC_LAZY_LOAD_DYLIB = 0x20;
export const LC_ENCRYPTION_INFO = 0x21;
export const LC_DYLD_INFO = 0x22;
export const LC_DYLD_INFO_ONLY = dyldCommand(0x22);
export const LC_LOAD_UPWARD_DYLIB = dyldCommand(0x23);
export const LC_VERSION_MIN_MACOSX = 0x24;
export const LC_VERSION_MIN_IPHONEOS = 0x25;
export const LC_FUNCTION_STARTS = 0x26;
export const LC_DYLD_ENVIRONMENT = 0x27;
export const LC_MAIN = dyldCommand(0x28);
export const LC_DATA_IN_CODE = 0x29;
export const LC_SOURCE_VERSION = 0x2a;
export const LC_DYLIB_CODE_SIGN_DRS = 0x2b;
export const LC_ENCRYPTION_INFO_64 = 0x2c;
export const LC_LINKER_OPTION = 0x2d;
export const LC_LINKER_OPTIMIZATION_HINT = 0x2e;
export const LC_VERSION_MIN_TVOS = 0x2f;
export const LC_VERSION_MIN_WATCHOS = 0x30;
export const LC_NOTE = 0x31;
export const LC_BUILD_VERSION = 0x32;
export const LC_DYLD_EXPORTS_TRIE = dyldCommand(0x33);
export const LC_DYLD_CHAINED_FIXUPS = dyldCommand(0x34);
export const LC_FILESET_ENTRY = dyldCommand(0x35);

export const SECTION_TYPE = 0xff;
export const S_REGULAR = 0x0;
export const S_ZEROFILL = 0x1;
export const S_CSTRING_LITERALS = 0x2;
export const S_4BYTE_LITERALS = 0x3;
export const S_8BYTE_LITERALS = 0x4;
export const S_LITERAL_POINTERS = 0x5;
export const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
export const S_LAZY_SYMBOL_POINTERS = 0x7;
export const S_SYMBOL_STUBS = 0x8;
export const S_MOD_INIT_FUNC_POINTERS = 0x9;
export const S_MOD_TERM_FUNC_POINTERS = 0xa;
export const S_COALESCED = 0xb;
export const S_GB_ZEROFILL = 0xc;
export const S_INTERPOSING = 0xd;
export const S_16BYTE_LITERALS = 0xe;
export const S_DTRACE_DOF = 0xf;
export const S_LAZY_DYLIB_SYMBOL_POINTERS = 0x10;
export const S_THREAD_LOCAL_REGULAR = 0x11;
export const S_THREAD_LOCAL_ZEROFILL = 0x12;
export const S_THREAD_LOCAL_VARIABLES = 0x13;
export const S_THREAD_LOCAL_VARIABLE_POINTERS = 0x14;
export const S_THREAD_LOCAL_INIT_FUNCTION_POINTERS = 0x15;
export const S_INIT_FUNC_OFFSETS = 0x16;

export const VM_PROT_READ = 0x1;
export const VM_PROT_WRITE = 0x2;
export const VM_PROT_EXECUTE = 0x4;

export const N_STAB = 0xe0;
export const N_PEXT = 0x10;
export const N_TYPE = 0x0e;
export const N_EXT = 0x01;
export const N_UNDF = 0x0;
export const N_ABS = 0x2;
export const N_SECT = 0xe;
export const N_PBUD = 0xc;
export const N_INDR = 0xa;

export const EXPORT_SYMBOL_FLAGS_KIND_MASK = 0x3;
export const EXPORT_SYMBOL_FLAGS_KIND_REGULAR = 0x0;
export const EXPORT_SYMBOL_FLAGS_KIND_THREAD_LOCAL = 0x1;
export const EXPORT_SYMBOL_FLAGS_KIND_ABSOLUTE = 0x2;
export const EXPORT_SYMBOL_FLAGS_WEAK_DEFINITION = 0x4;
export const EXPORT_SYMBOL_FLAGS_REEXPORT = 0x8;
export const EXPORT_SYMBOL_FLAGS_STUB_AND_RESOLVER = 0x10;

export const DYLD_CHAINED_PTR_ARM64E = 1;
export const DYLD_CHAINED_PTR_64 = 2;
export const DYLD_CHAINED_PTR_64_OFFSET = 6;
export const DYLD_CHAINED_PTR_ARM64E_USERLAND = 9;
export const DYLD_CHAINED_PTR_ARM64E_USERLAND24 = 12;
export const DYLD_CHAINED_PTR_64_KERNEL_CACHE = 8;

export const DYLD_CHAINED_PTR_START_NONE = 0xffff;
export const DYLD_CHAINED_PTR_START_MULTI = 0x8000;
export const DYLD_CHAINED_PTR_START_LAST = 0x8000;

export const DYLD_CHAINED_IMPORT = 1;
export const DYLD_CHAINED_IMPORT_ADDEND = 2;
export const DYLD_CHAINED_IMPORT_ADDEND64 = 3;

export const DYLD_CHAINED_SYMBOLS_UNCOMPRESSED = 0;
export const DYLD_CHAINED_SYMBOLS_ZLIB = 1;

/** Human-readable names for load commands, for `inspect` output and errors. */
export const LOAD_COMMAND_NAMES: Readonly<Record<number, string>> = {
  [LC_SEGMENT]: "LC_SEGMENT",
  [LC_SYMTAB]: "LC_SYMTAB",
  [LC_SYMSEG]: "LC_SYMSEG",
  [LC_THREAD]: "LC_THREAD",
  [LC_UNIXTHREAD]: "LC_UNIXTHREAD",
  [LC_LOADFVMLIB]: "LC_LOADFVMLIB",
  [LC_IDFVMLIB]: "LC_IDFVMLIB",
  [LC_IDENT]: "LC_IDENT",
  [LC_FVMFILE]: "LC_FVMFILE",
  [LC_PREPAGE]: "LC_PREPAGE",
  [LC_DYSYMTAB]: "LC_DYSYMTAB",
  [LC_LOAD_DYLIB]: "LC_LOAD_DYLIB",
  [LC_ID_DYLIB]: "LC_ID_DYLIB",
  [LC_LOAD_DYLINKER]: "LC_LOAD_DYLINKER",
  [LC_ID_DYLINKER]: "LC_ID_DYLINKER",
  [LC_PREBOUND_DYLIB]: "LC_PREBOUND_DYLIB",
  [LC_ROUTINES]: "LC_ROUTINES",
  [LC_SUB_FRAMEWORK]: "LC_SUB_FRAMEWORK",
  [LC_SUB_UMBRELLA]: "LC_SUB_UMBRELLA",
  [LC_SUB_CLIENT]: "LC_SUB_CLIENT",
  [LC_SUB_LIBRARY]: "LC_SUB_LIBRARY",
  [LC_TWOLEVEL_HINTS]: "LC_TWOLEVEL_HINTS",
  [LC_PREBIND_CKSUM]: "LC_PREBIND_CKSUM",
  [LC_LOAD_WEAK_DYLIB]: "LC_LOAD_WEAK_DYLIB",
  [LC_SEGMENT_64]: "LC_SEGMENT_64",
  [LC_ROUTINES_64]: "LC_ROUTINES_64",
  [LC_UUID]: "LC_UUID",
  [LC_RPATH]: "LC_RPATH",
  [LC_CODE_SIGNATURE]: "LC_CODE_SIGNATURE",
  [LC_SEGMENT_SPLIT_INFO]: "LC_SEGMENT_SPLIT_INFO",
  [LC_REEXPORT_DYLIB]: "LC_REEXPORT_DYLIB",
  [LC_LAZY_LOAD_DYLIB]: "LC_LAZY_LOAD_DYLIB",
  [LC_ENCRYPTION_INFO]: "LC_ENCRYPTION_INFO",
  [LC_DYLD_INFO]: "LC_DYLD_INFO",
  [LC_DYLD_INFO_ONLY]: "LC_DYLD_INFO_ONLY",
  [LC_LOAD_UPWARD_DYLIB]: "LC_LOAD_UPWARD_DYLIB",
  [LC_VERSION_MIN_MACOSX]: "LC_VERSION_MIN_MACOSX",
  [LC_VERSION_MIN_IPHONEOS]: "LC_VERSION_MIN_IPHONEOS",
  [LC_FUNCTION_STARTS]: "LC_FUNCTION_STARTS",
  [LC_DYLD_ENVIRONMENT]: "LC_DYLD_ENVIRONMENT",
  [LC_MAIN]: "LC_MAIN",
  [LC_DATA_IN_CODE]: "LC_DATA_IN_CODE",
  [LC_SOURCE_VERSION]: "LC_SOURCE_VERSION",
  [LC_DYLIB_CODE_SIGN_DRS]: "LC_DYLIB_CODE_SIGN_DRS",
  [LC_ENCRYPTION_INFO_64]: "LC_ENCRYPTION_INFO_64",
  [LC_LINKER_OPTION]: "LC_LINKER_OPTION",
  [LC_LINKER_OPTIMIZATION_HINT]: "LC_LINKER_OPTIMIZATION_HINT",
  [LC_VERSION_MIN_TVOS]: "LC_VERSION_MIN_TVOS",
  [LC_VERSION_MIN_WATCHOS]: "LC_VERSION_MIN_WATCHOS",
  [LC_NOTE]: "LC_NOTE",
  [LC_BUILD_VERSION]: "LC_BUILD_VERSION",
  [LC_DYLD_EXPORTS_TRIE]: "LC_DYLD_EXPORTS_TRIE",
  [LC_DYLD_CHAINED_FIXUPS]: "LC_DYLD_CHAINED_FIXUPS",
  [LC_FILESET_ENTRY]: "LC_FILESET_ENTRY",
};

export const PLATFORM_NAMES: Readonly<Record<number, string>> = {
  1: "macOS",
  2: "iOS",
  3: "tvOS",
  4: "watchOS",
  5: "bridgeOS",
  6: "macCatalyst",
  7: "iOSSimulator",
  8: "tvOSSimulator",
  9: "watchOSSimulator",
  10: "driverKit",
  11: "visionOS",
  12: "visionOSSimulator",
};
