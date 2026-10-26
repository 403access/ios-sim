/**
 * Standard soak cases for QA-006.
 *
 * Each case creates and destroys one resource class: Mach tasks/ports, dynamic
 * images, or processes. The counters are object-table sizes and mapped bytes,
 * so a leak is visible without relying on GC timing.
 */

import { movz, svc, words } from "../arm64/assembler.js";
import { DynamicLoader } from "../dyld/dlopen.js";
import { ImageLoader, MapFileProvider } from "../dyld/loader.js";
import { VirtualMemory } from "../dyld/vm.js";
import { MachKernel } from "../mach/kernel.js";
import { ProcessTable } from "../runtime/process-table.js";
import { GuestScheduler } from "../runtime/scheduler.js";
import { buildHello, buildHelperDylib } from "./fixtures.js";
import type { SoakCase, SoakMetrics } from "./soak.js";

export function machSoakCase(): SoakCase {
  const kernel = new MachKernel();
  let pid = 1000;
  return {
    name: "mach-objects",
    step: () => {
      const task = kernel.createTask(pid++);
      kernel.insertReceiveRight(task, `soak-${pid}`);
      kernel.destroyTask(task);
    },
    sample: (): SoakMetrics => {
      const stats = kernel.stats();
      return {
        tasks: stats.tasks,
        ports: stats.ports,
        queuedMessages: stats.queuedMessages,
        services: stats.services,
      };
    },
  };
}

export function loaderSoakCase(): SoakCase {
  const loader = new ImageLoader({
    provider: new MapFileProvider(
      new Map([
        ["/hello", buildHello().bytes],
        ["/lib/libhelper.dylib", buildHelperDylib().bytes],
      ]),
    ),
  });
  return {
    name: "dynamic-loader",
    step: () => {
      const dynamic = new DynamicLoader(loader);
      const handle = dynamic.open("/lib/libhelper.dylib");
      dynamic.close(handle);
    },
    sample: (): SoakMetrics => ({
      images: loader.loadedImageCount(),
      bytes: loader.memoryView.usedBytes,
    }),
  };
}

export function processSoakCase(): SoakCase {
  const memory = new VirtualMemory();
  const stack = memory.allocate(0x2000, { tag: "root" });
  memory.mapFixed(0x4_0000_0000n, 0x1000, {
    bytes: words(movz(16, 1), svc(0x80)),
    tag: "root-text",
    protection: 7,
  });
  const scheduler = new GuestScheduler(memory);
  scheduler.createThread({ entry: 0x4_0000_0000n, stackPointer: stack + 0x1ff0n });
  const table = new ProcessTable();
  const root = table.spawn(memory, scheduler);
  return {
    name: "process-table",
    step: () => {
      const child = table.fork(root.pid);
      table.run(child.pid, {
        maxInstructions: 100,
        syscallHandler: () => ({ value: 0, halt: true }),
      });
      table.waitpid(root.pid, -1);
    },
    sample: (): SoakMetrics => ({ processes: table.list().length, children: root.children.size }),
  };
}

export function standardSoakCases(): SoakCase[] {
  return [machSoakCase(), loaderSoakCase(), processSoakCase()];
}
