import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Launchd, parseLaunchdManifest } from "./launchd.js";
import { MapFileProvider } from "../dyld/loader.js";
import { DarwinRuntime } from "../runtime/process.js";
import { buildExitProgram } from "../testing/fixtures.js";
import { BootstrapClient } from "../mach/bootstrap.js";

const roots: string[] = [];

function runtimeFor(files: Record<string, Uint8Array>): DarwinRuntime {
  const root = mkdtempSync(join(tmpdir(), "darwin-launchd-"));
  roots.push(root);
  return new DarwinRuntime({ provider: new MapFileProvider(files), rootDir: root });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(overrides: string, services = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.example.job</string>
<key>Program</key><string>/job</string>
<key>RunAtLoad</key><true/>
${overrides}
${services}
</dict></plist>`;
}

describe("launchd manifests", () => {
  it("parses a job with environment and MachServices", () => {
    const jobs = parseLaunchdManifest(
      manifest(
        "<key>ProgramArguments</key><array><string>/job</string><string>--flag</string></array>",
        "<key>MachServices</key><dict><key>com.example.service</key><true/></dict><key>EnvironmentVariables</key><dict><key>MODE</key><string>test</string></dict>",
      ),
      { baseDir: "/" },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      label: "com.example.job",
      program: "/job",
      args: ["--flag"],
      environment: { MODE: "test" },
      machServices: ["com.example.service"],
      runAtLoad: true,
      keepAlive: false,
    });
  });

  it("rejects invalid labels, missing programs, and bad field types", () => {
    const base = (body: string) => `<plist><dict>${body}</dict></plist>`;
    expect(() => parseLaunchdManifest(base("<key>Label</key><string>../bad</string>"))).toThrow(
      /label/,
    );
    expect(() =>
      parseLaunchdManifest(base("<key>Label</key><string>com.example</string>")),
    ).toThrow(/Program/);
    expect(() =>
      parseLaunchdManifest(
        base(
          "<key>Label</key><string>com.example</string><key>Program</key><string>/x</string><key>RunAtLoad</key><string>yes</string>",
        ),
      ),
    ).toThrow(/boolean/);
  });
});

describe("launchd boot", () => {
  it("runs RunAtLoad jobs and registers MachServices", () => {
    const runtime = runtimeFor({ "/job": buildExitProgram(0).bytes });
    const jobs = parseLaunchdManifest(
      manifest("", "<key>MachServices</key><dict><key>com.example.svc</key><true/></dict>"),
      { baseDir: "/" },
    );
    const launchd = new Launchd(runtime);
    launchd.addJobs(jobs);
    const result = launchd.boot();
    expect(result.services).toEqual(["com.example.svc"]);
    expect(result.jobs[0]).toMatchObject({
      label: "com.example.job",
      state: "succeeded",
      exitStatus: 0,
      runs: 1,
    });
    expect(result.jobs[0]?.stdout).toEqual(new Uint8Array());
    expect(launchd.status("com.example.job")?.state).toBe("succeeded");
    const client = runtime.mach.createTask(500);
    const lookup = new BootstrapClient(runtime.mach, client).lookup("com.example.svc");
    expect(lookup.status).toBe(0);
    expect(lookup.portName).toBeGreaterThan(0);
  });

  it("records a failed exit and retries KeepAlive up to the budget", () => {
    const runtime = runtimeFor({ "/job": buildExitProgram(3).bytes });
    const jobs = parseLaunchdManifest(manifest("<key>KeepAlive</key><true/>"), { baseDir: "/" });
    const launchd = new Launchd(runtime, { maxRestarts: 2 });
    launchd.addJobs(jobs);
    const result = launchd.boot();
    expect(result.jobs[0]).toMatchObject({
      state: "failed",
      exitStatus: 3,
      runs: 3,
      error: "exited with status 3",
    });
  });

  it("can start a job on demand and reject duplicates", () => {
    const runtime = runtimeFor({ "/job": buildExitProgram(0).bytes });
    const jobs = parseLaunchdManifest(manifest(""), { baseDir: "/" });
    const launchd = new Launchd(runtime);
    launchd.addJobs(jobs);
    expect(() => launchd.addJobs(jobs)).toThrow(/already registered/);
    const status = launchd.start("com.example.job");
    expect(status).toMatchObject({ state: "succeeded", runs: 1 });
    expect(launchd.listJobs()).toHaveLength(1);
    expect(() => launchd.start("missing")).toThrow(/no job/);
  });

  it("captures process output in the job status", () => {
    const runtime = runtimeFor({ "/job": buildExitProgram(0).bytes });
    const jobs = parseLaunchdManifest(manifest(""), { baseDir: "/" });
    const launchd = new Launchd(runtime);
    launchd.addJobs(jobs);
    const status = launchd.boot().jobs[0]!;
    expect(status.stdout).toBeInstanceOf(Uint8Array);
  });
});
