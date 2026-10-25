import { describe, expect, it } from "vitest";
import { parsePlist } from "./parse.js";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.&amp;test</string>
    <key>Enabled</key><true/>
    <key>Disabled</key><false/>
    <key>Count</key><integer>42</integer>
    <key>Ratio</key><real>1.5</real>
    <key>List</key><array><string>a</string><integer>2</integer></array>
    <key>Data</key><data>AQID</data>
  </dict>
</plist>`;

describe("XML plist parser", () => {
  it("parses every supported type", () => {
    const value = parsePlist(xml);
    expect(value).toEqual({
      Label: "com.example.&test",
      Enabled: true,
      Disabled: false,
      Count: 42,
      Ratio: 1.5,
      List: ["a", 2],
      Data: Uint8Array.from([1, 2, 3]),
    });
  });

  it("supports empty containers, empty strings, and nested structures", () => {
    const value = parsePlist(
      "<plist><dict><key>a</key><dict/><key>b</key><array/><key>c</key><string/></dict></plist>",
    );
    expect(value).toEqual({ a: {}, b: [], c: "" });
  });

  it("rejects DTDs, binary plists, duplicate keys, and unknown tags", () => {
    expect(() =>
      parsePlist('<!DOCTYPE plist [<!ENTITY x "y">]><plist><string>&x;</string></plist>'),
    ).toThrow(/DOCTYPE/);
    expect(() => parsePlist("bplist00")).toThrow(/binary/);
    expect(() =>
      parsePlist(
        "<plist><dict><key>a</key><string>1</string><key>a</key><string>2</string></dict></plist>",
      ),
    ).toThrow(/duplicate/);
    expect(() => parsePlist("<plist><wat/></plist>")).toThrow(/unknown/);
  });

  it("rejects unsafe keys and malformed numbers", () => {
    expect(() =>
      parsePlist("<plist><dict><key>__proto__</key><string>x</string></dict></plist>"),
    ).toThrow(/not allowed/);
    expect(() => parsePlist("<plist><integer>1x</integer></plist>")).toThrow(/invalid integer/);
    expect(() => parsePlist("<plist><dict><key>a</key></dict></plist>")).toThrow();
  });

  it("decodes numeric character references", () => {
    expect(parsePlist("<plist><string>&#65;&#x42;</string></plist>")).toBe("AB");
  });

  it("rejects excessive nesting", () => {
    const nested = `${"<array>".repeat(70)}${"</array>".repeat(70)}`;
    expect(() => parsePlist(`<plist>${nested}</plist>`)).toThrow(/depth/);
  });
});
