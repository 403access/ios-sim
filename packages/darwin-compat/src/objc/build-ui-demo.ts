/**
 * The generated Objective-C application used by the UIKit proof of concept.
 *
 * It is a real arm64 Mach-O image with a real `__objc_classlist` containing
 * two classes, an absolute method list, an ivar list, a category, and a `main`
 * that calls `UIApplicationMain`.
 *
 * - `AppDelegate` implements `+initialize` (increments a marker) and gets its
 *   delegate method from a category, so category merge is on the hot path.
 * - `TapView` subclasses `UIView`, declares a `_pressed` ivar, and overrides
 *   `touchesBegan:withEvent:` / `touchesEnded:withEvent:` to change its colour.
 *
 * Nothing here is Apple code: the bytes are emitted by this repository's
 * assembler and Mach-O writer, so the fixture is reproducible on Linux with no
 * SDK, compiler, or committed binary.
 */

import {
  buildMachO,
  type BuildDataSection,
  type BuildFixup,
  type BuiltMachO,
} from "../macho/build.js";
import type { MachOLayout } from "../macho/build.js";
import { S_CSTRING_LITERALS, S_REGULAR } from "../macho/constants.js";
import {
  addImm,
  adrp,
  blr,
  ldpPost,
  ldrDouble,
  ldrUnsigned,
  movReg,
  movz,
  ret,
  stpPre,
  strUnsigned,
} from "../arm64/assembler.js";

export const DEMO_SCREEN = { width: 375, height: 667 } as const;
export const DEMO_VIEW_RECT = { x: 20, y: 20, width: 200, height: 100 } as const;
export const DEMO_VIEW_COLOR = { r: 1, g: 0, b: 0, a: 1 } as const;
export const DEMO_CLASS_NAME = "AppDelegate";
export const DEMO_VIEW_CLASS_NAME = "TapView";
export const DEMO_CATEGORY_NAME = "Window";

const SELECTORS = {
  alloc: "alloc",
  initWithFrame: "initWithFrame:",
  setFrame: "setFrame:",
  setBackgroundColor: "setBackgroundColor:",
  addSubview: "addSubview:",
  makeKeyAndVisible: "makeKeyAndVisible",
  redColor: "redColor",
  blueColor: "blueColor",
  greenColor: "greenColor",
  touchesBegan: "touchesBegan:withEvent:",
  touchesEnded: "touchesEnded:withEvent:",
  didFinishLaunching: "application:didFinishLaunchingWithOptions:",
  initialize: "initialize",
  load: "load",
} as const;

const TYPES = "v16@0:8";

type SlotName =
  | "classWindow"
  | "classTapView"
  | "classColor"
  | "msgSend"
  | "uiApplicationMain"
  | "delegateName"
  | "initializeMarker"
  | "loadMarker";

interface Plan {
  readonly slotOffsets: Readonly<Record<SlotName, number>>;
  readonly stringOffsets: Readonly<Record<string, number>>;
  readonly appRo: number;
  readonly appMetaRo: number;
  readonly appEmptyMethods: number;
  readonly appClassMethods: number;
  readonly appCategoryMethods: number;
  readonly appCategory: number;
  readonly tapRo: number;
  readonly tapMetaRo: number;
  readonly tapEmptyMethods: number;
  readonly tapMethods: number;
  readonly tapIvars: number;
  readonly appClass: number;
  readonly appMeta: number;
  readonly tapClass: number;
  readonly tapMeta: number;
  readonly classList: number;
  readonly categoryList: number;
  readonly windowRect: number;
  readonly viewRect: number;
  readonly size: number;
  readonly sections: readonly BuildDataSection[];
}

interface Code {
  readonly words: number[];
  readonly labels: Map<string, number>;
}

interface Emission {
  readonly text: Uint8Array;
  readonly data: Uint8Array;
  readonly fixups: readonly BuildFixup[];
  readonly sections: readonly BuildDataSection[];
  readonly symbols: readonly { name: string; value: number; sectionIndex?: number }[];
}

export interface UIKitDemo {
  readonly built: BuiltMachO;
  readonly layout: MachOLayout;
}

export function buildUIKitDemo(): UIKitDemo {
  const plan = planData();

  const probe = emit({ textBase: 0, dataBase: 0 }, plan);
  const probeBuilt = buildMachO({
    fileType: "execute",
    text: probe.text,
    data: probe.data,
    dataSections: probe.sections,
    fixups: probe.fixups,
    symbols: probe.symbols,
    dependencies: [{ name: "/usr/lib/libobjc.A.dylib", weak: true }],
    entryOffset: 0,
  });

  const final = emit({ textBase: probeBuilt.layout.text, dataBase: probeBuilt.layout.data }, plan);
  if (final.text.length !== probe.text.length || final.data.length !== probe.data.length) {
    throw new Error("UIKit demo emission is not location-independent");
  }

  const built = buildMachO({
    fileType: "execute",
    text: final.text,
    data: final.data,
    dataSections: final.sections,
    fixups: final.fixups,
    symbols: final.symbols,
    dependencies: [{ name: "/usr/lib/libobjc.A.dylib", weak: true }],
    entryOffset: 0,
    stackSize: 1024 * 1024,
  });
  return { built, layout: built.layout };
}

/** Stable plan of the __DATA blob. Sizes do not depend on any address. */
function planData(): Plan {
  let cursor = 0;
  const align = (value: number): number => Math.ceil(value / 8) * 8;

  cursor = align(cursor);
  const slotsStart = cursor;
  const slotNames: SlotName[] = [
    "classWindow",
    "classTapView",
    "classColor",
    "msgSend",
    "uiApplicationMain",
    "delegateName",
    "initializeMarker",
    "loadMarker",
  ];
  const slotOffsets = {} as Record<SlotName, number>;
  for (const name of slotNames) {
    slotOffsets[name] = cursor;
    cursor += 8;
  }
  const slotsEnd = cursor;

  const stringsStart = cursor;
  const stringOffsets: Record<string, number> = {};
  const intern = (value: string): void => {
    if (stringOffsets[value] !== undefined) return;
    stringOffsets[value] = cursor;
    cursor += new TextEncoder().encode(value).length + 1;
  };
  for (const selector of Object.values(SELECTORS)) intern(selector);
  for (const value of [
    TYPES,
    DEMO_CLASS_NAME,
    DEMO_VIEW_CLASS_NAME,
    DEMO_CATEGORY_NAME,
    "_pressed",
    "B",
  ]) {
    intern(value);
  }
  const stringsEnd = cursor;

  cursor = align(cursor);
  const constStart = cursor;
  const appRo = cursor;
  cursor += 72;
  const appMetaRo = cursor;
  cursor += 72;
  const appEmptyMethods = cursor;
  cursor += 8;
  const appClassMethods = cursor;
  cursor += 8 + 2 * 24;
  const appCategoryMethods = cursor;
  cursor += 8 + 24;
  const appCategory = cursor;
  cursor += 48;

  const tapRo = cursor;
  cursor += 72;
  const tapMetaRo = cursor;
  cursor += 72;
  const tapEmptyMethods = cursor;
  cursor += 8;
  const tapMethods = cursor;
  cursor += 8 + 2 * 24;
  const tapIvars = cursor;
  cursor += 8 + 32;
  const constEnd = cursor;

  cursor = align(cursor);
  const dataStart = cursor;
  const appClass = cursor;
  cursor += 40;
  const appMeta = cursor;
  cursor += 40;
  const tapClass = cursor;
  cursor += 40;
  const tapMeta = cursor;
  cursor += 40;
  const dataEnd = cursor;

  cursor = align(cursor);
  const classList = cursor;
  cursor += 16;
  const categoryList = cursor;
  cursor += 8;

  cursor = align(cursor);
  const windowRect = cursor;
  cursor += 32;
  const viewRect = cursor;
  cursor += 32;

  const sections: BuildDataSection[] = [
    {
      name: "__data",
      offset: slotsStart,
      size: slotsEnd - slotsStart,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__objc_methname",
      offset: stringsStart,
      size: stringsEnd - stringsStart,
      alignment: 0,
      flags: S_CSTRING_LITERALS,
    },
    {
      name: "__objc_const",
      offset: constStart,
      size: constEnd - constStart,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__objc_data",
      offset: dataStart,
      size: dataEnd - dataStart,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__objc_classlist",
      offset: classList,
      size: 16,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__objc_catlist",
      offset: categoryList,
      size: 8,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__const",
      offset: windowRect,
      size: 64,
      alignment: 3,
      flags: S_REGULAR,
    },
  ];

  return {
    slotOffsets,
    stringOffsets,
    appRo,
    appMetaRo,
    appEmptyMethods,
    appClassMethods,
    appCategoryMethods,
    appCategory,
    tapRo,
    tapMetaRo,
    tapEmptyMethods,
    tapMethods,
    tapIvars,
    appClass,
    appMeta,
    tapClass,
    tapMeta,
    classList,
    categoryList,
    windowRect,
    viewRect,
    size: cursor,
    sections,
  };
}

function emit(bases: { textBase: number; dataBase: number }, plan: Plan): Emission {
  const code: Code = { words: [], labels: new Map() };
  const dataAddress = (offset: number): number => bases.dataBase + offset;
  const selector = (name: string): number => {
    const offset = plan.stringOffsets[name];
    if (offset === undefined) throw new Error(`selector ${name} is not planned`);
    return dataAddress(offset);
  };
  const slot = (name: SlotName): number => dataAddress(plan.slotOffsets[name]);
  const pc = (): number => bases.textBase + code.words.length * 4;

  const emitWord = (word: number): void => {
    code.words.push(word);
  };
  const emitAddress = (register: number, address: number): void => {
    emitWord(adrp(register, address, pc()));
    emitWord(addImm(register, register, address & 0xfff));
  };
  const emitPointer = (register: number, address: number): void => {
    emitWord(adrp(register, address, pc()));
    emitWord(ldrUnsigned(register, register, address & 0xfff));
  };
  const emitDouble = (register: number, address: number): void => {
    emitWord(adrp(9, address, pc()));
    emitWord(ldrDouble(register, 9, address & 0xfff));
  };
  const label = (name: string): void => {
    code.labels.set(name, code.words.length * 4);
  };

  // int main(void) { return UIApplicationMain(0, 0, 0, "AppDelegate"); }
  label("main");
  emitWord(stpPre(29, 30, 31, -16));
  emitWord(movz(0, 0));
  emitWord(movz(1, 0));
  emitWord(movz(2, 0));
  emitPointer(3, slot("delegateName"));
  emitPointer(16, slot("uiApplicationMain"));
  emitWord(blr(16));
  emitWord(movz(0, 0));
  emitWord(ldpPost(29, 30, 31, 16));
  emitWord(ret());

  // +[AppDelegate initialize] { ++marker; }
  label("initialize");
  emitAddress(1, slot("initializeMarker"));
  emitWord(ldrUnsigned(2, 1, 0));
  emitWord(addImm(2, 2, 1));
  emitWord(strUnsigned(2, 1, 0));
  emitWord(ret());

  // +[AppDelegate load] { ++loadMarker; }
  label("load");
  emitAddress(1, slot("loadMarker"));
  emitWord(ldrUnsigned(2, 1, 0));
  emitWord(addImm(2, 2, 1));
  emitWord(strUnsigned(2, 1, 0));
  emitWord(ret());

  label("delegate");
  emitDelegate();

  label("tapBegan");
  emitTouchHandler(SELECTORS.blueColor);
  label("tapEnded");
  emitTouchHandler(SELECTORS.greenColor);

  const data = emitData(
    bases,
    plan,
    selector,
    bases.textBase + (code.labels.get("delegate") ?? 0),
    bases.textBase + (code.labels.get("initialize") ?? 0),
    bases.textBase + (code.labels.get("load") ?? 0),
    bases.textBase + (code.labels.get("tapBegan") ?? 0),
    bases.textBase + (code.labels.get("tapEnded") ?? 0),
  );

  const text = new Uint8Array(code.words.length * 4);
  const view = new DataView(text.buffer);
  code.words.forEach((word, index) => view.setUint32(index * 4, word >>> 0, true));

  return {
    text,
    data: data.bytes,
    fixups: data.fixups,
    sections: plan.sections,
    symbols: [
      { name: "_main", value: bases.textBase, sectionIndex: 1 },
      {
        name: "_OBJC_CLASS_$_AppDelegate",
        value: dataAddress(plan.appClass),
        sectionIndex: 5,
      },
      { name: "_OBJC_CLASS_$_TapView", value: dataAddress(plan.tapClass), sectionIndex: 5 },
      {
        name: "_initializeMarker",
        value: dataAddress(plan.slotOffsets.initializeMarker),
        sectionIndex: 2,
      },
      { name: "_loadMarker", value: dataAddress(plan.slotOffsets.loadMarker), sectionIndex: 2 },
    ],
  };

  function emitDelegate(): void {
    // -[AppDelegate(Window) application:didFinishLaunchingWithOptions:] -> BOOL
    emitWord(stpPre(29, 30, 31, -16));
    emitWord(stpPre(19, 20, 31, -16));

    // UIWindow *window = [[UIWindow alloc] initWithFrame:...];
    emitPointer(0, slot("classWindow"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(19, 0));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.windowRect));
    emitDouble(1, dataAddress(plan.windowRect + 8));
    emitDouble(2, dataAddress(plan.windowRect + 16));
    emitDouble(3, dataAddress(plan.windowRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // TapView *view = [TapView alloc];
    emitPointer(0, slot("classTapView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(20, 0));

    // [view setFrame:...];
    emitWord(movReg(0, 20));
    emitAddress(1, selector(SELECTORS.setFrame));
    emitDouble(0, dataAddress(plan.viewRect));
    emitDouble(1, dataAddress(plan.viewRect + 8));
    emitDouble(2, dataAddress(plan.viewRect + 16));
    emitDouble(3, dataAddress(plan.viewRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [view setBackgroundColor:[UIColor redColor]];
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.redColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 20));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [window addSubview:view];
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 20));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [window makeKeyAndVisible];
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.makeKeyAndVisible));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    emitWord(movz(0, 1));
    emitWord(ldpPost(19, 20, 31, 16));
    emitWord(ldpPost(29, 30, 31, 16));
    emitWord(ret());
  }

  function emitTouchHandler(color: string): void {
    emitWord(stpPre(29, 30, 31, -16));
    emitWord(stpPre(19, 20, 31, -16));
    emitWord(movReg(19, 0));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(color));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(ldpPost(19, 20, 31, 16));
    emitWord(ldpPost(29, 30, 31, 16));
    emitWord(ret());
  }
}

function emitData(
  bases: { textBase: number; dataBase: number },
  plan: Plan,
  selector: (name: string) => number,
  delegateImp: number,
  initializeImp: number,
  loadImp: number,
  tapBeganImp: number,
  tapEndedImp: number,
): { bytes: Uint8Array; fixups: BuildFixup[] } {
  const bytes = new Uint8Array(plan.size);
  const view = new DataView(bytes.buffer);
  const u32 = (offset: number, value: number): void => view.setUint32(offset, value, true);
  const f64 = (offset: number, value: number): void => view.setFloat64(offset, value, true);

  const encoder = new TextEncoder();
  for (const value of [
    ...Object.values(SELECTORS),
    TYPES,
    DEMO_CLASS_NAME,
    DEMO_VIEW_CLASS_NAME,
    DEMO_CATEGORY_NAME,
    "_pressed",
    "B",
  ]) {
    const offset = plan.stringOffsets[value];
    if (offset === undefined) throw new Error(`string ${value} is not planned`);
    bytes.set(encoder.encode(value), offset);
  }

  const fixups: BuildFixup[] = [];
  const rebase = (offset: number, target: number): void => {
    fixups.push({ kind: "rebase", offset, target });
  };
  const bind = (offset: number, symbol: string): void => {
    fixups.push({ kind: "bind", offset, symbol, ordinal: 1 });
  };
  const address = (offset: number): number => bases.dataBase + offset;

  // AppDelegate metadata.
  u32(plan.appRo, 0);
  u32(plan.appRo + 4, 8);
  u32(plan.appRo + 8, 8);
  u32(plan.appMetaRo, 0x1); // RO_META
  u32(plan.appMetaRo + 4, 40);
  u32(plan.appMetaRo + 8, 40);
  u32(plan.appEmptyMethods, 24);
  u32(plan.appEmptyMethods + 4, 0);
  u32(plan.appClassMethods, 24);
  u32(plan.appClassMethods + 4, 2);
  u32(plan.appCategoryMethods, 24);
  u32(plan.appCategoryMethods + 4, 1);

  const initializeEntry = plan.appClassMethods + 8;
  rebase(initializeEntry, selector(SELECTORS.initialize));
  rebase(initializeEntry + 8, selector(TYPES));
  rebase(initializeEntry + 16, initializeImp);

  const loadEntry = plan.appClassMethods + 32;
  rebase(loadEntry, selector(SELECTORS.load));
  rebase(loadEntry + 8, selector(TYPES));
  rebase(loadEntry + 16, loadImp);

  const categoryEntry = plan.appCategoryMethods + 8;
  rebase(categoryEntry, selector(SELECTORS.didFinishLaunching));
  rebase(categoryEntry + 8, selector(TYPES));
  rebase(categoryEntry + 16, delegateImp);

  // category_t { name, cls, instanceMethods, classMethods, protocols,
  //              properties, classProperties }
  rebase(plan.appCategory, address(plan.stringOffsets[DEMO_CATEGORY_NAME]!));
  rebase(plan.appCategory + 8, address(plan.appClass));
  rebase(plan.appCategory + 16, address(plan.appCategoryMethods));

  rebase(plan.appRo + 24, address(plan.stringOffsets[DEMO_CLASS_NAME]!));
  rebase(plan.appRo + 32, address(plan.appEmptyMethods));
  rebase(plan.appMetaRo + 24, address(plan.stringOffsets[DEMO_CLASS_NAME]!));
  rebase(plan.appMetaRo + 32, address(plan.appClassMethods));

  rebase(plan.appClass, address(plan.appMeta));
  bind(plan.appClass + 8, "_OBJC_CLASS_$_NSObject");
  rebase(plan.appClass + 32, address(plan.appRo));
  rebase(plan.appMeta, address(plan.appMeta));
  bind(plan.appMeta + 8, "_OBJC_METACLASS_$_NSObject");
  rebase(plan.appMeta + 32, address(plan.appMetaRo));

  // TapView metadata.
  u32(plan.tapRo, 0);
  u32(plan.tapRo + 4, 8);
  u32(plan.tapRo + 8, 16); // isa + BOOL _pressed
  u32(plan.tapMetaRo, 0x1);
  u32(plan.tapMetaRo + 4, 40);
  u32(plan.tapMetaRo + 8, 40);
  u32(plan.tapEmptyMethods, 24);
  u32(plan.tapEmptyMethods + 4, 0);
  u32(plan.tapMethods, 24);
  u32(plan.tapMethods + 4, 2);

  const beganEntry = plan.tapMethods + 8;
  rebase(beganEntry, selector(SELECTORS.touchesBegan));
  rebase(beganEntry + 8, selector(TYPES));
  rebase(beganEntry + 16, tapBeganImp);
  const endedEntry = plan.tapMethods + 32;
  rebase(endedEntry, selector(SELECTORS.touchesEnded));
  rebase(endedEntry + 8, selector(TYPES));
  rebase(endedEntry + 16, tapEndedImp);

  rebase(plan.tapRo + 24, address(plan.stringOffsets[DEMO_VIEW_CLASS_NAME]!));
  rebase(plan.tapRo + 32, address(plan.tapMethods));
  rebase(plan.tapRo + 48, address(plan.tapIvars));
  rebase(plan.tapMetaRo + 24, address(plan.stringOffsets[DEMO_VIEW_CLASS_NAME]!));
  rebase(plan.tapMetaRo + 32, address(plan.tapEmptyMethods));

  rebase(plan.tapClass, address(plan.tapMeta));
  bind(plan.tapClass + 8, "_OBJC_CLASS_$_UIView");
  rebase(plan.tapClass + 32, address(plan.tapRo));
  rebase(plan.tapMeta, address(plan.tapMeta));
  bind(plan.tapMeta + 8, "_OBJC_METACLASS_$_UIView");
  rebase(plan.tapMeta + 32, address(plan.tapMetaRo));

  // ivar_list_t { entsize 32, count 1, [offset, name, type, alignment, size] }
  u32(plan.tapIvars, 32);
  u32(plan.tapIvars + 4, 1);
  u32(plan.tapIvars + 8, 8); // offset
  rebase(plan.tapIvars + 16, address(plan.stringOffsets["_pressed"]!));
  rebase(plan.tapIvars + 24, address(plan.stringOffsets.B!));
  u32(plan.tapIvars + 32, 0); // alignment 2^0
  u32(plan.tapIvars + 36, 1); // size

  rebase(plan.classList, address(plan.appClass));
  rebase(plan.classList + 8, address(plan.tapClass));
  rebase(plan.categoryList, address(plan.appCategory));

  // Import slots used by the code.
  bind(plan.slotOffsets.classWindow, "_OBJC_CLASS_$_UIWindow");
  bind(plan.slotOffsets.classColor, "_OBJC_CLASS_$_UIColor");
  bind(plan.slotOffsets.msgSend, "_objc_msgSend");
  bind(plan.slotOffsets.uiApplicationMain, "_UIApplicationMain");
  rebase(plan.slotOffsets.delegateName, address(plan.stringOffsets[DEMO_CLASS_NAME]!));
  rebase(plan.slotOffsets.classTapView, address(plan.tapClass));

  f64(plan.windowRect, 0);
  f64(plan.windowRect + 8, 0);
  f64(plan.windowRect + 16, DEMO_SCREEN.width);
  f64(plan.windowRect + 24, DEMO_SCREEN.height);
  f64(plan.viewRect, DEMO_VIEW_RECT.x);
  f64(plan.viewRect + 8, DEMO_VIEW_RECT.y);
  f64(plan.viewRect + 16, DEMO_VIEW_RECT.width);
  f64(plan.viewRect + 24, DEMO_VIEW_RECT.height);

  return { bytes, fixups };
}

/** Deterministic description used by the CLI and the tests. */
export function describeUIKitDemo(demo: UIKitDemo): string {
  return [
    `text 0x${demo.layout.text.toString(16)}`,
    `data 0x${demo.layout.data.toString(16)}`,
    `${demo.built.bytes.length} bytes`,
  ].join(", ");
}
