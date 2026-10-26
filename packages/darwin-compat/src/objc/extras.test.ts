import { describe, expect, it } from "vitest";
import { ObjcError, ObjcRuntime } from "./runtime.js";

describe("categories, protocols, and exceptions", () => {
  it("lets categories override methods and later categories win", () => {
    const objc = new ObjcRuntime();
    objc.registerClass("Base");
    objc.addMethod("Base", "hello", () => "base");
    objc.addCategory("Base", "Greeting", { hello: () => "category1" });
    expect(objc.send(objc.allocate("Base"), "hello")).toBe("category1");
    objc.addCategory("Base", "Loud", { hello: () => "category2", shout: () => "SHOUT" });
    expect(objc.send(objc.allocate("Base"), "hello")).toBe("category2");
    expect(objc.send(objc.allocate("Base"), "shout")).toBe("SHOUT");
    expect(objc.categoriesFor("Base")).toEqual(["Greeting", "Loud"]);
  });

  it("checks required protocol methods and inherited conformance", () => {
    const objc = new ObjcRuntime();
    objc.registerClass("Base");
    objc.registerClass("Child", "Base");
    objc.registerProtocol("Drawable", ["draw"], ["optional"]);
    objc.addProtocol("Base", "Drawable");
    expect(objc.conformsTo("Child", "Drawable")).toBe(false);
    expect(objc.missingProtocolMethods("Child", "Drawable")).toEqual(["draw"]);
    objc.addMethod("Base", "draw", () => "drawn");
    expect(objc.conformsTo("Child", "Drawable")).toBe(true);
    expect(objc.missingProtocolMethods("Child", "Drawable")).toEqual([]);
    expect(() => objc.addProtocol("Child", "Missing")).toThrow(/not registered/);
    expect(() => objc.registerProtocol("Drawable", [])).toThrow(/exists/);
  });

  it("unwinds ObjcError to a catch and supports rethrow", () => {
    const objc = new ObjcRuntime();
    objc.registerClass("Thing");
    objc.addMethod("Thing", "fail", () => {
      throw new ObjcError("boom", "thing failed");
    });
    const caught: string[] = [];
    try {
      objc.send(objc.allocate("Thing"), "fail");
    } catch (error) {
      caught.push((error as ObjcError).code);
    }
    expect(caught).toEqual(["boom"]);
    expect(() => objc.send(objc.allocate("Thing"), "fail")).toThrow(/thing failed/);
  });
});
