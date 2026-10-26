import { describe, expect, it } from "vitest";
import { assertCompatibleVersion, assertExactVersion, checkVersionPolicy } from "./version.js";

describe("version policy", () => {
  it("allows patch drift but rejects major/minor drift", () => {
    expect(() => assertCompatibleVersion("runtime", "0.1.0", "0.1.9")).not.toThrow();
    expect(() => assertCompatibleVersion("runtime", "0.1.0", "0.2.0")).toThrow(/major\/minor/);
    expect(() => assertCompatibleVersion("runtime", "0.1.0", "1.1.0")).toThrow(/major\/minor/);
    expect(() => assertCompatibleVersion("runtime", "0.1.0", "nope")).toThrow(/semantic/);
  });

  it("treats schema and ABI versions as exact", () => {
    expect(() => assertExactVersion("host ABI", 1, 1)).not.toThrow();
    expect(() => assertExactVersion("host ABI", 1, 2)).toThrow(/does not match/);
    expect(() => checkVersionPolicy({ component: "events", expected: 1, actual: 2 })).toThrow(
      /version_mismatch|does not match/,
    );
    expect(() =>
      checkVersionPolicy({ component: "runtime", expected: "0.1.0", actual: "0.1.3" }),
    ).not.toThrow();
  });

  it("reports expected and actual values in the error details", () => {
    try {
      assertExactVersion("capability schema", 1, 3);
      throw new Error("expected mismatch");
    } catch (error) {
      expect(error).toMatchObject({
        code: "version_mismatch",
        details: { component: "capability schema", expected: 1, actual: 3 },
      });
    }
  });
});
