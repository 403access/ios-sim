/**
 * dyld environment variables and dependency closure (LDR-009).
 *
 * Supported: DYLD_LIBRARY_PATH, DYLD_FRAMEWORK_PATH, DYLD_FALLBACK_LIBRARY_PATH,
 * DYLD_INSERT_LIBRARIES, DYLD_PRINT_LIBRARIES, DYLD_BIND_AT_LAUNCH, and
 * DYLD_IMAGE_SUFFIX. Unknown DYLD_* variables are reported, not silently used.
 */

export interface DyldEnvironment {
  readonly libraryPaths: readonly string[];
  readonly frameworkPaths: readonly string[];
  readonly fallbackLibraryPaths: readonly string[];
  readonly insertLibraries: readonly string[];
  readonly printLibraries: boolean;
  readonly bindAtLaunch: boolean;
  readonly imageSuffix: string | null;
  readonly warnings: readonly string[];
}

export interface ClosureImage {
  readonly path: string;
  readonly base: bigint;
  readonly dependencies: readonly string[];
}

export function parseDyldEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): DyldEnvironment {
  const warnings: string[] = [];
  const paths = (name: string): string[] =>
    (env[name] ?? "")
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  const flag = (name: string): boolean => /^(1|yes|true|on)$/i.test(env[name] ?? "");
  const known = new Set([
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_PRINT_LIBRARIES",
    "DYLD_BIND_AT_LAUNCH",
    "DYLD_IMAGE_SUFFIX",
  ]);
  for (const key of Object.keys(env)) {
    if (key.startsWith("DYLD_") && !known.has(key)) warnings.push(`ignored ${key}`);
  }
  const suffix = env.DYLD_IMAGE_SUFFIX?.trim();
  return {
    libraryPaths: paths("DYLD_LIBRARY_PATH"),
    frameworkPaths: paths("DYLD_FRAMEWORK_PATH"),
    fallbackLibraryPaths: paths("DYLD_FALLBACK_LIBRARY_PATH"),
    insertLibraries: paths("DYLD_INSERT_LIBRARIES"),
    printLibraries: flag("DYLD_PRINT_LIBRARIES"),
    bindAtLaunch: flag("DYLD_BIND_AT_LAUNCH"),
    imageSuffix: suffix && suffix.length > 0 ? suffix : null,
    warnings,
  };
}

/** Ordered image closure exactly as the loader mapped it. */
export function dependencyClosure(program: {
  readonly images: readonly {
    path: string;
    base: bigint;
    dependencies: readonly ({ path: string } | null)[];
  }[];
}): ClosureImage[] {
  return program.images.map((image) => ({
    path: image.path,
    base: image.base,
    dependencies: image.dependencies
      .filter((dependency): dependency is { path: string } => dependency !== null)
      .map((dependency) => dependency.path),
  }));
}

export function closureMatches(program: Parameters<typeof dependencyClosure>[0]): boolean {
  const expected = program.images.map((image) => image.path);
  return (
    dependencyClosure(program).every((image, index) => image.path === expected[index]) &&
    new Set(expected).size === expected.length
  );
}
