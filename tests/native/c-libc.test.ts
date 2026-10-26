import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CaptureSink, DarwinRuntime } from "@ios-sim/darwin-compat";

const root = mkdtempSync(join(tmpdir(), "darwin-c-libc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasClang = spawnSync("clang", ["--version"], { encoding: "utf8" }).status === 0;
const available = process.platform === "darwin" && hasClang;
if (!available) {
  console.warn(
    `skip freestanding C libc fixture: platform=${process.platform}, clang=${hasClang ? "present" : "missing"}; ` +
      "generated guest-libc tests still cover malloc/mem/str helpers",
  );
}

describe.skipIf(!available)("freestanding C guest-libc fixture", () => {
  it("runs malloc/memcpy/strlen/write through the guest kernel", () => {
    const binary = join(root, "hello");
    const build = spawnSync(
      "clang",
      [
        "-target",
        "arm64-apple-macos13",
        "-nostdlib",
        "-static",
        "-fno-builtin",
        "-Wl,-e,__start",
        "-o",
        binary,
        join(import.meta.dirname, "../../fixtures/darwin-libc/hello.c"),
      ],
      { encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    const out = new CaptureSink();
    const result = new DarwinRuntime({ rootDir: root }).run(binary, { stdout: out });
    expect(result.exitStatus).toBe(0);
    expect(out.text()).toBe("hello from a freestanding C fixture\n");
  });
});
