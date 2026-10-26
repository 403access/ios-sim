/**
 * Minimal Mach-O writer used by tests, fixtures, and the `inspect`/`run`
 * demo. It is deliberately small: one `__TEXT`, one `__DATA`, one
 * `__LINKEDIT`, chained fixups in `__DATA`, and an exports trie.
 *
 * This is **not** a general linker. It exists so the compatibility layer can
 * be exercised deterministically on Linux without committing compiler output
 * or Apple binaries.
 */

import { BinaryWriter } from "../binary.js";
import { MachOError } from "../errors.js";
import { encodeLegacyBinds, encodeLegacyRebases } from "./legacy-fixups.js";
import {
  CPU_SUBTYPE_ARM64_ALL,
  CPU_TYPE_ARM64,
  LC_BUILD_VERSION,
  LC_DYLD_CHAINED_FIXUPS,
  LC_DYLD_EXPORTS_TRIE,
  LC_DYLD_INFO_ONLY,
  LC_ID_DYLIB,
  LC_LOAD_DYLIB,
  LC_LOAD_WEAK_DYLIB,
  LC_MAIN,
  LC_SEGMENT_64,
  LC_SOURCE_VERSION,
  LC_SYMTAB,
  LC_UUID,
  MH_DYLDLINK,
  MH_EXECUTE,
  MH_NOUNDEFS,
  MH_PIE,
  MH_TWOLEVEL,
  N_EXT,
  N_SECT,
  N_UNDF,
  S_CSTRING_LITERALS,
  S_REGULAR,
  S_ZEROFILL,
  VM_PROT_EXECUTE,
  VM_PROT_READ,
  VM_PROT_WRITE,
} from "./constants.js";

export const DEFAULT_PAGE_SIZE = 0x4000;
const HEADER_RESERVE = 0x1000;
const PREFERRED_BASE = 0x100000000;

export type BuildFileType = "execute" | "dylib";
export type BuildExportKind = "regular" | "thread-local" | "absolute";

export interface BuildSymbol {
  readonly name: string;
  readonly value: number;
  readonly sectionIndex?: number;
  readonly external?: boolean;
  readonly undefined?: boolean;
  readonly type?: number;
}

export interface BuildExport {
  readonly name: string;
  /** Absolute VM address in the built image. */
  readonly address: number;
  readonly kind?: BuildExportKind;
  readonly weak?: boolean;
}

export interface BuildFixup {
  readonly kind: "bind" | "rebase";
  /** Offset from the start of `__DATA`. Must be 8-byte aligned. */
  readonly offset: number;
  readonly symbol?: string;
  /** Dependency ordinal for a bind. 1 is the first LC_LOAD_DYLIB. */
  readonly ordinal?: number;
  readonly weak?: boolean;
  readonly addend?: number;
  /** Absolute VM address for a rebase. */
  readonly target?: number;
}

export interface BuildDependency {
  readonly name: string;
  readonly weak?: boolean;
}

export interface BuildMachOOptions {
  readonly fileType?: BuildFileType;
  readonly text: Uint8Array;
  readonly cstring?: string;
  readonly data?: Uint8Array;
  readonly symbols?: readonly BuildSymbol[];
  readonly exports?: readonly BuildExport[];
  readonly fixups?: readonly BuildFixup[];
  /** Emit `LC_DYLD_INFO_ONLY` rebase/bind opcodes instead of chained fixups. */
  readonly legacyFixups?: readonly BuildFixup[];
  /** Legacy lazy-bind stream (entries resolved on demand by the loader). */
  readonly legacyLazyFixups?: readonly BuildFixup[];
  /** Legacy weak-bind stream (flat lookup; missing symbols become null). */
  readonly legacyWeakFixups?: readonly BuildFixup[];
  /** Preferred addresses written to `__DATA,__mod_init_func`. */
  readonly moduleInitFunctions?: readonly number[];
  /** Preferred addresses written to `__DATA,__mod_term_func`. */
  readonly moduleTermFunctions?: readonly number[];
  /** Interposition pairs written to `__DATA,__interpose`. */
  readonly interpositions?: ReadonlyArray<{ replacement: number; replaced: number }>;
  readonly dependencies?: readonly BuildDependency[];
  readonly installName?: string;
  readonly uuid?: Uint8Array;
  readonly entryOffset?: number;
  readonly stackSize?: number;
  readonly minimumOs?: string;
  readonly sdk?: string;
  readonly sourceVersion?: bigint;
}

export interface MachOLayout {
  readonly preferredBase: number;
  readonly pageSize: number;
  readonly text: number;
  readonly cstring: number;
  readonly data: number;
  readonly linkedit: number;
  readonly entry: number | null;
  readonly entryFileOffset: number | null;
  readonly dataFileOffset: number;
  readonly fileSize: number;
}

export interface BuiltMachO {
  readonly bytes: Uint8Array;
  readonly layout: MachOLayout;
}

export function buildMachO(options: BuildMachOOptions): BuiltMachO {
  const pageSize = DEFAULT_PAGE_SIZE;
  const fileType = options.fileType ?? "execute";
  if (options.text.length === 0) {
    throw new MachOError("empty_text", "a Mach-O fixture needs at least one text byte");
  }
  if (options.text.length % 4 !== 0) {
    throw new MachOError(
      "unaligned_text",
      `text length ${options.text.length} must be a multiple of 4`,
    );
  }
  const entryOffset = options.entryOffset ?? 0;
  if (entryOffset < 0 || entryOffset >= Math.max(options.text.length, 1) || entryOffset % 4 !== 0) {
    throw new MachOError(
      "bad_entry_offset",
      `entry offset ${entryOffset} is not a valid text offset`,
    );
  }

  const textFileOffset = HEADER_RESERVE;
  const cstring = options.cstring ? new TextEncoder().encode(options.cstring) : new Uint8Array();
  const cstringFileOffset = align(textFileOffset + options.text.length, 16);
  const textEnd = align(cstringFileOffset + cstring.length, pageSize);
  const rawData = options.data ?? new Uint8Array(8);
  const moduleInitFunctions = options.moduleInitFunctions ?? [];
  const moduleTermFunctions = options.moduleTermFunctions ?? [];
  const moduleInitOffset = align(rawData.length, 8);
  const moduleTermOffset = align(moduleInitOffset + moduleInitFunctions.length * 8, 8);
  const interpositions = options.interpositions ?? [];
  const interposeOffset = align(moduleTermOffset + moduleTermFunctions.length * 8, 8);
  const data = new Uint8Array(interposeOffset + interpositions.length * 16);
  data.set(rawData);
  const dataView = new DataView(data.buffer);
  moduleInitFunctions.forEach((address, index) => {
    dataView.setBigUint64(moduleInitOffset + index * 8, BigInt(address), true);
  });
  moduleTermFunctions.forEach((address, index) => {
    dataView.setBigUint64(moduleTermOffset + index * 8, BigInt(address), true);
  });
  interpositions.forEach((pair, index) => {
    dataView.setBigUint64(interposeOffset + index * 16, BigInt(pair.replacement), true);
    dataView.setBigUint64(interposeOffset + index * 16 + 8, BigInt(pair.replaced), true);
  });
  const moduleRebases: BuildFixup[] = [
    ...moduleInitFunctions.map((target, index) => ({
      kind: "rebase" as const,
      offset: moduleInitOffset + index * 8,
      target,
    })),
    ...moduleTermFunctions.map((target, index) => ({
      kind: "rebase" as const,
      offset: moduleTermOffset + index * 8,
      target,
    })),
    ...interpositions.flatMap((pair, index) => [
      {
        kind: "rebase" as const,
        offset: interposeOffset + index * 16,
        target: pair.replacement,
      },
      {
        kind: "rebase" as const,
        offset: interposeOffset + index * 16 + 8,
        target: pair.replaced,
      },
    ]),
  ];
  const dataFileOffset = textEnd;
  const dataEnd = align(dataFileOffset + Math.max(data.length, 8), pageSize);
  const dataVm = PREFERRED_BASE + dataFileOffset;
  const textVm = PREFERRED_BASE + textFileOffset;
  const cstringVm = PREFERRED_BASE + cstringFileOffset;

  const symbols = options.symbols ?? [];
  const exports = options.exports ?? [];
  const fixups = options.fixups ?? [];
  const legacyFixups = options.legacyFixups ?? [];
  const legacyLazyFixups = options.legacyLazyFixups ?? [];
  const legacyWeakFixups = options.legacyWeakFixups ?? [];
  const allLegacy = [...legacyFixups, ...legacyLazyFixups, ...legacyWeakFixups];
  if (fixups.length > 0 && allLegacy.length > 0) {
    throw new MachOError(
      "mixed_fixups",
      "a fixture cannot mix chained fixups and legacy dyld opcodes",
    );
  }

  // __LINKEDIT blobs.
  const symtab = new BinaryWriter();
  const stringTable = new BinaryWriter();
  stringTable.u8(0);
  const symbolEntries: Array<{ name: string; type: number; section: number; value: number }> = [];
  for (const symbol of symbols) {
    const stringOffset = stringTable.length;
    stringTable.cstring(symbol.name);
    const undefined = symbol.undefined ?? false;
    const section =
      symbol.sectionIndex ?? inferSection(symbol.value, textVm, cstringVm, dataVm, data.length);
    const baseType = symbol.type ?? (undefined ? N_UNDF : N_SECT);
    const external = symbol.external ?? true;
    symbolEntries.push({
      name: symbol.name,
      type: baseType | (external ? N_EXT : 0),
      section: undefined ? 0 : section,
      value: undefined ? 0 : symbol.value,
    });
    symtab.u32(stringOffset);
    symtab.u8(baseType | (external ? N_EXT : 0));
    symtab.u8(undefined ? 0 : section);
    symtab.u16(0);
    symtab.u64(undefined ? 0 : symbol.value);
  }

  const exportTrie =
    exports.length > 0 ? buildExportsTrie(exports, PREFERRED_BASE) : new Uint8Array();
  const chainedFixups =
    fixups.length > 0
      ? buildChainedFixups([...fixups, ...moduleRebases], dataFileOffset, data.length, pageSize)
      : null;
  const dataSegmentIndex = 2;
  const legacyRebaseEntries = [
    ...legacyFixups.filter((fixup) => fixup.kind === "rebase"),
    ...(chainedFixups ? [] : moduleRebases),
  ];
  const legacyRebases =
    legacyRebaseEntries.length > 0
      ? encodeLegacyRebases(
          legacyRebaseEntries.map((fixup) => ({
            segmentIndex: dataSegmentIndex,
            segmentOffset: fixup.offset,
          })),
        )
      : new Uint8Array();
  const toBind = (fixup: BuildFixup) => ({
    segmentIndex: dataSegmentIndex,
    segmentOffset: fixup.offset,
    symbol: fixup.symbol ?? "",
    ordinal: fixup.ordinal ?? 0,
    addend: fixup.addend,
    weak: fixup.weak,
  });
  const legacyBindEntries = legacyFixups.filter((fixup) => fixup.kind === "bind");
  const legacyBinds =
    legacyBindEntries.length > 0
      ? encodeLegacyBinds(legacyBindEntries.map(toBind))
      : new Uint8Array();
  const legacyLazyBinds =
    legacyLazyFixups.length > 0
      ? encodeLegacyBinds(legacyLazyFixups.map(toBind), true)
      : new Uint8Array();
  const legacyWeakBinds =
    legacyWeakFixups.length > 0
      ? encodeLegacyBinds(legacyWeakFixups.map(toBind))
      : new Uint8Array();
  const hasLegacyStreams =
    (!chainedFixups && moduleRebases.length > 0) ||
    legacyFixups.some((fixup) => fixup.kind === "rebase") ||
    legacyFixups.some((fixup) => fixup.kind === "bind") ||
    legacyLazyFixups.length > 0 ||
    legacyWeakFixups.length > 0;

  const linkeditOffset = dataEnd;
  const symtabOffset = 0;
  const stringTableOffset = symtab.length;
  const exportTrieOffset = align(stringTableOffset + stringTable.length, 8);
  const chainedFixupsOffset = align(exportTrieOffset + exportTrie.length, 8);
  const legacyRebaseOffset = align(chainedFixupsOffset + (chainedFixups?.bytes.length ?? 0), 8);
  const legacyBindOffset = align(legacyRebaseOffset + legacyRebases.length, 8);
  const legacyWeakOffset = align(legacyBindOffset + legacyBinds.length, 8);
  const legacyLazyOffset = align(legacyWeakOffset + legacyWeakBinds.length, 8);
  const linkeditLength = legacyLazyOffset + legacyLazyBinds.length;
  const fileSize = align(linkeditOffset + linkeditLength, pageSize);
  const linkeditVm = PREFERRED_BASE + linkeditOffset;

  const commands = new BinaryWriter();
  const addLoadCommand = (body: Uint8Array): void => {
    while (body.length % 8 !== 0) body = Uint8Array.from([...body, 0]);
    if (body.length < 8)
      throw new MachOError("bad_command", "load command must be at least 8 bytes");
    commands.bytes(body);
  };

  // __PAGEZERO
  addLoadCommand(
    segmentCommand({
      name: "__PAGEZERO",
      vmAddress: 0,
      vmSize: PREFERRED_BASE,
      fileOffset: 0,
      fileSize: 0,
      maxProtection: 0,
      initialProtection: 0,
      sections: [],
    }),
  );

  // __TEXT
  const textSections: SectionSpec[] = [
    {
      name: "__text",
      segmentName: "__TEXT",
      address: textVm,
      size: options.text.length,
      fileOffset: textFileOffset,
      alignment: 2,
      flags: S_REGULAR | 0x80000400,
    },
  ];
  if (cstring.length > 0) {
    textSections.push({
      name: "__cstring",
      segmentName: "__TEXT",
      address: cstringVm,
      size: cstring.length,
      fileOffset: cstringFileOffset,
      alignment: 0,
      flags: S_CSTRING_LITERALS,
    });
  }
  addLoadCommand(
    segmentCommand({
      name: "__TEXT",
      vmAddress: PREFERRED_BASE,
      vmSize: textEnd,
      fileOffset: 0,
      fileSize: textEnd,
      maxProtection: VM_PROT_READ | VM_PROT_EXECUTE,
      initialProtection: VM_PROT_READ | VM_PROT_EXECUTE,
      sections: textSections,
    }),
  );

  // __DATA
  addLoadCommand(
    segmentCommand({
      name: "__DATA",
      vmAddress: dataVm,
      vmSize: dataEnd - dataFileOffset,
      fileOffset: dataFileOffset,
      fileSize: dataEnd - dataFileOffset,
      maxProtection: VM_PROT_READ | VM_PROT_WRITE,
      initialProtection: VM_PROT_READ | VM_PROT_WRITE,
      sections: dataSections({
        dataVm,
        dataFileOffset,
        dataSize: rawData.length,
        moduleInitOffset,
        moduleInitCount: moduleInitFunctions.length,
        moduleTermOffset,
        moduleTermCount: moduleTermFunctions.length,
        interposeOffset,
        interposeCount: interpositions.length,
      }),
    }),
  );

  // __LINKEDIT
  addLoadCommand(
    segmentCommand({
      name: "__LINKEDIT",
      vmAddress: linkeditVm,
      vmSize: align(linkeditLength, pageSize),
      fileOffset: linkeditOffset,
      fileSize: linkeditLength,
      maxProtection: VM_PROT_READ,
      initialProtection: VM_PROT_READ,
      sections: [],
    }),
  );

  if (fileType === "execute") {
    const main = new BinaryWriter();
    main.u32(LC_MAIN);
    main.u32(24);
    main.u64(textFileOffset + entryOffset);
    main.u64(options.stackSize ?? 8 * 1024 * 1024);
    addLoadCommand(main.toUint8Array());
  }

  if (fileType === "dylib") {
    if (!options.installName)
      throw new MachOError("missing_install_name", "dylib fixtures need an installName");
    addLoadCommand(dylibCommand(LC_ID_DYLIB, options.installName));
  }

  for (const dependency of options.dependencies ?? []) {
    addLoadCommand(
      dylibCommand(dependency.weak ? LC_LOAD_WEAK_DYLIB : LC_LOAD_DYLIB, dependency.name),
    );
  }

  const symtabCommand = new BinaryWriter();
  symtabCommand.u32(LC_SYMTAB);
  symtabCommand.u32(24);
  symtabCommand.u32(linkeditOffset + symtabOffset);
  symtabCommand.u32(symbolEntries.length);
  symtabCommand.u32(linkeditOffset + stringTableOffset);
  symtabCommand.u32(stringTable.length);
  addLoadCommand(symtabCommand.toUint8Array());

  if (exportTrie.length > 0) {
    const command = new BinaryWriter();
    command.u32(LC_DYLD_EXPORTS_TRIE);
    command.u32(16);
    command.u32(linkeditOffset + exportTrieOffset);
    command.u32(exportTrie.length);
    addLoadCommand(command.toUint8Array());
  }

  if (chainedFixups) {
    const command = new BinaryWriter();
    command.u32(LC_DYLD_CHAINED_FIXUPS);
    command.u32(16);
    command.u32(linkeditOffset + chainedFixupsOffset);
    command.u32(chainedFixups.bytes.length);
    addLoadCommand(command.toUint8Array());
  }

  if (hasLegacyStreams) {
    const command = new BinaryWriter();
    command.u32(LC_DYLD_INFO_ONLY);
    command.u32(48);
    command.u32(linkeditOffset + legacyRebaseOffset);
    command.u32(legacyRebases.length);
    command.u32(linkeditOffset + legacyBindOffset);
    command.u32(legacyBinds.length);
    command.u32(linkeditOffset + legacyWeakOffset);
    command.u32(legacyWeakBinds.length);
    command.u32(linkeditOffset + legacyLazyOffset);
    command.u32(legacyLazyBinds.length);
    command.u32(0); // export offset
    command.u32(0); // export size
    addLoadCommand(command.toUint8Array());
  }

  const uuid = options.uuid ?? deriveUuid(options.text, cstring);
  const uuidCommand = new BinaryWriter();
  uuidCommand.u32(LC_UUID);
  uuidCommand.u32(24);
  uuidCommand.bytes(uuid);
  addLoadCommand(uuidCommand.toUint8Array());

  const buildVersion = new BinaryWriter();
  buildVersion.u32(LC_BUILD_VERSION);
  buildVersion.u32(24);
  buildVersion.u32(7); // iOS Simulator
  buildVersion.u32(packVersion(options.minimumOs ?? "26.0"));
  buildVersion.u32(packVersion(options.sdk ?? "26.0"));
  buildVersion.u32(0);
  addLoadCommand(buildVersion.toUint8Array());

  const sourceVersion = new BinaryWriter();
  sourceVersion.u32(LC_SOURCE_VERSION);
  sourceVersion.u32(16);
  sourceVersion.u64(options.sourceVersion ?? 0n);
  addLoadCommand(sourceVersion.toUint8Array());

  const commandBytes = commands.toUint8Array();
  if (32 + commandBytes.length > HEADER_RESERVE) {
    throw new MachOError(
      "fixture_header_too_large",
      `load commands need ${32 + commandBytes.length} bytes, header reserve is ${HEADER_RESERVE}`,
    );
  }

  const header = new BinaryWriter();
  header.u32(0xfeedfacf);
  header.u32(CPU_TYPE_ARM64);
  header.u32(CPU_SUBTYPE_ARM64_ALL);
  header.u32(fileType === "execute" ? MH_EXECUTE : 6);
  header.u32(countCommands(commandBytes));
  header.u32(commandBytes.length);
  header.u32(MH_NOUNDEFS | MH_DYLDLINK | MH_TWOLEVEL | (fileType === "execute" ? MH_PIE : 0));
  header.u32(0);
  header.bytes(commandBytes);

  const file = new Uint8Array(fileSize);
  file.set(header.toUint8Array(), 0);
  file.set(options.text, textFileOffset);
  file.set(cstring, cstringFileOffset);
  file.set(data, dataFileOffset);
  file.set(symtab.toUint8Array(), linkeditOffset + symtabOffset);
  file.set(stringTable.toUint8Array(), linkeditOffset + stringTableOffset);
  file.set(exportTrie, linkeditOffset + exportTrieOffset);
  if (chainedFixups) {
    file.set(chainedFixups.bytes, linkeditOffset + chainedFixupsOffset);
    applyBuiltFixups(file, chainedFixups, dataFileOffset);
  }
  if (hasLegacyStreams) {
    file.set(legacyRebases, linkeditOffset + legacyRebaseOffset);
    file.set(legacyBinds, linkeditOffset + legacyBindOffset);
    file.set(legacyWeakBinds, linkeditOffset + legacyWeakOffset);
    file.set(legacyLazyBinds, linkeditOffset + legacyLazyOffset);
  }

  return {
    bytes: file,
    layout: {
      preferredBase: PREFERRED_BASE,
      pageSize,
      text: textVm,
      cstring: cstringVm,
      data: dataVm,
      linkedit: linkeditVm,
      entry: fileType === "execute" ? textVm + entryOffset : null,
      entryFileOffset: fileType === "execute" ? textFileOffset + entryOffset : null,
      dataFileOffset,
      fileSize,
    },
  };
}

function dataSections(input: {
  dataVm: number;
  dataFileOffset: number;
  dataSize: number;
  moduleInitOffset: number;
  moduleInitCount: number;
  moduleTermOffset: number;
  moduleTermCount: number;
  interposeOffset: number;
  interposeCount: number;
}): SectionSpec[] {
  const sections: SectionSpec[] = [
    {
      name: "__data",
      segmentName: "__DATA",
      address: input.dataVm,
      size: input.dataSize,
      fileOffset: input.dataFileOffset,
      alignment: 3,
      flags: S_REGULAR,
    },
  ];
  if (input.moduleInitCount > 0) {
    sections.push({
      name: "__mod_init_func",
      segmentName: "__DATA",
      address: input.dataVm + input.moduleInitOffset,
      size: input.moduleInitCount * 8,
      fileOffset: input.dataFileOffset + input.moduleInitOffset,
      alignment: 3,
      flags: S_REGULAR,
    });
  }
  if (input.moduleTermCount > 0) {
    sections.push({
      name: "__mod_term_func",
      segmentName: "__DATA",
      address: input.dataVm + input.moduleTermOffset,
      size: input.moduleTermCount * 8,
      fileOffset: input.dataFileOffset + input.moduleTermOffset,
      alignment: 3,
      flags: S_REGULAR,
    });
  }
  if (input.interposeCount > 0) {
    sections.push({
      name: "__interpose",
      segmentName: "__DATA",
      address: input.dataVm + input.interposeOffset,
      size: input.interposeCount * 16,
      fileOffset: input.dataFileOffset + input.interposeOffset,
      alignment: 3,
      flags: S_REGULAR,
    });
  }
  return sections;
}

interface SectionSpec {
  readonly name: string;
  readonly segmentName: string;
  readonly address: number;
  readonly size: number;
  readonly fileOffset: number;
  readonly alignment: number;
  readonly flags: number;
}

function segmentCommand(input: {
  name: string;
  vmAddress: number;
  vmSize: number;
  fileOffset: number;
  fileSize: number;
  maxProtection: number;
  initialProtection: number;
  sections: readonly SectionSpec[];
}): Uint8Array {
  const writer = new BinaryWriter();
  writer.u32(LC_SEGMENT_64);
  writer.u32(72 + input.sections.length * 80);
  writer.bytes(fixedName(input.name));
  writer.u64(input.vmAddress);
  writer.u64(input.vmSize);
  writer.u64(input.fileOffset);
  writer.u64(input.fileSize);
  writer.u32(input.maxProtection);
  writer.u32(input.initialProtection);
  writer.u32(input.sections.length);
  writer.u32(0);
  for (const section of input.sections) {
    writer.bytes(fixedName(section.name));
    writer.bytes(fixedName(section.segmentName));
    writer.u64(section.address);
    writer.u64(section.size);
    writer.u32(section.fileOffset);
    writer.u32(section.alignment);
    writer.u32(0);
    writer.u32(0);
    writer.u32(section.flags);
    writer.u32(0);
    writer.u32(0);
    writer.u32(0);
  }
  return writer.toUint8Array();
}

function dylibCommand(cmd: number, name: string): Uint8Array {
  const writer = new BinaryWriter();
  const nameOffset = 24;
  const size = align(nameOffset + new TextEncoder().encode(name).length + 1, 8);
  writer.u32(cmd);
  writer.u32(size);
  writer.u32(nameOffset);
  writer.u32(0);
  writer.u32(0x10000);
  writer.u32(0x10000);
  writer.cstring(name);
  writer.zeros(size - writer.length);
  return writer.toUint8Array();
}

function buildExportsTrie(exports: readonly BuildExport[], preferredBase: number): Uint8Array {
  interface Node {
    readonly children: Map<string, Node>;
    terminal: { address: number; flags: number } | null;
  }
  const root: Node = { children: new Map(), terminal: null };
  for (const entry of exports) {
    if (entry.name.length === 0)
      throw new MachOError("empty_export", "export names cannot be empty");
    let node = root;
    for (const char of entry.name) {
      let child = node.children.get(char);
      if (!child) {
        child = { children: new Map(), terminal: null };
        node.children.set(char, child);
      }
      node = child;
    }
    if (node.terminal)
      throw new MachOError("duplicate_export", `export ${entry.name} is declared twice`);
    node.terminal = {
      address: entry.address - preferredBase,
      flags: (entry.weak ? 4 : 0) | exportKindBits(entry.kind ?? "regular"),
    };
  }

  // Node sizes are fixed-width on purpose: every ULEB except the terminal size
  // is encoded in three bytes. That makes layout a single pre-order pass.
  const sizes = new Map<Node, number>();
  const measure = (node: Node): number => {
    let size = 1 + (node.terminal ? 1 + 5 : 0) + 1;
    for (const [edge, child] of node.children) {
      size += new TextEncoder().encode(edge).length + 1 + 5;
      if (!sizes.has(child)) measure(child);
    }
    sizes.set(node, size);
    return size;
  };
  measure(root);

  const offsets = new Map<Node, number>();
  let nextOffset = 0;
  const assign = (node: Node): void => {
    offsets.set(node, nextOffset);
    nextOffset += sizes.get(node)!;
    for (const [, child] of sortedChildren(node)) assign(child);
  };
  assign(root);

  const ordered = [...offsets.entries()].sort((a, b) => a[1] - b[1]).map(([node]) => node);
  const writer = new BinaryWriter();
  for (const node of ordered) {
    writer.u8(node.terminal ? 6 : 0);
    if (node.terminal) {
      writer.u8(node.terminal.flags);
      writeFixedUleb(writer, node.terminal.address, 5);
    }
    const children = sortedChildren(node);
    writer.u8(children.length);
    for (const [edge, child] of children) {
      writer.cstring(edge);
      writeFixedUleb(writer, offsets.get(child)!, 5);
    }
  }
  return writer.toUint8Array();

  function sortedChildren(node: Node): Array<[string, Node]> {
    return [...node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

function exportKindBits(kind: BuildExportKind): number {
  if (kind === "regular") return 0;
  if (kind === "thread-local") return 1;
  return 2;
}

export interface BuiltChainedFixups {
  readonly bytes: Uint8Array;
  readonly chainValues: ReadonlyMap<number, bigint>;
}

/**
 * Encode chained fixups for a fixture.
 *
 * The public shape is intentionally explicit: `bytes` is the `__LINKEDIT`
 * payload, while `chainValues` are the — possibly patched — words that belong
 * in `__DATA`. `buildMachO` applies both. Keeping them separate lets tests
 * inspect the packed bitfields without reverse-engineering a whole file.
 */
export function buildChainedFixups(
  fixups: readonly BuildFixup[],
  dataFileOffset: number,
  dataLength: number,
  pageSize = DEFAULT_PAGE_SIZE,
): BuiltChainedFixups {
  if (fixups.length === 0) return { bytes: new Uint8Array(), chainValues: new Map() };
  const sorted = [...fixups].sort((a, b) => a.offset - b.offset);
  const imports: Array<{ ordinal: number; symbol: string; weak: boolean }> = [];
  const importIndex = new Map<string, number>();
  const pages = new Map<number, BuildFixup[]>();

  for (const fixup of sorted) {
    if (fixup.offset < 0 || fixup.offset + 8 > dataLength || fixup.offset % 8 !== 0) {
      throw new MachOError(
        "bad_fixup_offset",
        `fixup offset ${fixup.offset} is outside __DATA or unaligned`,
      );
    }
    if (fixup.kind === "bind") {
      if (!fixup.symbol) throw new MachOError("bad_fixup", "bind fixups need a symbol");
      const key = `${fixup.ordinal ?? 1}:${fixup.symbol}:${fixup.weak ? 1 : 0}`;
      if (!importIndex.has(key)) {
        importIndex.set(key, imports.length);
        imports.push({
          ordinal: fixup.ordinal ?? 1,
          symbol: fixup.symbol,
          weak: fixup.weak ?? false,
        });
      }
    } else if (fixup.target === undefined) {
      throw new MachOError("bad_fixup", "rebase fixups need a target");
    }
    const page = Math.floor(fixup.offset / pageSize);
    const list = pages.get(page) ?? [];
    list.push(fixup);
    pages.set(page, list);
  }
  if (pages.size > 1) {
    throw new MachOError(
      "multi_page_fixture",
      "test fixtures support fixups on a single __DATA page",
    );
  }

  const page = [...pages.keys()][0] ?? 0;
  const entries = pages.get(page) ?? [];
  if (entries.length === 0) return { bytes: new Uint8Array(), chainValues: new Map() };
  const pageStarts = new Uint16Array(1);
  pageStarts[0] = entries[0]!.offset;
  const startsSize = 22 + pageStarts.length * 2;

  const symbols = new BinaryWriter();
  const symbolOffsets = imports.map((entry) => {
    const offset = symbols.length;
    symbols.cstring(entry.symbol);
    return offset;
  });

  const headerSize = 28;
  const startsImageSize = 4 + 4 * 4; // seg_count + four segment offsets
  const startsOffset = headerSize;
  const segInfoOffset = startsImageSize;
  const importsOffset = startsOffset + startsImageSize + startsSize;
  const symbolsOffset = importsOffset + imports.length * 4;

  const writer = new BinaryWriter();
  writer.u32(0); // version
  writer.u32(startsOffset);
  writer.u32(importsOffset);
  writer.u32(symbolsOffset);
  writer.u32(imports.length);
  writer.u32(1); // DYLD_CHAINED_IMPORT
  writer.u32(0); // uncompressed symbols

  writer.u32(4); // __PAGEZERO, __TEXT, __DATA, __LINKEDIT
  writer.u32(0);
  writer.u32(0);
  writer.u32(segInfoOffset);
  writer.u32(0);

  writer.u32(startsSize);
  writer.u16(pageSize);
  writer.u16(2); // DYLD_CHAINED_PTR_64
  writer.u64(dataFileOffset);
  writer.u32(0);
  writer.u16(pageStarts.length);
  for (const start of pageStarts) writer.u16(start);

  for (let index = 0; index < imports.length; index += 1) {
    const entry = imports[index]!;
    const raw = (entry.ordinal & 0xff) | (entry.weak ? 1 << 8 : 0) | (symbolOffsets[index]! << 9);
    writer.u32(raw >>> 0);
  }
  writer.bytes(symbols.toUint8Array());

  const chainValues = new Map<number, bigint>();
  for (let index = 0; index < entries.length; index += 1) {
    const fixup = entries[index]!;
    const next = index + 1 < entries.length ? (entries[index + 1]!.offset - fixup.offset) / 4 : 0;
    if (next < 0 || next > 0xfff)
      throw new MachOError("fixup_stride", "fixup chain stride exceeds 12 bits");
    if (fixup.kind === "bind") {
      const key = `${fixup.ordinal ?? 1}:${fixup.symbol}:${fixup.weak ? 1 : 0}`;
      const ordinal = (importIndex.get(key) ?? 0) + 1;
      const addend = BigInt.asUintN(8, BigInt(fixup.addend ?? 0));
      chainValues.set(
        fixup.offset,
        (1n << 63n) | (BigInt(next) << 51n) | (addend << 24n) | BigInt(ordinal),
      );
    } else {
      const target = BigInt(fixup.target!) & 0xf_ffff_ffffn;
      chainValues.set(fixup.offset, (BigInt(next) << 51n) | target);
    }
  }

  return { bytes: writer.toUint8Array(), chainValues };
}

/** Apply the chain words produced by {@link buildChainedFixups} to __DATA. */
export function applyBuiltFixups(
  bytes: Uint8Array,
  chainedFixups: BuiltChainedFixups,
  dataFileOffset: number,
): void {
  for (const [offset, value] of chainedFixups.chainValues) {
    const at = dataFileOffset + offset;
    for (let index = 0; index < 8; index += 1) {
      bytes[at + index] = Number((value >> BigInt(index * 8)) & 0xffn);
    }
  }
}

function countCommands(bytes: Uint8Array): number {
  let offset = 0;
  let count = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length)
      throw new MachOError("bad_commands", "truncated load command while counting");
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    if (size < 8 || offset + size > bytes.length)
      throw new MachOError("bad_commands", "invalid load command size");
    offset += size;
    count += 1;
  }
  return count;
}

function inferSection(
  value: number,
  text: number,
  cstring: number,
  data: number,
  dataLength: number,
): number {
  if (value >= text && value < cstring) return 1;
  if (value >= cstring && value < data) return 2;
  if (value >= data && value < data + Math.max(dataLength, 8)) return 3;
  return 1;
}

function fixedName(value: string): Uint8Array {
  const bytes = new Uint8Array(16);
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 16)
    throw new MachOError("name_too_long", `Mach-O name ${value} exceeds 16 bytes`);
  bytes.set(encoded);
  return bytes;
}

function writeFixedUleb(writer: BinaryWriter, value: number, width: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new MachOError("bad_uleb", `cannot encode ${value} as ULEB`);
  }
  let remaining = value;
  for (let index = 0; index < width; index += 1) {
    const last = index === width - 1;
    const byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    writer.u8(last ? byte : byte | 0x80);
  }
  if (remaining !== 0)
    throw new MachOError("uleb_overflow", `value ${value} does not fit in ${width} ULEB bytes`);
}

function packVersion(value: string): number {
  const parts = value.split(".").map((part) => Number(part));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (![major, minor, patch].every((part) => Number.isInteger(part) && part >= 0 && part < 256)) {
    throw new MachOError("bad_version", `version ${value} is not representable`);
  }
  return (major << 16) | (minor << 8) | patch;
}

function deriveUuid(text: Uint8Array, cstring: Uint8Array): Uint8Array {
  let hash = 0x811c9dc5;
  for (const byte of text) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  for (const byte of cstring) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  const uuid = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    hash = Math.imul(hash ^ index, 0x01000193) >>> 0;
    uuid[index] = (hash >>> ((index % 4) * 8)) & 0xff;
  }
  uuid[6] = (uuid[6]! & 0x0f) | 0x40;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  return uuid;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
