import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DarwinRuntime } from "@ios-sim/darwin-compat";

const root = mkdtempSync(join(tmpdir(), "darwin-clang-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasClang = spawnSync("clang", ["--version"], { encoding: "utf8" }).status === 0;
const available = process.platform === "darwin" && hasClang;
if (!available) {
  console.warn(
    `skip native clang Mach-O test: platform=${process.platform}, clang=${hasClang ? "present" : "missing"}; ` +
      "the hermetic generated-Mach-O tests still run everywhere",
  );
}

describe.skipIf(!available)("real clang Mach-O integration", () => {
  it("builds a static arm64 Mach-O and runs it through the layer", () => {
    const source = join(import.meta.dirname, "../../fixtures/darwin-hello/hello.s");
    const binary = join(root, "hello");
    const build = spawnSync(
      "clang",
      [
        "-target",
        "arm64-apple-macos13",
        "-nostdlib",
        "-static",
        "-Wl,-e,_start",
        "-o",
        binary,
        source,
      ],
      { encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    const result = new DarwinRuntime({ rootDir: root }).run(binary);
    expect(result.exitStatus).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("hello from a real Mach-O\n");
    expect(result.program.images).toHaveLength(1);
  });
});
