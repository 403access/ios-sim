/**
 * Minimal `.app` bundle reader.
 *
 * It does not unpack, sign, or execute an Apple app: it reads a directory's
 * `Info.plist`, finds `CFBundleExecutable`, and reports the metadata a launcher
 * needs. The executable path is confined to the bundle, so a crafted plist
 * cannot point outside it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { CompatError, PlistError } from "../errors.js";
import { parsePlist, type PlistValue } from "../plist/parse.js";

export class AppBundleError extends CompatError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AppBundleError";
  }
}

export interface AppBundle {
  /** Absolute directory of the bundle. */
  readonly bundlePath: string;
  /** Absolute path of `CFBundleExecutable` inside the bundle. */
  readonly executable: string;
  readonly identifier: string | null;
  readonly name: string | null;
  readonly version: string | null;
  readonly minimumOS: string | null;
}

/** Read a `.app` directory's metadata without executing anything. */
export function readAppBundle(path: string): AppBundle {
  const bundlePath = resolve(path);
  let stats;
  try {
    stats = statSync(bundlePath);
  } catch {
    throw new AppBundleError("bundle_not_found", `${path} does not exist`);
  }
  if (!stats.isDirectory()) {
    throw new AppBundleError("not_a_directory", `${path} is not an app bundle directory`);
  }
  const infoPath = join(bundlePath, "Info.plist");
  if (!existsSync(infoPath)) {
    throw new AppBundleError("missing_info_plist", `${bundlePath} has no Info.plist`);
  }
  let info: PlistValue;
  try {
    info = parsePlist(readFileSync(infoPath));
  } catch (error) {
    if (error instanceof PlistError) throw error;
    throw new AppBundleError(
      "invalid_info_plist",
      `${infoPath} could not be parsed: ${(error as Error).message}`,
    );
  }
  if (!isDictionary(info)) {
    throw new AppBundleError("invalid_info_plist", `${infoPath} is not a dictionary`);
  }
  const executableName = stringValue(info, "CFBundleExecutable");
  if (executableName === null) {
    throw new AppBundleError("missing_executable", `${infoPath} has no CFBundleExecutable`);
  }
  if (
    executableName.length === 0 ||
    executableName.includes("/") ||
    executableName.includes("\\") ||
    executableName === ".." ||
    executableName === "."
  ) {
    throw new AppBundleError(
      "invalid_executable",
      `CFBundleExecutable ${JSON.stringify(executableName)} must be a plain file name`,
    );
  }
  const executable = join(bundlePath, executableName);
  if (!executable.startsWith(bundlePath + sep)) {
    throw new AppBundleError("invalid_executable", "CFBundleExecutable escapes the bundle");
  }
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new AppBundleError("executable_not_found", `${executable} is missing`);
  }
  return {
    bundlePath,
    executable,
    identifier: stringValue(info, "CFBundleIdentifier"),
    name: stringValue(info, "CFBundleName") ?? stringValue(info, "CFBundleDisplayName"),
    version: stringValue(info, "CFBundleShortVersionString"),
    minimumOS: stringValue(info, "MinimumOSVersion"),
  };
}

/** True when the path is a directory, so the CLI can treat it as a bundle. */
export function isAppBundlePath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Suggested display label for logs: the identifier, else the folder name. */
export function appBundleLabel(bundle: AppBundle): string {
  return bundle.identifier ?? basename(bundle.bundlePath);
}

function isDictionary(value: PlistValue): value is { [key: string]: PlistValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(dictionary: { [key: string]: PlistValue }, key: string): string | null {
  const value = dictionary[key];
  return typeof value === "string" ? value : null;
}
