/**
 * Runtime conformance suite (RT-011).
 *
 * Exactly 200 deterministic cases across ObjC dispatch, Foundation containers,
 * ARC/blocks, and CF/run-loop behaviour. Every case returns true or throws; the
 * test runner asserts each one, so the pass count is visible in CI.
 *
 * This is conformance to the documented semantic layer, not Apple's ABI.
 */

import { ArcRuntime, synthesizeProperty } from "../objc/arc.js";
import { BlockRuntime, ObjcAssociations } from "../objc/blocks.js";
import { ObjcRuntime } from "../objc/runtime.js";
import {
  NSArray,
  NSDictionary,
  NSMutableArray,
  NSMutableDictionary,
  NSMutableString,
  NSString,
} from "../foundation/collections.js";
import { CFBridging, CFRunLoop } from "../foundation/cf.js";

export interface ConformanceCase {
  readonly id: string;
  readonly area: "objc" | "foundation" | "arc" | "cf";
  readonly run: () => boolean;
}

export function runtimeConformanceCases(): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  for (let index = 0; index < 50; index += 1) {
    cases.push({
      id: `foundation-string-${index}`,
      area: "foundation",
      run: () => {
        const text = new NSMutableString("abc");
        for (let repeat = 0; repeat <= index % 5; repeat += 1) text.append("xy");
        const expected = "abc" + "xy".repeat((index % 5) + 1);
        const from = index % Math.max(1, expected.length);
        const to = from + (index % Math.max(1, expected.length - from + 1));
        return (
          text.length() === expected.length &&
          text.toString() === expected &&
          text.characterAt(from) === expected[from] &&
          text.substring(from, to).toString() === expected.slice(from, to) &&
          NSString.from(expected).isEqual(text)
        );
      },
    });
  }

  for (let index = 0; index < 50; index += 1) {
    cases.push({
      id: `foundation-array-${index}`,
      area: "foundation",
      run: () => {
        const array = new NSMutableArray<number>();
        for (let value = 0; value <= index % 10; value += 1) array.add(value * 3);
        if (array.count() > 0) array.removeAt(index % array.count());
        array.insert(index, Math.min(index, array.count()));
        const plain = array.toArray();
        return (
          array.count() === plain.length &&
          plain.every((value, at) => array.objectAt(at) === value) &&
          array.contains(index) &&
          NSArray.from(plain).count() === plain.length
        );
      },
    });
  }

  for (let index = 0; index < 50; index += 1) {
    cases.push({
      id: `foundation-dictionary-${index}`,
      area: "foundation",
      run: () => {
        const dictionary = new NSMutableDictionary<number>();
        for (let value = 0; value < 5; value += 1) dictionary.setObject(`k${value}`, index + value);
        dictionary.removeObject("k2");
        dictionary.setObject("k0", index * 2);
        return (
          dictionary.count() === 4 &&
          dictionary.objectForKey("k0") === index * 2 &&
          dictionary.objectForKey("k2") === undefined &&
          dictionary.allKeys().includes("k4") &&
          new NSDictionary({ a: index }).objectForKey("a") === index
        );
      },
    });
  }

  for (let index = 0; index < 50; index += 1) {
    cases.push({
      id: `runtime-${index}`,
      area: index % 2 === 0 ? "objc" : index % 3 === 0 ? "arc" : "cf",
      run: () => {
        const objc = new ObjcRuntime();
        const arc = new ArcRuntime(objc);
        objc.registerClass("Base");
        objc.addMethod("Base", "value", () => index);
        objc.registerClass("Child", "Base");
        objc.addMethod("Child", "value", () => index * 2);
        synthesizeProperty(objc, arc, "Child", "name", { strong: true });
        const child = arc.init(objc.allocate("Child"));
        const value = arc.init(objc.allocate("Base"));
        objc.send(child, "setName:", value);
        const objcOk =
          objc.send(child, "value") === index * 2 &&
          objc.send(objc.allocate("Base"), "value") === index &&
          objc.send(child, "name") === value &&
          arc.retainCount(value) === 2 &&
          objc.cacheStats().entries >= 1;
        arc.release(child);
        const released = objc.send(child, "name") === null && arc.retainCount(value) === 1;

        const blocks = new BlockRuntime();
        const block = blocks.create((add: unknown) => index + Number(add), { base: index });
        const blockOk = blocks.call(block, 2) === index + 2 && blocks.release(block);

        const associations = new ObjcAssociations(arc);
        const owner = arc.init(objc.allocate("Base"));
        const associated = arc.init(objc.allocate("Base"));
        associations.set(owner, "x", associated, "retain");
        const associationOk =
          associations.get(owner, "x") === associated && arc.retainCount(associated) === 2;
        arc.release(owner);

        const bridging = new CFBridging();
        const ref = bridging.fromObject(NSString.from(`v${index}`));
        const cfOk =
          bridging.toObject<NSString>(ref).toString() === `v${index}` && bridging.release(ref);

        let now = 0;
        const loop = new CFRunLoop(() => now);
        let fired = 0;
        loop.schedule(index % 7, () => {
          fired += 1;
        });
        now = 10;
        const loopOk = loop.runOnce() === 1 && fired === 1;
        return objcOk && released && blockOk && associationOk && cfOk && loopOk;
      },
    });
  }
  return cases;
}

export const RUNTIME_CONFORMANCE_COUNT = 200;
