/**
 * Standard benchmark set for QA-004.
 *
 * Fixtures are built once; each iteration then exercises one hot path. The
 * budgets are intentionally loose (2-5 s per case at the default iteration
 * count) so a slow CI host reports metadata instead of flaking.
 */

import { encodeXpcValue, decodeXpcValue } from "../xpc/codec.js";
import { parseMachO } from "../macho/parse.js";
import { buildMachO } from "../macho/build.js";
import { buildCodeSignature, parseCodeSignature } from "../macho/code-signature.js";
import { ImageLoader, MapFileProvider } from "../dyld/loader.js";
import { VirtualMemory } from "../dyld/vm.js";
import { GuestScheduler } from "../runtime/scheduler.js";
import { buildHello, buildHelperDylib } from "./fixtures.js";
import { ObjcRuntime } from "../objc/runtime.js";
import { NSMutableArray, NSMutableString } from "../foundation/collections.js";
import { CFRunLoop } from "../foundation/cf.js";
import { runtimeConformanceCases } from "../conformance/suite.js";
import type { BenchmarkCase } from "./benchmark.js";

export function standardBenchmarks(): BenchmarkCase[] {
  const hello = buildHello();
  const chained = buildMachO({
    text: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5]),
    data: new Uint8Array(0x4000),
    dependencies: [{ name: "/lib/libhelper.dylib" }],
    fixups: [{ kind: "bind", offset: 0, symbol: "_helper", ordinal: 1 }],
  });
  const provider = new MapFileProvider(
    new Map([
      ["/hello", hello.bytes],
      ["/lib/libhelper.dylib", buildHelperDylib().bytes],
    ]),
  );
  const signature = buildCodeSignature({
    identifier: "com.example.bench",
    entitlements: '<plist version="1.0"><dict><key>get-task-allow</key><true/></dict></plist>',
  });
  const xpcValue = {
    name: "bench",
    count: 42,
    list: [1, 2, 3, { nested: true }],
    data: Uint8Array.from([1, 2, 3, 4]),
  };

  const objc = new ObjcRuntime();
  objc.registerClass("Base");
  objc.addMethod("Base", "value", () => 1);
  objc.registerClass("Child", "Base");
  objc.addMethod("Child", "value", () => 2);
  const child = objc.allocate("Child");
  const conformance = runtimeConformanceCases();

  return [
    {
      name: "objc-dispatch",
      iterations: 50_000,
      budgetMs: 3000,
      run: () => void objc.send(child, "value"),
    },
    {
      name: "foundation-string",
      iterations: 10_000,
      budgetMs: 3000,
      run: () => {
        const text = new NSMutableString("a");
        for (let index = 0; index < 50; index += 1) text.append("b");
        text.substring(1, 20);
      },
    },
    {
      name: "foundation-array",
      iterations: 5000,
      budgetMs: 3000,
      run: () => {
        const array = new NSMutableArray<number>();
        for (let index = 0; index < 100; index += 1) array.add(index);
        array.removeAt(50);
      },
    },
    {
      name: "cf-run-loop",
      iterations: 2000,
      budgetMs: 3000,
      run: () => {
        let now = 0;
        const loop = new CFRunLoop(() => now);
        loop.schedule(0, () => {});
        now = 0;
        loop.runOnce();
      },
    },
    {
      name: "runtime-conformance",
      iterations: 20,
      budgetMs: 3000,
      run: () => {
        for (const entry of conformance) if (!entry.run()) throw new Error(entry.id);
      },
    },
    {
      name: "macho-parse",
      iterations: 2000,
      budgetMs: 3000,
      run: () => void parseMachO(hello.bytes),
    },
    {
      name: "macho-parse-chained",
      iterations: 1000,
      budgetMs: 3000,
      run: () => void parseMachO(chained.bytes),
    },
    {
      name: "loader-load",
      iterations: 300,
      budgetMs: 3000,
      run: () => void new ImageLoader({ provider }).load("/hello"),
    },
    {
      name: "signature-parse",
      iterations: 5000,
      budgetMs: 3000,
      run: () => void parseCodeSignature(signature, 0, signature.length),
    },
    {
      name: "xpc-roundtrip",
      iterations: 20000,
      budgetMs: 3000,
      run: () => void decodeXpcValue(encodeXpcValue(xpcValue)),
    },
    {
      name: "vm-map-read",
      iterations: 2000,
      budgetMs: 3000,
      run: () => {
        const memory = new VirtualMemory();
        const address = memory.allocate(0x4000, { tag: "bench" });
        memory.write(address, 8, 0x1234_5678n);
        memory.read(address, 8);
      },
    },
    {
      name: "scheduler-64-threads",
      iterations: 20,
      budgetMs: 5000,
      run: () => {
        const memory = new VirtualMemory();
        const stack = memory.allocate(0x1000, { tag: "bench-stack" });
        memory.mapFixed(0x4_0000_0000n, 0x1000, {
          bytes: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6]), // ret
          tag: "bench-text",
          protection: 7,
        });
        const scheduler = new GuestScheduler(memory, { quantum: 16 });
        for (let index = 0; index < 64; index += 1) {
          scheduler.createThread({
            entry: 0x4_0000_0000n,
            stackPointer: stack + 0xff0n,
            label: `bench-${index}`,
          });
        }
        scheduler.run({ maxInstructions: 10_000, syscallHandler: () => ({ value: 0 }) });
      },
    },
  ];
}
