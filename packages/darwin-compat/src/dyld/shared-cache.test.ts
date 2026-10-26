import { describe, expect, it } from "vitest";
import { buildHello } from "../testing/fixtures.js";
import {
  applyCacheSlide,
  buildSyntheticCacheWithImage,
  cacheImageBytes,
  cacheSymbol,
  buildSyntheticSharedCache,
  imageAtAddress,
  imageForPath,
  imagesForSubCache,
  parseSharedCache,
  SharedCacheError,
  subCacheForAddress,
} from "./shared-cache.js";

describe("dyld shared cache parser", () => {
  it("reads mappings, images, and sub-caches from a synthetic cache", () => {
    const bytes = buildSyntheticSharedCache({
      images: [
        { address: 0x180001000n, modTime: 1n, inode: 2n },
        { address: 0x180002000n, modTime: 3n, inode: 4n },
      ],
      imagePaths: ["/usr/lib/libSystem.B.dylib", "/usr/lib/libobjc.A.dylib"],
      subCaches: [{ uuid: "00112233-4455-6677-8899-aabbccddeeff", cacheVMOffset: 0x1000n }],
    });
    const cache = parseSharedCache(bytes);
    expect(cache.magic).toBe("dyld_v1  arm64e");
    expect(cache.mappings).toHaveLength(1);
    expect(cache.mappings[0]).toMatchObject({ address: 0x180000000n, size: 0x4000n });
    expect(cache.images.map((image) => image.path)).toEqual([
      "/usr/lib/libSystem.B.dylib",
      "/usr/lib/libobjc.A.dylib",
    ]);
    expect(cache.subCaches).toEqual([
      { uuid: "00112233-4455-6677-8899-aabbccddeeff", cacheVMOffset: 0x1000n },
    ]);
    expect(cache.sharedRegionStart).toBe(0x180000000n);
    expect(cache.maxSlide).toBe(0x1_0000_0000n);
  });

  it("rejects wrong magic, truncation, and implausible counts", () => {
    expect(() => parseSharedCache(new Uint8Array(8))).toThrow(SharedCacheError);
    expect(() => parseSharedCache(new Uint8Array(72))).toThrow(/magic/);
    const badMagic = buildSyntheticSharedCache({ magic: "not a cache" });
    expect(() => parseSharedCache(badMagic)).toThrow(/expected dyld_v1/);
    const truncated = buildSyntheticSharedCache().subarray(0, 32);
    expect(() => parseSharedCache(truncated)).toThrow(/cache is|truncated/);
    const many = buildSyntheticSharedCache();
    new DataView(many.buffer).setUint32(20, 999_999, true);
    expect(() => parseSharedCache(many)).toThrow(/implausible/);
  });

  it("rejects out-of-bounds and unterminated image paths", () => {
    const bytes = buildSyntheticSharedCache();
    const view = new DataView(bytes.buffer);
    const imagesOffset = view.getUint32(24, true);
    view.setUint32(imagesOffset + 24, bytes.length + 100, true);
    expect(() => parseSharedCache(bytes)).toThrow(/outside/);
    const noNul = buildSyntheticSharedCache({ imagePaths: ["/x"] });
    const last = noNul.length - 1;
    noNul[last] = 65;
    expect(() => parseSharedCache(noNul)).toThrow(/unterminated/);
    expect(() =>
      buildSyntheticSharedCache({ subCaches: [{ uuid: "nope", cacheVMOffset: 0n }] }),
    ).toThrow(/invalid UUID/);
  });
});

describe("cache slide and sub-cache resolution", () => {
  it("applies a valid slide and rejects invalid ones", () => {
    const cache = parseSharedCache(buildSyntheticSharedCache());
    const slid = applyCacheSlide(cache, 0x2000n);
    expect(slid.mappings[0]?.address).toBe(0x180002000n);
    expect(slid.images[0]?.address).toBe(0x180003000n);
    expect(() => applyCacheSlide(cache, 0x1_0000_0001n)).toThrow(/exceeds/);
    expect(() => applyCacheSlide(cache, 0x100n)).toThrow(/page-aligned/);
  });

  it("resolves images, paths, and sub-cache membership", () => {
    const cache = parseSharedCache(
      buildSyntheticSharedCache({
        images: [
          { address: 0x1000n, modTime: 0n, inode: 1n },
          { address: 0x9000n, modTime: 0n, inode: 2n },
          { address: 0x11000n, modTime: 0n, inode: 3n },
        ],
        imagePaths: ["/a", "/b", "/c"],
        subCaches: [
          { uuid: "00000000-0000-0000-0000-000000000001", cacheVMOffset: 0n },
          { uuid: "00000000-0000-0000-0000-000000000002", cacheVMOffset: 0x8000n },
        ],
      }),
    );
    expect(imageAtAddress(cache, 0x9000n)?.path).toBe("/b");
    expect(imageForPath(cache, "/c")?.address).toBe(0x11000n);
    expect(imageAtAddress(cache, 0x42n)).toBeNull();
    expect(subCacheForAddress(cache, 0x9000n)?.cacheVMOffset).toBe(0x8000n);
    const second = cache.subCaches[1]!;
    expect(imagesForSubCache(cache, second).map((image) => image.path)).toEqual(["/b", "/c"]);
  });
});

describe("cache image extraction and symbols", () => {
  it("extracts an embedded Mach-O and resolves its exports", () => {
    const macho = buildHello().bytes;
    const bytes = buildSyntheticCacheWithImage("/usr/lib/libfixture.dylib", macho);
    const cache = parseSharedCache(bytes);
    const extracted = cacheImageBytes(cache, bytes, "/usr/lib/libfixture.dylib");
    expect(extracted.macho.header.magic).toBe(0xfeedfacf);
    expect(cacheSymbol(cache, bytes, "/usr/lib/libfixture.dylib", "_start")).toBe(0x180002000n);
    expect(cacheSymbol(cache, bytes, "/usr/lib/libfixture.dylib", "_missing")).toBeNull();
    expect(imageForPath(cache, "/usr/lib/libfixture.dylib")?.address).toBe(0x180001000n);
  });

  it("rejects missing images, unmapped addresses, and malformed Mach-O", () => {
    const bytes = buildSyntheticCacheWithImage("/a", buildHello().bytes);
    const cache = parseSharedCache(bytes);
    expect(() => cacheImageBytes(cache, bytes, "/missing")).toThrow(/no image/);
    const unmapped = { ...cache, mappings: [] };
    expect(() => cacheImageBytes(unmapped, bytes, "/a")).toThrow(/not mapped/);
    const bad = buildSyntheticCacheWithImage("/bad", Uint8Array.from([1, 2, 3, 4]));
    expect(() => cacheImageBytes(parseSharedCache(bad), bad, "/bad")).toThrow();
  });
});
