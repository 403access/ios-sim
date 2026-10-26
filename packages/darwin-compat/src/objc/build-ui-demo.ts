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
  addReg,
  and,
  adrp,
  b,
  blr,
  cbz,
  cbnz,
  ldpPost,
  ldrDouble,
  ldrUnsigned,
  lslImm,
  movReg,
  movz,
  ret,
  stpPre,
  strUnsigned,
  ubfm,
} from "../arm64/assembler.js";

export const DEMO_SCREEN = { width: 375, height: 667 } as const;
export const DEMO_VIEW_RECT = { x: 20, y: 20, width: 200, height: 100 } as const;
export const DEMO_VIEW_COLOR = { r: 1, g: 0, b: 0, a: 1 } as const;
export const DEMO_CLASS_NAME = "AppDelegate";
export const DEMO_VIEW_CLASS_NAME = "TapView";
export const DEMO_CATEGORY_NAME = "Window";
const DEMO_BASE_CLASS_NAME = "BaseView";

const SELECTORS = {
  alloc: "alloc",
  init: "init",
  view: "view",
  setRootViewController: "setRootViewController:",
  stringWithUTF8String: "stringWithUTF8String:",
  utf8String: "UTF8String",
  mainBundle: "mainBundle",
  pathForResource: "pathForResource:ofType:",
  text: "text",
  length: "length",
  isEqualToString: "isEqualToString:",
  array: "array",
  addObject: "addObject:",
  count: "count",
  objectAtIndex: "objectAtIndex:",
  numberWithInt: "numberWithInt:",
  intValue: "intValue",
  dictionary: "dictionary",
  setObjectForKey: "setObject:forKey:",
  objectForKey: "objectForKey:",
  scheduledTimer: "scheduledTimerWithTimeInterval:target:selector:repeats:",
  timerFired: "timerFired:",
  switchChanged: "switchChanged:",
  sliderChanged: "sliderChanged:",
  performAfterDelay: "performSelector:withObject:afterDelay:",
  delayedTick: "delayedTick:",
  postNotificationUserInfo: "postNotificationName:object:userInfo:",
  userInfo: "userInfo",
  imageNamed: "imageNamed:",
  initWithImage: "initWithImage:",
  setNumberOfLines: "setNumberOfLines:",
  beginAnimations: "beginAnimations:context:",
  setAnimationDuration: "setAnimationDuration:",
  commitAnimations: "commitAnimations",
  initWithFrame: "initWithFrame:",
  setFrame: "setFrame:",
  setBackgroundColor: "setBackgroundColor:",
  addSubview: "addSubview:",
  makeKeyAndVisible: "makeKeyAndVisible",
  redColor: "redColor",
  blueColor: "blueColor",
  greenColor: "greenColor",
  purpleColor: "purpleColor",
  yellowColor: "yellowColor",
  conformsToProtocol: "conformsToProtocol:",
  retain: "retain",
  release: "release",
  autorelease: "autorelease",
  touchesBegan: "touchesBegan:withEvent:",
  touchesMoved: "touchesMoved:withEvent:",
  touchesEnded: "touchesEnded:withEvent:",
  didFinishLaunching: "application:didFinishLaunchingWithOptions:",
  initialize: "initialize",
  load: "load",
  tick: "tick:",
  dealloc: "dealloc",
  new: "new",
  drain: "drain",
  performSelector: "performSelector:",
  probeColor: "probeColor",
  orangeColor: "orangeColor",
  buttonTapped: "buttonTapped:",
  addTarget: "addTarget:action:forControlEvents:",
  setAlpha: "setAlpha:",
  grayColor: "grayColor",
  blackColor: "blackColor",
  setText: "setText:",
  setTextColor: "setTextColor:",
  didBecomeActive: "applicationDidBecomeActive:",
  willTerminate: "applicationWillTerminate:",
  setTextAlignment: "setTextAlignment:",
  setClips: "setClipsToBounds:",
  setContentOffset: "setContentOffset:",
  setContentSize: "setContentSize:",
  defaultCenter: "defaultCenter",
  addObserver: "addObserver:selector:name:object:",
  postNotification: "postNotificationName:object:",
  themeChanged: "themeChanged:",
  standardUserDefaults: "standardUserDefaults",
  setBool: "setBool:forKey:",
  boolForKey: "boolForKey:",
  setInteger: "setInteger:forKey:",
  integerForKey: "integerForKey:",
  viewDidLoad: "viewDidLoad",
  viewWillAppear: "viewWillAppear:",
  viewDidAppear: "viewDidAppear:",
} as const;

const TYPES = "v16@0:8";

type SlotName =
  | "classWindow"
  | "classTapView"
  | "protocolTappable"
  | "classColor"
  | "msgSend"
  | "uiApplicationMain"
  | "delegateName"
  | "initializeMarker"
  | "loadMarker"
  | "currentView"
  | "tickIndex"
  | "assocSet"
  | "assocGet"
  | "weakSlot"
  | "weakSet"
  | "weakLoad"
  | "msgSendSuper"
  | "superStruct"
  | "baseInitMarker"
  | "tapInitMarker"
  | "initOrder"
  | "deallocMarker"
  | "classPool"
  | "classButton"
  | "delegateSelf"
  | "classView"
  | "mainView"
  | "classLabel"
  | "activeMarker"
  | "terminateMarker"
  | "nslog"
  | "classScroll"
  | "classCenter"
  | "notificationMarker"
  | "classDefaults"
  | "defaultsMarker"
  | "defaultsInt"
  | "classController"
  | "lifecycleMarker"
  | "willAppearMarker"
  | "didAppearMarker"
  | "appearOrder"
  | "classString"
  | "stringText"
  | "stringLength"
  | "stringEqual"
  | "classMutableArray"
  | "classNumber"
  | "array"
  | "arrayCount"
  | "numberValue"
  | "classDictionary"
  | "dictionary"
  | "dictionaryCount"
  | "classTimer"
  | "timer"
  | "timerFires"
  | "timerColors"
  | "statusView"
  | "classSwitch"
  | "toggle"
  | "switchChanges"
  | "classSlider"
  | "slider"
  | "sliderChanges"
  | "delayedMarker"
  | "userInfoValue"
  | "classImage"
  | "classImageView"
  | "image"
  | "imageView"
  | "classBundle"
  | "bundle"
  | "bundleFound"
  | "bundlePathText"
  | "bundleMissing";

interface Plan {
  readonly slotOffsets: Readonly<Record<SlotName, number>>;
  readonly stringOffsets: Readonly<Record<string, number>>;
  readonly appRo: number;
  readonly appMetaRo: number;
  readonly appEmptyMethods: number;
  readonly appClassMethods: number;
  readonly appCategoryMethods: number;
  readonly appCategory: number;
  readonly lifecycleCategory: number;
  readonly lifecycleMethods: number;
  readonly tapRo: number;
  readonly tapMetaRo: number;
  readonly tapEmptyMethods: number;
  readonly tapMethods: number;
  readonly tapIvars: number;
  readonly tapProtocols: number;
  readonly tappableProtocol: number;
  readonly baseRo: number;
  readonly baseMetaRo: number;
  readonly baseMethods: number;
  readonly tapClassMethods: number;
  readonly baseClassMethods: number;
  readonly appClass: number;
  readonly appMeta: number;
  readonly tapClass: number;
  readonly tapMeta: number;
  readonly baseClass: number;
  readonly baseMeta: number;
  readonly classList: number;
  readonly categoryList: number;
  readonly protocolList: number;
  readonly windowRect: number;
  readonly viewRect: number;
  readonly rectTable: number;
  readonly buttonRect: number;
  readonly overlayRect: number;
  readonly containerRect: number;
  readonly nestedRect: number;
  readonly labelRect: number;
  readonly clipRect: number;
  readonly scrollRect: number;
  readonly scrollContent: number;
  readonly scrollOffset: number;
  readonly scrollChildren: number;
  readonly scrollBand: number;
  readonly timerInterval: number;
  readonly statusRect: number;
  readonly switchRect: number;
  readonly sliderRect: number;
  readonly imageRect: number;
  readonly wrapRect: number;
  readonly animationDuration: number;
  readonly animationAlpha: number;
  readonly half: number;
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
    "protocolTappable",
    "classColor",
    "msgSend",
    "uiApplicationMain",
    "delegateName",
    "initializeMarker",
    "loadMarker",
    "currentView",
    "tickIndex",
    "assocSet",
    "assocGet",
    "weakSlot",
    "weakSet",
    "weakLoad",
    "msgSendSuper",
    "baseInitMarker",
    "tapInitMarker",
    "initOrder",
    "deallocMarker",
    "classPool",
    "classButton",
    "delegateSelf",
    "classView",
    "mainView",
    "classLabel",
    "activeMarker",
    "terminateMarker",
    "nslog",
    "classScroll",
    "classCenter",
    "notificationMarker",
    "classDefaults",
    "defaultsMarker",
    "defaultsInt",
    "classController",
    "lifecycleMarker",
    "willAppearMarker",
    "didAppearMarker",
    "appearOrder",
    "classString",
    "stringText",
    "stringLength",
    "stringEqual",
    "classMutableArray",
    "classNumber",
    "array",
    "arrayCount",
    "numberValue",
    "classDictionary",
    "dictionary",
    "dictionaryCount",
    "classTimer",
    "timer",
    "timerFires",
    "timerColors",
    "statusView",
    "classSwitch",
    "toggle",
    "switchChanges",
    "classSlider",
    "slider",
    "sliderChanges",
    "delayedMarker",
    "userInfoValue",
    "classImage",
    "classImageView",
    "image",
    "imageView",
    "classBundle",
    "bundle",
    "bundleFound",
    "bundlePathText",
    "bundleMissing",
  ];
  const slotOffsets = {} as Record<SlotName, number>;
  for (const name of slotNames) {
    slotOffsets[name] = cursor;
    cursor += 8;
  }
  const superStruct = cursor;
  cursor += 16;
  slotOffsets.superStruct = superStruct;
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
    DEMO_BASE_CLASS_NAME,
    "HELLO 42",
    "hello from objc",
    "ThemeChanged",
    "Seen",
    "Count",
    "count",
    "assets/icon.png",
    "assets/icon",
    "png",
    "nope",
    "WRAP THE LABEL\nSECOND LINE",
    "theme",
    "Lifecycle",
    "Tappable",
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
  cursor += 8 + 10 * 24;
  const appCategory = cursor;
  cursor += 48;
  const lifecycleCategory = cursor;
  cursor += 48;
  const lifecycleMethods = cursor;
  cursor += 8 + 3 * 24;

  const tapRo = cursor;
  cursor += 72;
  const tapMetaRo = cursor;
  cursor += 72;
  const tapEmptyMethods = cursor;
  cursor += 8;
  const tapMethods = cursor;
  cursor += 8 + 5 * 24;
  const tapIvars = cursor;
  cursor += 8 + 32;
  const tapProtocols = cursor;
  cursor += 16;
  const tappableProtocol = cursor;
  cursor += 96;

  const baseRo = cursor;
  cursor += 72;
  const baseMetaRo = cursor;
  cursor += 72;
  const baseMethods = cursor;
  cursor += 8 + 24;
  const tapClassMethods = cursor;
  cursor += 8 + 24;
  const baseClassMethods = cursor;
  cursor += 8 + 24;
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
  const baseClass = cursor;
  cursor += 40;
  const baseMeta = cursor;
  cursor += 40;
  const dataEnd = cursor;

  cursor = align(cursor);
  const classList = cursor;
  cursor += 24;
  const categoryList = cursor;
  cursor += 16;
  const protocolList = cursor;
  cursor += 8;

  cursor = align(cursor);
  const windowRect = cursor;
  cursor += 32;
  const viewRect = cursor;
  cursor += 32;
  const rectTable = cursor;
  cursor += 4 * 32;
  const buttonRect = cursor;
  cursor += 32;
  const overlayRect = cursor;
  cursor += 32;
  const containerRect = cursor;
  cursor += 32;
  const nestedRect = cursor;
  cursor += 32;
  const labelRect = cursor;
  cursor += 32;
  const clipRect = cursor;
  cursor += 32;
  const scrollRect = cursor;
  cursor += 32;
  const scrollContent = cursor;
  cursor += 16;
  const scrollOffset = cursor;
  cursor += 16;
  const scrollChildren = cursor;
  cursor += 64;
  const scrollBand = cursor;
  cursor += 32;
  const statusRect = cursor;
  cursor += 32;
  const switchRect = cursor;
  cursor += 32;
  const sliderRect = cursor;
  cursor += 32;
  const imageRect = cursor;
  cursor += 32;
  const wrapRect = cursor;
  cursor += 32;
  const animationDuration = cursor;
  cursor += 8;
  const animationAlpha = cursor;
  cursor += 8;
  const timerInterval = cursor;
  cursor += 8;
  const half = cursor;
  cursor += 8;

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
      size: 24,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__objc_catlist",
      offset: categoryList,
      size: 16,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__objc_protolist",
      offset: protocolList,
      size: 8,
      alignment: 3,
      flags: S_REGULAR,
    },
    {
      name: "__const",
      offset: windowRect,
      size: cursor - windowRect,
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
    lifecycleCategory,
    lifecycleMethods,
    tapRo,
    tapMetaRo,
    tapEmptyMethods,
    tapMethods,
    tapIvars,
    tapProtocols,
    tappableProtocol,
    baseRo,
    baseMetaRo,
    baseMethods,
    tapClassMethods,
    baseClassMethods,
    appClass,
    appMeta,
    tapClass,
    tapMeta,
    baseClass,
    baseMeta,
    classList,
    categoryList,
    protocolList,
    windowRect,
    viewRect,
    rectTable,
    buttonRect,
    overlayRect,
    containerRect,
    nestedRect,
    labelRect,
    clipRect,
    scrollRect,
    scrollContent,
    scrollOffset,
    scrollChildren,
    scrollBand,
    statusRect,
    switchRect,
    sliderRect,
    imageRect,
    wrapRect,
    animationDuration,
    animationAlpha,
    timerInterval,
    half,
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
  const emitStore = (register: number, address: number): void => {
    emitWord(adrp(9, address, pc()));
    emitWord(strUnsigned(register, 9, address & 0xfff));
  };
  const emitMarker = (address: number, value: number): void => {
    emitWord(adrp(9, address, pc()));
    emitWord(movz(10, value));
    emitWord(strUnsigned(10, 9, address & 0xfff));
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

  label("baseInitialize");
  emitMarker(slot("baseInitMarker"), 1);
  emitMarker(slot("initOrder"), 1);
  emitWord(ret());

  label("tapInitialize");
  emitMarker(slot("tapInitMarker"), 1);
  emitMarker(slot("initOrder"), 2);
  emitWord(ret());

  label("tick");
  emitTick();

  label("delegate");
  emitDelegate();

  label("tapBegan");
  emitBeganHandler();
  label("tapSuperBegan");
  emitSuperBeganHandler();
  label("tapMoved");
  emitTouchHandler(SELECTORS.yellowColor);
  label("tapEnded");
  emitTouchHandler(SELECTORS.greenColor);

  label("tapDealloc");
  emitMarker(slot("deallocMarker"), 1);
  emitWord(ret());

  label("appActive");
  emitMarker(slot("activeMarker"), 1);
  emitWord(ret());

  label("appTerminate");
  emitMarker(slot("terminateMarker"), 1);
  emitWord(ret());

  label("tapButton");
  emitWord(stpPre(29, 30, 31, -16));
  emitWord(stpPre(19, 20, 31, -16));
  emitPointer(0, slot("classCenter"));
  emitAddress(1, selector(SELECTORS.defaultCenter));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(movReg(19, 0));
  // NSMutableDictionary *info = [NSMutableDictionary dictionary];
  emitPointer(0, slot("classDictionary"));
  emitAddress(1, selector(SELECTORS.dictionary));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(movReg(20, 0));
  // [info setObject:[NSNumber numberWithInt:7] forKey:"count"];
  emitPointer(0, slot("classNumber"));
  emitAddress(1, selector(SELECTORS.numberWithInt));
  emitWord(movz(2, 7));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(movReg(2, 0));
  emitWord(movReg(0, 20));
  emitAddress(1, selector(SELECTORS.setObjectForKey));
  emitAddress(3, dataAddress(plan.stringOffsets.count!));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  // [center postNotificationName:"ThemeChanged" object:0 userInfo:info];
  emitWord(movReg(0, 19));
  emitAddress(1, selector(SELECTORS.postNotificationUserInfo));
  emitAddress(2, dataAddress(plan.stringOffsets.ThemeChanged!));
  emitWord(movz(3, 0));
  emitWord(movReg(4, 20));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(ldpPost(19, 20, 31, 16));
  emitWord(ldpPost(29, 30, 31, 16));
  emitWord(ret());

  label("delayedTick");
  emitMarker(slot("delayedMarker"), 1);
  emitWord(ret());

  label("sliderChanged");
  emitPointer(19, slot("sliderChanges"));
  emitWord(addImm(19, 19, 1));
  emitStore(19, slot("sliderChanges"));
  emitWord(ret());

  label("switchChanged");
  emitMarker(slot("switchChanges"), 1);
  emitWord(ret());

  label("timerFired");
  emitWord(stpPre(29, 30, 31, -16));
  emitWord(stpPre(19, 20, 31, -16));
  // UIColor *color = [timerColors objectAtIndex:(timerFires & 1)];
  emitPointer(19, slot("timerFires"));
  emitWord(movz(10, 1));
  emitWord(and(2, 19, 10));
  emitPointer(0, slot("timerColors"));
  emitAddress(1, selector(SELECTORS.objectAtIndex));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(movReg(2, 0));
  emitPointer(0, slot("statusView"));
  emitWord(movReg(20, 0));
  emitWord(movReg(0, 20));
  emitAddress(1, selector(SELECTORS.setBackgroundColor));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitPointer(19, slot("timerFires"));
  emitWord(addImm(19, 19, 1));
  emitStore(19, slot("timerFires"));
  emitWord(ldpPost(19, 20, 31, 16));
  emitWord(ldpPost(29, 30, 31, 16));
  emitWord(ret());

  label("viewDidLoad");
  emitMarker(slot("lifecycleMarker"), 1);
  emitWord(ret());

  label("viewWillAppear");
  emitMarker(slot("willAppearMarker"), 1);
  emitWord(ret());

  label("viewDidAppear");
  emitPointer(0, slot("lifecycleMarker"));
  emitStore(0, slot("appearOrder"));
  emitMarker(slot("didAppearMarker"), 1);
  emitWord(ret());

  label("themeChanged");
  emitWord(stpPre(29, 30, 31, -16));
  emitWord(stpPre(19, 20, 31, -16));
  // NSNumber *count = [[notification userInfo] objectForKey:"count"];
  emitWord(movReg(0, 2));
  emitAddress(1, selector(SELECTORS.userInfo));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(movReg(0, 0));
  emitAddress(1, selector(SELECTORS.objectForKey));
  emitAddress(2, dataAddress(plan.stringOffsets.count!));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitAddress(1, selector(SELECTORS.intValue));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitStore(0, slot("userInfoValue"));
  emitPointer(0, slot("mainView"));
  emitWord(movReg(19, 0));
  // UIColor *color = [theme objectForKey:"theme"];
  emitPointer(0, slot("dictionary"));
  emitAddress(1, selector(SELECTORS.objectForKey));
  emitAddress(2, dataAddress(plan.stringOffsets.theme!));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(movReg(2, 0));
  emitWord(movReg(0, 19));
  emitAddress(1, selector(SELECTORS.setBackgroundColor));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitMarker(slot("notificationMarker"), 1);
  emitWord(ldpPost(19, 20, 31, 16));
  emitWord(ldpPost(29, 30, 31, 16));
  emitWord(ret());

  label("tapProbeColor");
  emitWord(stpPre(29, 30, 31, -16));
  emitPointer(0, slot("classColor"));
  emitAddress(1, selector(SELECTORS.blueColor));
  emitPointer(16, slot("msgSend"));
  emitWord(blr(16));
  emitWord(ldpPost(29, 30, 31, 16));
  emitWord(ret());

  const data = emitData(
    bases,
    plan,
    selector,
    bases.textBase + (code.labels.get("delegate") ?? 0),
    bases.textBase + (code.labels.get("initialize") ?? 0),
    bases.textBase + (code.labels.get("load") ?? 0),
    bases.textBase + (code.labels.get("baseInitialize") ?? 0),
    bases.textBase + (code.labels.get("tapInitialize") ?? 0),
    bases.textBase + (code.labels.get("tick") ?? 0),
    bases.textBase + (code.labels.get("tapBegan") ?? 0),
    bases.textBase + (code.labels.get("tapSuperBegan") ?? 0),
    bases.textBase + (code.labels.get("tapMoved") ?? 0),
    bases.textBase + (code.labels.get("tapEnded") ?? 0),
    bases.textBase + (code.labels.get("tapDealloc") ?? 0),
    bases.textBase + (code.labels.get("tapProbeColor") ?? 0),
    bases.textBase + (code.labels.get("tapButton") ?? 0),
    bases.textBase + (code.labels.get("appActive") ?? 0),
    bases.textBase + (code.labels.get("appTerminate") ?? 0),
    bases.textBase + (code.labels.get("themeChanged") ?? 0),
    bases.textBase + (code.labels.get("viewDidLoad") ?? 0),
    bases.textBase + (code.labels.get("viewWillAppear") ?? 0),
    bases.textBase + (code.labels.get("viewDidAppear") ?? 0),
    bases.textBase + (code.labels.get("timerFired") ?? 0),
    bases.textBase + (code.labels.get("switchChanged") ?? 0),
    bases.textBase + (code.labels.get("sliderChanged") ?? 0),
    bases.textBase + (code.labels.get("delayedTick") ?? 0),
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
      { name: "_OBJC_CLASS_$_BaseView", value: dataAddress(plan.baseClass), sectionIndex: 5 },
      {
        name: "_initializeMarker",
        value: dataAddress(plan.slotOffsets.initializeMarker),
        sectionIndex: 2,
      },
      { name: "_loadMarker", value: dataAddress(plan.slotOffsets.loadMarker), sectionIndex: 2 },
      {
        name: "_baseInitMarker",
        value: dataAddress(plan.slotOffsets.baseInitMarker),
        sectionIndex: 2,
      },
      {
        name: "_tapInitMarker",
        value: dataAddress(plan.slotOffsets.tapInitMarker),
        sectionIndex: 2,
      },
      { name: "_initOrder", value: dataAddress(plan.slotOffsets.initOrder), sectionIndex: 2 },
      {
        name: "_activeMarker",
        value: dataAddress(plan.slotOffsets.activeMarker),
        sectionIndex: 2,
      },
      {
        name: "_terminateMarker",
        value: dataAddress(plan.slotOffsets.terminateMarker),
        sectionIndex: 2,
      },
      {
        name: "_lifecycleMarker",
        value: dataAddress(plan.slotOffsets.lifecycleMarker),
        sectionIndex: 2,
      },
      {
        name: "_userInfoValue",
        value: dataAddress(plan.slotOffsets.userInfoValue),
        sectionIndex: 2,
      },
      {
        name: "_bundleFound",
        value: dataAddress(plan.slotOffsets.bundleFound),
        sectionIndex: 2,
      },
      {
        name: "_bundlePathText",
        value: dataAddress(plan.slotOffsets.bundlePathText),
        sectionIndex: 2,
      },
      {
        name: "_bundleMissing",
        value: dataAddress(plan.slotOffsets.bundleMissing),
        sectionIndex: 2,
      },
      {
        name: "_delayedMarker",
        value: dataAddress(plan.slotOffsets.delayedMarker),
        sectionIndex: 2,
      },
      {
        name: "_sliderChanges",
        value: dataAddress(plan.slotOffsets.sliderChanges),
        sectionIndex: 2,
      },
      {
        name: "_switchChanges",
        value: dataAddress(plan.slotOffsets.switchChanges),
        sectionIndex: 2,
      },
      {
        name: "_timerFires",
        value: dataAddress(plan.slotOffsets.timerFires),
        sectionIndex: 2,
      },
      {
        name: "_dictionaryCount",
        value: dataAddress(plan.slotOffsets.dictionaryCount),
        sectionIndex: 2,
      },
      {
        name: "_arrayCount",
        value: dataAddress(plan.slotOffsets.arrayCount),
        sectionIndex: 2,
      },
      {
        name: "_numberValue",
        value: dataAddress(plan.slotOffsets.numberValue),
        sectionIndex: 2,
      },
      {
        name: "_stringLength",
        value: dataAddress(plan.slotOffsets.stringLength),
        sectionIndex: 2,
      },
      {
        name: "_stringEqual",
        value: dataAddress(plan.slotOffsets.stringEqual),
        sectionIndex: 2,
      },
      {
        name: "_willAppearMarker",
        value: dataAddress(plan.slotOffsets.willAppearMarker),
        sectionIndex: 2,
      },
      {
        name: "_didAppearMarker",
        value: dataAddress(plan.slotOffsets.didAppearMarker),
        sectionIndex: 2,
      },
      {
        name: "_appearOrder",
        value: dataAddress(plan.slotOffsets.appearOrder),
        sectionIndex: 2,
      },
      {
        name: "_defaultsMarker",
        value: dataAddress(plan.slotOffsets.defaultsMarker),
        sectionIndex: 2,
      },
      {
        name: "_defaultsInt",
        value: dataAddress(plan.slotOffsets.defaultsInt),
        sectionIndex: 2,
      },
      {
        name: "_notificationMarker",
        value: dataAddress(plan.slotOffsets.notificationMarker),
        sectionIndex: 2,
      },
      {
        name: "_deallocMarker",
        value: dataAddress(plan.slotOffsets.deallocMarker),
        sectionIndex: 2,
      },
    ],
  };

  function emitSuperBeganHandler(): void {
    // struct objc_super { receiver, super_class } at superStruct.
    emitWord(stpPre(29, 30, 31, -16));
    emitAddress(9, slot("superStruct"));
    emitWord(strUnsigned(0, 9, 0));
    emitAddress(0, slot("superStruct"));
    emitAddress(1, selector(SELECTORS.touchesBegan));
    emitPointer(16, slot("msgSendSuper"));
    emitWord(blr(16));
    emitWord(ldpPost(29, 30, 31, 16));
    emitWord(ret());
  }

  function emitTick(): void {
    emitWord(stpPre(29, 30, 31, -16));
    emitWord(stpPre(19, 20, 31, -16));
    // index = index + 1
    emitAddress(9, slot("tickIndex"));
    emitWord(ldrUnsigned(10, 9, 0));
    emitWord(addImm(10, 10, 1));
    emitWord(strUnsigned(10, 9, 0));
    // x11 = rectTable + (index & 3) * 32
    emitWord(ubfm(11, 10, 0, 1));
    emitWord(lslImm(11, 11, 5));
    emitAddress(12, dataAddress(plan.rectTable));
    emitWord(addReg(11, 12, 11));
    // [mainView setFrame:...]
    emitPointer(0, slot("mainView"));
    emitAddress(1, selector(SELECTORS.setFrame));
    emitWord(ldrDouble(0, 11, 0));
    emitWord(ldrDouble(1, 11, 8));
    emitWord(ldrDouble(2, 11, 16));
    emitWord(ldrDouble(3, 11, 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(ldpPost(19, 20, 31, 16));
    emitWord(ldpPost(29, 30, 31, 16));
    emitWord(ret());
  }

  function emitDelegate(): void {
    // -[AppDelegate(Window) application:didFinishLaunchingWithOptions:] -> BOOL
    emitWord(stpPre(29, 30, 31, -16));
    emitWord(stpPre(19, 20, 31, -16));
    emitWord(stpPre(21, 22, 31, -16));
    emitStore(0, slot("delegateSelf"));
    emitAddress(0, dataAddress(plan.stringOffsets["hello from objc"]!));
    emitPointer(16, slot("nslog"));
    emitWord(blr(16));

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
    emitStore(20, slot("currentView"));
    emitStore(20, slot("mainView"));

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

    // UIView *overlay = [[UIView alloc] initWithFrame:CGRectMake(250,20,100,100)];
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.overlayRect));
    emitDouble(1, dataAddress(plan.overlayRect + 8));
    emitDouble(2, dataAddress(plan.overlayRect + 16));
    emitDouble(3, dataAddress(plan.overlayRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.greenColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setAlpha));
    emitDouble(0, dataAddress(plan.half));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UIView *container = [[UIView alloc] initWithFrame:(20,140,200,100)];
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.containerRect));
    emitDouble(1, dataAddress(plan.containerRect + 8));
    emitDouble(2, dataAddress(plan.containerRect + 16));
    emitDouble(3, dataAddress(plan.containerRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.grayColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // TapView *nested = [[TapView alloc] initWithFrame:(10,10,80,40)];
    emitWord(movReg(22, 21));
    emitPointer(0, slot("classTapView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.nestedRect));
    emitDouble(1, dataAddress(plan.nestedRect + 8));
    emitDouble(2, dataAddress(plan.nestedRect + 16));
    emitDouble(3, dataAddress(plan.nestedRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.redColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 22));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UIView *clipChild = [[UIView alloc] initWithFrame:(150,50,100,40)];
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.clipRect));
    emitDouble(1, dataAddress(plan.clipRect + 8));
    emitDouble(2, dataAddress(plan.clipRect + 16));
    emitDouble(3, dataAddress(plan.clipRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.redColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 22));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 22));
    emitAddress(1, selector(SELECTORS.setClips));
    emitWord(movz(2, 1));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UIButton *button = [UIButton alloc];
    emitPointer(0, slot("classButton"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.buttonRect));
    emitDouble(1, dataAddress(plan.buttonRect + 8));
    emitDouble(2, dataAddress(plan.buttonRect + 16));
    emitDouble(3, dataAddress(plan.buttonRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.addTarget));
    emitPointer(2, slot("delegateSelf"));
    emitAddress(3, selector(SELECTORS.buttonTapped));
    emitWord(movz(4, 64));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UISwitch *toggle = [[UISwitch alloc] initWithFrame:(280,310,60,32)];
    emitPointer(0, slot("classSwitch"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.switchRect));
    emitDouble(1, dataAddress(plan.switchRect + 8));
    emitDouble(2, dataAddress(plan.switchRect + 16));
    emitDouble(3, dataAddress(plan.switchRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(21, slot("toggle"));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.addTarget));
    emitPointer(2, slot("delegateSelf"));
    emitAddress(3, selector(SELECTORS.switchChanged));
    emitWord(movz(4, 4096 & 0xffff));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UISlider *slider = [[UISlider alloc] initWithFrame:(20,560,300,24)];
    emitPointer(0, slot("classSlider"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.sliderRect));
    emitDouble(1, dataAddress(plan.sliderRect + 8));
    emitDouble(2, dataAddress(plan.sliderRect + 16));
    emitDouble(3, dataAddress(plan.sliderRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(21, slot("slider"));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.addTarget));
    emitPointer(2, slot("delegateSelf"));
    emitAddress(3, selector(SELECTORS.sliderChanged));
    emitWord(movz(4, 4096));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // NSBundle *bundle = [NSBundle mainBundle];
    // NSString *found = [bundle pathForResource:"icon" ofType:"png"];
    emitPointer(0, slot("classBundle"));
    emitAddress(1, selector(SELECTORS.mainBundle));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("bundle"));
    emitPointer(0, slot("bundle"));
    emitAddress(1, selector(SELECTORS.pathForResource));
    emitAddress(2, dataAddress(plan.stringOffsets["assets/icon"]!));
    emitAddress(3, dataAddress(plan.stringOffsets.png!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("bundleFound"));
    emitAddress(1, selector(SELECTORS.utf8String));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("bundlePathText"));
    // NSString *missing = [bundle pathForResource:"nope" ofType:"png"];
    emitPointer(0, slot("bundle"));
    emitAddress(1, selector(SELECTORS.pathForResource));
    emitAddress(2, dataAddress(plan.stringOffsets.nope!));
    emitAddress(3, dataAddress(plan.stringOffsets.png!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("bundleMissing"));

    // UILabel *wrapped = [[UILabel alloc] initWithFrame:(20,240,300,60)];
    emitPointer(0, slot("classLabel"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.wrapRect));
    emitDouble(1, dataAddress(plan.wrapRect + 8));
    emitDouble(2, dataAddress(plan.wrapRect + 16));
    emitDouble(3, dataAddress(plan.wrapRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setText));
    emitAddress(2, dataAddress(plan.stringOffsets["WRAP THE LABEL\nSECOND LINE"]!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setNumberOfLines));
    emitWord(movz(2, 0));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UIImageView *picture = [[UIImageView alloc] initWithImage:
    //     [UIImage imageNamed:"assets/icon.png"]];
    emitPointer(0, slot("classImage"));
    emitAddress(1, selector(SELECTORS.imageNamed));
    emitAddress(2, dataAddress(plan.stringOffsets["assets/icon.png"]!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("image"));
    emitPointer(0, slot("classImageView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithImage));
    emitPointer(2, slot("image"));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setFrame));
    emitDouble(0, dataAddress(plan.imageRect));
    emitDouble(1, dataAddress(plan.imageRect + 8));
    emitDouble(2, dataAddress(plan.imageRect + 16));
    emitDouble(3, dataAddress(plan.imageRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(21, slot("imageView"));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [UIView beginAnimations:nil context:0];
    // [UIView setAnimationDuration:2]; [picture setAlpha:0.25];
    // [UIView commitAnimations];
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.beginAnimations));
    emitWord(movz(2, 0));
    emitWord(movz(3, 0));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.setAnimationDuration));
    emitDouble(0, dataAddress(plan.animationDuration));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("imageView"));
    emitAddress(1, selector(SELECTORS.setAlpha));
    emitDouble(0, dataAddress(plan.animationAlpha));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.commitAnimations));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UILabel *label = [[UILabel alloc] initWithFrame:(20,400,300,40)];
    emitPointer(0, slot("classLabel"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.labelRect));
    emitDouble(1, dataAddress(plan.labelRect + 8));
    emitDouble(2, dataAddress(plan.labelRect + 16));
    emitDouble(3, dataAddress(plan.labelRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // NSString *text = [NSString stringWithUTF8String:"HELLO 42"];
    emitPointer(0, slot("classString"));
    emitAddress(1, selector(SELECTORS.stringWithUTF8String));
    emitAddress(2, dataAddress(plan.stringOffsets["HELLO 42"]!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("stringText"));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setText));
    emitPointer(2, slot("stringText"));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // (void)[[label text] length]; (void)[[label text] isEqualToString:text];
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.text));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(20, 0));
    emitWord(movReg(0, 20));
    emitAddress(1, selector(SELECTORS.length));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("stringLength"));
    emitPointer(0, slot("classString"));
    emitAddress(1, selector(SELECTORS.stringWithUTF8String));
    emitAddress(2, dataAddress(plan.stringOffsets["HELLO 42"]!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 20));
    emitAddress(1, selector(SELECTORS.isEqualToString));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("stringEqual"));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.blackColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setTextColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setTextAlignment));
    emitWord(movz(2, 1));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UIScrollView *scroll = [[UIScrollView alloc] initWithFrame:(20,470,300,80)];
    emitPointer(0, slot("classScroll"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.scrollRect));
    emitDouble(1, dataAddress(plan.scrollRect + 8));
    emitDouble(2, dataAddress(plan.scrollRect + 16));
    emitDouble(3, dataAddress(plan.scrollRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setContentSize));
    emitDouble(0, dataAddress(plan.scrollContent));
    emitDouble(1, dataAddress(plan.scrollContent + 8));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setContentOffset));
    emitDouble(0, dataAddress(plan.scrollOffset));
    emitDouble(1, dataAddress(plan.scrollOffset + 8));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // Red child at (0,0,300,80) and blue child at (0,80,300,120) inside the scroll view.
    emitWord(movReg(22, 21));
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.scrollChildren));
    emitDouble(1, dataAddress(plan.scrollChildren + 8));
    emitDouble(2, dataAddress(plan.scrollChildren + 16));
    emitDouble(3, dataAddress(plan.scrollChildren + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.redColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 22));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // blue child
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.scrollChildren + 32));
    emitDouble(1, dataAddress(plan.scrollChildren + 40));
    emitDouble(2, dataAddress(plan.scrollChildren + 48));
    emitDouble(3, dataAddress(plan.scrollChildren + 56));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.blueColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 22));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // UIView *band = [[UIView alloc] initWithFrame:(0,160,300,40)]; [scroll addSubview:band];
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.scrollBand));
    emitDouble(1, dataAddress(plan.scrollBand + 8));
    emitDouble(2, dataAddress(plan.scrollBand + 16));
    emitDouble(3, dataAddress(plan.scrollBand + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.yellowColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 22));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [[NSNotificationCenter defaultCenter] addObserver:self
    //     selector:@selector(themeChanged:) name:"ThemeChanged" object:0];
    emitPointer(0, slot("classCenter"));
    emitAddress(1, selector(SELECTORS.defaultCenter));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.addObserver));
    emitPointer(2, slot("delegateSelf"));
    emitAddress(3, selector(SELECTORS.themeChanged));
    emitAddress(4, dataAddress(plan.stringOffsets.ThemeChanged!));
    emitWord(movz(5, 0));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    emitPointer(0, slot("classDefaults"));
    emitAddress(1, selector(SELECTORS.standardUserDefaults));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setBool));
    emitWord(movz(2, 1));
    emitAddress(3, dataAddress(plan.stringOffsets.Seen!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.boolForKey));
    emitAddress(2, dataAddress(plan.stringOffsets.Seen!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("defaultsMarker"));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.setInteger));
    emitWord(movz(2, 7));
    emitAddress(3, dataAddress(plan.stringOffsets.Count!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.integerForKey));
    emitAddress(2, dataAddress(plan.stringOffsets.Count!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("defaultsInt"));

    // UIViewController *controller = [[UIViewController alloc] init]; (void)[controller view];
    emitPointer(0, slot("classController"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitAddress(1, selector(SELECTORS.init));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.view));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.setRootViewController));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // NSMutableArray *colors = [NSMutableArray array];
    emitPointer(0, slot("classMutableArray"));
    emitAddress(1, selector(SELECTORS.array));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("array"));
    // [colors addObject:[UIColor redColor]];
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.redColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitPointer(0, slot("array"));
    emitAddress(1, selector(SELECTORS.addObject));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // [colors addObject:[UIColor purpleColor]];
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.purpleColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitPointer(0, slot("array"));
    emitAddress(1, selector(SELECTORS.addObject));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // (void)[colors count];
    emitPointer(0, slot("array"));
    emitAddress(1, selector(SELECTORS.count));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("arrayCount"));
    // NSMutableDictionary *theme = [NSMutableDictionary dictionary];
    emitPointer(0, slot("classDictionary"));
    emitAddress(1, selector(SELECTORS.dictionary));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("dictionary"));
    // [theme setObject:[colors objectAtIndex:1] forKey:"theme"];
    emitPointer(0, slot("array"));
    emitAddress(1, selector(SELECTORS.objectAtIndex));
    emitWord(movz(2, 1));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitPointer(0, slot("dictionary"));
    emitAddress(1, selector(SELECTORS.setObjectForKey));
    emitAddress(3, dataAddress(plan.stringOffsets.theme!));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // (void)[theme count];
    emitPointer(0, slot("dictionary"));
    emitAddress(1, selector(SELECTORS.count));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("dictionaryCount"));
    // NSNumber *number = [NSNumber numberWithInt:5]; (void)[number intValue];
    emitPointer(0, slot("classNumber"));
    emitAddress(1, selector(SELECTORS.numberWithInt));
    emitWord(movz(2, 5));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(20, 0));
    emitWord(movReg(0, 20));
    emitAddress(1, selector(SELECTORS.intValue));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(addImm(0, 0, 1));
    emitStore(0, slot("numberValue"));

    // UIView *status = [[UIView alloc] initWithFrame:(0,620,375,40)]; [window addSubview:status];
    emitPointer(0, slot("classView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.initWithFrame));
    emitDouble(0, dataAddress(plan.statusRect));
    emitDouble(1, dataAddress(plan.statusRect + 8));
    emitDouble(2, dataAddress(plan.statusRect + 16));
    emitDouble(3, dataAddress(plan.statusRect + 24));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(21, slot("statusView"));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.addSubview));
    emitWord(movReg(2, 21));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // NSMutableArray *timerColors = [NSMutableArray array];
    emitPointer(0, slot("classMutableArray"));
    emitAddress(1, selector(SELECTORS.array));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("timerColors"));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.greenColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitPointer(0, slot("timerColors"));
    emitAddress(1, selector(SELECTORS.addObject));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.orangeColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    emitPointer(0, slot("timerColors"));
    emitAddress(1, selector(SELECTORS.addObject));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [NSTimer scheduledTimerWithTimeInterval:1 target:self
    //     selector:@selector(timerFired:) repeats:YES];
    emitPointer(0, slot("classTimer"));
    emitAddress(1, selector(SELECTORS.scheduledTimer));
    emitDouble(0, dataAddress(plan.timerInterval));
    emitPointer(2, slot("delegateSelf"));
    emitAddress(3, selector(SELECTORS.timerFired));
    emitWord(movz(4, 1));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitStore(0, slot("timer"));

    // [self performSelector:@selector(delayedTick:) withObject:nil afterDelay:0.5];
    emitPointer(0, slot("delegateSelf"));
    emitAddress(1, selector(SELECTORS.performAfterDelay));
    emitAddress(2, selector(SELECTORS.delayedTick));
    emitWord(movz(3, 0));
    emitDouble(0, dataAddress(plan.half));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // [window makeKeyAndVisible];
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.makeKeyAndVisible));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // Temporary TapView: releasing it runs the guest -dealloc override.
    emitPointer(0, slot("classTapView"));
    emitAddress(1, selector(SELECTORS.alloc));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.release));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    // NSAutoreleasePool *pool = [NSAutoreleasePool new]; [pool drain];
    emitPointer(0, slot("classPool"));
    emitAddress(1, selector(SELECTORS.new));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(21, 0));
    emitWord(movReg(0, 21));
    emitAddress(1, selector(SELECTORS.drain));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));

    emitWord(movz(0, 1));
    emitWord(ldpPost(21, 22, 31, 16));
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

  function emitBeganHandler(): void {
    emitWord(stpPre(29, 30, 31, -16));
    emitWord(stpPre(19, 20, 31, -16));
    emitWord(movReg(19, 0));
    // Weak reference must be zeroed when its object is released.
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.redColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(20, 0));
    emitAddress(0, slot("weakSlot"));
    emitWord(movReg(1, 20));
    emitPointer(16, slot("weakSet"));
    emitWord(blr(16));
    emitWord(movReg(0, 20));
    emitAddress(1, selector(SELECTORS.release));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitAddress(0, slot("weakSlot"));
    emitPointer(16, slot("weakLoad"));
    emitWord(blr(16));
    const weakFail = code.words.length;
    emitWord(0);
    // Exercise retain/release bookkeeping without changing the colour.
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.retain));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.autorelease));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // if ([self conformsToProtocol:@protocol(Tappable)]) blue else purple
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.conformsToProtocol));
    emitPointer(2, slot("protocolTappable"));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    const skipBlue = code.words.length;
    emitWord(0);
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.blueColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    // objc_setAssociatedObject(self, @protocol(Tappable), blue, RETAIN);
    emitWord(movReg(2, 0));
    emitWord(movReg(0, 19));
    emitAddress(1, dataAddress(plan.tappableProtocol));
    emitWord(movz(3, 1));
    emitPointer(16, slot("assocSet"));
    emitWord(blr(16));
    // blue = objc_getAssociatedObject(self, key);
    emitWord(movReg(0, 19));
    emitAddress(1, dataAddress(plan.tappableProtocol));
    emitPointer(16, slot("assocGet"));
    emitWord(blr(16));
    // UIColor *probed = [self performSelector:@selector(probeColor)];
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.performSelector));
    emitAddress(2, selector(SELECTORS.probeColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    const jumpToApply = code.words.length;
    emitWord(0);
    const purple = code.words.length;
    emitPointer(0, slot("classColor"));
    emitAddress(1, selector(SELECTORS.purpleColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(movReg(2, 0));
    const apply = code.words.length;
    emitWord(movReg(0, 19));
    emitAddress(1, selector(SELECTORS.setBackgroundColor));
    emitPointer(16, slot("msgSend"));
    emitWord(blr(16));
    emitWord(ldpPost(19, 20, 31, 16));
    emitWord(ldpPost(29, 30, 31, 16));
    emitWord(ret());
    code.words[skipBlue] = cbz(0, (purple - skipBlue) * 4);
    code.words[jumpToApply] = b((apply - jumpToApply) * 4);
    code.words[weakFail] = cbnz(0, (purple - weakFail) * 4);
  }
}

function emitData(
  bases: { textBase: number; dataBase: number },
  plan: Plan,
  selector: (name: string) => number,
  delegateImp: number,
  initializeImp: number,
  loadImp: number,
  baseInitializeImp: number,
  tapInitializeImp: number,
  tickImp: number,
  tapBeganImp: number,
  tapSuperBeganImp: number,
  tapMovedImp: number,
  tapEndedImp: number,
  tapDeallocImp: number,
  tapProbeColorImp: number,
  tapButtonImp: number,
  appActiveImp: number,
  appTerminateImp: number,
  themeChangedImp: number,
  viewDidLoadImp: number,
  viewWillAppearImp: number,
  viewDidAppearImp: number,
  timerFiredImp: number,
  switchChangedImp: number,
  sliderChangedImp: number,
  delayedTickImp: number,
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
    DEMO_BASE_CLASS_NAME,
    "HELLO 42",
    "hello from objc",
    "ThemeChanged",
    "Seen",
    "Count",
    "count",
    "assets/icon.png",
    "assets/icon",
    "png",
    "nope",
    "WRAP THE LABEL\nSECOND LINE",
    "theme",
    "Lifecycle",
    "Tappable",
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
  u32(plan.appCategoryMethods + 4, 10);

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
  const tickEntry = plan.appCategoryMethods + 32;
  rebase(tickEntry, selector(SELECTORS.tick));
  rebase(tickEntry + 8, selector(TYPES));
  rebase(tickEntry + 16, tickImp);
  const buttonEntry = plan.appCategoryMethods + 56;
  rebase(buttonEntry, selector(SELECTORS.buttonTapped));
  rebase(buttonEntry + 8, selector(TYPES));
  rebase(buttonEntry + 16, tapButtonImp);
  const activeEntry = plan.appCategoryMethods + 80;
  rebase(activeEntry, selector(SELECTORS.didBecomeActive));
  rebase(activeEntry + 8, selector(TYPES));
  rebase(activeEntry + 16, appActiveImp);
  const terminateEntry = plan.appCategoryMethods + 104;
  rebase(terminateEntry, selector(SELECTORS.willTerminate));
  rebase(terminateEntry + 8, selector(TYPES));
  rebase(terminateEntry + 16, appTerminateImp);
  const themeEntry = plan.appCategoryMethods + 128;
  rebase(themeEntry, selector(SELECTORS.themeChanged));
  rebase(themeEntry + 8, selector(TYPES));
  rebase(themeEntry + 16, themeChangedImp);
  const timerEntry = plan.appCategoryMethods + 152;
  rebase(timerEntry, selector(SELECTORS.timerFired));
  rebase(timerEntry + 8, selector(TYPES));
  rebase(timerEntry + 16, timerFiredImp);
  const switchEntry = plan.appCategoryMethods + 176;
  rebase(switchEntry, selector(SELECTORS.switchChanged));
  rebase(switchEntry + 8, selector(TYPES));
  rebase(switchEntry + 16, switchChangedImp);
  const sliderEntry = plan.appCategoryMethods + 200;
  rebase(sliderEntry, selector(SELECTORS.sliderChanged));
  rebase(sliderEntry + 8, selector(TYPES));
  rebase(sliderEntry + 16, sliderChangedImp);
  const delayedEntry = plan.appCategoryMethods + 224;
  rebase(delayedEntry, selector(SELECTORS.delayedTick));
  rebase(delayedEntry + 8, selector(TYPES));
  rebase(delayedEntry + 16, delayedTickImp);

  // category_t { name, cls, instanceMethods, classMethods, protocols,
  //              properties, classProperties }
  rebase(plan.appCategory, address(plan.stringOffsets[DEMO_CATEGORY_NAME]!));
  rebase(plan.appCategory + 8, address(plan.appClass));
  rebase(plan.appCategory + 16, address(plan.appCategoryMethods));

  // UIViewController (Lifecycle) category.
  rebase(plan.lifecycleCategory, address(plan.stringOffsets.Lifecycle!));
  bind(plan.lifecycleCategory + 8, "_OBJC_CLASS_$_UIViewController");
  rebase(plan.lifecycleCategory + 16, address(plan.lifecycleMethods));
  u32(plan.lifecycleMethods, 24);
  u32(plan.lifecycleMethods + 4, 3);
  const lifecycleEntry = plan.lifecycleMethods + 8;
  rebase(lifecycleEntry, selector(SELECTORS.viewDidLoad));
  rebase(lifecycleEntry + 8, selector(TYPES));
  rebase(lifecycleEntry + 16, viewDidLoadImp);
  rebase(lifecycleEntry + 24, selector(SELECTORS.viewWillAppear));
  rebase(lifecycleEntry + 32, selector(TYPES));
  rebase(lifecycleEntry + 40, viewWillAppearImp);
  rebase(lifecycleEntry + 48, selector(SELECTORS.viewDidAppear));
  rebase(lifecycleEntry + 56, selector(TYPES));
  rebase(lifecycleEntry + 64, viewDidAppearImp);

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
  u32(plan.tapMethods + 4, 5);

  const beganEntry = plan.tapMethods + 8;
  rebase(beganEntry, selector(SELECTORS.touchesBegan));
  rebase(beganEntry + 8, selector(TYPES));
  rebase(beganEntry + 16, tapSuperBeganImp);
  const movedEntry = plan.tapMethods + 32;
  rebase(movedEntry, selector(SELECTORS.touchesMoved));
  rebase(movedEntry + 8, selector(TYPES));
  rebase(movedEntry + 16, tapMovedImp);
  const endedEntry = plan.tapMethods + 56;
  rebase(endedEntry, selector(SELECTORS.touchesEnded));
  rebase(endedEntry + 8, selector(TYPES));
  rebase(endedEntry + 16, tapEndedImp);
  const deallocEntry = plan.tapMethods + 80;
  rebase(deallocEntry, selector(SELECTORS.dealloc));
  rebase(deallocEntry + 8, selector(TYPES));
  rebase(deallocEntry + 16, tapDeallocImp);
  const probeEntry = plan.tapMethods + 104;
  rebase(probeEntry, selector(SELECTORS.probeColor));
  rebase(probeEntry + 8, selector(TYPES));
  rebase(probeEntry + 16, tapProbeColorImp);

  rebase(plan.tapRo + 24, address(plan.stringOffsets[DEMO_VIEW_CLASS_NAME]!));
  rebase(plan.tapRo + 32, address(plan.tapMethods));
  rebase(plan.tapRo + 40, address(plan.tapProtocols));
  rebase(plan.tapRo + 48, address(plan.tapIvars));
  rebase(plan.tapMetaRo + 24, address(plan.stringOffsets[DEMO_VIEW_CLASS_NAME]!));
  rebase(plan.tapMetaRo + 32, address(plan.tapClassMethods));

  rebase(plan.tapClass, address(plan.tapMeta));
  rebase(plan.tapClass + 8, address(plan.baseClass));
  rebase(plan.tapClass + 32, address(plan.tapRo));
  rebase(plan.tapMeta, address(plan.tapMeta));
  rebase(plan.tapMeta + 8, address(plan.baseMeta));
  rebase(plan.tapMeta + 32, address(plan.tapMetaRo));

  // protocol_list_t { count 1, [protocol] } and protocol_t { isa, name, protocols, ... }
  u32(plan.tapProtocols, 1);
  rebase(plan.tapProtocols + 8, address(plan.tappableProtocol));
  rebase(plan.tappableProtocol + 8, address(plan.stringOffsets.Tappable!));
  rebase(plan.protocolList, address(plan.tappableProtocol));

  // ivar_list_t { entsize 32, count 1, [offset, name, type, alignment, size] }
  u32(plan.tapIvars, 32);
  u32(plan.tapIvars + 4, 1);
  u32(plan.tapIvars + 8, 8); // offset
  rebase(plan.tapIvars + 16, address(plan.stringOffsets["_pressed"]!));
  rebase(plan.tapIvars + 24, address(plan.stringOffsets.B!));
  u32(plan.tapIvars + 32, 0); // alignment 2^0
  u32(plan.tapIvars + 36, 1); // size

  // BaseView metadata (TapView's guest superclass).
  u32(plan.baseRo, 0);
  u32(plan.baseRo + 4, 8);
  u32(plan.baseRo + 8, 56);
  u32(plan.baseMetaRo, 0x1);
  u32(plan.baseMetaRo + 4, 40);
  u32(plan.baseMetaRo + 8, 40);
  u32(plan.baseMethods, 24);
  u32(plan.baseMethods + 4, 1);
  u32(plan.tapClassMethods, 24);
  u32(plan.tapClassMethods + 4, 1);
  const tapInitializeEntry = plan.tapClassMethods + 8;
  rebase(tapInitializeEntry, selector(SELECTORS.initialize));
  rebase(tapInitializeEntry + 8, selector(TYPES));
  rebase(tapInitializeEntry + 16, tapInitializeImp);
  u32(plan.baseClassMethods, 24);
  u32(plan.baseClassMethods + 4, 1);
  const baseInitializeEntry = plan.baseClassMethods + 8;
  rebase(baseInitializeEntry, selector(SELECTORS.initialize));
  rebase(baseInitializeEntry + 8, selector(TYPES));
  rebase(baseInitializeEntry + 16, baseInitializeImp);
  const baseEntry = plan.baseMethods + 8;
  rebase(baseEntry, selector(SELECTORS.touchesBegan));
  rebase(baseEntry + 8, selector(TYPES));
  rebase(baseEntry + 16, tapBeganImp);
  rebase(plan.baseRo + 24, address(plan.stringOffsets[DEMO_BASE_CLASS_NAME]!));
  rebase(plan.baseRo + 32, address(plan.baseMethods));
  rebase(plan.baseMetaRo + 24, address(plan.stringOffsets[DEMO_BASE_CLASS_NAME]!));
  rebase(plan.baseMetaRo + 32, address(plan.baseClassMethods));
  rebase(plan.baseClass, address(plan.baseMeta));
  bind(plan.baseClass + 8, "_OBJC_CLASS_$_UIView");
  rebase(plan.baseClass + 32, address(plan.baseRo));
  rebase(plan.baseMeta, address(plan.baseMeta));
  bind(plan.baseMeta + 8, "_OBJC_METACLASS_$_UIView");
  rebase(plan.baseMeta + 32, address(plan.baseMetaRo));

  // TapView now inherits BaseView.
  rebase(plan.classList, address(plan.appClass));
  rebase(plan.classList + 8, address(plan.tapClass));
  rebase(plan.classList + 16, address(plan.baseClass));
  rebase(plan.categoryList, address(plan.appCategory));
  rebase(plan.categoryList + 8, address(plan.lifecycleCategory));

  // Import slots used by the code.
  bind(plan.slotOffsets.classWindow, "_OBJC_CLASS_$_UIWindow");
  bind(plan.slotOffsets.classColor, "_OBJC_CLASS_$_UIColor");
  bind(plan.slotOffsets.msgSend, "_objc_msgSend");
  bind(plan.slotOffsets.assocSet, "_objc_setAssociatedObject");
  bind(plan.slotOffsets.assocGet, "_objc_getAssociatedObject");
  bind(plan.slotOffsets.weakSet, "_objc_storeWeak");
  bind(plan.slotOffsets.weakLoad, "_objc_loadWeakRetained");
  bind(plan.slotOffsets.msgSendSuper, "_objc_msgSendSuper2");
  bind(plan.slotOffsets.classPool, "_OBJC_CLASS_$_NSAutoreleasePool");
  bind(plan.slotOffsets.classButton, "_OBJC_CLASS_$_UIButton");
  bind(plan.slotOffsets.classView, "_OBJC_CLASS_$_UIView");
  bind(plan.slotOffsets.classLabel, "_OBJC_CLASS_$_UILabel");
  bind(plan.slotOffsets.nslog, "_NSLog");
  bind(plan.slotOffsets.classScroll, "_OBJC_CLASS_$_UIScrollView");
  bind(plan.slotOffsets.classCenter, "_OBJC_CLASS_$_NSNotificationCenter");
  bind(plan.slotOffsets.classDefaults, "_OBJC_CLASS_$_NSUserDefaults");
  bind(plan.slotOffsets.classController, "_OBJC_CLASS_$_UIViewController");
  bind(plan.slotOffsets.classString, "_OBJC_CLASS_$_NSString");
  bind(plan.slotOffsets.classMutableArray, "_OBJC_CLASS_$_NSMutableArray");
  bind(plan.slotOffsets.classNumber, "_OBJC_CLASS_$_NSNumber");
  bind(plan.slotOffsets.classDictionary, "_OBJC_CLASS_$_NSMutableDictionary");
  bind(plan.slotOffsets.classTimer, "_OBJC_CLASS_$_NSTimer");
  bind(plan.slotOffsets.classSwitch, "_OBJC_CLASS_$_UISwitch");
  bind(plan.slotOffsets.classSlider, "_OBJC_CLASS_$_UISlider");
  bind(plan.slotOffsets.classBundle, "_OBJC_CLASS_$_NSBundle");
  bind(plan.slotOffsets.classImage, "_OBJC_CLASS_$_UIImage");
  bind(plan.slotOffsets.classImageView, "_OBJC_CLASS_$_UIImageView");
  rebase(plan.slotOffsets.superStruct + 8, address(plan.tapClass));
  bind(plan.slotOffsets.uiApplicationMain, "_UIApplicationMain");
  rebase(plan.slotOffsets.delegateName, address(plan.stringOffsets[DEMO_CLASS_NAME]!));
  rebase(plan.slotOffsets.classTapView, address(plan.tapClass));
  rebase(plan.slotOffsets.protocolTappable, address(plan.tappableProtocol));

  f64(plan.windowRect, 0);
  f64(plan.windowRect + 8, 0);
  f64(plan.windowRect + 16, DEMO_SCREEN.width);
  f64(plan.windowRect + 24, DEMO_SCREEN.height);
  f64(plan.viewRect, DEMO_VIEW_RECT.x);
  f64(plan.viewRect + 8, DEMO_VIEW_RECT.y);
  f64(plan.viewRect + 16, DEMO_VIEW_RECT.width);
  f64(plan.viewRect + 24, DEMO_VIEW_RECT.height);
  f64(plan.buttonRect, 20);
  f64(plan.buttonRect + 8, 300);
  f64(plan.buttonRect + 16, 200);
  f64(plan.buttonRect + 24, 60);
  f64(plan.overlayRect, 250);
  f64(plan.overlayRect + 8, 20);
  f64(plan.overlayRect + 16, 100);
  f64(plan.overlayRect + 24, 100);
  f64(plan.containerRect, 20);
  f64(plan.containerRect + 8, 140);
  f64(plan.containerRect + 16, 200);
  f64(plan.containerRect + 24, 100);
  f64(plan.nestedRect, 10);
  f64(plan.nestedRect + 8, 10);
  f64(plan.nestedRect + 16, 80);
  f64(plan.nestedRect + 24, 40);
  f64(plan.labelRect, 20);
  f64(plan.labelRect + 8, 400);
  f64(plan.labelRect + 16, 300);
  f64(plan.labelRect + 24, 40);
  f64(plan.clipRect, 150);
  f64(plan.clipRect + 8, 50);
  f64(plan.clipRect + 16, 100);
  f64(plan.clipRect + 24, 40);
  f64(plan.scrollRect, 20);
  f64(plan.scrollRect + 8, 470);
  f64(plan.scrollRect + 16, 300);
  f64(plan.scrollRect + 24, 80);
  f64(plan.scrollContent, 300);
  f64(plan.scrollContent + 8, 200);
  f64(plan.scrollOffset, 0);
  f64(plan.scrollOffset + 8, 80);
  f64(plan.scrollChildren, 0);
  f64(plan.scrollChildren + 8, 0);
  f64(plan.scrollChildren + 16, 300);
  f64(plan.scrollChildren + 24, 80);
  f64(plan.scrollChildren + 32, 0);
  f64(plan.scrollChildren + 40, 80);
  f64(plan.scrollChildren + 48, 300);
  f64(plan.scrollChildren + 56, 120);
  f64(plan.scrollBand, 0);
  f64(plan.scrollBand + 8, 160);
  f64(plan.scrollBand + 16, 300);
  f64(plan.scrollBand + 24, 40);
  f64(plan.statusRect, 0);
  f64(plan.statusRect + 8, 620);
  f64(plan.statusRect + 16, 375);
  f64(plan.statusRect + 24, 40);
  f64(plan.switchRect, 280);
  f64(plan.switchRect + 8, 310);
  f64(plan.switchRect + 16, 60);
  f64(plan.switchRect + 24, 32);
  f64(plan.sliderRect, 20);
  f64(plan.sliderRect + 8, 560);
  f64(plan.sliderRect + 16, 300);
  f64(plan.sliderRect + 24, 24);
  f64(plan.imageRect, 250);
  f64(plan.imageRect + 8, 140);
  f64(plan.imageRect + 16, 80);
  f64(plan.imageRect + 24, 80);
  f64(plan.wrapRect, 20);
  f64(plan.wrapRect + 8, 240);
  f64(plan.wrapRect + 16, 300);
  f64(plan.wrapRect + 24, 60);
  f64(plan.animationDuration, 2);
  f64(plan.animationAlpha, 0.25);
  f64(plan.timerInterval, 1);
  f64(plan.half, 0.5);
  for (let index = 0; index < 4; index += 1) {
    const rect = plan.rectTable + index * 32;
    f64(rect, DEMO_VIEW_RECT.x + index * 40);
    f64(rect + 8, DEMO_VIEW_RECT.y);
    f64(rect + 16, DEMO_VIEW_RECT.width);
    f64(rect + 24, DEMO_VIEW_RECT.height);
  }

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
