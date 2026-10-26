import { describe, expect, it } from "vitest";
import { buildMachO } from "../macho/build.js";
import { MapFileProvider } from "../dyld/loader.js";
import { DarwinRuntime } from "../runtime/process.js";
import { formatFault } from "./fault.js";

function invalidProgram() {
  return buildMachO({
    text: Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
  }).bytes;
}

describe("fault diagnostics", () => {
  it("captures pc, encoding, disassembly, registers, and maps", () => {
    const runtime = new DarwinRuntime({
      provider: new MapFileProvider(new Map([["/bad", invalidProgram()]])),
    });
    try {
      runtime.run("/bad");
      throw new Error("expected a fault");
    } catch (error) {
      const details = (error as { details?: { fault?: Record<string, unknown> } }).details;
      expect(details?.fault).toMatchObject({
        pc: "0x100001000",
        instruction: "ffffffff",
        disassembly: ".word 0xffffffff",
        images: ["/bad"],
      });
      expect(details?.fault?.registers).toBeTruthy();
      const maps = details?.fault?.maps as Array<{ tag: string }>;
      expect(maps.some((map) => map.tag === "__TEXT")).toBe(true);
      expect(formatFault(details?.fault as never)).toContain("instruction: ffffffff");
    }
  });

  it("attaches a fault to instruction-limit failures", () => {
    const runtime = new DarwinRuntime({
      provider: new MapFileProvider(
        new Map([["/loop", buildMachO({ text: Uint8Array.from([0x00, 0x00, 0x00, 0x14]) }).bytes]]),
      ),
    });
    try {
      runtime.run("/loop", { maxInstructions: 4 });
      throw new Error("expected the limit");
    } catch (error) {
      expect(error).toMatchObject({ code: "instruction_limit" });
      const fault = (error as { details?: { fault?: { pc?: string } } }).details?.fault;
      expect(fault?.pc).toMatch(/^0x/);
    }
  });
});
