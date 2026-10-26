import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppBundleError, isAppBundlePath, readAppBundle } from "./bundle.js";

const roots: string[] = [];

function makeBundle(plist: string, executable: string | null = "Demo"): string {
  const root = mkdtempSync(join(tmpdir(), "ios-sim-app-"));
  roots.push(root);
  const app = join(root, "Demo.app");
  mkdirSync(app);
  writeFileSync(join(app, "Info.plist"), plist);
  if (executable !== null) writeFileSync(join(app, executable), "not a real binary");
  return app;
}

function info(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${entries}</dict></plist>`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("app bundles", () => {
  it("reads the executable and metadata from Info.plist", () => {
    const app = makeBundle(
      info(`
        <key>CFBundleExecutable</key><string>Demo</string>
        <key>CFBundleIdentifier</key><string>dev.example.demo</string>
        <key>CFBundleName</key><string>Demo</string>
        <key>CFBundleShortVersionString</key><string>1.2</string>
      `),
    );
    const bundle = readAppBundle(app);
    expect(bundle.bundlePath).toBe(app);
    expect(bundle.executable).toBe(join(app, "Demo"));
    expect(bundle.identifier).toBe("dev.example.demo");
    expect(bundle.name).toBe("Demo");
    expect(bundle.version).toBe("1.2");
    expect(isAppBundlePath(app)).toBe(true);
  });

  it("rejects a bundle without Info.plist or an executable", () => {
    const root = mkdtempSync(join(tmpdir(), "ios-sim-app-"));
    roots.push(root);
    expect(() => readAppBundle(root)).toThrow(/Info.plist/);

    const noExecutable = makeBundle(info(""), null);
    expect(() => readAppBundle(noExecutable)).toThrow(/CFBundleExecutable/);

    const missing = makeBundle(info("<key>CFBundleExecutable</key><string>Gone</string>"), null);
    expect(() => readAppBundle(missing)).toThrow(AppBundleError);
  });

  it("refuses an executable path that escapes the bundle", () => {
    const escape = makeBundle(
      info("<key>CFBundleExecutable</key><string>../../evil</string>"),
      null,
    );
    expect(() => readAppBundle(escape)).toThrow(/plain file name/);
  });
});
