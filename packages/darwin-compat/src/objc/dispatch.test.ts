import { describe, expect, it } from "vitest";
import { ObjcError, ObjcRuntime } from "./runtime.js";

function matrix() {
  const objc = new ObjcRuntime();
  objc.registerClass("A");
  objc.addMethod("A", "shared", () => "A.shared");
  objc.addMethod("A", "onlyA", () => "A.onlyA");
  objc.registerClass("B", "A");
  objc.addMethod("B", "shared", () => "B.shared");
  objc.addMethod("B", "onlyB", () => "B.onlyB");
  objc.registerClass("C", "B");
  return objc;
}

describe("message dispatch matrix", () => {
  it("resolves each receiver/selector pair to the right implementation", () => {
    const objc = matrix();
    const a = objc.allocate("A");
    const b = objc.allocate("B");
    const c = objc.allocate("C");
    expect(objc.send(a, "shared")).toBe("A.shared");
    expect(objc.send(b, "shared")).toBe("B.shared");
    expect(objc.send(c, "shared")).toBe("B.shared");
    expect(objc.send(c, "onlyA")).toBe("A.onlyA");
    expect(objc.send(c, "onlyB")).toBe("B.onlyB");
    expect(objc.sendSuper(c, "A", "shared")).toBe("A.shared");
    expect(objc.sendSuper(c, "B", "shared")).toBe("B.shared");
    expect(objc.respondsTo(c, "onlyA")).toBe(true);
    expect(objc.respondsTo(c, "missing")).toBe(false);
    expect(objc.respondsTo(null, "shared")).toBe(false);
    expect(objc.methodOwner("C", "onlyA")).toBe("A");
    expect(objc.methodOwner("C", "missing")).toBeNull();
  });

  it("counts cache misses then hits, and invalidates on method changes", () => {
    const objc = matrix();
    const c = objc.allocate("C");
    expect(objc.send(c, "onlyA")).toBe("A.onlyA");
    expect(objc.cacheStats()).toMatchObject({ hits: 0, misses: 1, entries: 1 });
    expect(objc.send(c, "onlyA")).toBe("A.onlyA");
    expect(objc.cacheStats()).toMatchObject({ hits: 1, misses: 1 });
    objc.addMethod("A", "onlyA", () => "A.onlyA2");
    expect(objc.send(c, "onlyA")).toBe("A.onlyA2");
    expect(objc.cacheStats().misses).toBeGreaterThan(1);
  });

  it("uses a forwarding hook for unknown selectors", () => {
    const objc = matrix();
    const c = objc.allocate("C");
    expect(() => objc.send(c, "forwarded", 1)).toThrow(ObjcError);
    objc.setForwardHandler(
      (receiver, selector, args) => `${receiver.isa.name}:${selector}:${args[0]}`,
    );
    expect(objc.send(c, "forwarded", 1)).toBe("C:forwarded:1");
    objc.setForwardHandler(null);
    expect(() => objc.send(c, "forwarded")).toThrow(/does not respond/);
  });
});
