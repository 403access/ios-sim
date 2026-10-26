import { describe, expect, it } from "vitest";
import { ObjcError, ObjcRuntime } from "./runtime.js";

function runtime() {
  const objc = new ObjcRuntime();
  objc.registerClass("NSObject");
  objc.addMethod("NSObject", "description", (_self, _sel) => "NSObject");
  objc.addMethod("NSObject", "retain", (self) => self);
  objc.registerClass("View", "NSObject");
  objc.addMethod("View", "description", () => "View");
  objc.addMethod("View", "draw", (self, _sel, args) => `draw:${String(args[0])}`);
  objc.addIvar("NSObject", "tag");
  return objc;
}

describe("Objective-C runtime core", () => {
  it("dispatches overrides and inherited methods", () => {
    const objc = runtime();
    const view = objc.allocate("View");
    expect(objc.send(view, "description")).toBe("View");
    expect(objc.send(view, "draw", 7)).toBe("draw:7");
    expect(objc.send(view, "retain")).toBe(view);
    expect(objc.send(null, "description")).toBeUndefined();
    expect(objc.lookup("View", "description")).not.toBeNull();
    expect(objc.dispatchRecord("View", "description")).toMatchObject({
      owner: "View",
      selector: "description",
      calls: 1,
    });
    expect(objc.dispatchRecord("View", "retain")?.owner).toBe("NSObject");
  });

  it("invalidates the cache when a method is added or overridden", () => {
    const objc = runtime();
    const view = objc.allocate("View");
    expect(objc.send(view, "description")).toBe("View");
    objc.addMethod("View", "description", () => "View2");
    expect(objc.send(view, "description")).toBe("View2");
    objc.registerClass("Sub", "View");
    objc.addMethod("Sub", "description", () => "Sub");
    objc.addMethod("View", "description", () => "View3");
    expect(objc.send(objc.allocate("Sub"), "description")).toBe("Sub");
  });

  it("reports unknown selectors, classes, ivars, and duplicate classes", () => {
    const objc = runtime();
    const view = objc.allocate("View");
    expect(() => objc.send(view, "missing")).toThrow(ObjcError);
    expect(() => objc.send(view, "missing")).toThrow(/does not respond/);
    expect(() => objc.requireClass("Nope")).toThrow(/not registered/);
    expect(() => objc.registerClass("View")).toThrow(/already registered/);
    expect(() => view.set("unknown", 1)).toThrow(/no ivar/);
    view.set("tag", 3);
    expect(view.get("tag")).toBe(3);
    expect(objc.selector("draw")).toBe("draw");
    expect(objc.selectorsView()).toContain("draw");
    expect(() => objc.addMethod("View", "", () => 0)).toThrow(/empty/);
  });
});
