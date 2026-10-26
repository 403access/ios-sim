/**
 * Foundation-style files, URLs, JSON, and plists (RT-007).
 *
 * Paths are resolved inside an explicit jail root; absolute guest paths are
 * rooted, `..` escapes are rejected. JSON and plist helpers round-trip through
 * the repository's bounded plist parser.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FoundationError } from "./collections.js";
import { parsePlist, type PlistValue } from "../plist/parse.js";

export class NSURL {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static fileURLWithPath(path: string): NSURL {
    return new NSURL(path);
  }

  absoluteString(): string {
    return `file://${this.path}`;
  }

  lastPathComponent(): string {
    return this.path.replace(/\/+$/, "").split("/").pop() ?? "";
  }

  appendingPathComponent(component: string): NSURL {
    return new NSURL(join(this.path, component));
  }
}

export class FoundationFileSystem {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  readText(path: string): string {
    return readFileSync(this.guestPath(path), "utf8");
  }

  writeText(path: string, value: string): void {
    const target = this.guestPath(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }

  readBytes(path: string): Uint8Array {
    return readFileSync(this.guestPath(path));
  }

  writeBytes(path: string, value: Uint8Array): void {
    const target = this.guestPath(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }

  exists(path: string): boolean {
    return existsSync(this.guestPath(path));
  }

  remove(path: string): void {
    rmSync(this.guestPath(path), { recursive: true, force: true });
  }

  readJSON(path: string): unknown {
    return NSJSON.parse(this.readText(path));
  }

  writeJSON(path: string, value: unknown): void {
    this.writeText(path, NSJSON.stringify(value));
  }

  readPlist(path: string): PlistValue {
    return NSPropertyList.parse(this.readText(path));
  }

  writePlist(path: string, value: PlistValue): void {
    this.writeText(path, NSPropertyList.serialize(value));
  }

  guestPath(path: string): string {
    if (path.includes("\u0000")) throw new FoundationError("bad_path", "path contains a null byte");
    const candidate = resolve(this.root, path.startsWith("/") ? path.slice(1) : path);
    const rel = relative(this.root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new FoundationError("path_escape", `path ${path} escapes ${this.root}`);
    }
    return candidate;
  }
}

export const NSJSON = {
  parse(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new FoundationError("bad_json", "JSON is not valid", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  },
  stringify(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  },
};

export const NSPropertyList = {
  parse(text: string): PlistValue {
    return parsePlist(text);
  },
  serialize(value: PlistValue): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${serializeValue(value)}</plist>\n`;
  },
};

function serializeValue(value: PlistValue): string {
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  }
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (value instanceof Uint8Array) return `<data>${Buffer.from(value).toString("base64")}</data>`;
  if (Array.isArray(value)) return `<array>${value.map(serializeValue).join("")}</array>`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .map(([key, entry]) => `<key>${escapeXml(key)}</key>${serializeValue(entry)}`)
      .join("");
    return `<dict>${entries}</dict>`;
  }
  throw new FoundationError("bad_plist", `cannot serialize ${typeof value}`);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
