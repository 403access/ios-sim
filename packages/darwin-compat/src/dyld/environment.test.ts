import { describe, expect, it } from "vitest";
import { buildDependentProgram, buildHelperDylib } from "../testing/fixtures.js";
import { closureMatches, dependencyClosure, parseDyldEnvironment } from "./environment.js";
import { ImageLoader, MapFileProvider } from "./loader.js";

describe("dyld environment and closure", () => {
  it("parses paths, insert libraries, flags, suffix, and warnings", () => {
    const env = parseDyldEnvironment({
      DYLD_LIBRARY_PATH: "/opt/a:/opt/b",
      DYLD_FRAMEWORK_PATH: "/Frameworks",
      DYLD_FALLBACK_LIBRARY_PATH: "/usr/lib",
      DYLD_INSERT_LIBRARIES: "/lib/inject.dylib",
      DYLD_PRINT_LIBRARIES: "YES",
      DYLD_BIND_AT_LAUNCH: "1",
      DYLD_IMAGE_SUFFIX: "_debug",
      DYLD_UNKNOWN_THING: "1",
    });
    expect(env.libraryPaths).toEqual(["/opt/a", "/opt/b"]);
    expect(env.frameworkPaths).toEqual(["/Frameworks"]);
    expect(env.insertLibraries).toEqual(["/lib/inject.dylib"]);
    expect(env.printLibraries).toBe(true);
    expect(env.bindAtLaunch).toBe(true);
    expect(env.imageSuffix).toBe("_debug");
    expect(env.warnings).toEqual(["ignored DYLD_UNKNOWN_THING"]);
  });

  it("uses DYLD_LIBRARY_PATH for dependency lookup", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/hello", buildDependentProgram().bytes],
        ["/opt/helper/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    );
    const env = parseDyldEnvironment({ DYLD_LIBRARY_PATH: "/opt/helper" });
    const program = new ImageLoader({ provider, searchPaths: env.libraryPaths }).load("/hello");
    expect(program.images.map((image) => image.path)).toEqual([
      "/hello",
      "/opt/helper/libhelper.dylib",
    ]);
    expect(program.images[1]?.exports.has("_helper")).toBe(true);
  });

  it("preloads inserted libraries and reports the ordered closure", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/hello", buildDependentProgram().bytes],
        ["/lib/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    );
    const printed: string[] = [];
    const program = new ImageLoader({
      provider,
      insertLibraries: ["/lib/libhelper.dylib"],
      onImageLoaded: (image) => printed.push(image.path),
    }).load("/hello");
    expect(program.images.map((image) => image.path)).toEqual(["/lib/libhelper.dylib", "/hello"]);
    expect(printed).toEqual(["/lib/libhelper.dylib", "/hello"]);
    expect(closureMatches(program)).toBe(true);
    expect(dependencyClosure(program)[1]?.dependencies).toEqual(["/lib/libhelper.dylib"]);
  });
});
