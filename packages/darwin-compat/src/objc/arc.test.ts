import { describe, expect, it } from "vitest";
import { ArcRuntime, synthesizeProperty } from "./arc.js";
import { ObjcRuntime } from "./runtime.js";

function setup() {
  const objc = new ObjcRuntime();
  const arc = new ArcRuntime(objc);
  objc.registerClass("NSObject");
  objc.registerClass("Node", "NSObject");
  synthesizeProperty(objc, arc, "Node", "name");
  synthesizeProperty(objc, arc, "Node", "parent", { weak: true });
  return { objc, arc };
}

describe("ivars, properties, and ARC", () => {
  it("synthesizes strong property accessors and retains values", () => {
    const { objc, arc } = setup();
    const owner = arc.init(objc.allocate("Node"));
    const value = arc.init(objc.allocate("Node"));
    objc.send(owner, "setName:", value);
    expect(objc.send(owner, "name")).toBe(value);
    expect(arc.retainCount(value)).toBe(2);
    objc.send(owner, "setName:", null);
    expect(arc.retainCount(value)).toBe(1);
    expect(objc.send(owner, "name")).toBeNull();
  });

  it("releases to dealloc, zeroes weak ivars, and clears strong values", () => {
    const { objc, arc } = setup();
    const owner = arc.init(objc.allocate("Node"));
    const child = arc.init(objc.allocate("Node"));
    const weakParent = arc.init(objc.allocate("Node"));
    objc.send(owner, "setName:", child);
    objc.send(child, "setParent:", weakParent);
    expect(objc.send(child, "parent")).toBe(weakParent);
    expect(arc.release(weakParent)).toBe(true);
    expect(objc.send(child, "parent")).toBeNull();
    expect(arc.release(child)).toBe(false);
    expect(arc.release(owner)).toBe(true);
    expect(() => arc.retain(child)).toThrow(/deallocated/);
  });

  it("drains an autorelease pool exactly once", () => {
    const { objc, arc } = setup();
    const object = arc.init(objc.allocate("Node"));
    arc.retain(object);
    arc.autorelease(object);
    expect(arc.drainPool()).toBe(1);
    expect(arc.retainCount(object)).toBe(1);
    expect(arc.drainPool()).toBe(0);
    expect(arc.release(object)).toBe(true);
  });
});
