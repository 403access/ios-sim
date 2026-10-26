import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureSink } from "../syscall/kernel.js";
import {
  buildDependentProgram,
  buildHello,
  buildHelperDylib,
  buildInitializerLoopProgram,
  buildInitializerProgram,
  buildInterposedProgram,
  buildInterposingDylib,
  buildCollisionDylib,
  buildCollisionProgram,
  buildLegacyDependentProgram,
  buildLegacyLazyProgram,
  buildLegacyRebaseProgram,
  buildLegacyWeakProgram,
  buildMachPingProgram,
  buildOtherDylib,
  buildDependentDylib,
  HELLO_DATA_BASE,
} from "../testing/fixtures.js";
import { MapFileProvider } from "./loader.js";
import { DynamicLoader } from "./dlopen.js";
import { DarwinRuntime } from "../runtime/process.js";
import { ImageLoader } from "./loader.js";

const roots: string[] = [];

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "darwin-compat-"));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("dyld loader and runtime", () => {
  it("loads and executes a generated arm64 executable", () => {
    const provider = new MapFileProvider(new Map([["/hello", buildHello().bytes]]));
    const loader = new ImageLoader({ provider });
    const program = loader.load("/hello");
    expect(program.entry).toBe(0x100001000n);
    expect(program.images).toHaveLength(1);
    expect(program.main.exports.get("_start")).toBe(0x100001000n);

    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    const out = new CaptureSink();
    const err = new CaptureSink();
    const result = runtime.run("/hello", { stdout: out, stderr: err });
    expect(result.exitStatus).toBe(42);
    expect(out.text()).toBe("hello from darwin\n");
    expect(err.text()).toBe("");
    expect(result.instructions).toBeGreaterThan(5);
  });

  it("binds a chained import to a dependency and calls through the pointer", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/hello", buildDependentProgram().bytes],
        ["/lib/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    );
    const loader = new ImageLoader({ provider });
    const program = loader.load("/hello");
    expect(program.images).toHaveLength(2);
    expect(program.images[1]?.path).toBe("/lib/libhelper.dylib");
    expect(program.images[1]?.base).toBe(0x2_0000_0000n);
    expect(program.stats.binds).toBe(1);
    const pointer = program.memory.read(BigInt(HELLO_DATA_BASE), 8);
    expect(pointer).toBe(program.images[1]?.exports.get("_helper"));

    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    const out = new CaptureSink();
    const result = runtime.run("/hello", { stdout: out });
    expect(result.exitStatus).toBe(7);
    expect(out.text()).toBe("helper!\n");
  });

  it("binds legacy LC_DYLD_INFO opcodes to a dependency and calls through the pointer", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/hello", buildLegacyDependentProgram().bytes],
        ["/lib/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    );
    const loader = new ImageLoader({ provider });
    const program = loader.load("/hello");
    expect(program.stats.binds).toBe(1);
    expect(program.stats.rebases).toBe(0);
    const pointer = program.memory.read(BigInt(HELLO_DATA_BASE), 8);
    expect(pointer).toBe(program.images[1]?.exports.get("_helper"));

    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    const out = new CaptureSink();
    const result = runtime.run("/hello", { stdout: out });
    expect(result.exitStatus).toBe(7);
    expect(out.text()).toBe("helper!\n");
  });

  it("slides legacy rebase pointers by the chosen image slide", () => {
    const bytes = buildLegacyRebaseProgram().bytes;
    const provider = new MapFileProvider(
      new Map([
        ["/first", bytes],
        ["/second", bytes],
      ]),
    );
    const loader = new ImageLoader({ provider });
    const first = loader.load("/first");
    const second = loader.load("/second");
    expect(first.main.slide).toBe(0n);
    expect(second.main.slide).toBe(0x1_0000_0000n);
    expect(second.stats.rebases).toBe(2);
    const firstPointer = first.memory.read(first.main.base + 0x4100n, 8);
    const secondPointer = second.memory.read(second.main.base + 0x4100n, 8);
    expect(firstPointer).toBe(first.main.base + 0x1800n);
    expect(secondPointer).toBe(second.main.base + 0x1800n);
  });

  it("defers lazy binds until the first explicit resolution", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/lazy", buildLegacyLazyProgram().bytes],
        ["/lib/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    );
    const program = new ImageLoader({ provider }).load("/lazy");
    expect(program.lazyBindings).toHaveLength(1);
    expect(program.lazyBindings[0]).toMatchObject({
      address: BigInt(HELLO_DATA_BASE),
      symbol: "_helper",
      bound: false,
    });
    expect(program.memory.read(BigInt(HELLO_DATA_BASE), 8)).toBe(0n);
    expect(program.stats.binds).toBe(0);

    expect(program.bindLazy(BigInt(HELLO_DATA_BASE))).toBe(true);
    expect(program.bindLazy(BigInt(HELLO_DATA_BASE))).toBe(false);
    expect(program.memory.read(BigInt(HELLO_DATA_BASE), 8)).toBe(
      program.images[1]?.exports.get("_helper"),
    );
    expect(program.lazyBindings[0]?.bound).toBe(true);
  });

  it("resolves weak binds flat and turns missing symbols into null", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/weak", buildLegacyWeakProgram().bytes],
        ["/lib/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    );
    const program = new ImageLoader({ provider }).load("/weak");
    expect(program.memory.read(BigInt(HELLO_DATA_BASE), 8)).toBe(
      program.images[1]?.exports.get("_helper"),
    );
    expect(program.memory.read(BigInt(HELLO_DATA_BASE) + 8n, 8)).toBe(0n);
    expect(program.stats.binds).toBe(2);
  });

  it("runs module initializers dependency-first and terminators after main", () => {
    const provider = new MapFileProvider(new Map([["/init", buildInitializerProgram().bytes]]));
    const program = new ImageLoader({ provider }).load("/init");
    expect(program.initializers).toHaveLength(2);
    expect(program.terminators).toHaveLength(1);
    expect(program.initializers[0]).toBeLessThan(program.initializers[1] ?? 0n);

    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    const out = new CaptureSink();
    const result = runtime.run("/init", { stdout: out });
    expect(result.exitStatus).toBe(0);
    expect(out.text()).toBe("init-1\ninit-2\nmain\nterm\n");
  });

  it("attributes an initializer failure to its stage", () => {
    const provider = new MapFileProvider(new Map([["/loop", buildInitializerLoopProgram().bytes]]));
    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    try {
      runtime.run("/loop", { maxInstructions: 8 });
      throw new Error("expected the initializer to hit the instruction limit");
    } catch (error) {
      expect(error).toMatchObject({
        code: "instruction_limit",
        details: { stage: "initializer" },
      });
    }
  });

  it("opens, resolves, and unloads a dylib with reference counts", () => {
    const provider = new MapFileProvider(
      new Map([["/lib/libother.dylib", buildOtherDylib().bytes]]),
    );
    const loader = new ImageLoader({ provider });
    const dynamic = new DynamicLoader(loader);
    const first = dynamic.open("/lib/libother.dylib");
    const second = dynamic.open("/lib/libother.dylib");
    expect(dynamic.refCount("/lib/libother.dylib")).toBe(2);
    expect(dynamic.symbol(first, "_other")).toBe(0x1_0000_1000n);
    expect(dynamic.symbol(first, "_missing")).toBeNull();

    expect(dynamic.close(first)).toBe(false);
    expect(dynamic.isLoaded("/lib/libother.dylib")).toBe(true);
    expect(dynamic.close(second)).toBe(true);
    expect(dynamic.isLoaded("/lib/libother.dylib")).toBe(false);
    expect(() => loader.memoryView.read(0x1_0000_1000n, 4)).toThrow(/unmapped/);
  });

  it("retains dependencies until their last dynamic reference closes", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/lib/libdependent.dylib", buildDependentDylib().bytes],
        ["/lib/libother.dylib", buildOtherDylib().bytes],
      ]),
    );
    const dynamic = new DynamicLoader(new ImageLoader({ provider }));
    const handle = dynamic.open("/lib/libdependent.dylib");
    expect(dynamic.refCount("/lib/libother.dylib")).toBe(1);
    expect(dynamic.loadedPaths()).toContain("/lib/libother.dylib");
    dynamic.close(handle);
    expect(dynamic.isLoaded("/lib/libdependent.dylib")).toBe(false);
    expect(dynamic.isLoaded("/lib/libother.dylib")).toBe(false);
  });

  it("applies __interpose replacements to bound symbols", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/interposed", buildInterposedProgram().bytes],
        ["/lib/libinterpose.dylib", buildInterposingDylib().bytes],
      ]),
    );
    const loader = new ImageLoader({ provider });
    const program = loader.load("/interposed");
    expect(program.interpositions).toHaveLength(1);
    expect(program.memory.read(BigInt(HELLO_DATA_BASE), 8)).toBe(program.images[1]!.base + 0x1008n);

    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    expect(runtime.run("/interposed").exitStatus).toBe(9);
  });

  it("resolves flat collisions in dependency load order", () => {
    const provider = new MapFileProvider(
      new Map([
        ["/collide", buildCollisionProgram().bytes],
        ["/lib/libcollide-a.dylib", buildCollisionDylib("/lib/libcollide-a.dylib", 11).bytes],
        ["/lib/libcollide-b.dylib", buildCollisionDylib("/lib/libcollide-b.dylib", 22).bytes],
      ]),
    );
    const program = new ImageLoader({ provider }).load("/collide");
    expect(program.memory.read(BigInt(HELLO_DATA_BASE), 8)).toBe(program.images[1]!.base + 0x1000n);
    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    expect(runtime.run("/collide").exitStatus).toBe(11);
  });

  it("reports a missing dependency with a stable code", () => {
    const provider = new MapFileProvider(new Map([["/hello", buildDependentProgram().bytes]]));
    expect(() => new ImageLoader({ provider }).load("/hello")).toThrow(/depends on/);
    try {
      new ImageLoader({ provider }).load("/hello");
    } catch (error) {
      expect(error).toMatchObject({ code: "dependency_not_found" });
    }
  });

  it("rejects a dylib passed as the main executable", () => {
    const provider = new MapFileProvider(
      new Map([["/lib/libhelper.dylib", buildHelperDylib().bytes]]),
    );
    expect(() => new ImageLoader({ provider }).load("/lib/libhelper.dylib")).toThrow(/MH_EXECUTE/);
  });

  it("routes a Mach message from interpreted code to a host handler", () => {
    const provider = new MapFileProvider(new Map([["/ping", buildMachPingProgram().bytes]]));
    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    let seen = 0;
    runtime.mach.setPortHandlerById(runtime.mach.bootstrapPort, (message, reply) => {
      seen += 1;
      expect(Array.from(message.body)).toEqual([0xed, 0xfe, 0x00, 0x00]);
      const body = new Uint8Array(4);
      new DataView(body.buffer).setUint32(0, 0xbeef, true);
      reply(body, { id: message.header.id });
    });
    const result = runtime.run("/ping");
    expect(seen).toBe(1);
    expect(result.exitStatus).toBe(0);
    expect(result.unsupportedSyscalls.size).toBe(0);
  });

  it("enforces the instruction budget", () => {
    const hello = buildHello();
    const provider = new MapFileProvider(new Map([["/hello", hello.bytes]]));
    const runtime = new DarwinRuntime({ provider, rootDir: root() });
    const process = runtime.createProcess({ program: "/hello", maxInstructions: 1 });
    expect(() => process.run()).toThrow(/instruction limit/);
  });
});
