import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FoundationError } from "./collections.js";
import { FoundationFileSystem, NSJSON, NSPropertyList, NSURL } from "./data.js";

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "foundation-"));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Foundation files, URLs, JSON, and plists", () => {
  it("round-trips text, JSON, and plists inside a jail", () => {
    const files = new FoundationFileSystem(root());
    files.writeText("/notes/hello.txt", "hello");
    expect(files.readText("/notes/hello.txt")).toBe("hello");
    expect(files.exists("/notes/hello.txt")).toBe(true);
    files.writeJSON("/data/state.json", { ok: true, list: [1, 2] });
    expect(files.readJSON("/data/state.json")).toEqual({ ok: true, list: [1, 2] });
    const value = {
      Label: "com.example",
      RunAtLoad: true,
      Args: ["a", 2],
      Blob: Uint8Array.from([1, 2]),
    };
    files.writePlist("/data/job.plist", value);
    expect(files.readPlist("/data/job.plist")).toEqual(value);
  });

  it("rejects path escapes and malformed data", () => {
    const files = new FoundationFileSystem(root());
    expect(() => files.readText("../outside")).toThrow(FoundationError);
    expect(() => files.readText("a\u0000b")).toThrow(/null byte/);
    expect(() => NSJSON.parse("{nope}")).toThrow(/JSON is not valid/);
    expect(() => NSPropertyList.parse("<plist><wat/></plist>")).toThrow();
    expect(() => NSPropertyList.serialize([() => 1] as never)).toThrow(/cannot serialize/);
  });

  it("builds file URLs and appending components", () => {
    const url = NSURL.fileURLWithPath("/tmp/app");
    expect(url.absoluteString()).toBe("file:///tmp/app");
    expect(url.lastPathComponent()).toBe("app");
    expect(url.appendingPathComponent("Info.plist").path).toBe("/tmp/app/Info.plist");
  });
});
