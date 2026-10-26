/**
 * `ios-sim-native window` launcher for the native UIKitLite X11 window.
 *
 * This spawns a real native process. There is no web view, no HTML, and no
 * browser. The C program implements the UIKit-compatible object model and
 * renders through X11 (XWayland on Wayland desktops).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompatError } from "@ios-sim/darwin-compat";

export interface NativeWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly title: string;
  readonly build: boolean;
}

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "../../..");

export function nativeWindowBinaryPath(): string {
  return process.env.UIKIT_WINDOW_BIN
    ? resolve(process.env.UIKIT_WINDOW_BIN)
    : resolve(REPOSITORY_ROOT, "packages/uikit-native/build/uikit-window");
}

export function nativeWindowArguments(options: NativeWindowOptions): string[] {
  if (!Number.isInteger(options.width) || options.width < 1 || options.width > 16384) {
    throw new CompatError("window_bad_width", `width ${options.width} is outside 1..16384`);
  }
  if (!Number.isInteger(options.height) || options.height < 1 || options.height > 16384) {
    throw new CompatError("window_bad_height", `height ${options.height} is outside 1..16384`);
  }
  if (!/^#?[0-9a-fA-F]{6}$/.test(options.color)) {
    throw new CompatError("window_bad_color", `color ${options.color} is not RRGGBB`);
  }
  if (options.title.length === 0 || options.title.length > 127) {
    throw new CompatError("window_bad_title", "title must be 1..127 characters");
  }
  return [
    "--width",
    String(options.width),
    "--height",
    String(options.height),
    "--color",
    options.color,
    "--title",
    options.title,
  ];
}

export async function runNativeWindow(options: NativeWindowOptions): Promise<number> {
  if (process.platform === "win32") {
    throw new CompatError("window_unsupported", "UIKitLite currently targets X11 on Linux/macOS");
  }
  const binary = nativeWindowBinaryPath();
  if (!existsSync(binary)) {
    if (!options.build) {
      throw new CompatError(
        "window_not_built",
        `native window helper is missing at ${binary}; run 'bun run build:uikit' or omit --no-build`,
      );
    }
    const build = spawnSync("bash", [resolve(REPOSITORY_ROOT, "scripts/build-uikit-native.sh")], {
      stdio: "inherit",
      cwd: REPOSITORY_ROOT,
    });
    if (build.status !== 0) {
      throw new CompatError(
        "window_build_failed",
        `native window build failed with status ${build.status ?? "signal"}`,
      );
    }
  }
  if (!existsSync(binary)) {
    throw new CompatError("window_not_built", `native window helper was not produced at ${binary}`);
  }

  const args = nativeWindowArguments(options);
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: "inherit", env: process.env });
    child.once("error", (error) => reject(new CompatError("window_spawn_failed", error.message)));
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}
