/**
 * User-space dyld: map Mach-O images, load dependencies, apply chained fixups,
 * and resolve exports.
 *
 * Scope is explicit. Implemented: arm64 thin/fat parsing, segment mapping,
 * `@loader_path`/`@executable_path`/`@rpath` dependency lookup, export tries,
 * symbol-table fallback, chained binds/rebases (including arm64e pointer
 * formats), and `LC_MAIN`/`LC_UNIXTHREAD` entry selection.
 *
 * Not implemented: the dyld shared cache, legacy dyld opcode bindings, lazy
 * binding stubs, initializers, `dlopen`, weak symbol coalescing, and code
 * signing. Each has a stable error code instead of silent success.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { LoaderError } from "../errors.js";
import type { ChainedFixup } from "../macho/fixups.js";
import { parseMachO } from "../macho/parse.js";
import {
  DYLD_CHAINED_PTR_64_OFFSET,
  DYLD_CHAINED_PTR_ARM64E,
  DYLD_CHAINED_PTR_ARM64E_USERLAND,
  DYLD_CHAINED_PTR_ARM64E_USERLAND24,
  MH_EXECUTE,
} from "../macho/constants.js";
import type { ExportEntry } from "../macho/exports-trie.js";
import type { MachOImage } from "../macho/types.js";
import { VirtualMemory } from "./vm.js";

export interface FileProvider {
  readFile(path: string): Uint8Array;
}

export class NodeFileProvider implements FileProvider {
  readFile(path: string): Uint8Array {
    return readFileSync(path);
  }
}

export class MapFileProvider implements FileProvider {
  readonly files: Map<string, Uint8Array>;

  constructor(files: Map<string, Uint8Array> | Record<string, Uint8Array>) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }
  readFile(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (!bytes) throw new LoaderError("file_not_found", `virtual file ${path} is not present`);
    return bytes;
  }
}

export interface LoadedImage {
  readonly path: string;
  readonly image: MachOImage;
  readonly base: bigint;
  readonly slide: bigint;
  readonly dependencies: Array<LoadedImage | null>;
  readonly exports: ReadonlyMap<string, bigint>;
  readonly rawExports: ReadonlyMap<string, ExportEntry>;
}

export interface LoadStats {
  images: number;
  fixups: number;
  binds: number;
  rebases: number;
  cacheHits: number;
}

export interface LoadedProgram {
  readonly main: LoadedImage;
  readonly images: readonly LoadedImage[];
  readonly memory: VirtualMemory;
  readonly entry: bigint;
  readonly stackSize: number;
  readonly stats: LoadStats;
  readonly provider: FileProvider;
  resolveExport(name: string): bigint | null;
}

export interface LoaderOptions {
  readonly provider?: FileProvider;
  readonly memory?: VirtualMemory;
  readonly searchPaths?: readonly string[];
  readonly extraRpaths?: readonly string[];
  readonly maxImages?: number;
  readonly externalSymbols?: ReadonlyMap<string, bigint>;
}

interface LoadContext {
  readonly provider: FileProvider;
  readonly memory: VirtualMemory;
  readonly searchPaths: readonly string[];
  readonly extraRpaths: readonly string[];
  readonly executablePath: string;
  readonly maxImages: number;
  readonly externalSymbols: ReadonlyMap<string, bigint>;
  readonly cache: Map<string, LoadedImage>;
  readonly order: LoadedImage[];
  readonly stats: LoadStats;
}

const MAX_IMAGES = 128;

export class ImageLoader {
  private readonly memory: VirtualMemory;
  private readonly provider: FileProvider;
  private readonly searchPaths: readonly string[];
  private readonly extraRpaths: readonly string[];
  private readonly maxImages: number;
  private readonly externalSymbols: ReadonlyMap<string, bigint>;
  private readonly cache = new Map<string, LoadedImage>();
  private readonly order: LoadedImage[] = [];
  private readonly stats: LoadStats = { images: 0, fixups: 0, binds: 0, rebases: 0, cacheHits: 0 };

  constructor(options: LoaderOptions = {}) {
    this.provider = options.provider ?? new NodeFileProvider();
    this.memory = options.memory ?? new VirtualMemory();
    this.searchPaths = options.searchPaths ?? [];
    this.extraRpaths = options.extraRpaths ?? [];
    this.maxImages = Math.min(options.maxImages ?? MAX_IMAGES, MAX_IMAGES);
    this.externalSymbols = options.externalSymbols ?? new Map();
  }

  get memoryView(): VirtualMemory {
    return this.memory;
  }

  load(path: string): LoadedProgram {
    const executablePath = normalize(path);
    const context: LoadContext = {
      provider: this.provider,
      memory: this.memory,
      searchPaths: this.searchPaths,
      extraRpaths: this.extraRpaths,
      executablePath,
      maxImages: this.maxImages,
      externalSymbols: this.externalSymbols,
      cache: this.cache,
      order: this.order,
      stats: this.stats,
    };
    const main = this.loadImage(executablePath, context);
    if (main.image.header.fileType !== MH_EXECUTE) {
      throw new LoaderError(
        "not_executable",
        `${main.path} is Mach-O file type ${main.image.header.fileType}, expected MH_EXECUTE`,
        { fileType: main.image.header.fileType },
      );
    }
    const entry = entryPoint(main);
    const stackSize = main.image.main?.stackSize ?? 8 * 1024 * 1024;
    return {
      main,
      images: this.order,
      memory: this.memory,
      entry,
      stackSize,
      stats: { ...this.stats, images: this.order.length },
      provider: this.provider,
      resolveExport: (name: string) => lookupFlat(main, name),
    };
  }

  private loadImage(path: string, context: LoadContext): LoadedImage {
    const cached = context.cache.get(path);
    if (cached) {
      context.stats.cacheHits += 1;
      return cached;
    }
    if (context.order.length >= context.maxImages) {
      throw new LoaderError(
        "too_many_images",
        `loading ${path} would exceed the ${context.maxImages} image limit`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = context.provider.readFile(path);
    } catch (error) {
      throw new LoaderError("file_not_found", `cannot read Mach-O ${path}`, {
        path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const parsed = parseMachO(bytes);
    const image = parsed.image;
    const preferred = BigInt(image.preferredBase);
    const base = chooseBase(image, context.memory);
    const slide = base - preferred;
    const slice = bytes.subarray(image.sliceOffset, image.sliceOffset + image.byteLength);
    mapSegments(image, context.memory, base, slice);

    const rawExports = image.exportsTrie?.exports ?? new Map();
    const exports = new Map<string, bigint>();
    for (const [name, entry] of rawExports) {
      if (entry.kind === "reexport") continue;
      if (entry.address === null) continue;
      exports.set(
        name,
        entry.kind === "absolute" ? BigInt(entry.address) : base + BigInt(entry.address),
      );
    }
    for (const symbol of image.symbols) {
      if (symbol.debug || symbol.undefined || !symbol.external || symbol.name.length === 0)
        continue;
      if (exports.has(symbol.name)) continue;
      const address =
        symbol.value >= image.preferredBase
          ? base + BigInt(symbol.value - image.preferredBase)
          : BigInt(symbol.value);
      exports.set(symbol.name, address);
    }

    const loaded: LoadedImage = {
      path,
      image,
      base,
      slide,
      dependencies: [],
      exports,
      rawExports,
    };
    context.cache.set(path, loaded);
    context.order.push(loaded);

    for (const dylib of image.dylibs) {
      if (dylib.kind === "id") continue;
      const resolved = resolveDependency(path, dylib.name, image.rpaths, context);
      if (!resolved) {
        if (dylib.kind === "weak") {
          loaded.dependencies[dylib.ordinal - 1] = null;
          continue;
        }
        throw new LoaderError(
          "dependency_not_found",
          `${basename(path)} depends on ${dylib.name}, which could not be resolved`,
          { from: path, dependency: dylib.name },
        );
      }
      loaded.dependencies[dylib.ordinal - 1] = this.loadImage(resolved, context);
    }

    applyFixups(loaded, context);
    context.stats.images += 1;
    return loaded;
  }
}

function chooseBase(image: MachOImage, memory: VirtualMemory): bigint {
  let low = Number.MAX_SAFE_INTEGER;
  let high = 0;
  for (const segment of image.segments) {
    if (segment.name === "__PAGEZERO" || segment.vmSize === 0) continue;
    low = Math.min(low, segment.vmAddress);
    high = Math.max(high, segment.vmAddress + segment.vmSize);
  }
  if (low === Number.MAX_SAFE_INTEGER) {
    throw new LoaderError("no_image_segments", `${image.uuid ?? "image"} has no mappable segments`);
  }
  const preferred = BigInt(image.preferredBase);
  for (let slide = 0n; slide <= 128n; slide += 1n) {
    const base = preferred + slide * 0x1_0000_0000n;
    const start = base + BigInt(low - image.preferredBase);
    const end = base + BigInt(high - image.preferredBase);
    if (!memory.overlaps(start, end)) return base;
  }
  throw new LoaderError(
    "address_space_exhausted",
    `no free slide for ${image.preferredBase.toString(16)}`,
  );
}

function mapSegments(
  image: MachOImage,
  memory: VirtualMemory,
  base: bigint,
  bytes: Uint8Array,
): void {
  const relative = (address: number): bigint => BigInt(address - image.preferredBase);
  for (const segment of image.segments) {
    if (segment.vmSize === 0 || segment.name === "__PAGEZERO") continue;
    if (segment.fileSize === 0) {
      memory.mapFixed(base + relative(segment.vmAddress), segment.vmSize, {
        tag: segment.name,
        protection: segment.initialProtection,
      });
      continue;
    }
    if (segment.vmSize < segment.fileSize) {
      throw new LoaderError("bad_segment", `${segment.name} has a larger file size than VM size`);
    }
    memory.mapFixed(base + relative(segment.vmAddress), segment.vmSize, {
      tag: segment.name,
      protection: segment.initialProtection,
      bytes: bytes.subarray(segment.fileOffset, segment.fileOffset + segment.fileSize),
    });
  }
}

function applyFixups(loaded: LoadedImage, context: LoadContext): void {
  const fixups = loaded.image.chainedFixups;
  if (!fixups) {
    if (
      (loaded.image.dyldInfo?.bindSize ?? 0) > 0 ||
      (loaded.image.dyldInfo?.lazyBindSize ?? 0) > 0
    ) {
      throw new LoaderError(
        "legacy_bindings_unimplemented",
        `${loaded.path} uses legacy dyld opcode bindings; only chained fixups are implemented`,
      );
    }
    return;
  }

  for (const fixup of fixups.fixups) {
    const segment = loaded.image.segments[fixup.segmentIndex];
    if (!segment)
      throw new LoaderError("internal_error", `fixup segment ${fixup.segmentIndex} is missing`);
    const inSegment = fixup.location - segment.fileOffset;
    if (inSegment < 0 || inSegment + 8 > segment.vmSize) {
      throw new LoaderError(
        "fixup_outside_segment",
        `fixup at ${fixup.location} is outside ${segment.name}`,
      );
    }
    const address =
      loaded.base + BigInt(segment.vmAddress - loaded.image.preferredBase) + BigInt(inSegment);
    if (fixup.kind === "rebase") {
      const value = rebaseValue(fixup, loaded);
      context.memory.write(address, 8, value);
      context.stats.rebases += 1;
    } else {
      const value = bindValue(fixup, loaded, context);
      context.memory.write(address, 8, value);
      context.stats.binds += 1;
    }
    context.stats.fixups += 1;
  }
}

function rebaseValue(
  fixup: Extract<ChainedFixup, { kind: "rebase" }>,
  loaded: LoadedImage,
): bigint {
  let value = fixup.target;
  if (
    fixup.format === DYLD_CHAINED_PTR_64_OFFSET ||
    fixup.format === DYLD_CHAINED_PTR_ARM64E ||
    fixup.format === DYLD_CHAINED_PTR_ARM64E_USERLAND ||
    fixup.format === DYLD_CHAINED_PTR_ARM64E_USERLAND24
  ) {
    value += loaded.base;
  } else {
    let low = Number.MAX_SAFE_INTEGER;
    let high = 0;
    for (const segment of loaded.image.segments) {
      if (segment.name === "__PAGEZERO" || segment.vmSize === 0) continue;
      low = Math.min(low, segment.vmAddress);
      high = Math.max(high, segment.vmAddress + segment.vmSize);
    }
    if (value >= BigInt(low) && value < BigInt(high)) value += loaded.slide;
  }
  if (fixup.high8 !== 0) value |= BigInt(fixup.high8) << 56n;
  return BigInt.asUintN(64, value);
}

function bindValue(
  fixup: Extract<ChainedFixup, { kind: "bind" }>,
  loaded: LoadedImage,
  context: LoadContext,
): bigint {
  const imported = loaded.image.chainedFixups?.imports[fixup.ordinal - 1];
  if (!imported)
    throw new LoaderError("fixup_import_missing", `bind ${fixup.symbol} has no import entry`);
  const ordinal = imported.ordinal;
  let target: bigint | null = null;

  if (ordinal === 0) {
    target = lookupExport(loaded, fixup.symbol, new Set());
  } else if (ordinal === -1) {
    const main = context.order[0];
    target = main ? lookupExport(main, fixup.symbol, new Set()) : null;
  } else if (ordinal === -2 || ordinal === -3) {
    const main = context.order[0];
    target = main ? lookupFlat(main, fixup.symbol) : null;
  } else if (ordinal > 0) {
    const dependency = loaded.dependencies[ordinal - 1];
    target = dependency ? lookupExport(dependency, fixup.symbol, new Set()) : null;
  } else {
    throw new LoaderError(
      "unsupported_import_ordinal",
      `import ordinal ${ordinal} for ${fixup.symbol} is not supported`,
    );
  }

  if (target === null) {
    target = context.externalSymbols.get(fixup.symbol) ?? null;
  }
  if (target === null) {
    if (fixup.weak || imported.weak || ordinal === -3) return 0n;
    throw new LoaderError(
      "symbol_not_found",
      `${loaded.path} needs ${fixup.symbol} from ordinal ${ordinal}, but it is not exported`,
      { path: loaded.path, symbol: fixup.symbol, ordinal },
    );
  }
  return BigInt.asUintN(64, target + fixup.addend);
}

function lookupExport(image: LoadedImage, name: string, visited: Set<string>): bigint | null {
  const direct = image.exports.get(name);
  if (direct !== undefined) return direct;
  const key = `${image.path}:${name}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const raw = image.rawExports.get(name);
  if (raw?.kind === "reexport" && raw.reexport) {
    const dependency = image.dependencies[raw.reexport.ordinal - 1];
    if (!dependency) return null;
    return lookupExport(dependency, raw.reexport.name, visited);
  }
  return null;
}

function lookupFlat(main: LoadedImage, name: string): bigint | null {
  const visited = new Set<string>();
  const queue: LoadedImage[] = [main];
  while (queue.length > 0) {
    const image = queue.shift()!;
    const found = lookupExport(image, name, visited);
    if (found !== null) return found;
    for (const dependency of image.dependencies) {
      if (dependency) queue.push(dependency);
    }
  }
  return null;
}

function entryPoint(image: LoadedImage): bigint {
  if (image.image.main) {
    const address = fileOffsetToAddress(image, image.image.main.entryOffset);
    if (address === null) {
      throw new LoaderError(
        "bad_entry",
        `LC_MAIN entry offset ${image.image.main.entryOffset} is outside every segment`,
      );
    }
    return address;
  }
  if (image.image.unixThread && image.image.unixThread.entryPoint !== 0) {
    const preferred = BigInt(image.image.preferredBase);
    const entry = BigInt(image.image.unixThread.entryPoint);
    if (entry < preferred) {
      throw new LoaderError(
        "bad_entry",
        `${image.path} has a thread entry 0x${entry.toString(16)} below its preferred base 0x${preferred.toString(16)}`,
      );
    }
    return image.base + (entry - preferred);
  }
  throw new LoaderError(
    "no_entry",
    `${image.path} has neither LC_MAIN nor an arm64 LC_UNIXTHREAD entry`,
  );
}

function fileOffsetToAddress(image: LoadedImage, fileOffset: number): bigint | null {
  for (const segment of image.image.segments) {
    if (fileOffset >= segment.fileOffset && fileOffset < segment.fileOffset + segment.fileSize) {
      return (
        image.base +
        BigInt(segment.vmAddress - image.image.preferredBase) +
        BigInt(fileOffset - segment.fileOffset)
      );
    }
  }
  return null;
}

function resolveDependency(
  fromPath: string,
  name: string,
  rpaths: readonly string[],
  context: LoadContext,
): string | null {
  const candidates = dependencyCandidates(fromPath, name, rpaths, context);
  for (const candidate of candidates) {
    try {
      context.provider.readFile(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function dependencyCandidates(
  fromPath: string,
  name: string,
  rpaths: readonly string[],
  context: LoadContext,
): string[] {
  const candidates: string[] = [];
  const add = (path: string): void => {
    const normalized = normalize(path);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  if (name.startsWith("@loader_path/")) {
    add(join(dirname(fromPath), name.slice("@loader_path/".length)));
  } else if (name.startsWith("@executable_path/")) {
    add(join(dirname(context.executablePath), name.slice("@executable_path/".length)));
  } else if (name.startsWith("@rpath/")) {
    const suffix = name.slice("@rpath/".length);
    for (const rpath of [...rpaths, ...context.extraRpaths]) {
      add(join(expandRpath(rpath, fromPath, context.executablePath), suffix));
    }
  } else if (isAbsolute(name)) {
    add(name);
    for (const search of context.searchPaths) add(join(search, basename(name)));
  } else {
    add(join(dirname(fromPath), name));
    for (const search of context.searchPaths) add(join(search, name));
  }
  return candidates;
}

function expandRpath(rpath: string, fromPath: string, executablePath: string): string {
  if (rpath.startsWith("@loader_path/"))
    return join(dirname(fromPath), rpath.slice("@loader_path/".length));
  if (rpath.startsWith("@executable_path/")) {
    return join(dirname(executablePath), rpath.slice("@executable_path/".length));
  }
  return rpath;
}
