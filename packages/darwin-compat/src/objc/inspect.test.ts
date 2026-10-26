import { describe, expect, it } from "vitest";
import { buildUIKitDemo } from "./build-ui-demo.js";
import { formatObjcInspection, inspectObjc } from "./inspect.js";

describe("ObjC inspection", () => {
  it("reports classes, categories, protocols, and ivars without running code", () => {
    const demo = buildUIKitDemo();
    const inspection = inspectObjc(demo.built.bytes, "/UIKitDemo");
    expect(inspection.fixups).toBe("chained");
    const names = inspection.classes.map((klass) => klass.name);
    expect(names).toEqual(expect.arrayContaining(["AppDelegate", "TapView"]));

    const tapView = inspection.classes.find((klass) => klass.name === "TapView")!;
    expect(tapView.superclass).toBe("BaseView");
    const baseView = inspection.classes.find((klass) => klass.name === "BaseView")!;
    expect(baseView.superclass).toBe("UIView");
    expect(tapView.instanceSize).toBe(16);
    expect(tapView.protocols).toEqual(["Tappable"]);
    expect(tapView.ivars).toEqual([
      { name: "_pressed", type: "B", offset: 8, size: 1, alignment: 0 },
    ]);
    expect(tapView.methods).toEqual(
      expect.arrayContaining(["touchesBegan:withEvent:", "touchesEnded:withEvent:"]),
    );

    expect(inspection.categories).toEqual([
      {
        name: "Window",
        target: "AppDelegate",
        methods: ["application:didFinishLaunchingWithOptions:", "tick:"],
        protocols: [],
      },
    ]);
    expect(inspection.protocols).toContain("Tappable");
    expect(formatObjcInspection(inspection)).toContain("class TapView : BaseView");
  });
});
