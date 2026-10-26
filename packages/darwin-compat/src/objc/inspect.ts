/**
 * Read-only Objective-C inspection for `ios-sim-native inspect --objc`.
 *
 * The image is mapped into a throwaway address space with dependencies skipped
 * and unresolved imports bound to zero, then the same metadata parser used by
 * the runtime reports classes, categories, protocols, and fixup format. This is
 * inspection only: no code runs, no process is created.
 */

import { ImageLoader, MapFileProvider } from "../dyld/loader.js";
import { VirtualMemory } from "../dyld/vm.js";
import { parseMachO } from "../macho/parse.js";
import { parseLegacyFixups } from "../macho/legacy.js";
import { parseObjcCategories, parseObjcClasses, type ObjcIvar } from "./abi.js";

export interface ObjcInspectionClass {
  readonly name: string;
  readonly superclass: string | null;
  readonly instanceSize: number;
  readonly methods: readonly string[];
  readonly classMethods: readonly string[];
  readonly ivars: readonly ObjcIvar[];
  readonly protocols: readonly string[];
}

export interface ObjcInspectionCategory {
  readonly name: string;
  readonly target: string | null;
  readonly methods: readonly string[];
  readonly protocols: readonly string[];
}

export interface ObjcInspection {
  readonly fixups: "chained" | "legacy" | "none";
  readonly classes: readonly ObjcInspectionClass[];
  readonly categories: readonly ObjcInspectionCategory[];
  readonly protocols: readonly string[];
}

export function inspectObjc(bytes: Uint8Array, path: string): ObjcInspection {
  const parsedHeader = parseMachO(bytes).image;
  const slice = bytes.subarray(
    parsedHeader.sliceOffset,
    parsedHeader.sliceOffset + parsedHeader.byteLength,
  );
  const { symbols, namesByAddress } = classSymbols(parsedHeader, slice);
  const memory = new VirtualMemory();
  const loader = new ImageLoader({
    provider: new MapFileProvider(new Map([[path, bytes]])),
    memory,
    skipDependencies: true,
    missingSymbols: "zero",
    externalSymbols: symbols,
  });
  const program = loader.load(path);
  const parsed = program.images.flatMap((image) => parseObjcClasses(memory, image));
  const names = new Map<bigint, string>(namesByAddress);
  for (const klass of parsed) names.set(klass.address, klass.name);

  const categories = program.images.flatMap((image) => parseObjcCategories(memory, image));
  const protocols = new Set<string>();
  for (const klass of parsed) {
    for (const protocol of klass.protocols) protocols.add(protocol);
  }
  for (const category of categories) {
    for (const protocol of category.protocols) protocols.add(protocol);
  }

  const main = program.main.image;
  const fixups = main.chainedFixups
    ? "chained"
    : main.dyldInfo &&
        (main.dyldInfo.rebaseSize > 0 ||
          main.dyldInfo.bindSize > 0 ||
          main.dyldInfo.lazyBindSize > 0 ||
          main.dyldInfo.weakBindSize > 0)
      ? "legacy"
      : "none";

  return {
    fixups,
    classes: parsed.map((klass) => ({
      name: klass.name,
      superclass: names.get(klass.superclass) ?? null,
      instanceSize: klass.instanceSize,
      methods: [...klass.methods.keys()].sort(),
      classMethods: [...klass.classMethods.keys()].sort(),
      ivars: klass.ivars,
      protocols: klass.protocols,
    })),
    categories: categories.map((category) => ({
      name: category.name,
      target: names.get(category.classAddress) ?? null,
      methods: [...category.methods.keys()].sort(),
      protocols: category.protocols,
    })),
    protocols: [...protocols].sort(),
  };
}

/**
 * Inspection binds external class references to synthetic addresses so a
 * superclass or protocol name survives even when its framework is absent.
 */
function classSymbols(
  image: ReturnType<typeof parseMachO>["image"],
  slice: Uint8Array,
): { symbols: Map<string, bigint>; namesByAddress: Map<bigint, string> } {
  const imported = new Set<string>();
  if (image.chainedFixups) {
    for (const entry of image.chainedFixups.imports) imported.add(entry.name);
  } else if (image.dyldInfo) {
    try {
      for (const bind of parseLegacyFixups(slice, image).binds) imported.add(bind.symbol);
    } catch {
      // Threaded binds cannot be decoded statically; names are best effort.
    }
  }
  const symbols = new Map<string, bigint>();
  const namesByAddress = new Map<bigint, string>();
  let next = 0x7_0000_0000n;
  for (const name of [...imported].sort()) {
    if (
      name.startsWith("_OBJC_CLASS_$_") ||
      name.startsWith("_OBJC_METACLASS_$_") ||
      name.startsWith("_OBJC_PROTOCOL_$_")
    ) {
      symbols.set(name, next);
      namesByAddress.set(next, name.split("$_").at(-1) ?? name);
      next += 8n;
    }
  }
  return { symbols, namesByAddress };
}

export function formatObjcInspection(inspection: ObjcInspection): string {
  const lines: string[] = [`objc fixups: ${inspection.fixups}`];
  for (const klass of inspection.classes) {
    const parent = klass.superclass ? ` : ${klass.superclass}` : "";
    lines.push(`class ${klass.name}${parent} (${klass.instanceSize} bytes)`);
    if (klass.protocols.length > 0) lines.push(`  protocols: ${klass.protocols.join(", ")}`);
    if (klass.ivars.length > 0) {
      lines.push(
        `  ivars: ${klass.ivars
          .map((ivar) => `${ivar.type} ${ivar.name} @${ivar.offset}`)
          .join(", ")}`,
      );
    }
    if (klass.classMethods.length > 0)
      lines.push(`  class methods: ${klass.classMethods.join(", ")}`);
    if (klass.methods.length > 0) lines.push(`  methods: ${klass.methods.join(", ")}`);
  }
  for (const category of inspection.categories) {
    lines.push(`category ${category.name} on ${category.target ?? "unknown"}`);
    lines.push(`  methods: ${category.methods.join(", ") || "(none)"}`);
    if (category.protocols.length > 0) lines.push(`  protocols: ${category.protocols.join(", ")}`);
  }
  return lines.join("\n");
}
