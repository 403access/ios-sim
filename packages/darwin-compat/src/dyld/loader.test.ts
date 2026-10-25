import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureSink } from "../syscall/kernel.js";
import {
  buildDependentProgram,
  buildHello,
  buildHelperDylib,
  buildMachPingProgram,
  HELLO_DATA_BASE,
} from "../testing/fixtures.js";
import { MapFileProvider } from "./loader.js";
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
