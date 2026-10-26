/**
 * User-space dyld: map Mach-O images, load dependencies, apply chained fixups,
 * and resolve exports.
 *
 * Scope is explicit. Implemented: arm64 thin/fat parsing, segment mapping,
 * `@loader_path`/`@executable_path`/`@rpath` dependency lookup, export tries,
 * symbol-table fallback, chained binds/rebases (including arm64e pointer
 * formats), and `LC_MAIN`/`LC_UNIXTHREAD` entry selection.
 *
 * Implemented: legacy `LC_DYLD_INFO` rebase/bind opcodes (LDR-001), lazy
 * binding entries resolved on demand (LDR-002), and weak binds with flat
 * lookup that resolve missing symbols to null (LDR-002).
 *
 * Not implemented: the dyld shared cache, real lazy-stub trampolines, general
 * weak-definition coalescing, initializers, `dlopen`, and code signing. Each
 * has a stable error code instead of silent success.
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
  MH_DYLIB,
  MH_EXECUTE,
} from "../macho/constants.js";
import type { ExportEntry } from "../macho/exports-trie.js";
import type { LegacyBind } from "../macho/legacy-fixups.js";
import {
  parseLegacyBinds,
  parseLegacyLazyBinds,
  parseLegacyRebases,
} from "../macho/legacy-fixups.js";
import type { MachOImage } from "../macho/types.js";
import { VirtualMemory } from "./vm.js";
import { describeLoaderError, type LoaderReport } from "./diagnostics.js";

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
  /** Module initializer addresses in this image, in section order. */
  readonly initializers: bigint[];
  /** Module terminator addresses in this image, in section order. */
  readonly terminators: bigint[];
}

export interface LoadStats {
  images: number;
  fixups: number;
  binds: number;
  rebases: number;
  cacheHits: number;
}

export interface Interposition {
  readonly replaced: bigint;
  readonly replacement: bigint;
  readonly imagePath: string;
}

export interface LazyBindingView {
  readonly address: bigint;
  readonly symbol: string;
  readonly ordinal: number;
  readonly bound: boolean;
}

export interface LoadedProgram {
  readonly main: LoadedImage;
  readonly images: readonly LoadedImage[];
  readonly memory: VirtualMemory;
  readonly entry: bigint;
  readonly stackSize: number;
  readonly stats: LoadStats;
  readonly provider: FileProvider;
  /** Module initializers in dependency-first order. */
  readonly initializers: readonly bigint[];
  /** Module terminators in main-first order. */
  readonly terminators: readonly bigint[];
  /** `__interpose` pairs in registration order. */
  readonly interpositions: readonly Interposition[];
  /** Lazy-bind sites decoded from `LC_DYLD_INFO`, in stream order. */
  readonly lazyBindings: readonly LazyBindingView[];
  resolveExport(name: string): bigint | null;
  /** Resolve one lazy site on first use. Returns false when already bound. */
  bindLazy(address: bigint): boolean;
}

export interface LoaderOptions {
  readonly provider?: FileProvider;
  readonly memory?: VirtualMemory;
  readonly searchPaths?: readonly string[];
  readonly extraRpaths?: readonly string[];
  readonly maxImages?: number;
  readonly externalSymbols?: ReadonlyMap<string, bigint>;
}

interface LazyState {
  readonly address: bigint;
  readonly bind: LegacyBind;
  readonly image: LoadedImage;
  bound: boolean;
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
  readonly lazyStates: LazyState[];
  readonly lazyByAddress: Map<string, LazyState>;
  readonly interpositions: Map<string, Interposition>;
  readonly interpositionList: Interposition[];
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
  private readonly lazyStates: LazyState[] = [];
  private readonly lazyByAddress = new Map<string, LazyState>();
  private readonly pinned = new Set<string>();
  private readonly interpositions = new Map<string, Interposition>();
  private readonly interpositionList: Interposition[] = [];
  private mainPath: string | null = null;

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
    this.mainPath = executablePath;
    const context = this.contextFor(executablePath);
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
    const lazyStates = context.lazyStates;
    this.pin(main);
    const initializers = dedupe([...this.order].reverse().flatMap((image) => image.initializers));
    const terminators = dedupe(this.order.flatMap((image) => image.terminators));
    return {
      main,
      images: this.order,
      memory: this.memory,
      entry,
      stackSize,
      initializers,
      terminators,
      interpositions: this.interpositionList,
      stats: { ...this.stats, images: this.order.length },
      provider: this.provider,
      get lazyBindings() {
        return lazyStates.map((state) => ({
          address: state.address,
          symbol: state.bind.symbol,
          ordinal: state.bind.ordinal,
          bound: state.bound,
        }));
      },
      resolveExport: (name: string) => lookupFlat(main, name),
      bindLazy: (address: bigint) => bindLazy(context, address),
    };
  }

  /**
   * Load one `MH_DYLIB` into the existing address space (LDR-004). The image
   * joins the same cache/order as the main program, so static and dynamic
   * lookups see one namespace.
   */
  loadDylib(path: string): LoadedImage {
    const normalized = normalize(path);
    const context = this.contextFor(this.mainPath ?? normalized);
    const image = this.loadImage(normalized, context);
    if (image.image.header.fileType !== MH_DYLIB) {
      throw new LoaderError(
        "not_dylib",
        `${normalized} is Mach-O file type ${image.image.header.fileType}, expected MH_DYLIB`,
        { fileType: image.image.header.fileType },
      );
    }
    return image;
  }

  /** Resolve a dynamic symbol and apply any registered interposition. */
  resolveDynamicSymbol(image: LoadedImage, name: string): bigint | null {
    const target = resolveImageExport(image, name);
    if (target === null) return null;
    return this.interpositions.get(target.toString())?.replacement ?? target;
  }

  /** True when an image was loaded as part of the main program graph. */
  isPinned(path: string): boolean {
    return this.pinned.has(normalize(path));
  }

  /** Remove a dynamically loaded image and release its mappings. */
  unloadImage(path: string): boolean {
    const normalized = normalize(path);
    if (this.pinned.has(normalized)) return false;
    const loaded = this.cache.get(normalized);
    if (!loaded) return false;
    for (const segment of loaded.image.segments) {
      if (segment.vmSize === 0 || segment.name === "__PAGEZERO") continue;
      const address = loaded.base + BigInt(segment.vmAddress - loaded.image.preferredBase);
      const size = Math.ceil(segment.vmSize / this.memory.pageSize) * this.memory.pageSize;
      this.memory.unmap(address, size);
    }
    this.cache.delete(normalized);
    const index = this.order.findIndex((candidate) => candidate.path === normalized);
    if (index >= 0) this.order.splice(index, 1);
    return true;
  }

  private pin(loaded: LoadedImage): void {
    const seen = new Set<string>();
    const visit = (image: LoadedImage): void => {
      if (seen.has(image.path)) return;
      seen.add(image.path);
      this.pinned.add(image.path);
      for (const dependency of image.dependencies) {
        if (dependency) visit(dependency);
      }
    };
    visit(loaded);
  }

  private contextFor(executablePath: string): LoadContext {
    return {
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
      lazyStates: this.lazyStates,
      lazyByAddress: this.lazyByAddress,
      interpositions: this.interpositions,
      interpositionList: this.interpositionList,
    };
  }

  /** Load with a structured, actionable failure report instead of throwing. */
  diagnose(path: string): LoaderReport {
    try {
      const program = this.load(path);
      return {
        ok: true,
        path: normalize(path),
        program,
        diagnostic: null,
        stats: { ...this.stats, images: this.order.length },
      };
    } catch (error) {
      return {
        ok: false,
        path: normalize(path),
        program: null,
        diagnostic: describeLoaderError(error, normalize(path)),
        stats: { ...this.stats, images: this.order.length },
      };
    }
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
      initializers: [],
      terminators: [],
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

    applyFixups(loaded, context, slice);
    collectModuleFunctions(loaded, context);
    collectInterpositions(loaded, context);
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

function applyFixups(loaded: LoadedImage, context: LoadContext, slice: Uint8Array): void {
  const fixups = loaded.image.chainedFixups;
  if (!fixups) {
    applyLegacyFixups(loaded, context, slice);
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

function applyLegacyFixups(loaded: LoadedImage, context: LoadContext, slice: Uint8Array): void {
  const info = loaded.image.dyldInfo;
  if (!info) return;
  const segments = loaded.image.segments.map((segment) => ({
    index: segment.index,
    vmAddress: segment.vmAddress,
    vmSize: segment.vmSize,
  }));
  const rebases =
    (info.rebaseSize ?? 0) > 0
      ? parseLegacyRebases(slice, info.rebaseOffset, info.rebaseSize, segments)
      : [];
  const binds =
    (info.bindSize ?? 0) > 0
      ? parseLegacyBinds(slice, info.bindOffset, info.bindSize, segments)
      : [];
  const weakBinds =
    (info.weakBindSize ?? 0) > 0
      ? parseLegacyBinds(slice, info.weakBindOffset, info.weakBindSize, segments)
      : [];
  const lazyBinds =
    (info.lazyBindSize ?? 0) > 0
      ? parseLegacyLazyBinds(slice, info.lazyBindOffset, info.lazyBindSize, segments)
      : [];

  for (const rebase of rebases) {
    const address = legacyAddress(loaded, rebase.segmentIndex, rebase.segmentOffset);
    const current = context.memory.read(address, 8);
    const preferredLow = legacyPreferredLow(loaded);
    const preferredHigh = legacyPreferredHigh(loaded);
    const value =
      current >= preferredLow && current < preferredHigh ? current + loaded.slide : current;
    context.memory.write(address, 8, BigInt.asUintN(64, value));
    context.stats.rebases += 1;
    context.stats.fixups += 1;
  }

  for (const bind of binds) {
    const address = legacyAddress(loaded, bind.segmentIndex, bind.segmentOffset);
    const target = resolveSymbol(loaded, bind.symbol, bind.ordinal, bind.weak, context);
    context.memory.write(address, 8, BigInt.asUintN(64, target + bind.addend));
    context.stats.binds += 1;
    context.stats.fixups += 1;
  }

  for (const bind of weakBinds) {
    const address = legacyAddress(loaded, bind.segmentIndex, bind.segmentOffset);
    // Weak bind streams have no dylib ordinal: resolve flat and allow null.
    const target = resolveSymbol(loaded, bind.symbol, -3, true, context);
    context.memory.write(address, 8, BigInt.asUintN(64, target + bind.addend));
    context.stats.binds += 1;
    context.stats.fixups += 1;
  }

  for (const bind of lazyBinds) {
    const address = legacyAddress(loaded, bind.segmentIndex, bind.segmentOffset);
    const existing = context.lazyByAddress.get(address.toString());
    if (existing) continue;
    const state: LazyState = { address, bind, image: loaded, bound: false };
    context.lazyByAddress.set(address.toString(), state);
    context.lazyStates.push(state);
  }
}

function bindLazy(context: LoadContext, address: bigint): boolean {
  const state = context.lazyByAddress.get(address.toString());
  if (!state || state.bound) return false;
  const target = resolveSymbol(
    state.image,
    state.bind.symbol,
    state.bind.ordinal,
    state.bind.weak,
    context,
  );
  context.memory.write(state.address, 8, BigInt.asUintN(64, target + state.bind.addend));
  state.bound = true;
  context.stats.binds += 1;
  context.stats.fixups += 1;
  return true;
}

function dedupe(addresses: readonly bigint[]): bigint[] {
  const seen = new Set<string>();
  const unique: bigint[] = [];
  for (const address of addresses) {
    const key = address.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

function collectModuleFunctions(loaded: LoadedImage, context: LoadContext): void {
  const routines = loaded.image.routines;
  if (routines && routines.initAddress !== 0) {
    const preferred = BigInt(loaded.image.preferredBase);
    loaded.initializers.push(loaded.base + (BigInt(routines.initAddress) - preferred));
  }

  for (const section of loaded.image.sections) {
    const target =
      section.name === "__mod_init_func"
        ? loaded.initializers
        : section.name === "__mod_term_func"
          ? loaded.terminators
          : null;
    if (!target) continue;
    if (section.size % 8 !== 0) {
      throw new LoaderError(
        "bad_module_function_section",
        `${loaded.path} ${section.name} size ${section.size} is not pointer-aligned`,
      );
    }
    const start = loaded.base + BigInt(section.address - loaded.image.preferredBase);
    for (let offset = 0; offset < section.size; offset += 8) {
      const address = context.memory.read(start + BigInt(offset), 8);
      if (address !== 0n) target.push(address);
    }
  }
}

function collectInterpositions(loaded: LoadedImage, context: LoadContext): void {
  for (const section of loaded.image.sections) {
    if (section.name !== "__interpose") continue;
    if (section.size % 16 !== 0) {
      throw new LoaderError(
        "bad_interpose_section",
        `${loaded.path} __interpose size ${section.size} is not pair-aligned`,
      );
    }
    const start = loaded.base + BigInt(section.address - loaded.image.preferredBase);
    for (let offset = 0; offset < section.size; offset += 16) {
      const replacement = context.memory.read(start + BigInt(offset), 8);
      const replaced = context.memory.read(start + BigInt(offset) + 8n, 8);
      if (replacement === 0n || replaced === 0n) continue;
      const entry: Interposition = { replaced, replacement, imagePath: loaded.path };
      if (context.interpositions.has(replaced.toString())) continue;
      context.interpositions.set(replaced.toString(), entry);
      context.interpositionList.push(entry);
    }
  }
}

function legacyAddress(loaded: LoadedImage, segmentIndex: number, offset: number): bigint {
  const segment = loaded.image.segments.find((candidate) => candidate.index === segmentIndex);
  if (!segment) {
    throw new LoaderError(
      "legacy_fixup_bad_segment",
      `${loaded.path} rebases segment ${segmentIndex}, which is missing`,
    );
  }
  return loaded.base + BigInt(segment.vmAddress - loaded.image.preferredBase) + BigInt(offset);
}

function legacyPreferredLow(loaded: LoadedImage): bigint {
  let low = Number.MAX_SAFE_INTEGER;
  for (const segment of loaded.image.segments) {
    if (segment.name === "__PAGEZERO" || segment.vmSize === 0) continue;
    low = Math.min(low, segment.vmAddress);
  }
  return BigInt(low);
}

function legacyPreferredHigh(loaded: LoadedImage): bigint {
  let high = 0;
  for (const segment of loaded.image.segments) {
    if (segment.name === "__PAGEZERO" || segment.vmSize === 0) continue;
    high = Math.max(high, segment.vmAddress + segment.vmSize);
  }
  return BigInt(high);
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
  const target = resolveSymbol(
    loaded,
    fixup.symbol,
    imported.ordinal,
    fixup.weak || imported.weak,
    context,
  );
  return BigInt.asUintN(64, target + fixup.addend);
}

function resolveSymbol(
  loaded: LoadedImage,
  symbol: string,
  ordinal: number,
  weak: boolean,
  context: LoadContext,
): bigint {
  let target: bigint | null = null;

  if (ordinal === 0) {
    target = lookupExport(loaded, symbol, new Set());
  } else if (ordinal === -1) {
    const main = context.order[0];
    target = main ? lookupExport(main, symbol, new Set()) : null;
  } else if (ordinal === -2 || ordinal === -3) {
    const main = context.order[0];
    target = main ? lookupFlat(main, symbol) : null;
  } else if (ordinal > 0) {
    const dependency = loaded.dependencies[ordinal - 1];
    target = dependency ? lookupExport(dependency, symbol, new Set()) : null;
  } else {
    throw new LoaderError(
      "unsupported_import_ordinal",
      `import ordinal ${ordinal} for ${symbol} is not supported`,
    );
  }

  if (target === null) {
    target = context.externalSymbols.get(symbol) ?? null;
  }
  if (target === null) {
    if (weak || ordinal === -3) return 0n;
    throw new LoaderError(
      "symbol_not_found",
      `${loaded.path} needs ${symbol} from ordinal ${ordinal}, but it is not exported`,
      { path: loaded.path, symbol, ordinal },
    );
  }
  return context.interpositions.get(target.toString())?.replacement ?? target;
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

/** Resolve a symbol from one image and its reexports (dlsym semantics). */
export function resolveImageExport(image: LoadedImage, name: string): bigint | null {
  return lookupExport(image, name, new Set());
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
