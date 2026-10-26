import { describe, expect, it } from "vitest";
import { ArcRuntime } from "./arc.js";
import { BlockRuntime, ObjcAssociations } from "./blocks.js";
import { ObjcRuntime } from "./runtime.js";

function setup() {
  const objc = new ObjcRuntime();
  const arc = new ArcRuntime(objc);
  objc.registerClass("NSObject");
  return { objc, arc };
}

describe("blocks and associations", () => {
  it("copies, retains, releases, and deallocates blocks", () => {
    const blocks = new BlockRuntime();
    const block = blocks.create((a, b) => Number(a) + Number(b), { base: 2 });
    expect(blocks.call(block, 3, 4)).toBe(7);
    expect(block.captured.get("base")).toBe(2);
    blocks.copy(block);
    expect(block.retainCount).toBe(2);
    expect(blocks.release(block)).toBe(false);
    expect(blocks.release(block)).toBe(true);
    expect(() => blocks.call(block)).toThrow(/released/);
    expect(blocks.release(block)).toBe(false);
  });

  it("retains retained associations until the owner deallocates", () => {
    const { objc, arc } = setup();
    const associations = new ObjcAssociations(arc);
    const owner = arc.init(objc.allocate("NSObject"));
    const value = arc.init(objc.allocate("NSObject"));
    associations.set(owner, "payload", value, "retain");
    expect(associations.get(owner, "payload")).toBe(value);
    expect(arc.retainCount(value)).toBe(2);
    arc.release(owner);
    expect(arc.retainCount(value)).toBe(1);
    expect(associations.get(owner, "payload")).toBeUndefined();
  });

  it("honors assign, replacement, and removal policies", () => {
    const { objc, arc } = setup();
    const associations = new ObjcAssociations(arc);
    const owner = arc.init(objc.allocate("NSObject"));
    const first = arc.init(objc.allocate("NSObject"));
    const second = arc.init(objc.allocate("NSObject"));
    associations.set(owner, "weak", first, "assign");
    expect(arc.retainCount(first)).toBe(1);
    associations.set(owner, "payload", first, "retain");
    associations.set(owner, "payload", second, "retain");
    expect(arc.retainCount(first)).toBe(1);
    expect(arc.retainCount(second)).toBe(2);
    associations.remove(owner, "payload");
    expect(arc.retainCount(second)).toBe(1);
    expect(associations.get(owner, "payload")).toBeUndefined();
    expect(() => associations.set(owner, "", 1)).toThrow(/empty/);
  });
});
