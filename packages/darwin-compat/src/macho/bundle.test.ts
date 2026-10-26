import { describe, expect, it } from "vitest";
import { N_EXT, N_OSO } from "./constants.js";
import { buildMachO } from "./build.js";
import { dsymMetadata, parseBundle } from "./bundle.js";
import { parseMachO } from "./parse.js";

const UUID = Uint8Array.from([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f, 0xf0,
]);

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.bundle</string>
  <key>CFBundleExecutable</key><string>MyApp</string>
  <key>CFBundleVersion</key><string>42</string>
</dict></plist>`;

function executable(uuid = UUID) {
  return buildMachO({
    text: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]),
    uuid,
    filesetEntries: [{ vmAddress: 0x100000000, fileOffset: 0x4000, entryId: "com.apple.kernel" }],
    symbols: [
      {
        name: "/tmp/MyApp.build/foo.o",
        value: 1_700_000_000,
        sectionIndex: 0,
        type: N_OSO | N_EXT,
      },
    ],
  }).bytes;
}

describe("bundle and dSYM metadata", () => {
  it("parses Info.plist, the executable, fileset entries, and dSYM objects", () => {
    const metadata = parseBundle(
      new Map([
        ["Info.plist", new TextEncoder().encode(INFO_PLIST)],
        ["MyApp", executable()],
        ["Contents/Resources/DWARF/MyApp", executable()],
      ]),
    );
    expect(metadata.identifier).toBe("com.example.bundle");
    expect(metadata.executableName).toBe("MyApp");
    expect(metadata.version).toBe("42");
    expect(metadata.executable?.uuid).toBe("11223344-5566-7788-99aa-bbccddee0ff0");
    expect(metadata.executable?.filesetEntries).toEqual([
      { entryId: "com.apple.kernel", vmAddress: "0x100000000", fileOffset: 0x4000 },
    ]);
    expect(metadata.dsym?.uuid).toBe(metadata.executable?.uuid);
    expect(metadata.dsym?.objectFiles).toEqual([
      { path: "/tmp/MyApp.build/foo.o", mtime: 1_700_000_000 },
    ]);
    expect(metadata.warnings).toEqual([]);
  });

  it("warns when the dSYM UUID does not match", () => {
    const other = Uint8Array.from([...UUID].reverse());
    const metadata = parseBundle(
      new Map([
        ["Contents/Info.plist", new TextEncoder().encode(INFO_PLIST)],
        ["Contents/MacOS/MyApp", executable()],
        ["Contents/Resources/DWARF/MyApp", executable(other)],
      ]),
    );
    expect(metadata.bundlePath).toBe("Contents");
    expect(metadata.warnings.join(" ")).toContain("does not match");
  });

  it("extracts N_OSO debug objects from an image", () => {
    const image = parseMachO(executable()).image;
    expect(dsymMetadata(image)).toEqual({
      uuid: "11223344-5566-7788-99aa-bbccddee0ff0",
      objectFiles: [{ path: "/tmp/MyApp.build/foo.o", mtime: 1_700_000_000 }],
    });
  });

  it("reports a bundle without Info.plist instead of guessing", () => {
    const metadata = parseBundle(new Map([["MyApp", executable()]]));
    expect(metadata.identifier).toBeNull();
    expect(metadata.warnings).toContain("bundle has no Info.plist");
    expect(metadata.executable?.path).toBe("MyApp");
  });
});
