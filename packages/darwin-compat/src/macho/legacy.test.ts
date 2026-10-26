import { describe, expect, it } from "vitest";
import { MachOError } from "../errors.js";
import type { MachOImage } from "./types.js";
import { parseLegacyFixups } from "./legacy.js";

function image(info: Partial<MachOImage["dyldInfo"]> & object): MachOImage {
  return {
    dyldInfo: {
      rebaseOffset: 0,
      rebaseSize: 0,
      bindOffset: 0,
      bindSize: 0,
      weakBindOffset: 0,
      weakBindSize: 0,
      lazyBindOffset: 0,
      lazyBindSize: 0,
      exportOffset: 0,
      exportSize: 0,
      ...info,
    },
  } as unknown as MachOImage;
}

function stream(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

const ascii = (...values: string[]): number[] =>
  values.flatMap((value) => [...new TextEncoder().encode(value), 0]);

describe("legacy dyld fixups", () => {
  it("decodes rebase and bind opcodes", () => {
    const bytes = new Uint8Array(64);
    // rebase: set type 1, segment 2 offset 0, one rebase, done
    bytes.set(stream([0x11, 0x22, 0x00, 0x51, 0x00]), 0);
    // bind: ordinal 1, symbol "sym", segment 1 offset 0, bind, done
    bytes.set(stream([0x11, 0x40, ...ascii("sym"), 0x71, 0x00, 0x90, 0x00]), 8);
    const fixups = parseLegacyFixups(
      bytes,
      image({ rebaseOffset: 0, rebaseSize: 5, bindOffset: 8, bindSize: 10 }),
    );
    expect(fixups.rebases).toEqual([{ segmentIndex: 2, offset: 0 }]);
    expect(fixups.binds).toEqual([
      { segmentIndex: 1, offset: 0, symbol: "sym", ordinal: 1, addend: 0n, weak: false },
    ]);
  });

  it("decodes skipped and scaled binds", () => {
    const bytes = new Uint8Array(64);
    // ordinal 2, symbol "s", segment 1 offset 8, bind twice skipping 8,
    // then bind+advance scaled by 1, done
    bytes.set(
      stream([0x12, 0x40, ...ascii("s"), 0x71, 0x08, 0xc0, 0x02, 0x08, 0xb0, 0x01, 0x00]),
      0,
    );
    const fixups = parseLegacyFixups(bytes, image({ bindOffset: 0, bindSize: 18 }));
    expect(fixups.binds.map((bind) => bind.offset)).toEqual([8, 24, 40]);
    expect(fixups.binds[0]?.ordinal).toBe(2);
  });

  it("decodes weak and lazy bind streams", () => {
    const bytes = new Uint8Array(64);
    // weak bind: trailing flag 1, symbol "w", segment 2 offset 0, bind, done
    bytes.set(stream([0x41, ...ascii("w"), 0x72, 0x00, 0x90, 0x00]), 0);
    // lazy bind: ordinal -2, symbol "l", segment 3 offset 0, bind, done
    bytes.set(stream([0x3e, 0x40, ...ascii("l"), 0x73, 0x00, 0x90, 0x00]), 16);
    const fixups = parseLegacyFixups(
      bytes,
      image({ weakBindOffset: 0, weakBindSize: 7, lazyBindOffset: 16, lazyBindSize: 9 }),
    );
    expect(fixups.binds).toEqual([
      { segmentIndex: 2, offset: 0, symbol: "w", ordinal: 0, addend: 0n, weak: true },
      { segmentIndex: 3, offset: 0, symbol: "l", ordinal: -2, addend: 0n, weak: false },
    ]);
  });

  it("parses each lazy-bind program", () => {
    const bytes = new Uint8Array(64);
    bytes.set(
      stream([
        0x71,
        0x00,
        0x40,
        ...ascii("a"),
        0x90,
        0x00,
        0x71,
        0x08,
        0x40,
        ...ascii("b"),
        0x90,
        0x00,
      ]),
      0,
    );
    const fixups = parseLegacyFixups(bytes, image({ lazyBindOffset: 0, lazyBindSize: 16 }));
    expect(fixups.binds.map((bind) => [bind.symbol, bind.offset])).toEqual([
      ["a", 0],
      ["b", 8],
    ]);
  });

  it("rejects the threaded-bind opcode with a named error", () => {
    const bytes = new Uint8Array(8);
    bytes.set(stream([0xd0, 0x01, 0x00, 0x00, 0x00]), 0);
    try {
      parseLegacyFixups(bytes, image({ bindOffset: 0, bindSize: 5 }));
      throw new Error("expected a legacy_threaded_binds_unimplemented error");
    } catch (error) {
      expect(error).toBeInstanceOf(MachOError);
      expect((error as MachOError).code).toBe("legacy_threaded_binds_unimplemented");
    }
  });

  it("rejects a stream outside the image", () => {
    expect(() =>
      parseLegacyFixups(new Uint8Array(4), image({ bindOffset: 2, bindSize: 8 })),
    ).toThrow(/outside the image/);
  });
});
