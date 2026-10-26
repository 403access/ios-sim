import { describe, expect, it } from "vitest";
import { addImm, adrp, cbnz, ldrUnsigned, movReg, movz, svc, words } from "../arm64/assembler.js";
import { buildMachO } from "../macho/build.js";
import { ProcessRuntime } from "./process-runtime.js";

const DATA = 0x100004000;

function forkWaitProgram(): Uint8Array {
  return words(
    movz(16, 910), // fork
    svc(0x80),
    cbnz(0, 16), // parent path
    movz(0, 7), // child exits 7
    movz(16, 1),
    svc(0x80),
    movReg(9, 0), // parent: save child pid
    movReg(0, 9),
    adrp(1, DATA, 32),
    addImm(1, 1, DATA & 0xfff),
    movz(16, 911), // waitpid(child, &status)
    svc(0x80),
    adrp(9, DATA, 48),
    addImm(9, 9, DATA & 0xfff),
    ldrUnsigned(0, 9, 0, 2),
    movz(16, 1),
    svc(0x80),
  );
}

describe("ProcessRuntime", () => {
  it("execs a registered image through the guest exec syscall", () => {
    const initial = buildMachO({
      text: words(movz(0, 1), movz(16, 912), svc(0x80)),
      data: new Uint8Array(0x1000),
    });
    const replacement = buildMachO({
      text: words(movz(0, 7), movz(16, 1), svc(0x80)),
      data: new Uint8Array(0x1000),
    });
    const runtime = new ProcessRuntime({ rootDir: process.cwd() });
    const parent = runtime.create({ bytes: initial.bytes, path: "/exec" });
    const imageId = runtime.registerImage({ bytes: replacement.bytes, path: "/replacement" });
    expect(imageId).toBe(1);
    expect(runtime.run(parent.process.pid)).toBe(7);
  });

  it("forks, waits, and reaps a guest child through syscalls", () => {
    const image = buildMachO({
      text: forkWaitProgram(),
      data: new Uint8Array(0x1000),
      symbols: [{ name: "_start", value: 0x100001000 }],
    });
    const runtime = new ProcessRuntime({ rootDir: process.cwd() });
    const parent = runtime.create({ bytes: image.bytes, path: "/fork-wait" });

    expect(runtime.run(parent.process.pid)).toBe(0);
    const childPid = [...parent.process.children][0]!;
    expect(childPid).toBeGreaterThan(parent.process.pid);
    expect(runtime.table.get(childPid)?.state).toBe("running");

    expect(runtime.run(childPid)).toBe(7);
    expect(runtime.table.get(childPid)?.state).toBe("exited");
    expect(runtime.run(parent.process.pid)).toBe(7);
    expect(runtime.table.get(childPid)).toBeUndefined();
    expect(runtime.table.get(parent.process.pid)?.state).toBe("exited");
  });
});
