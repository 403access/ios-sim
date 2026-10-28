import { describe, expect, it } from "vitest";
import { VirtualMemory } from "../dyld/vm.js";
import type { LoadedImage } from "../dyld/loader.js";
import { parseObjcCategories, parseObjcClasses } from "./abi.js";

const BASE = 0x1_0000_0000;
const PAGE = 0x4000;

/**
 * A hand-built image with **relative** method lists and an absolute ivar list,
 * the formats clang emits. The absolute class path is covered by the generated
 * app in `host.test.ts`; this keeps all metadata readers covered on Linux.
 */
function relativeImage(): { memory: VirtualMemory; image: LoadedImage } {
  const data = new Uint8Array(PAGE);
  const view = new DataView(data.buffer);
  const at = (offset: number): bigint => BigInt(BASE + offset);
  const u32 = (offset: number, value: number): void => view.setUint32(offset, value, true);
  const s32 = (offset: number, value: number): void => view.setInt32(offset, value, true);
  const u64 = (offset: number, value: number | bigint): void =>
    view.setBigUint64(offset, BigInt.asUintN(64, BigInt(value)), true);
  const text = (offset: number, value: string): void => {
    new TextEncoder().encodeInto(value, data.subarray(offset));
  };

  const classList = 0;
  const classAddress = 8;
  const metaclass = 48;
  const ro = 88;
  const metaRo = 160;
  const methods = 232;
  const selectorSlot = 256;
  const strings = 264;
  const name = strings;
  const selector = name + "Relative".length + 1;
  const types = selector + "answer".length + 1;

  const ivars = 0x300;
  const ivarName = 0x328;
  const ivarType = 0x330;
  const ivarOffset = 0x3b0;
  const categoryMethods = 0x338;
  const category = 0x350;
  const categoryList = 0x380;
  const categoryName = 0x388;
  const categorySelector = 0x390;
  const categorySelectorSlot = 0x398;
  const code = 0x1000;
  const categoryCode = 0x1010;

  text(name, "Relative");
  text(selector, "answer");
  text(types, "i16@0:8");
  text(ivarName, "_count");
  text(ivarType, "i");
  text(categoryName, "Extra");
  text(categorySelector, "extra");

  u64(classList, at(classAddress));
  u64(classAddress, at(metaclass));
  u64(classAddress + 32, at(ro));
  u64(metaclass, at(metaclass));
  u64(metaclass + 32, at(metaRo));

  u32(ro + 8, 8); // instanceSize
  u64(ro + 24, at(name));
  u64(ro + 32, at(methods));
  u64(ro + 48, at(ivars));
  u32(metaRo, 0x1); // RO_META
  u64(metaRo + 24, at(name));

  u32(methods, 0x8000_000c); // sizeof(relative method_t), bit 31 set
  u32(methods + 4, 1);
  const entry = methods + 8;
  u32(entry, selectorSlot - entry); // relative offset to the selref slot
  u32(entry + 4, types - (entry + 4));
  u32(entry + 8, code - (entry + 8));

  u64(selectorSlot, at(selector));

  u32(ivars, 32);
  u32(ivars + 4, 1);
  s32(ivarOffset, 8);
  u64(ivars + 8, at(ivarOffset)); // ivar_t.offset points at the int32 offset
  u64(ivars + 16, at(ivarName));
  u64(ivars + 24, at(ivarType));
  u32(ivars + 32, 2); // alignment
  u32(ivars + 36, 4); // size

  u32(categoryMethods, 0x8000_000c);
  u32(categoryMethods + 4, 1);
  const categoryEntry = categoryMethods + 8;
  u32(categoryEntry, categorySelectorSlot - categoryEntry);
  u32(categoryEntry + 4, types - (categoryEntry + 4));
  u32(categoryEntry + 8, categoryCode - (categoryEntry + 8));

  u64(categorySelectorSlot, at(categorySelector));
  u64(category, at(categoryName));
  u64(category + 8, at(classAddress));
  u64(category + 16, at(categoryMethods));
  u64(categoryList, at(category));

  u32(code, 0xd2800540); // movz x0, #42
  u32(code + 4, 0xd65f03c0); // ret
  u32(categoryCode, 0xd28000e0); // movz x0, #7
  u32(categoryCode + 4, 0xd65f03c0); // ret

  const memory = new VirtualMemory();
  memory.mapFixed(BigInt(BASE), PAGE, { bytes: data, tag: "__DATA" });
  const image = {
    path: "/relative",
    base: BigInt(BASE),
    image: {
      preferredBase: BASE,
      sections: [
        {
          index: 1,
          segmentName: "__DATA_CONST",
          name: "__objc_classlist",
          address: BASE + classList,
          size: 8,
          fileOffset: classList,
          alignment: 3,
          relocationsOffset: 0,
          relocationCount: 0,
          flags: 0,
          reserved1: 0,
          reserved2: 0,
          reserved3: 0,
          zeroFill: false,
        },
        {
          index: 2,
          segmentName: "__DATA_CONST",
          name: "__objc_catlist",
          address: BASE + categoryList,
          size: 8,
          fileOffset: categoryList,
          alignment: 3,
          relocationsOffset: 0,
          relocationCount: 0,
          flags: 0,
          reserved1: 0,
          reserved2: 0,
          reserved3: 0,
          zeroFill: false,
        },
      ],
    },
  } as unknown as LoadedImage;

  return { memory, image };
}

describe("ObjC metadata", () => {
  it("parses a relative method list through its selector slot", () => {
    const { memory, image } = relativeImage();
    const classes = parseObjcClasses(memory, image);
    expect(classes).toHaveLength(1);
    const parsed = classes[0]!;
    expect(parsed.name).toBe("Relative");
    expect(parsed.instanceSize).toBe(8);
    expect(parsed.classMethods.size).toBe(0);
    const method = parsed.methods.get("answer");
    expect(method?.types).toBe("i16@0:8");
    expect(method?.imp).toBe(BigInt(BASE + 0x1000));
  });

  it("parses an absolute ivar list", () => {
    const { memory, image } = relativeImage();
    const parsed = parseObjcClasses(memory, image)[0]!;
    expect(parsed.ivars).toEqual([
      {
        name: "_count",
        type: "i",
        offset: 8,
        slot: BigInt(BASE + 0x3b0),
        size: 4,
        alignment: 2,
      },
    ]);
  });

  it("parses a category list and its relative methods", () => {
    const { memory, image } = relativeImage();
    const categories = parseObjcCategories(memory, image);
    expect(categories).toHaveLength(1);
    const category = categories[0]!;
    expect(category.name).toBe("Extra");
    expect(category.classAddress).toBe(BigInt(BASE + 8));
    expect(category.methods.get("extra")?.imp).toBe(BigInt(BASE + 0x1010));
  });

  it("rejects a class list that points outside mapped memory", () => {
    const { memory, image } = relativeImage();
    memory.write(BigInt(BASE), 8, 0xdead_beefn);
    expect(() => parseObjcClasses(memory, image)).toThrow(/outside mapped memory/);
  });
});
