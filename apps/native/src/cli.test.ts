import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDemoProgram, buildSyntheticSharedCache } from "@ios-sim/darwin-compat";
import { main, type CliIo } from "./cli.js";

const roots: string[] = [];

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), "ios-sim-native-cli-"));
  roots.push(directory);
  return directory;
}

function capture(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ios-sim-native CLI", () => {
  it("prints a doctor report without claiming a simulator", async () => {
    const io = capture();
    const code = await main(["doctor", "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.out.join(""));
    expect(report.service).toBe("ios-sim-native");
    expect(report.schemaVersion).toBe(1);
    expect(report.simulator).toBe(false);
    expect(report.features.length).toBeGreaterThan(15);
    expect(
      report.features.find((entry: { id: string }) => entry.id === "apple.simulator").state,
    ).toBe("no");
    expect(report.blocked.map((entry: { detail: string }) => entry.detail).join(" ")).toMatch(
      /Apple runtime|Metal|CoreSimulator/,
    );
  });

  it("runs the built-in demo and propagates the exit status", async () => {
    const io = capture();
    const code = await main(["demo", "--json"], io);
    expect(code).toBe(42);
    const result = JSON.parse(io.out.join(""));
    expect(result.stdout).toBe("hello from darwin\n");
    expect(result.exitStatus).toBe(42);
    expect(result.images).toHaveLength(1);
  });

  it("inspects and runs a generated Mach-O file", async () => {
    const directory = temp();
    const file = join(directory, "demo");
    writeFileSync(file, buildDemoProgram().bytes);

    const inspectIo = capture();
    expect(await main(["inspect", file, "--json"], inspectIo)).toBe(0);
    const report = JSON.parse(inspectIo.out.join(""));
    expect(report.architecture).toBe("arm64");
    expect(report.segments.map((segment: { name: string }) => segment.name)).toContain("__TEXT");

    const disasmIo = capture();
    expect(await main(["inspect", file, "--disasm"], disasmIo)).toBe(0);
    expect(disasmIo.out.join("")).toContain("svc #128");
    expect(disasmIo.out.join("")).toContain("movz");

    const runIo = capture();
    expect(await main(["run", file, "--json"], runIo)).toBe(42);
    const run = JSON.parse(runIo.out.join(""));
    expect(run.stdout).toBe("hello from darwin\n");

    const statsIo = capture();
    expect(await main(["stats", file, "--json"], statsIo)).toBe(0);
    const stats = JSON.parse(statsIo.out.join(""));
    expect(stats.processesStarted).toBe(1);
    expect(stats.processesExited).toBe(1);
    expect(stats.instructions).toBeGreaterThan(5);
  });

  it("inspects a synthetic shared cache", async () => {
    const directory = temp();
    const file = join(directory, "cache");
    writeFileSync(file, buildSyntheticSharedCache());
    const io = capture();
    expect(await main(["cache", file, "--json"], io)).toBe(0);
    const cache = JSON.parse(io.out.join(""));
    expect(cache.magic).toBe("dyld_v1  arm64e");
    expect(cache.images[0].path).toBe("/usr/lib/libSystem0.dylib");
  });

  it("reports missing bootstrap services", async () => {
    const directory = temp();
    const file = join(directory, "demo");
    writeFileSync(file, buildDemoProgram().bytes);
    const io = capture();
    expect(await main(["boot", file, "--service", "com.example.absent", "--json"], io)).toBe(1);
    const report = JSON.parse(io.out.join(""));
    expect(report.ok).toBe(false);
    expect(report.missingServices[0].service).toBe("com.example.absent");

    const ok = capture();
    expect(await main(["boot", file, "--json"], ok)).toBe(0);
    expect(JSON.parse(ok.out.join("")).ok).toBe(true);
  });

  it("emits traces and explains loader outcomes", async () => {
    const directory = temp();
    const file = join(directory, "demo");
    writeFileSync(file, buildDemoProgram().bytes);

    const traceIo = capture();
    expect(await main(["trace", file, "--chrome"], traceIo)).toBe(42);
    const trace = JSON.parse(traceIo.out.join(""));
    expect(trace.traceEvents.length).toBeGreaterThan(0);

    const filteredIo = capture();
    expect(await main(["trace", file, "--type", "process.*", "--chrome"], filteredIo)).toBe(42);
    const filtered = JSON.parse(filteredIo.out.join(""));
    expect(filtered.traceEvents.every((event: { name: string }) => event.name === "process")).toBe(
      true,
    );

    const whyIo = capture();
    expect(await main(["why", file, "--json"], whyIo)).toBe(0);
    const why = JSON.parse(whyIo.out.join(""));
    expect(why.diagnostic).toBeNull();
    expect(why.boot.ok).toBe(true);

    const missingIo = capture();
    expect(await main(["why", "/definitely/not/here"], missingIo)).toBe(1);
    expect(missingIo.err.join("")).toContain("file_not_found");
  });

  it("returns a failure for a missing file", async () => {
    const io = capture();
    expect(await main(["inspect", "/definitely/not/here"], io)).toBe(1);
    expect(io.err.join("")).toMatch(/ENOENT|no such file/i);
  });

  it("prints help and version through the injected IO", async () => {
    const io = capture();
    expect(await main(["--help"], io)).toBe(0);
    expect(io.out.join("")).toMatch(/inspect/);
    const versionIo = capture();
    expect(await main(["--version"], versionIo)).toBe(0);
    expect(versionIo.out.join("")).toMatch(/0\.1\.0/);
  });
});
