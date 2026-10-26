/**
 * Host side of the Objective-C proof of concept.
 *
 * Responsibilities:
 *  - allocate a real, inspectable ObjC class table for the framework shim;
 *  - parse the app image's classes and register them;
 *  - dispatch `objc_msgSend` to host IMPs (framework methods) or guest IMPs
 *    (application methods, via a tail call that preserves every argument);
 *  - run the `UIApplicationMain` shim and render the resulting view tree.
 *
 * The framework classes are clean-room, not Apple's UIKit. They exist so an
 * ObjC binary can link, send messages, and produce a frame. Nothing here
 * pretends to be Foundation, CoreAnimation, or Metal.
 */

import { ObjcError } from "../errors.js";
import { Arm64Cpu, type SyscallResult } from "../arm64/cpu.js";
import type { LoadedProgram } from "../dyld/loader.js";
import type { VirtualMemory } from "../dyld/vm.js";
import { BLACK, Framebuffer, WHITE, type Rgba } from "../ui/framebuffer.js";
import { drawText, textWidth } from "../ui/font.js";
import {
  adrp,
  b,
  blr,
  br,
  cbz,
  ldpPost,
  ldpQuadPost,
  ldrLiteral,
  ldrUnsigned,
  movReg,
  movk,
  movz,
  ret,
  stpPre,
  stpQuadPre,
  svc,
} from "../arm64/assembler.js";
import {
  CLASS_RO_SIZE,
  CLASS_T_SIZE,
  RO_META,
  RO_ROOT,
  parseObjcCategories,
  parseObjcClasses,
  type ObjcCategory,
  type ObjcClass,
  type ObjcMethod,
} from "./abi.js";

export const OBJC_TRAP_BASE = 0x9000;
export const OBJC_TRAP_LIMIT = 0x9100;
export const DEFAULT_SCREEN = { width: 375, height: 667 } as const;

const ARENA_SIZE = 0x8000;
const TRAMPOLINE_PAGE = 0x1000;
const STUB_PAGE = 0x1000;
const MAX_INSTANCES = 512;
const MAX_FRAMES = 8;
const MAX_CHILDREN = 64;
const MAX_STUBS = 8;
const MAX_INITIALIZE_STUBS = 32;
const INITIALIZE_PAGE = 0x2000;

/** UIView ivar offsets, chosen by this shim and documented in the PoC page. */
const VIEW_FRAME_X = 8;
const VIEW_FRAME_Y = 16;
const VIEW_FRAME_WIDTH = 24;
const VIEW_FRAME_HEIGHT = 32;
const VIEW_BACKGROUND = 40;
const VIEW_HIDDEN = 48;
const VIEW_ALPHA = 56;
const VIEW_CLIPS = 49;
const VIEW_INSTANCE_SIZE = 64;

const COLOR_RED = 8;
const COLOR_GREEN = 16;
const COLOR_BLUE = 24;
const COLOR_ALPHA = 32;
const COLOR_INSTANCE_SIZE = 40;

const SCROLL_OFFSET_X = 64;
const SCROLL_OFFSET_Y = 72;
const SCROLL_CONTENT_WIDTH = 80;
const SCROLL_CONTENT_HEIGHT = 88;
const SCROLL_INSTANCE_SIZE = 96;

const LABEL_TEXT = 64;
const LABEL_COLOR = 72;
const LABEL_SCALE = 80;
const LABEL_ALIGNMENT = 88;
const LABEL_INSTANCE_SIZE = 96;

const STRING_POINTER = 8;
const STRING_INSTANCE_SIZE = 16;

const NUMBER_VALUE = 8;
const NUMBER_INSTANCE_SIZE = 16;

const SWITCH_ON = 64;
const SWITCH_INSTANCE_SIZE = 72;

const SLIDER_VALUE = 64;
const SLIDER_MIN = 72;
const SLIDER_MAX = 80;
const SLIDER_INSTANCE_SIZE = 88;

const CONTROL_EVENT_TOUCH_UP_INSIDE = 64n;
const CONTROL_EVENT_VALUE_CHANGED = 4096n;

const TIMER_INSTANCE_SIZE = 8;
/** Virtual seconds advanced by one `tick` input event. */
export const TICK_SECONDS = 0.5;

const CONTROLLER_VIEW = 8;
const CONTROLLER_INSTANCE_SIZE = 16;

export interface CapturedFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly digest: string;
}

export interface TapEvent {
  readonly x: number;
  readonly y: number;
}

export interface DragEvent {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  /** Number of touch samples, including start and end. Default 4. */
  readonly steps?: number;
}

export interface TickEvent {
  readonly kind: "tick";
}

export type InputEvent = TapEvent | DragEvent | TickEvent;

interface StubPool {
  page: bigint;
  cursor: bigint;
}

interface TouchStep {
  readonly kind: "touch" | "tick";
  readonly x: number;
  readonly y: number;
  readonly selector: string;
}

export interface ObjcHostOptions {
  readonly memory: VirtualMemory;
  readonly width?: number;
  readonly height?: number;
  readonly maxFrames?: number;
  /** Scripted touches delivered after `didFinishLaunching`. */
  readonly events?: readonly InputEvent[];
  /** Receives NSLog output; the runtime wires this to the stderr sink. */
  readonly log?: (bytes: Uint8Array) => void;
}

type HostMethodHandler = (cpu: Arm64Cpu, receiver: bigint) => void;
type TrapHandler = (cpu: Arm64Cpu) => SyscallResult;

interface HostMethodSpec {
  readonly selector: string;
  readonly types: string;
  readonly run: HostMethodHandler;
}

interface HostClassSpec {
  readonly name: string;
  readonly superclass?: string;
  readonly instanceSize: number;
  readonly isRoot?: boolean;
  readonly methods: readonly HostMethodSpec[];
  readonly classMethods: readonly HostMethodSpec[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ObjcHost {
  readonly symbols = new Map<string, bigint>();
  readonly classes = new Map<string, ObjcClass>();
  readonly categories: string[] = [];
  readonly stats = {
    allocations: 0,
    retains: 0,
    releases: 0,
    autoreleases: 0,
    poolPushes: 0,
    poolPops: 0,
    associations: 0,
    weakStores: 0,
    weakLoads: 0,
    weakZeroings: 0,
    messages: 0,
    hostDispatches: 0,
    guestDispatches: 0,
    deallocs: 0,
    defaultsStores: 0,
    defaultsReads: 0,
  };
  readonly frames: CapturedFrame[] = [];
  readonly width: number;
  readonly height: number;
  readonly events: readonly InputEvent[];

  private readonly memory: VirtualMemory;
  private readonly maxFrames: number;
  private readonly arena: bigint;
  private readonly arenaEnd: bigint;
  private arenaCursor: bigint;
  private readonly trampolinePage: bigint;
  private trampolineCursor: bigint;
  private readonly stubPage: bigint;
  private stubCursor: bigint;
  private trapCount = 0;
  private stubCount = 0;
  private readonly traps = new Map<number, TrapHandler>();
  private readonly hostMethods = new Map<bigint, TrapHandler>();
  private readonly byAddress = new Map<bigint, ObjcClass>();
  private readonly byMetaAddress = new Map<bigint, ObjcClass>();
  private readonly selectors = new Map<string, bigint>();
  private readonly instances = new Map<bigint, ObjcClass>();
  private readonly initialized = new Set<bigint>();
  private readonly refcounts = new Map<bigint, number>();
  private readonly associations = new Map<bigint, Map<bigint, Association>>();
  private readonly weakSlots = new Map<bigint, Set<bigint>>();
  private readonly weakOwners = new Map<bigint, bigint>();
  private readonly deadObjects = new Set<bigint>();
  private readonly poolOwners = new Map<bigint, boolean>();
  private readonly controlActions = new Map<
    bigint,
    Array<{ target: bigint; action: bigint; events: bigint }>
  >();
  private readonly observers = new Map<string, Array<{ observer: bigint; selector: bigint }>>();
  private notificationCenter: bigint | null = null;
  private userDefaults: bigint | null = null;
  private readonly defaults = new Map<string, bigint>();
  private readonly arrays = new Map<bigint, bigint[]>();
  private readonly timerDefs = new Map<
    bigint,
    { interval: number; target: bigint; selector: bigint; repeats: boolean }
  >();
  private readonly scheduledTimers = new Map<bigint, number>();
  private readonly pendingCallbacks: Array<{
    target: bigint;
    selector: bigint;
    argument: bigint;
  }> = [];
  private readonly delayedCalls: Array<{
    fireAt: number;
    target: bigint;
    selector: bigint;
    argument: bigint;
  }> = [];
  private clock = 0;
  private tickAdvanced = false;
  private readonly dictionaries = new Map<bigint, Map<string, bigint>>();
  private readonly callbackPool: StubPool = { page: 0n, cursor: 0n };
  private readonly lifecyclePool: StubPool = { page: 0n, cursor: 0n };
  private readonly loadedControllers = new Set<bigint>();
  private readonly appearedControllers = new Set<bigint>();
  private readonly pendingLifecycle = new Map<bigint, { view: bigint; selectors: string[] }>();
  private controllerDepth = 0;
  private readonly deallocPage: bigint;
  private deallocCursor: bigint;
  private readonly autoreleasePools: bigint[][] = [];
  private readonly initializeStubs = new Map<bigint, bigint>();
  private readonly initializePage: bigint;
  private readonly loadStubPage: bigint;
  private initializeStubCursor: bigint;
  private readonly resendAddress: bigint;
  private readonly log: ((bytes: Uint8Array) => void) | undefined;
  private loadsPrepared = false;
  private readonly children = new Map<bigint, bigint[]>();
  private readonly windows: bigint[] = [];
  private keyWindow: bigint | null = null;
  private sharedApplication: bigint | null = null;
  private applicationDelegate: bigint | null = null;
  private readonly presentAddress: bigint;
  private readonly nextEventAddress: bigint;
  private eventIndex = 0;
  private readonly touchScript: readonly TouchStep[];

  constructor(options: ObjcHostOptions) {
    this.memory = options.memory;
    this.width = options.width ?? DEFAULT_SCREEN.width;
    this.height = options.height ?? DEFAULT_SCREEN.height;
    this.maxFrames = options.maxFrames ?? MAX_FRAMES;
    this.events = options.events ?? [];
    this.log = options.log;
    this.touchScript = buildTouchScript(this.events);
    this.arena = this.memory.allocate(ARENA_SIZE, { tag: "objc-host", protection: 3 });
    this.arenaCursor = this.arena;
    this.arenaEnd = this.arena + BigInt(ARENA_SIZE);
    this.trampolinePage = this.memory.allocate(TRAMPOLINE_PAGE, {
      tag: "objc-trampolines",
      protection: 7,
    });
    this.trampolineCursor = this.trampolinePage;
    this.stubPage = this.memory.allocate(STUB_PAGE, { tag: "objc-stubs", protection: 7 });
    this.stubCursor = this.stubPage;
    this.initializePage = this.memory.allocate(INITIALIZE_PAGE, {
      tag: "objc-initialize-stubs",
      protection: 7,
    });
    this.initializeStubCursor = this.initializePage;
    this.loadStubPage = this.memory.allocate(0x1000, { tag: "objc-load-stub", protection: 7 });
    this.deallocPage = this.memory.allocate(0x1000, { tag: "objc-dealloc-stubs", protection: 7 });
    this.deallocCursor = this.deallocPage;
    this.callbackPool.page = this.memory.allocate(0x1000, {
      tag: "objc-notification-stubs",
      protection: 7,
    });
    this.callbackPool.cursor = this.callbackPool.page;
    this.lifecyclePool.page = this.memory.allocate(0x1000, {
      tag: "objc-lifecycle-stubs",
      protection: 7,
    });
    this.lifecyclePool.cursor = this.lifecyclePool.page;

    // Data symbols some metadata references directly.
    const emptyCache = this.allocBytes(16);
    this.symbols.set("__objc_empty_cache", emptyCache);
    this.symbols.set("__objc_empty_vtable", emptyCache + 8n);

    this.installRuntimeSymbols();
    this.installFrameworkClasses();
    this.presentAddress = this.allocateTrampoline((cpu) => {
      this.present();
      return { value: cpu.readRegister(0) };
    });
    this.resendAddress = this.allocateTrampoline((cpu) => this.messageSend(cpu));
    this.nextEventAddress = this.allocateTrampoline((cpu) => this.nextEvent(cpu));
  }

  /** Register the classes of every loaded image, then merge categories. */
  attach(program: LoadedProgram): void {
    for (const image of program.images) {
      for (const parsed of parseObjcClasses(this.memory, image)) {
        const existing = this.classes.get(parsed.name);
        if (existing) {
          throw new ObjcError(
            "duplicate_class",
            `class ${parsed.name} is defined twice (0x${existing.address.toString(16)} and 0x${parsed.address.toString(16)})`,
          );
        }
        this.registerClass(parsed);
      }
    }
    for (const image of program.images) {
      for (const category of parseObjcCategories(this.memory, image)) {
        this.applyCategory(category);
      }
    }
  }

  /**
   * Generate a prologue that runs every `+load` (root class first) and then
   * branches to the real entry point. Returns null when no class has `+load`.
   */
  prepareLoads(entry: bigint): bigint | null {
    if (this.loadsPrepared) return null;
    this.loadsPrepared = true;
    const loads: Array<{ klass: ObjcClass; imp: bigint }> = [];
    for (const klass of this.classes.values()) {
      const method = klass.classMethods.get("load");
      if (method) loads.push({ klass, imp: method.imp });
    }
    if (loads.length === 0) return null;
    loads.sort((a, b) => depth(this.byAddress, a.klass) - depth(this.byAddress, b.klass));

    const address = this.loadStubPage;
    const code: number[] = [];
    const literals: bigint[] = [];
    const refs: Array<{ index: number; register: number; slot: number }> = [];
    const loadLiteral = (register: number, value: bigint): void => {
      refs.push({ index: code.length, register, slot: literals.length });
      literals.push(value);
      code.push(0);
    };
    code.push(stpPre(29, 30, 31, -16));
    code.push(stpPre(0, 1, 31, -16));
    code.push(stpPre(2, 3, 31, -16));
    const selector = this.internString("load");
    for (const { klass, imp } of loads) {
      code.push(...loadImmediate(0, Number(klass.address)));
      code.push(...loadImmediate(1, Number(selector)));
      loadLiteral(16, imp);
      code.push(blr(16));
    }
    code.push(ldpPost(2, 3, 31, 16));
    code.push(ldpPost(0, 1, 31, 16));
    code.push(ldpPost(29, 30, 31, 16));
    loadLiteral(16, entry);
    code.push(br(16));
    const literalStart = code.length * 4;
    for (const ref of refs) {
      code[ref.index] = ldrLiteral(ref.register, literalStart + ref.slot * 8 - ref.index * 4);
    }
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    literals.forEach((value, index) =>
      this.memory.write(address + BigInt(literalStart + index * 8), 8, value),
    );
    return address;
  }

  /** Trap dispatcher. Returns null when the trap is not ours. */
  handle(number: number, cpu: Arm64Cpu): SyscallResult | null {
    if (number < OBJC_TRAP_BASE || number >= OBJC_TRAP_LIMIT) return null;
    const handler = this.traps.get(number);
    if (!handler) {
      throw new ObjcError("unknown_objc_trap", `trap 0x${number.toString(16)} is not registered`);
    }
    return handler(cpu);
  }

  /** True when the address belongs to a host-provided IMP. */
  isHostImp(address: bigint): boolean {
    return this.hostMethods.has(address);
  }

  private installRuntimeSymbols(): void {
    this.registerSymbol("_objc_msgSend", (cpu) => this.messageSend(cpu));
    this.registerSymbol("_objc_msgSendSuper2", (cpu) => this.messageSendSuper2(cpu));
    this.registerSymbol("_objc_msgSend_fpret", (cpu) => this.messageSend(cpu));
    this.registerSymbol("_objc_msgSend_stret", (cpu) => this.messageSend(cpu));

    this.registerSymbol("_objc_retain", (cpu) => {
      this.retainObject(cpu.readRegister(0));
      return { value: cpu.readRegister(0) };
    });
    this.registerSymbol("_objc_retainAutorelease", (cpu) => {
      const object = cpu.readRegister(0);
      this.retainObject(object);
      this.autoreleaseObject(object);
      return { value: object };
    });
    this.registerSymbol("_objc_retainAutoreleasedReturnValue", (cpu) => {
      this.retainObject(cpu.readRegister(0));
      return { value: cpu.readRegister(0) };
    });
    this.registerSymbol("_objc_autoreleaseReturnValue", (cpu) => {
      this.autoreleaseObject(cpu.readRegister(0));
      return { value: cpu.readRegister(0) };
    });
    this.registerSymbol("_objc_autorelease", (cpu) => {
      this.autoreleaseObject(cpu.readRegister(0));
      return { value: cpu.readRegister(0) };
    });
    this.registerSymbol("_objc_release", (cpu) => {
      const object = cpu.readRegister(0);
      const dealloc = this.releaseObject(object);
      if (dealloc !== null) this.scheduleDealloc(cpu, object, dealloc);
      return { value: 0n };
    });
    for (const name of [
      "_objc_unsafeClaimAutoreleasedReturnValue",
      "_objc_retainBlock",
      "_objc_opt_self",
    ]) {
      this.registerSymbol(name, (cpu) => ({ value: cpu.readRegister(0) }));
    }

    this.registerSymbol("_objc_autoreleasePoolPush", () => {
      this.autoreleasePools.push([]);
      this.stats.poolPushes += 1;
      return { value: BigInt(this.autoreleasePools.length) };
    });
    this.registerSymbol("_objc_autoreleasePoolPop", () => {
      const pool = this.autoreleasePools.pop();
      if (pool) {
        this.stats.poolPops += 1;
        for (const object of pool) this.releaseObject(object);
      }
      return { value: 0n };
    });
    this.registerSymbol("_objc_sync_enter", () => ({ value: 0n }));
    // Exception handling is not implemented. The personality routine is
    // referenced by ARC cleanup tables; unwinding itself fails loudly.
    this.registerSymbol("___objc_personality_v0", () => ({ value: 0n }));
    this.registerSymbol("__Unwind_Resume", () => {
      throw new ObjcError(
        "unimplemented_unwind",
        "Objective-C exception unwinding is not implemented",
      );
    });
    this.registerSymbol("_objc_sync_exit", () => ({ value: 0n }));

    this.registerSymbol("_objc_alloc_init", (cpu) => {
      const klass = this.byAddress.get(cpu.readRegister(0));
      if (!klass) throw new ObjcError("bad_receiver", "objc_alloc_init receiver is not a class");
      const instance = this.allocateInstance(klass);
      const method = this.resolveFrom(klass, "init");
      if (!method) return { value: instance };
      cpu.writeRegister(0, instance);
      cpu.writeRegister(1, this.internString("init"));
      return this.invoke(method, cpu);
    });

    this.registerSymbol("_objc_setAssociatedObject", (cpu) => {
      this.setAssociated(
        cpu.readRegister(0),
        cpu.readRegister(1),
        cpu.readRegister(2),
        Number(cpu.readRegister(3)),
      );
      return { value: 0n };
    });
    this.registerSymbol("_objc_getAssociatedObject", (cpu) => ({
      value: this.getAssociated(cpu.readRegister(0), cpu.readRegister(1)),
    }));
    this.registerSymbol("_objc_removeAssociatedObjects", (cpu) => {
      this.removeAssociated(cpu.readRegister(0));
      return { value: 0n };
    });

    this.registerSymbol("_objc_storeStrong", (cpu) => {
      const location = cpu.readRegister(0);
      const value = cpu.readRegister(1);
      const previous = this.memory.read(location, 8);
      if (previous !== 0n) this.releaseObject(previous);
      if (value !== 0n) this.retainObject(value);
      this.memory.write(location, 8, value);
      return { value };
    });
    this.registerSymbol("_objc_storeWeak", (cpu) => {
      this.storeWeak(cpu.readRegister(0), cpu.readRegister(1));
      return { value: cpu.readRegister(1) };
    });
    this.registerSymbol("_objc_initWeak", (cpu) => {
      this.storeWeak(cpu.readRegister(0), cpu.readRegister(1));
      return { value: cpu.readRegister(0) };
    });
    this.registerSymbol("_objc_loadWeakRetained", (cpu) => ({
      value: this.loadWeakRetained(cpu.readRegister(0)),
    }));
    this.registerSymbol("_objc_loadWeak", (cpu) => {
      const value = this.loadWeakRetained(cpu.readRegister(0));
      this.autoreleaseObject(value);
      return { value };
    });
    this.registerSymbol("_objc_destroyWeak", (cpu) => {
      this.destroyWeak(cpu.readRegister(0));
      return { value: 0n };
    });

    this.registerSymbol("_NSLog", (cpu) => {
      const pointer = cpu.readRegister(0);
      if (pointer !== 0n && this.log) {
        const text = this.memory.readCString(pointer, 4096);
        this.log(new TextEncoder().encode(`${text}\n`));
      }
      return { value: 0n };
    });

    this.registerSymbol("_sel_registerName", (cpu) => ({ value: cpu.readRegister(0) }));
    this.registerSymbol("_objc_getClass", (cpu) => {
      const name = this.readCString(cpu.readRegister(0));
      return { value: this.classes.get(name)?.address ?? 0n };
    });
    this.registerSymbol("_objc_opt_class", (cpu) => {
      const receiver = cpu.readRegister(0);
      const direct = this.byAddress.get(receiver);
      return { value: direct ? receiver : this.memory.read(receiver, 8) };
    });
    this.registerSymbol("_objc_opt_isKindOfClass", (cpu) => {
      const receiver = cpu.readRegister(0);
      const target = cpu.readRegister(1);
      return { value: this.isKindOf(receiver, target) ? 1n : 0n };
    });
    this.registerSymbol("_objc_alloc", (cpu) => {
      const klass = this.byAddress.get(cpu.readRegister(0));
      if (!klass) throw new ObjcError("bad_receiver", "objc_alloc receiver is not a class");
      // Initialization is deferred to the first message on the instance:
      // objc_alloc has no selector in x1 to resend after +initialize.
      // objc_alloc must honour a guest +alloc override, not allocate directly.
      const method = this.resolveClassMethod(klass, "alloc");
      if (method) return this.invoke(method, cpu);
      return { value: this.allocateInstance(klass) };
    });

    this.registerSymbol("_UIApplicationMain", (cpu) => this.uiApplicationMain(cpu));
  }

  private registerSymbol(name: string, handler: TrapHandler): void {
    const imp = this.allocateTrampoline(handler);
    this.symbols.set(name, imp);
  }

  private installFrameworkClasses(): void {
    const self = (cpu: Arm64Cpu, receiver: bigint) => {
      cpu.writeRegister(0, receiver);
    };
    const bool =
      (value: boolean): HostMethodHandler =>
      (cpu) => {
        cpu.writeRegister(0, value ? 1n : 0n);
      };

    const object = this.defineClass({
      name: "NSObject",
      instanceSize: 8,
      isRoot: true,
      methods: [
        { selector: "init", types: "@16@0:8", run: self },
        { selector: "dealloc", types: "v16@0:8", run: self },
        {
          selector: "class",
          types: "#16@0:8",
          run: (cpu, receiver) => {
            cpu.writeRegister(0, this.byAddress.get(receiver) ? receiver : this.classOf(receiver));
          },
        },
        { selector: "self", types: "@16@0:8", run: self },
        {
          selector: "isKindOfClass:",
          types: "c24@0:8#16",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.isKindOf(receiver, cpu.readRegister(2)) ? 1n : 0n),
        },
        {
          selector: "respondsToSelector:",
          types: "c24@0:8:16",
          run: (cpu, receiver) =>
            cpu.writeRegister(
              0,
              this.resolve(receiver, this.readCString(cpu.readRegister(2))) ? 1n : 0n,
            ),
        },
        {
          selector: "retain",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.retainObject(receiver);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "release",
          types: "v16@0:8",
          run: (cpu, receiver) => {
            const dealloc = this.releaseObject(receiver);
            if (dealloc !== null) this.scheduleDealloc(cpu, receiver, dealloc);
          },
        },
        {
          selector: "autorelease",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.autoreleaseObject(receiver);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "performSelector:",
          types: "@24@0:8:16",
          run: (cpu, receiver) => this.performSelector(cpu, receiver, 2, 0),
        },
        {
          selector: "performSelector:withObject:",
          types: "@32@0:8:16@24",
          run: (cpu, receiver) => this.performSelector(cpu, receiver, 2, 1),
        },
        {
          selector: "performSelector:withObject:afterDelay:",
          types: "v40@0:8:16@24d32",
          run: (cpu, receiver) => {
            const selector = cpu.readRegister(2);
            const argument = cpu.readRegister(3);
            const delay = Math.max(0, cpu.readVectorDouble(0));
            this.delayedCalls.push({
              fireAt: this.clock + delay,
              target: receiver,
              selector,
              argument,
            });
          },
        },
        {
          selector: "cancelPreviousPerformRequestsWithTarget:",
          types: "+24@0:8@16",
          run: (cpu) => {
            const target = cpu.readRegister(2);
            for (let index = this.delayedCalls.length - 1; index >= 0; index -= 1) {
              if (this.delayedCalls[index]!.target === target) this.delayedCalls.splice(index, 1);
            }
          },
        },
        {
          selector: "performSelector:withObject:withObject:",
          types: "@40@0:8:16@24@32",
          run: (cpu, receiver) => this.performSelector(cpu, receiver, 2, 2),
        },
        {
          selector: "retainCount",
          types: "Q16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, BigInt(this.refcounts.get(receiver) ?? 1)),
        },
        {
          selector: "conformsToProtocol:",
          types: "c24@0:8^{objc_protocol=}16",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.conformsToProtocol(receiver, cpu.readRegister(2)) ? 1n : 0n),
        },
      ],
      classMethods: [
        {
          selector: "alloc",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "+alloc receiver is not a class");
            cpu.writeRegister(0, this.allocateInstance(klass));
          },
        },
        {
          selector: "new",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "+new receiver is not a class");
            cpu.writeRegister(0, this.allocateInstance(klass));
          },
        },
        {
          selector: "class",
          types: "#16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, receiver),
        },
        {
          selector: "conformsToProtocol:",
          types: "c24@0:8^{objc_protocol=}16",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.conformsToProtocol(receiver, cpu.readRegister(2)) ? 1n : 0n),
        },
        { selector: "initialize", types: "v16@0:8", run: () => undefined },
      ],
    });
    this.registerClass(object);

    const set = this.defineClass({
      name: "NSSet",
      superclass: "NSObject",
      instanceSize: 16,
      methods: [
        {
          selector: "anyObject",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, this.memory.read(receiver + 8n, 8)),
        },
      ],
      classMethods: [
        {
          selector: "setWithObject:",
          types: "@24@0:8@16",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "NSSet receiver is not a class");
            const instance = this.allocateInstance(klass);
            this.memory.write(instance + 8n, 8, cpu.readRegister(2));
            this.autoreleaseObject(instance);
            cpu.writeRegister(0, instance);
          },
        },
      ],
    });
    this.registerClass(set);

    const touch = this.defineClass({
      name: "UITouch",
      superclass: "NSObject",
      instanceSize: 24,
      methods: [
        {
          selector: "locationInView:",
          types: "{CGPoint=dd}24@0:8@16",
          run: (cpu, receiver) => {
            cpu.writeVectorDouble(0, this.readDouble(receiver, 8));
            cpu.writeVectorDouble(1, this.readDouble(receiver, 16));
          },
        },
      ],
      classMethods: [],
    });
    this.registerClass(touch);

    const uiEvent = this.defineClass({
      name: "UIEvent",
      superclass: "NSObject",
      instanceSize: 8,
      methods: [],
      classMethods: [],
    });
    this.registerClass(uiEvent);

    const view = this.defineClass({
      name: "UIView",
      superclass: "NSObject",
      instanceSize: VIEW_INSTANCE_SIZE,
      methods: [
        { selector: "init", types: "@16@0:8", run: self },
        {
          selector: "initWithFrame:",
          types: "@48@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16",
          run: (cpu, receiver) => {
            this.writeRect(receiver, this.readRect(cpu));
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "setFrame:",
          types: "v48@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16",
          run: (_cpu, receiver) => this.writeRect(receiver, this.readRect(_cpu)),
        },
        {
          selector: "frame",
          types: "{CGRect={CGPoint=dd}{CGSize=dd}}16@0:8",
          run: (cpu, receiver) => this.writeRectToRegisters(cpu, this.readStoredRect(receiver)),
        },
        {
          selector: "setAlpha:",
          types: "v24@0:8d16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(VIEW_ALPHA), 8, cpu.readVectorBits(0, 64)),
        },
        {
          selector: "alpha",
          types: "d16@0:8",
          run: (cpu, receiver) => cpu.writeVectorDouble(0, this.readDouble(receiver, VIEW_ALPHA)),
        },
        {
          selector: "setClipsToBounds:",
          types: "v20@0:8B16",
          run: (cpu, receiver) =>
            this.memory.write(
              receiver + BigInt(VIEW_CLIPS),
              1,
              cpu.readRegister(2) === 0n ? 0n : 1n,
            ),
        },
        {
          selector: "clipsToBounds",
          types: "B16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(VIEW_CLIPS), 1)),
        },
        {
          selector: "setBackgroundColor:",
          types: "v24@0:8@16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(VIEW_BACKGROUND), 8, cpu.readRegister(2)),
        },
        {
          selector: "backgroundColor",
          types: "@16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(VIEW_BACKGROUND), 8)),
        },
        {
          selector: "addSubview:",
          types: "v24@0:8@16",
          run: (cpu, receiver) => this.addSubview(receiver, cpu.readRegister(2)),
        },
        {
          selector: "setHidden:",
          types: "v20@0:8B16",
          run: (cpu, receiver) =>
            this.memory.write(
              receiver + BigInt(VIEW_HIDDEN),
              1,
              cpu.readRegister(2) === 0n ? 0n : 1n,
            ),
        },
        {
          selector: "isHidden",
          types: "B16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(VIEW_HIDDEN), 1)),
        },
        { selector: "layoutSubviews", types: "v16@0:8", run: () => undefined },
        { selector: "touchesBegan:withEvent:", types: "v32@0:8@16@24", run: () => undefined },
        { selector: "touchesMoved:withEvent:", types: "v32@0:8@16@24", run: () => undefined },
        { selector: "touchesEnded:withEvent:", types: "v32@0:8@16@24", run: () => undefined },
        { selector: "touchesCancelled:withEvent:", types: "v32@0:8@16@24", run: () => undefined },
      ],
      classMethods: [],
    });
    this.registerClass(view);

    const window = this.defineClass({
      name: "UIWindow",
      superclass: "UIView",
      instanceSize: VIEW_INSTANCE_SIZE,
      methods: [
        {
          selector: "initWithFrame:",
          types: "@48@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16",
          run: (cpu, receiver) => {
            this.writeRect(receiver, this.readRect(cpu));
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "makeKeyAndVisible",
          types: "v16@0:8",
          run: (cpu, receiver) => {
            this.keyWindow = receiver;
            if (!this.windows.includes(receiver)) this.windows.push(receiver);
            this.controllerDepth += 1;
            this.requestAppearance(this.memory.read(receiver + BigInt(CONTROLLER_VIEW), 8));
            this.controllerDepth -= 1;
            this.present();
            this.flushLifecycle(this.memory.read(receiver + BigInt(CONTROLLER_VIEW), 8), cpu);
          },
        },
        {
          selector: "setRootViewController:",
          types: "v24@0:8@16",
          run: (cpu, receiver) => {
            const controller = cpu.readRegister(2);
            this.controllerDepth += 1;
            this.memory.write(receiver + BigInt(CONTROLLER_VIEW), 8, controller);
            const child = this.controllerView(controller);
            if (child !== 0n) this.addSubview(receiver, child, 0);
            if (this.windows.includes(receiver)) this.requestAppearance(controller);
            this.controllerDepth -= 1;
            this.flushLifecycle(controller, cpu);
          },
        },
        {
          selector: "rootViewController",
          types: "@16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(CONTROLLER_VIEW), 8)),
        },
      ],
      classMethods: [],
    });
    this.registerClass(window);

    const control = this.defineClass({
      name: "UIControl",
      superclass: "UIView",
      instanceSize: VIEW_INSTANCE_SIZE,
      methods: [
        { selector: "init", types: "@16@0:8", run: self },
        {
          selector: "addTarget:action:forControlEvents:",
          types: "v40@0:8@16:24Q32",
          run: (cpu, receiver) => {
            const list = this.controlActions.get(receiver) ?? [];
            list.push({
              target: cpu.readRegister(2),
              action: cpu.readRegister(3),
              events: cpu.readRegister(4),
            });
            this.controlActions.set(receiver, list);
          },
        },
        {
          selector: "removeTarget:action:forControlEvents:",
          types: "v40@0:8@16:24Q32",
          run: (cpu, receiver) => {
            const target = cpu.readRegister(2);
            const action = cpu.readRegister(3);
            const events = cpu.readRegister(4);
            const list = this.controlActions.get(receiver);
            if (!list) return;
            const remaining = list.filter(
              (entry) =>
                !(
                  (target === 0n || entry.target === target) &&
                  (action === 0n || entry.action === action) &&
                  (events === 0n || (entry.events & events) !== 0n)
                ),
            );
            if (remaining.length === 0) this.controlActions.delete(receiver);
            else this.controlActions.set(receiver, remaining);
          },
        },
        {
          selector: "sendActionsForControlEvents:",
          types: "v24@0:8Q16",
          run: (cpu, receiver) => this.sendControlActions(cpu, receiver, cpu.readRegister(2)),
        },
      ],
      classMethods: [],
    });
    this.registerClass(control);

    const button = this.defineClass({
      name: "UIButton",
      superclass: "UIControl",
      instanceSize: VIEW_INSTANCE_SIZE,
      methods: [
        {
          selector: "touchesEnded:withEvent:",
          types: "v32@0:8@16@24",
          run: (cpu, receiver) =>
            this.sendControlActions(cpu, receiver, CONTROL_EVENT_TOUCH_UP_INSIDE),
        },
      ],
      classMethods: [],
    });
    this.registerClass(button);

    const uiSwitch = this.defineClass({
      name: "UISwitch",
      superclass: "UIControl",
      instanceSize: SWITCH_INSTANCE_SIZE,
      methods: [
        {
          selector: "setOn:animated:",
          types: "v28@0:8B16B20",
          run: (cpu, receiver) =>
            this.memory.write(
              receiver + BigInt(SWITCH_ON),
              1,
              cpu.readRegister(2) === 0n ? 0n : 1n,
            ),
        },
        {
          selector: "setOn:",
          types: "v20@0:8B16",
          run: (cpu, receiver) =>
            this.memory.write(
              receiver + BigInt(SWITCH_ON),
              1,
              cpu.readRegister(2) === 0n ? 0n : 1n,
            ),
        },
        {
          selector: "isOn",
          types: "B16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(SWITCH_ON), 1)),
        },
        {
          selector: "touchesEnded:withEvent:",
          types: "v32@0:8@16@24",
          run: (cpu, receiver) => {
            const next = this.memory.read(receiver + BigInt(SWITCH_ON), 1) === 0n ? 1n : 0n;
            this.memory.write(receiver + BigInt(SWITCH_ON), 1, next);
            return this.sendControlActions(cpu, receiver, CONTROL_EVENT_VALUE_CHANGED);
          },
        },
      ],
      classMethods: [],
    });
    this.registerClass(uiSwitch);

    const slider = this.defineClass({
      name: "UISlider",
      superclass: "UIControl",
      instanceSize: SLIDER_INSTANCE_SIZE,
      methods: [
        {
          selector: "init",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.writeDouble(receiver, SLIDER_MIN, 0);
            this.writeDouble(receiver, SLIDER_MAX, 1);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "initWithFrame:",
          types: "@48@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16",
          run: (cpu, receiver) => {
            this.writeRect(receiver, this.readRect(cpu));
            this.writeDouble(receiver, SLIDER_MIN, 0);
            this.writeDouble(receiver, SLIDER_MAX, 1);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "setValue:",
          types: "v24@0:8d16",
          run: (cpu, receiver) => this.writeSliderValue(receiver, cpu.readVectorDouble(0)),
        },
        {
          selector: "setValue:animated:",
          types: "v28@0:8d16B24",
          run: (cpu, receiver) => this.writeSliderValue(receiver, cpu.readVectorDouble(0)),
        },
        {
          selector: "value",
          types: "d16@0:8",
          run: (cpu, receiver) => cpu.writeVectorDouble(0, this.readDouble(receiver, SLIDER_VALUE)),
        },
        {
          selector: "setMinimumValue:",
          types: "v24@0:8d16",
          run: (cpu, receiver) => this.writeDouble(receiver, SLIDER_MIN, cpu.readVectorDouble(0)),
        },
        {
          selector: "setMaximumValue:",
          types: "v24@0:8d16",
          run: (cpu, receiver) => this.writeDouble(receiver, SLIDER_MAX, cpu.readVectorDouble(0)),
        },
        {
          selector: "minimumValue",
          types: "d16@0:8",
          run: (cpu, receiver) => cpu.writeVectorDouble(0, this.readDouble(receiver, SLIDER_MIN)),
        },
        {
          selector: "maximumValue",
          types: "d16@0:8",
          run: (cpu, receiver) => cpu.writeVectorDouble(0, this.readDouble(receiver, SLIDER_MAX)),
        },
        {
          selector: "touchesBegan:withEvent:",
          types: "v32@0:8@16@24",
          run: (cpu, receiver) => this.updateSliderFromTouch(cpu, receiver),
        },
        {
          selector: "touchesMoved:withEvent:",
          types: "v32@0:8@16@24",
          run: (cpu, receiver) => this.updateSliderFromTouch(cpu, receiver),
        },
        {
          selector: "touchesEnded:withEvent:",
          types: "v32@0:8@16@24",
          run: (cpu, receiver) => this.updateSliderFromTouch(cpu, receiver),
        },
      ],
      classMethods: [],
    });
    this.registerClass(slider);

    const string = this.defineClass({
      name: "NSString",
      superclass: "NSObject",
      instanceSize: STRING_INSTANCE_SIZE,
      methods: [
        {
          selector: "UTF8String",
          types: "*16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(STRING_POINTER), 8)),
        },
        {
          selector: "length",
          types: "Q16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, BigInt(this.stringValue(receiver).length)),
        },
        {
          selector: "isEqualToString:",
          types: "B24@0:8@16",
          run: (cpu, receiver) => {
            const other = this.stringValue(cpu.readRegister(2));
            cpu.writeRegister(0, this.stringValue(receiver) === other ? 1n : 0n);
          },
        },
        {
          selector: "description",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, receiver),
        },
        {
          selector: "integerValue",
          types: "q16@0:8",
          run: (cpu, receiver) => {
            const parsed = Number.parseInt(this.stringValue(receiver), 10);
            cpu.writeRegister(0, Number.isFinite(parsed) ? BigInt(parsed) : 0n);
          },
        },
      ],
      classMethods: [
        {
          selector: "stringWithUTF8String:",
          types: "@24@0:8*16",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "stringWithUTF8String: is not a class");
            cpu.writeRegister(0, this.newString(cpu.readRegister(2)));
          },
        },
        {
          selector: "stringWithString:",
          types: "@24@0:8@16",
          run: (cpu) => cpu.writeRegister(0, this.newString(cpu.readRegister(2))),
        },
      ],
    });
    this.registerClass(string);

    const number = this.defineClass({
      name: "NSNumber",
      superclass: "NSObject",
      instanceSize: NUMBER_INSTANCE_SIZE,
      methods: [
        {
          selector: "integerValue",
          types: "q16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(NUMBER_VALUE), 8)),
        },
        {
          selector: "intValue",
          types: "i16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(
              0,
              BigInt(
                Number(BigInt.asIntN(32, this.memory.read(receiver + BigInt(NUMBER_VALUE), 8))),
              ),
            ),
        },
        {
          selector: "boolValue",
          types: "B16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(
              0,
              this.memory.read(receiver + BigInt(NUMBER_VALUE), 8) === 0n ? 0n : 1n,
            ),
        },
        {
          selector: "doubleValue",
          types: "d16@0:8",
          run: (cpu, receiver) =>
            cpu.writeVectorDouble(0, Number(this.memory.read(receiver + BigInt(NUMBER_VALUE), 8))),
        },
      ],
      classMethods: [
        {
          selector: "numberWithInt:",
          types: "@20@0:8i16",
          run: (cpu, receiver) => {
            if (!this.byAddress.has(receiver)) {
              throw new ObjcError("bad_receiver", "numberWithInt: is not a class");
            }
            cpu.writeRegister(0, this.newNumber(BigInt.asIntN(32, cpu.readRegister(2))));
          },
        },
        {
          selector: "numberWithInteger:",
          types: "@24@0:8q16",
          run: (cpu, receiver) => {
            if (!this.byAddress.has(receiver)) {
              throw new ObjcError("bad_receiver", "numberWithInteger: is not a class");
            }
            cpu.writeRegister(0, this.newNumber(cpu.readRegister(2)));
          },
        },
        {
          selector: "numberWithBool:",
          types: "@20@0:8B16",
          run: (cpu, receiver) => {
            if (!this.byAddress.has(receiver)) {
              throw new ObjcError("bad_receiver", "numberWithBool: is not a class");
            }
            cpu.writeRegister(0, this.newNumber(cpu.readRegister(2) === 0n ? 0n : 1n));
          },
        },
      ],
    });
    this.registerClass(number);

    const array = this.defineClass({
      name: "NSArray",
      superclass: "NSObject",
      instanceSize: 8,
      methods: [
        {
          selector: "count",
          types: "Q16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, BigInt(this.arrayOf(receiver).length)),
        },
        {
          selector: "objectAtIndex:",
          types: "@24@0:8Q16",
          run: (cpu, receiver) => {
            const list = this.arrayOf(receiver);
            const index = Number(cpu.readRegister(2));
            if (!Number.isInteger(index) || index < 0 || index >= list.length) {
              throw new ObjcError(
                "range_error",
                `objectAtIndex: ${index} is outside 0..${list.length - 1}`,
              );
            }
            cpu.writeRegister(0, list[index]!);
          },
        },
        {
          selector: "firstObject",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, this.arrayOf(receiver)[0] ?? 0n),
        },
        {
          selector: "lastObject",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const list = this.arrayOf(receiver);
            cpu.writeRegister(0, list[list.length - 1] ?? 0n);
          },
        },
      ],
      classMethods: [
        {
          selector: "array",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "array receiver is not a class");
            const instance = this.allocateInstance(klass);
            this.arrays.set(instance, []);
            cpu.writeRegister(0, instance);
          },
        },
      ],
    });
    this.registerClass(array);

    const mutableArray = this.defineClass({
      name: "NSMutableArray",
      superclass: "NSArray",
      instanceSize: 8,
      methods: [
        {
          selector: "init",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.arrays.set(receiver, []);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "addObject:",
          types: "v24@0:8@16",
          run: (cpu, receiver) => {
            const list = this.arrayOf(receiver);
            const object = cpu.readRegister(2);
            if (object === 0n) throw new ObjcError("nil_argument", "addObject: does not take nil");
            if (list.length >= 1024) {
              throw new ObjcError("array_limit", "an array already holds 1024 objects");
            }
            list.push(object);
          },
        },
        {
          selector: "removeAllObjects",
          types: "v16@0:8",
          run: (_cpu, receiver) => {
            this.arrays.set(receiver, []);
          },
        },
      ],
      classMethods: [],
    });
    this.registerClass(mutableArray);

    const dictionary = this.defineClass({
      name: "NSDictionary",
      superclass: "NSObject",
      instanceSize: 8,
      methods: [
        {
          selector: "count",
          types: "Q16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, BigInt(this.dictionaryOf(receiver).size)),
        },
        {
          selector: "objectForKey:",
          types: "@24@0:8@16",
          run: (cpu, receiver) =>
            cpu.writeRegister(
              0,
              this.dictionaryOf(receiver).get(this.stringValue(cpu.readRegister(2))) ?? 0n,
            ),
        },
      ],
      classMethods: [
        {
          selector: "dictionary",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "dictionary receiver is not a class");
            const instance = this.allocateInstance(klass);
            this.dictionaries.set(instance, new Map());
            cpu.writeRegister(0, instance);
          },
        },
      ],
    });
    this.registerClass(dictionary);

    const mutableDictionary = this.defineClass({
      name: "NSMutableDictionary",
      superclass: "NSDictionary",
      instanceSize: 8,
      methods: [
        {
          selector: "init",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.dictionaries.set(receiver, new Map());
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "setObject:forKey:",
          types: "v32@0:8@16@24",
          run: (cpu, receiver) => {
            const map = this.dictionaryOf(receiver);
            const object = cpu.readRegister(2);
            const key = this.stringValue(cpu.readRegister(3));
            if (object === 0n)
              throw new ObjcError("nil_argument", "setObject:forKey: takes no nil");
            if (!map.has(key) && map.size >= 1024) {
              throw new ObjcError("dictionary_limit", "a dictionary already holds 1024 keys");
            }
            map.set(key, object);
          },
        },
        {
          selector: "removeObjectForKey:",
          types: "v24@0:8@16",
          run: (cpu, receiver) => {
            this.dictionaryOf(receiver).delete(this.stringValue(cpu.readRegister(2)));
          },
        },
        {
          selector: "removeAllObjects",
          types: "v16@0:8",
          run: (_cpu, receiver) => {
            this.dictionaries.set(receiver, new Map());
          },
        },
      ],
      classMethods: [],
    });
    this.registerClass(mutableDictionary);

    const timer = this.defineClass({
      name: "NSTimer",
      superclass: "NSObject",
      instanceSize: TIMER_INSTANCE_SIZE,
      methods: [
        {
          selector: "invalidate",
          types: "v16@0:8",
          run: (_cpu, receiver) => {
            this.scheduledTimers.delete(receiver);
          },
        },
        {
          selector: "isValid",
          types: "B16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.scheduledTimers.has(receiver) ? 1n : 0n),
        },
        {
          selector: "timeInterval",
          types: "d16@0:8",
          run: (cpu, receiver) =>
            cpu.writeVectorDouble(0, this.timerDefs.get(receiver)?.interval ?? 0),
        },
        {
          selector: "fire",
          types: "v16@0:8",
          run: (_cpu, receiver) => {
            const definition = this.timerDefs.get(receiver);
            if (definition) {
              this.pendingCallbacks.push({
                target: definition.target,
                selector: definition.selector,
                argument: receiver,
              });
            }
          },
        },
      ],
      classMethods: [
        {
          selector: "scheduledTimerWithTimeInterval:target:selector:repeats:",
          types: "@48@0:8d16@24:32B40",
          run: (cpu, receiver) => {
            if (!this.byAddress.has(receiver)) {
              throw new ObjcError("bad_receiver", "scheduledTimerWithTimeInterval: is not a class");
            }
            cpu.writeRegister(0, this.addTimer(cpu, true));
          },
        },
        {
          selector: "timerWithTimeInterval:target:selector:repeats:",
          types: "@48@0:8d16@24:32B40",
          run: (cpu, receiver) => {
            if (!this.byAddress.has(receiver)) {
              throw new ObjcError("bad_receiver", "timerWithTimeInterval: is not a class");
            }
            cpu.writeRegister(0, this.addTimer(cpu, false));
          },
        },
      ],
    });
    this.registerClass(timer);

    const defaults = this.defineClass({
      name: "NSUserDefaults",
      superclass: "NSObject",
      instanceSize: 8,
      methods: [
        {
          selector: "setBool:forKey:",
          types: "v28@0:8B16*20",
          run: (cpu) => {
            const key = this.readCString(cpu.readRegister(3));
            this.defaults.set(key, cpu.readRegister(2) === 0n ? 0n : 1n);
            this.stats.defaultsStores += 1;
          },
        },
        {
          selector: "boolForKey:",
          types: "B24@0:8*16",
          run: (cpu) => {
            const key = this.readCString(cpu.readRegister(2));
            this.stats.defaultsReads += 1;
            cpu.writeRegister(0, (this.defaults.get(key) ?? 0n) === 0n ? 0n : 1n);
          },
        },
        {
          selector: "setInteger:forKey:",
          types: "v28@0:8q16*20",
          run: (cpu) => {
            const key = this.readCString(cpu.readRegister(3));
            this.defaults.set(key, cpu.readRegister(2));
            this.stats.defaultsStores += 1;
          },
        },
        {
          selector: "integerForKey:",
          types: "q24@0:8*16",
          run: (cpu) => {
            const key = this.readCString(cpu.readRegister(2));
            this.stats.defaultsReads += 1;
            cpu.writeRegister(0, this.defaults.get(key) ?? 0n);
          },
        },
        {
          selector: "removeObjectForKey:",
          types: "v24@0:8*16",
          run: (cpu) => this.defaults.delete(this.readCString(cpu.readRegister(2))),
        },
      ],
      classMethods: [
        {
          selector: "standardUserDefaults",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass)
              throw new ObjcError("bad_receiver", "standardUserDefaults receiver is not a class");
            this.userDefaults ??= this.allocateInstance(klass);
            cpu.writeRegister(0, this.userDefaults);
          },
        },
      ],
    });
    this.registerClass(defaults);

    const notification = this.defineClass({
      name: "NSNotification",
      superclass: "NSObject",
      instanceSize: 32,
      methods: [
        {
          selector: "name",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, this.memory.read(receiver + 8n, 8)),
        },
        {
          selector: "object",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, this.memory.read(receiver + 16n, 8)),
        },
        {
          selector: "userInfo",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, this.memory.read(receiver + 24n, 8)),
        },
      ],
      classMethods: [],
    });
    this.registerClass(notification);

    const center = this.defineClass({
      name: "NSNotificationCenter",
      superclass: "NSObject",
      instanceSize: 8,
      methods: [
        {
          selector: "addObserver:selector:name:object:",
          types: "v48@0:8@16:24*32@40",
          run: (cpu) => {
            const observer = cpu.readRegister(2);
            const selector = cpu.readRegister(3);
            const namePointer = cpu.readRegister(4);
            const name = namePointer === 0n ? "" : this.readCString(namePointer);
            const list = this.observers.get(name) ?? [];
            list.push({ observer, selector });
            this.observers.set(name, list);
          },
        },
        {
          selector: "removeObserver:",
          types: "v24@0:8@16",
          run: (cpu) => {
            const observer = cpu.readRegister(2);
            for (const [name, list] of this.observers) {
              const remaining = list.filter((entry) => entry.observer !== observer);
              if (remaining.length === 0) this.observers.delete(name);
              else this.observers.set(name, remaining);
            }
          },
        },
        {
          selector: "postNotificationName:object:",
          types: "v32@0:8*16@24",
          run: (cpu) => this.postNotification(cpu, false),
        },
        {
          selector: "postNotificationName:object:userInfo:",
          types: "v40@0:8*16@24@32",
          run: (cpu) => this.postNotification(cpu, true),
        },
      ],
      classMethods: [
        {
          selector: "defaultCenter",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass)
              throw new ObjcError("bad_receiver", "defaultCenter receiver is not a class");
            this.notificationCenter ??= this.allocateInstance(klass);
            cpu.writeRegister(0, this.notificationCenter);
          },
        },
      ],
    });
    this.registerClass(center);

    const scroll = this.defineClass({
      name: "UIScrollView",
      superclass: "UIView",
      instanceSize: SCROLL_INSTANCE_SIZE,
      methods: [
        {
          selector: "init",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.memory.write(receiver + BigInt(VIEW_ALPHA), 8, doubleBits(1));
            this.memory.write(receiver + BigInt(VIEW_CLIPS), 1, 1n);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "initWithFrame:",
          types: "@48@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16",
          run: (cpu, receiver) => {
            this.writeRect(receiver, this.readRect(cpu));
            this.memory.write(receiver + BigInt(VIEW_ALPHA), 8, doubleBits(1));
            this.memory.write(receiver + BigInt(VIEW_CLIPS), 1, 1n);
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "setContentOffset:",
          types: "v32@0:8{CGPoint=dd}16",
          run: (cpu, receiver) => {
            this.memory.write(receiver + BigInt(SCROLL_OFFSET_X), 8, cpu.readVectorBits(0, 64));
            this.memory.write(receiver + BigInt(SCROLL_OFFSET_Y), 8, cpu.readVectorBits(1, 64));
          },
        },
        {
          selector: "contentOffset",
          types: "{CGPoint=dd}16@0:8",
          run: (cpu, receiver) => {
            cpu.writeVectorDouble(0, this.readDouble(receiver, SCROLL_OFFSET_X));
            cpu.writeVectorDouble(1, this.readDouble(receiver, SCROLL_OFFSET_Y));
          },
        },
        {
          selector: "setContentSize:",
          types: "v32@0:8{CGSize=dd}16",
          run: (cpu, receiver) => {
            this.memory.write(
              receiver + BigInt(SCROLL_CONTENT_WIDTH),
              8,
              cpu.readVectorBits(0, 64),
            );
            this.memory.write(
              receiver + BigInt(SCROLL_CONTENT_HEIGHT),
              8,
              cpu.readVectorBits(1, 64),
            );
          },
        },
        {
          selector: "contentSize",
          types: "{CGSize=dd}16@0:8",
          run: (cpu, receiver) => {
            cpu.writeVectorDouble(0, this.readDouble(receiver, SCROLL_CONTENT_WIDTH));
            cpu.writeVectorDouble(1, this.readDouble(receiver, SCROLL_CONTENT_HEIGHT));
          },
        },
      ],
      classMethods: [],
    });
    this.registerClass(scroll);

    const label = this.defineClass({
      name: "UILabel",
      superclass: "UIView",
      instanceSize: LABEL_INSTANCE_SIZE,
      methods: [
        {
          selector: "init",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.memory.write(receiver + BigInt(VIEW_ALPHA), 8, doubleBits(1));
            this.memory.write(receiver + BigInt(LABEL_SCALE), 8, doubleBits(2));
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "initWithFrame:",
          types: "@48@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16",
          run: (cpu, receiver) => {
            this.writeRect(receiver, this.readRect(cpu));
            this.memory.write(receiver + BigInt(VIEW_ALPHA), 8, doubleBits(1));
            this.memory.write(receiver + BigInt(LABEL_SCALE), 8, doubleBits(2));
            cpu.writeRegister(0, receiver);
          },
        },
        {
          selector: "setText:",
          types: "v24@0:8*16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(LABEL_TEXT), 8, cpu.readRegister(2)),
        },
        {
          selector: "text",
          types: "*16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(LABEL_TEXT), 8)),
        },
        {
          selector: "setTextColor:",
          types: "v24@0:8@16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(LABEL_COLOR), 8, cpu.readRegister(2)),
        },
        {
          selector: "textColor",
          types: "@16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(LABEL_COLOR), 8)),
        },
        {
          selector: "setFontSize:",
          types: "v24@0:8d16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(LABEL_SCALE), 8, cpu.readVectorBits(0, 64)),
        },
        {
          selector: "setTextAlignment:",
          types: "v20@0:8q16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(LABEL_ALIGNMENT), 8, cpu.readRegister(2)),
        },
        {
          selector: "textAlignment",
          types: "q16@0:8",
          run: (cpu, receiver) =>
            cpu.writeRegister(0, this.memory.read(receiver + BigInt(LABEL_ALIGNMENT), 8)),
        },
        {
          selector: "fontSize",
          types: "d16@0:8",
          run: (cpu, receiver) => cpu.writeVectorDouble(0, this.readDouble(receiver, LABEL_SCALE)),
        },
      ],
      classMethods: [],
    });
    this.registerClass(label);

    const controller = this.defineClass({
      name: "UIViewController",
      superclass: "NSObject",
      instanceSize: CONTROLLER_INSTANCE_SIZE,
      methods: [
        { selector: "init", types: "@16@0:8", run: self },
        {
          selector: "view",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            this.controllerDepth += 1;
            const view = this.controllerView(receiver);
            this.controllerDepth -= 1;
            cpu.writeRegister(0, view);
            this.flushLifecycle(receiver, cpu);
          },
        },
        {
          selector: "setView:",
          types: "v24@0:8@16",
          run: (cpu, receiver) =>
            this.memory.write(receiver + BigInt(CONTROLLER_VIEW), 8, cpu.readRegister(2)),
        },
        { selector: "loadView", types: "v16@0:8", run: () => undefined },
      ],
      classMethods: [],
    });
    this.registerClass(controller);

    const pool = this.defineClass({
      name: "NSAutoreleasePool",
      superclass: "NSObject",
      instanceSize: 16,
      methods: [
        {
          selector: "drain",
          types: "v16@0:8",
          run: (_cpu, receiver) => this.drainPool(receiver),
        },
        {
          selector: "release",
          types: "v16@0:8",
          run: (_cpu, receiver) => this.drainPool(receiver),
        },
      ],
      classMethods: [
        {
          selector: "new",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass)
              throw new ObjcError("bad_receiver", "NSAutoreleasePool receiver is not a class");
            const instance = this.allocateInstance(klass);
            this.autoreleasePools.push([]);
            this.stats.poolPushes += 1;
            this.poolOwners.set(instance, false);
            cpu.writeRegister(0, instance);
          },
        },
      ],
    });
    this.registerClass(pool);

    const color = this.defineClass({
      name: "UIColor",
      superclass: "NSObject",
      instanceSize: COLOR_INSTANCE_SIZE,
      methods: [],
      classMethods: [
        {
          selector: "colorWithRed:green:blue:alpha:",
          types: "@64@0:8d16d24d32d40",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass) throw new ObjcError("bad_receiver", "UIColor receiver is not a class");
            const instance = this.allocateInstance(klass);
            for (let index = 0; index < 4; index += 1) {
              this.memory.write(
                instance + BigInt(COLOR_RED + index * 8),
                8,
                cpu.readVectorBits(index, 64),
              );
            }
            // Convenience constructors return autoreleased objects.
            this.autoreleaseObject(instance);
            cpu.writeRegister(0, instance);
          },
        },
        this.constantColor("redColor", { r: 1, g: 0, b: 0, a: 1 }),
        this.constantColor("blueColor", { r: 0, g: 0, b: 1, a: 1 }),
        this.constantColor("purpleColor", { r: 0.5, g: 0, b: 0.5, a: 1 }),
        this.constantColor("yellowColor", { r: 1, g: 1, b: 0, a: 1 }),
        this.constantColor("orangeColor", { r: 1, g: 0.5, b: 0, a: 1 }),
        this.constantColor("grayColor", { r: 0.5, g: 0.5, b: 0.5, a: 1 }),
        this.constantColor("greenColor", { r: 0, g: 1, b: 0, a: 1 }),
        this.constantColor("whiteColor", { r: 1, g: 1, b: 1, a: 1 }),
        this.constantColor("blackColor", { r: 0, g: 0, b: 0, a: 1 }),
        this.constantColor("clearColor", { r: 0, g: 0, b: 0, a: 0 }),
      ],
    });
    this.registerClass(color);

    const application = this.defineClass({
      name: "UIApplication",
      superclass: "NSObject",
      instanceSize: 8,
      methods: [
        {
          selector: "setDelegate:",
          types: "v24@0:8@16",
          run: (cpu) => {
            this.applicationDelegate = cpu.readRegister(2);
          },
        },
        {
          selector: "delegate",
          types: "@16@0:8",
          run: (cpu) => cpu.writeRegister(0, this.applicationDelegate ?? 0n),
        },
      ],
      classMethods: [
        {
          selector: "sharedApplication",
          types: "@16@0:8",
          run: (cpu, receiver) => {
            const klass = this.byAddress.get(receiver);
            if (!klass)
              throw new ObjcError("bad_receiver", "UIApplication receiver is not a class");
            this.sharedApplication ??= this.allocateInstance(klass);
            cpu.writeRegister(0, this.sharedApplication);
          },
        },
      ],
    });
    this.registerClass(application);
  }

  private constantColor(selector: string, rgba: Rgba): HostMethodSpec {
    return {
      selector,
      types: "@16@0:8",
      run: (cpu, receiver) => {
        const klass = this.byAddress.get(receiver);
        if (!klass)
          throw new ObjcError("bad_receiver", `UIColor +${selector} receiver is not a class`);
        const instance = this.allocateInstance(klass);
        for (const [offset, value] of [
          [COLOR_RED, rgba.r],
          [COLOR_GREEN, rgba.g],
          [COLOR_BLUE, rgba.b],
          [COLOR_ALPHA, rgba.a],
        ] as const) {
          this.memory.write(instance + BigInt(offset), 8, doubleBits(value));
        }
        this.autoreleaseObject(instance);
        cpu.writeRegister(0, instance);
      },
    };
  }

  private defineClass(spec: HostClassSpec): ObjcClass {
    const classAddress = this.allocBytes(CLASS_T_SIZE);
    const metaclass = this.allocBytes(CLASS_T_SIZE);
    const roAddress = this.allocBytes(CLASS_RO_SIZE);
    const metaRoAddress = this.allocBytes(CLASS_RO_SIZE);
    const nameAddress = this.internString(spec.name);
    const methods = this.writeMethodList(spec.methods);
    const classMethods = this.writeMethodList(spec.classMethods);
    const parent = spec.superclass ? this.classes.get(spec.superclass) : undefined;
    if (spec.superclass && !parent) {
      throw new ObjcError("missing_superclass", `${spec.name} needs ${spec.superclass}`);
    }
    const superclass = parent?.address ?? 0n;
    const metaclassSuperclass = parent?.metaclass ?? 0n;

    this.writeU64(classAddress, metaclass);
    this.writeU64(classAddress + 8n, superclass);
    this.writeU64(classAddress + 32n, roAddress);

    this.writeU64(metaclass, metaclass);
    this.writeU64(metaclass + 8n, metaclassSuperclass);
    this.writeU64(metaclass + 32n, metaRoAddress);

    const flags = spec.isRoot ? RO_ROOT : 0;
    this.writeU32(roAddress, flags);
    this.writeU32(roAddress + 4n, spec.isRoot ? 0 : 8);
    this.writeU32(roAddress + 8n, spec.instanceSize);
    this.writeU64(roAddress + 24n, nameAddress);
    this.writeU64(roAddress + 32n, methods);

    this.writeU32(metaRoAddress, RO_META | flags);
    this.writeU32(metaRoAddress + 4n, 40);
    this.writeU32(metaRoAddress + 8n, 40);
    this.writeU64(metaRoAddress + 24n, nameAddress);
    this.writeU64(metaRoAddress + 32n, classMethods);

    const methodMap = new Map<string, ObjcMethod>();
    for (const method of spec.methods) {
      methodMap.set(method.selector, {
        selector: method.selector,
        types: method.types,
        imp: this.methodImp(method),
      });
    }
    const classMap = new Map<string, ObjcMethod>();
    for (const method of spec.classMethods) {
      classMap.set(method.selector, {
        selector: method.selector,
        types: method.types,
        imp: this.methodImp(method),
      });
    }

    const record: ObjcClass = {
      name: spec.name,
      address: classAddress,
      metaclass,
      superclass,
      metaclassSuperclass,
      instanceSize: spec.instanceSize,
      isRoot: spec.isRoot ?? false,
      methods: methodMap,
      classMethods: classMap,
      ivars: [],
      protocols: [],
    };
    this.symbols.set(`_OBJC_CLASS_$_${spec.name}`, classAddress);
    this.symbols.set(`_OBJC_METACLASS_$_${spec.name}`, metaclass);
    return record;
  }

  private methodImp(spec: HostMethodSpec): bigint {
    const cached = this.impByMethod.get(spec);
    if (cached) return cached;
    const imp = this.allocateTrampoline((cpu) => {
      spec.run(cpu, cpu.readRegister(0));
      return { value: cpu.readRegister(0) };
    });
    this.hostMethods.set(imp, (cpu) => {
      spec.run(cpu, cpu.readRegister(0));
      return { value: cpu.readRegister(0) };
    });
    this.impByMethod.set(spec, imp);
    return imp;
  }

  private writeMethodList(methods: readonly HostMethodSpec[]): bigint {
    const address = this.allocBytes(8 + methods.length * 24);
    this.writeU32(address, 24);
    this.writeU32(address + 4n, methods.length);
    methods.forEach((method, index) => {
      const entry = address + 8n + BigInt(index * 24);
      this.writeU64(entry, this.internString(method.selector));
      this.writeU64(entry + 8n, this.internString(method.types));
      this.writeU64(entry + 16n, this.methodImp(method));
    });
    return address;
  }

  private readonly impByMethod = new Map<HostMethodSpec, bigint>();

  private applyCategory(category: ObjcCategory): void {
    const klass = this.byAddress.get(category.classAddress);
    if (!klass) {
      throw new ObjcError(
        "unknown_category_class",
        `category ${category.name} targets 0x${category.classAddress.toString(16)}, which is not a loaded class`,
      );
    }
    const methods = new Map(klass.methods);
    for (const [selector, method] of category.methods) methods.set(selector, method);
    const classMethods = new Map(klass.classMethods);
    for (const [selector, method] of category.classMethods) classMethods.set(selector, method);
    const protocols = [...klass.protocols];
    for (const protocol of category.protocols) {
      if (!protocols.includes(protocol)) protocols.push(protocol);
    }
    const updated: ObjcClass = { ...klass, methods, classMethods, protocols };
    this.classes.set(updated.name, updated);
    this.byAddress.set(updated.address, updated);
    this.byMetaAddress.set(updated.metaclass, updated);
    this.categories.push(`${klass.name}(${category.name})`);
  }

  /**
   * Run `+initialize` exactly once before the first message to a class.
   *
   * A guest initializer must not clobber the pending message's arguments, so
   * a stub saves x0..x7 and q0..q7, calls the initializer, restores the
   * registers, then jumps to the resend trap. The resend re-enters dispatch
   * with the original receiver and selector, and `LR` still points at the
   * original caller.
   */
  private ensureInitialized(cpu: Arm64Cpu): boolean {
    const receiver = cpu.readRegister(0);
    if (receiver === 0n) return false;
    const classObject = this.byAddress.get(receiver);
    const klass = classObject ?? this.byAddress.get(this.memory.read(receiver, 8));
    if (!klass || this.initialized.has(klass.address)) return false;

    const chain: ObjcClass[] = [];
    let current: ObjcClass | undefined = klass;
    while (current) {
      chain.unshift(current);
      current = this.byAddress.get(current.superclass);
    }
    const pending: Array<{ klass: ObjcClass; imp: bigint }> = [];
    for (const candidate of chain) {
      if (this.initialized.has(candidate.address)) continue;
      this.initialized.add(candidate.address);
      const method = candidate.classMethods.get("initialize");
      if (method && !this.hostMethods.has(method.imp)) {
        pending.push({ klass: candidate, imp: method.imp });
      }
    }
    if (pending.length === 0) return false;
    cpu.pc = this.initializeStub(pending);
    return true;
  }

  /** Call every pending `+initialize` (root first), then re-enter dispatch. */
  private initializeStub(pending: readonly { klass: ObjcClass; imp: bigint }[]): bigint {
    const key = pending[pending.length - 1]!.klass.address;
    const cached = this.initializeStubs.get(key);
    if (cached) return cached;
    if (this.initializeStubs.size >= MAX_INITIALIZE_STUBS) {
      throw new ObjcError(
        "stub_limit",
        `more than ${MAX_INITIALIZE_STUBS} classes needed a +initialize stub`,
      );
    }
    if (pending.length > 8) {
      throw new ObjcError("stub_limit", "more than 8 pending +initialize methods");
    }
    const address = this.initializeStubCursor;
    this.initializeStubCursor += 256n;
    if (this.initializeStubCursor > this.initializePage + BigInt(INITIALIZE_PAGE)) {
      throw new ObjcError("stub_limit", "the +initialize stub area overflowed");
    }
    const selector = this.internString("initialize");
    const code: number[] = [
      stpPre(29, 30, 31, -16),
      stpPre(0, 1, 31, -16),
      stpPre(2, 3, 31, -16),
      stpPre(4, 5, 31, -16),
      stpPre(6, 7, 31, -16),
      stpQuadPre(0, 1, 31, -32),
      stpQuadPre(2, 3, 31, -32),
      stpQuadPre(4, 5, 31, -32),
      stpQuadPre(6, 7, 31, -32),
    ];
    const literals: bigint[] = [];
    const refs: Array<{ index: number; slot: number }> = [];
    for (const entry of pending) {
      code.push(...loadImmediate(0, Number(entry.klass.address)));
      code.push(...loadImmediate(1, Number(selector)));
      refs.push({ index: code.length, slot: literals.length });
      literals.push(entry.imp);
      code.push(0);
      code.push(blr(16));
    }
    code.push(
      ldpQuadPost(6, 7, 31, 32),
      ldpQuadPost(4, 5, 31, 32),
      ldpQuadPost(2, 3, 31, 32),
      ldpQuadPost(0, 1, 31, 32),
      ldpPost(6, 7, 31, 16),
      ldpPost(4, 5, 31, 16),
      ldpPost(2, 3, 31, 16),
      ldpPost(0, 1, 31, 16),
      ldpPost(29, 30, 31, 16),
    );
    const resendIndex = code.length;
    code.push(0);
    code.push(br(16));
    const literalStart = code.length * 4;
    for (const ref of refs) {
      code[ref.index] = ldrLiteral(16, literalStart + ref.slot * 8 - ref.index * 4);
    }
    code[resendIndex] = ldrLiteral(16, literalStart + literals.length * 8 - resendIndex * 4);
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    literals.forEach((value, index) =>
      this.memory.write(address + BigInt(literalStart + index * 8), 8, value),
    );
    this.memory.write(address + BigInt(literalStart + literals.length * 8), 8, this.resendAddress);
    this.initializeStubs.set(key, address);
    return address;
  }

  private registerClass(record: ObjcClass): void {
    if (this.classes.has(record.name)) {
      throw new ObjcError("duplicate_class", `class ${record.name} is already registered`);
    }
    this.classes.set(record.name, record);
    this.byAddress.set(record.address, record);
    this.byMetaAddress.set(record.metaclass, record);
  }

  private allocateTrampoline(handler: TrapHandler): bigint {
    const trap = OBJC_TRAP_BASE + this.trapCount;
    this.trapCount += 1;
    if (trap >= OBJC_TRAP_LIMIT) {
      throw new ObjcError("trap_limit", "the ObjC trampoline page is exhausted");
    }
    const address = this.trampolineCursor;
    this.trampolineCursor += 16n;
    if (this.trampolineCursor > this.trampolinePage + BigInt(TRAMPOLINE_PAGE)) {
      throw new ObjcError("trap_limit", "the ObjC trampoline page overflowed");
    }
    this.traps.set(trap, handler);
    const code = [movz(16, trap), svc(0x80), ret(), 0xd503201f];
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    return address;
  }

  private allocateInstance(klass: ObjcClass): bigint {
    if (this.instances.size >= MAX_INSTANCES) {
      throw new ObjcError("instance_limit", `more than ${MAX_INSTANCES} objects were allocated`);
    }
    const size = Math.max(8, klass.instanceSize);
    const address = this.memory.allocate(size, { tag: "objc-instance", protection: 3 });
    this.memory.write(address, 8, klass.address);
    if (this.isViewClass(klass)) {
      // Parsed app classes may declare a smaller instanceSize than the shim's
      // UIView layout; the page still has room for the alpha lane.
      this.memory.write(address + BigInt(VIEW_ALPHA), 8, doubleBits(1));
    }
    this.instances.set(address, klass);
    this.refcounts.set(address, 1);
    this.stats.allocations += 1;
    return address;
  }

  private messageSend(cpu: Arm64Cpu): SyscallResult {
    const receiver = cpu.readRegister(0);
    if (receiver === 0n) {
      cpu.writeRegister(0, 0n);
      return { value: 0n };
    }
    if (this.ensureInitialized(cpu)) return { value: receiver };
    this.stats.messages += 1;
    const selector = this.readCString(cpu.readRegister(1));
    const method = this.resolve(receiver, selector);
    if (!method) {
      throw new ObjcError(
        "unrecognized_selector",
        `${this.describe(receiver)} does not respond to ${selector}`,
        { selector, receiver: receiver.toString(16) },
      );
    }
    return this.invoke(method, cpu);
  }

  private messageSendSuper2(cpu: Arm64Cpu): SyscallResult {
    const superPointer = cpu.readRegister(0);
    const receiver = this.memory.read(superPointer, 8);
    if (this.ensureInitialized(cpu)) return { value: receiver };
    // objc_msgSendSuper2 passes the class containing the method, not the
    // superclass; lookup starts at that class's superclass.
    this.stats.messages += 1;
    const container = this.byAddress.get(this.memory.read(superPointer + 8n, 8));
    const start = container ? this.byAddress.get(container.superclass) : undefined;
    const selector = this.readCString(cpu.readRegister(1));
    if (!start) {
      throw new ObjcError("bad_receiver", `objc_msgSendSuper2 container class is not registered`);
    }
    const method = this.resolveFrom(start, selector);
    if (!method) {
      throw new ObjcError("unrecognized_selector", `superclass does not respond to ${selector}`);
    }
    // objc_msgSendSuper2 receives a struct pointer in x0; the IMP must see the
    // actual receiver.
    cpu.writeRegister(0, receiver);
    return this.invoke(method, cpu);
  }

  private invoke(method: ObjcMethod, cpu: Arm64Cpu): SyscallResult {
    const host = this.hostMethods.get(method.imp);
    if (host) {
      this.stats.hostDispatches += 1;
      return host(cpu);
    }
    if (method.imp === 0n) {
      throw new ObjcError("bad_objc_metadata", `method ${method.selector} has a null IMP`);
    }
    // Guest IMP: tail-call it with the argument registers untouched. The
    // return address already points at the caller of objc_msgSend.
    this.stats.guestDispatches += 1;
    cpu.pc = method.imp;
    return { value: cpu.readRegister(0) };
  }

  private resolve(receiver: bigint, selector: string): ObjcMethod | null {
    const classObject = this.byAddress.get(receiver);
    if (classObject) return this.resolveClassMethod(classObject, selector);
    const isa = this.memory.read(receiver, 8);
    const klass = this.byAddress.get(isa);
    return klass ? this.resolveFrom(klass, selector) : null;
  }

  private resolveFrom(start: ObjcClass, selector: string): ObjcMethod | null {
    let current: ObjcClass | undefined = start;
    while (current) {
      const method = current.methods.get(selector);
      if (method) return method;
      current = this.byAddress.get(current.superclass);
    }
    return null;
  }

  private resolveClassMethod(start: ObjcClass, selector: string): ObjcMethod | null {
    let current: ObjcClass | undefined = start;
    while (current) {
      const method = current.classMethods.get(selector);
      if (method) return method;
      current = this.byMetaAddress.get(current.metaclassSuperclass);
    }
    return null;
  }

  private classOf(receiver: bigint): bigint {
    const klass = this.byAddress.get(receiver);
    return klass ? klass.address : this.memory.read(receiver, 8);
  }

  private isKindOf(receiver: bigint, target: bigint): boolean {
    let current = this.byAddress.get(this.classOf(receiver));
    while (current) {
      if (current.address === target) return true;
      current = this.byAddress.get(current.superclass);
    }
    return false;
  }

  /**
   * -performSelector: family. The target method's `_cmd` is the requested
   * selector; extra object arguments move into x2/x3.
   */
  private postNotification(cpu: Arm64Cpu, withUserInfo: boolean): SyscallResult {
    const namePointer = cpu.readRegister(2);
    if (namePointer === 0n) return { value: 0n };
    const name = this.readCString(namePointer);
    const object = cpu.readRegister(3);
    const list = [...(this.observers.get(name) ?? []), ...(this.observers.get("") ?? [])];
    if (list.length === 0) return { value: 0n };
    const klass = this.classes.get("NSNotification");
    if (!klass) throw new ObjcError("internal_error", "NSNotification is missing");
    const notification = this.allocateInstance(klass);
    this.memory.write(notification + 8n, 8, namePointer);
    this.memory.write(notification + 16n, 8, object);
    this.memory.write(notification + 24n, 8, withUserInfo ? cpu.readRegister(4) : 0n);
    const calls = list.map((entry) => ({
      receiver: entry.observer,
      selector: entry.selector,
      argument: notification,
    }));
    const stub = this.emitCallStub(this.callbackPool, calls, 0n);
    if (stub !== null) cpu.pc = stub;
    return { value: 0n };
  }

  /**
   * Generate a guest stub that sends several messages in order and returns a
   * value, so a host method can trigger multiple callbacks (notification
   * observers, control targets, lifecycle steps) and still hand control back
   * to the guest caller afterwards.
   */
  private emitCallStub(
    pool: StubPool,
    calls: ReadonlyArray<{ receiver: bigint; selector: bigint; argument: bigint }>,
    returnValue: bigint,
  ): bigint | null {
    if (calls.length === 0) return null;
    const messageSend = this.symbols.get("_objc_msgSend");
    if (!messageSend) throw new ObjcError("internal_error", "objc_msgSend is not registered");
    const address = pool.cursor;
    const code: number[] = [stpPre(29, 30, 31, -16)];
    const literals: bigint[] = [];
    const refs: Array<{ index: number; register: number; slot: number }> = [];
    const addLiteral = (register: number, value: bigint): void => {
      refs.push({ index: code.length, register, slot: literals.length });
      literals.push(value);
      code.push(0);
    };
    for (const call of calls) {
      addLiteral(0, call.receiver);
      addLiteral(1, call.selector);
      addLiteral(2, call.argument);
      addLiteral(16, messageSend);
      code.push(blr(16));
    }
    addLiteral(0, returnValue);
    code.push(ldpPost(29, 30, 31, 16), ret());
    const literalStart = code.length * 4;
    for (const ref of refs) {
      code[ref.index] = ldrLiteral(ref.register, literalStart + ref.slot * 8 - ref.index * 4);
    }
    const size = BigInt(literalStart + literals.length * 8);
    if (address + size > pool.page + 0x1000n) {
      throw new ObjcError("stub_limit", "the callback stub page overflowed");
    }
    pool.cursor = address + size;
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    literals.forEach((value, index) =>
      this.memory.write(address + BigInt(literalStart + index * 8), 8, value),
    );
    return address;
  }

  private performSelector(
    cpu: Arm64Cpu,
    receiver: bigint,
    selectorRegister: number,
    extraArgs: number,
  ): SyscallResult {
    const selectorAddress = cpu.readRegister(selectorRegister);
    const args = [cpu.readRegister(selectorRegister + 1), cpu.readRegister(selectorRegister + 2)];
    const selector = this.readCString(selectorAddress);
    const method = this.resolve(receiver, selector);
    if (!method) {
      throw new ObjcError(
        "unrecognized_selector",
        `${this.describe(receiver)} does not respond to ${selector}`,
      );
    }
    cpu.writeRegister(0, receiver);
    cpu.writeRegister(1, selectorAddress);
    for (let index = 0; index < extraArgs; index += 1) {
      cpu.writeRegister(2 + index, args[index]!);
    }
    return this.invoke(method, cpu);
  }

  /** Send every matching control action through objc_msgSend. */
  private sendControlActions(cpu: Arm64Cpu, control: bigint, mask: bigint): SyscallResult {
    const entries = (this.controlActions.get(control) ?? []).filter(
      (entry) => (entry.events & mask) !== 0n,
    );
    const calls = entries.map((entry) => ({
      receiver: entry.target,
      selector: entry.action,
      argument: control,
    }));
    const stub = this.emitCallStub(this.callbackPool, calls, 0n);
    if (stub !== null) cpu.pc = stub;
    return { value: 0n };
  }

  /** Clamp a slider value to its configured range. */
  private writeSliderValue(receiver: bigint, value: number): void {
    const min = this.readDouble(receiver, SLIDER_MIN);
    const max = this.readDouble(receiver, SLIDER_MAX);
    const clamped = Math.min(Math.max(value, min), max);
    this.writeDouble(receiver, SLIDER_VALUE, clamped);
  }

  /** Map the touch's x position inside the track to a value and notify. */
  private updateSliderFromTouch(cpu: Arm64Cpu, receiver: bigint): SyscallResult {
    const point = this.touchPoint(cpu);
    if (point !== null) {
      const rect = this.readStoredRect(receiver);
      const min = this.readDouble(receiver, SLIDER_MIN);
      const max = this.readDouble(receiver, SLIDER_MAX);
      const ratio = rect.width <= 0 ? 0 : Math.min(1, Math.max(0, (point.x - rect.x) / rect.width));
      this.writeDouble(receiver, SLIDER_VALUE, min + ratio * (max - min));
    }
    return this.sendControlActions(cpu, receiver, CONTROL_EVENT_VALUE_CHANGED);
  }

  private touchPoint(cpu: Arm64Cpu): { x: number; y: number } | null {
    const touches = cpu.readRegister(2);
    if (touches === 0n) return null;
    const touch = this.memory.read(touches + 8n, 8);
    if (touch === 0n) return null;
    return { x: this.readDouble(touch, 8), y: this.readDouble(touch, 16) };
  }

  private drainPool(receiver: bigint): void {
    if (this.poolOwners.get(receiver)) return;
    this.poolOwners.set(receiver, true);
    const drained = this.autoreleasePools.pop();
    if (!drained) return;
    this.stats.poolPops += 1;
    for (const object of drained) this.releaseObject(object);
  }

  private setAssociated(object: bigint, key: bigint, value: bigint, policy: number): void {
    if (!this.instances.has(object)) return;
    let map = this.associations.get(object);
    if (!map) {
      map = new Map();
      this.associations.set(object, map);
    }
    const previous = map.get(key);
    if (previous && retainsAssociation(previous.policy)) this.releaseObject(previous.value);
    if (value === 0n) {
      map.delete(key);
      if (map.size === 0) this.associations.delete(object);
      return;
    }
    if (retainsAssociation(policy)) this.retainObject(value);
    map.set(key, { value, policy });
    this.stats.associations += 1;
  }

  private getAssociated(object: bigint, key: bigint): bigint {
    return this.associations.get(object)?.get(key)?.value ?? 0n;
  }

  private removeAssociated(object: bigint): void {
    const map = this.associations.get(object);
    if (!map) return;
    this.associations.delete(object);
    for (const association of map.values()) {
      if (retainsAssociation(association.policy)) this.releaseObject(association.value);
    }
  }

  private storeWeak(slot: bigint, value: bigint): void {
    const previous = this.weakOwners.get(slot);
    if (previous !== undefined) {
      this.weakSlots.get(previous)?.delete(slot);
      this.weakOwners.delete(slot);
    }
    this.memory.write(slot, 8, value);
    if (value === 0n || !this.instances.has(value)) return;
    let slots = this.weakSlots.get(value);
    if (!slots) {
      slots = new Set();
      this.weakSlots.set(value, slots);
    }
    slots.add(slot);
    this.weakOwners.set(slot, value);
    this.stats.weakStores += 1;
  }

  private loadWeakRetained(slot: bigint): bigint {
    const value = this.memory.read(slot, 8);
    this.stats.weakLoads += 1;
    if (value === 0n || !this.instances.has(value)) return 0n;
    this.retainObject(value);
    return value;
  }

  private destroyWeak(slot: bigint): void {
    const previous = this.weakOwners.get(slot);
    if (previous !== undefined) {
      this.weakSlots.get(previous)?.delete(slot);
      this.weakOwners.delete(slot);
    }
    this.memory.write(slot, 8, 0n);
  }

  private zeroWeakSlots(object: bigint): void {
    const slots = this.weakSlots.get(object);
    if (!slots) return;
    this.weakSlots.delete(object);
    for (const slot of slots) {
      this.memory.write(slot, 8, 0n);
      this.weakOwners.delete(slot);
      this.stats.weakZeroings += 1;
    }
  }

  private retainObject(object: bigint): void {
    if (!this.instances.has(object) || this.deadObjects.has(object)) return;
    this.refcounts.set(object, (this.refcounts.get(object) ?? 1) + 1);
    this.stats.retains += 1;
  }

  /**
   * Drop a reference. Returns a guest `-dealloc` IMP when the object reaches
   * zero and overrides dealloc. Callers that can divert execution (the direct
   * release entry points) schedule it; bookkeeping releases leave the object
   * dead without running guest code.
   */
  private releaseObject(object: bigint): bigint | null {
    if (!this.instances.has(object) || this.deadObjects.has(object)) return null;
    const count = (this.refcounts.get(object) ?? 1) - 1;
    this.stats.releases += 1;
    if (count <= 0) {
      this.refcounts.delete(object);
      this.deadObjects.add(object);
      this.zeroWeakSlots(object);
      this.removeAssociated(object);
      const klass = this.instances.get(object);
      if (!klass) return null;
      const dealloc = this.resolveFrom(klass, "dealloc");
      if (!dealloc || this.hostMethods.has(dealloc.imp)) return null;
      this.stats.deallocs += 1;
      return dealloc.imp;
    }
    this.refcounts.set(object, count);
    return null;
  }

  private scheduleDealloc(cpu: Arm64Cpu, object: bigint, imp: bigint): void {
    const address = this.deallocCursor;
    this.deallocCursor += 64n;
    if (this.deallocCursor > this.deallocPage + 0x1000n) {
      throw new ObjcError("stub_limit", "the -dealloc stub page overflowed");
    }
    const selector = this.internString("dealloc");
    const code = [
      stpPre(29, 30, 31, -16),
      ldrLiteral(0, 16),
      ldrLiteral(1, 24),
      ldrLiteral(16, 32),
      blr(16),
      ldpPost(29, 30, 31, 16),
      ret(),
    ];
    // literals start after 7 instructions (28) but the ldr offsets need exact
    // positions; place them at 32 to keep 8-byte alignment.
    const literalStart = 32;
    code[1] = ldrLiteral(0, literalStart - 1 * 4);
    code[2] = ldrLiteral(1, literalStart + 8 - 2 * 4);
    code[3] = ldrLiteral(16, literalStart + 16 - 3 * 4);
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    this.memory.write(address + 32n, 8, object);
    this.memory.write(address + 40n, 8, selector);
    this.memory.write(address + 48n, 8, imp);
    cpu.writeRegister(0, object);
    cpu.pc = address;
  }

  private autoreleaseObject(object: bigint): void {
    if (!this.instances.has(object)) return;
    this.stats.autoreleases += 1;
    const pool = this.autoreleasePools.at(-1);
    // Apple's runtime leaks an autoreleased object when no pool is in place;
    // releasing immediately would make convenience constructors return dead
    // objects.
    if (pool) pool.push(object);
  }

  private isViewClass(klass: ObjcClass): boolean {
    let current: ObjcClass | undefined = klass;
    let levels = 0;
    while (current && levels < 64) {
      if (current.name === "UIView") return true;
      current = this.byAddress.get(current.superclass);
      levels += 1;
    }
    return false;
  }

  private conformsToProtocol(receiver: bigint, protocol: bigint): boolean {
    if (protocol === 0n) return false;
    const name = this.memory.read(protocol + 8n, 8);
    if (name === 0n) return false;
    const wanted = this.readCString(name);
    const klass = this.byAddress.get(this.classOf(receiver));
    if (!klass) return false;
    for (const candidate of klass.protocols) {
      if (candidate === wanted) return true;
    }
    return false;
  }

  /** `Class:Protocol` pairs, for CLI and tests. */
  protocolSummary(): string[] {
    const summary: string[] = [];
    for (const klass of this.classes.values()) {
      for (const protocol of klass.protocols) summary.push(`${klass.name}:${protocol}`);
    }
    return summary;
  }

  private describe(receiver: bigint): string {
    const klass = this.byAddress.get(this.classOf(receiver));
    return klass ? `<${klass.name}>` : `<object 0x${receiver.toString(16)}>`;
  }

  /** Allocate an NSNumber holding a signed 64-bit value. */
  private newNumber(value: bigint): bigint {
    const numberClass = this.classes.get("NSNumber");
    if (!numberClass) throw new ObjcError("internal_error", "NSNumber is missing");
    const instance = this.allocateInstance(numberClass);
    this.memory.write(instance + BigInt(NUMBER_VALUE), 8, BigInt.asIntN(64, value));
    return instance;
  }

  /** Create an NSTimer; scheduling starts it on the virtual clock. */
  private addTimer(cpu: Arm64Cpu, schedule: boolean): bigint {
    const klass = this.classes.get("NSTimer");
    if (!klass) throw new ObjcError("internal_error", "NSTimer is missing");
    const interval = Math.max(0, cpu.readVectorDouble(0));
    const instance = this.allocateInstance(klass);
    this.timerDefs.set(instance, {
      interval,
      target: cpu.readRegister(2),
      selector: cpu.readRegister(3),
      repeats: cpu.readRegister(4) !== 0n,
    });
    if (schedule) this.scheduledTimers.set(instance, this.clock + interval);
    return instance;
  }

  /** Queue every timer that is due on the virtual clock, earliest first. */
  private collectDueTimers(): void {
    const due = [...this.scheduledTimers.entries()]
      .filter(([, fireAt]) => fireAt <= this.clock + 1e-9)
      .sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1));
    for (const [instance, fireAt] of due) {
      const definition = this.timerDefs.get(instance);
      if (!definition) {
        this.scheduledTimers.delete(instance);
        continue;
      }
      this.pendingCallbacks.push({
        target: definition.target,
        selector: definition.selector,
        argument: instance,
      });
      if (definition.repeats) {
        const step = definition.interval > 0 ? definition.interval : TICK_SECONDS;
        this.scheduledTimers.set(instance, fireAt + step);
      } else {
        this.scheduledTimers.delete(instance);
      }
    }
  }

  /** Queue delayed `performSelector:` calls that are due on the virtual clock. */
  private collectDelayedCalls(): void {
    const due = this.delayedCalls.filter((call) => call.fireAt <= this.clock + 1e-9);
    if (due.length === 0) return;
    for (const call of due) {
      const index = this.delayedCalls.indexOf(call);
      if (index >= 0) this.delayedCalls.splice(index, 1);
      this.pendingCallbacks.push({
        target: call.target,
        selector: call.selector,
        argument: call.argument,
      });
    }
  }

  /** Dictionaries also live in host memory, keyed by their string value. */
  private dictionaryOf(instance: bigint): Map<string, bigint> {
    const map = this.dictionaries.get(instance);
    if (!map) throw new ObjcError("bad_receiver", "object is not a dictionary");
    return map;
  }

  /** Arrays live in host memory; guest code sees only the object handle. */
  private arrayOf(instance: bigint): bigint[] {
    const list = this.arrays.get(instance);
    if (!list) throw new ObjcError("bad_receiver", "object is not an array");
    return list;
  }

  /** Allocate an NSString holding a copy-free pointer to a guest C string. */
  private newString(text: bigint): bigint {
    const klass = this.classes.get("NSString");
    if (!klass) throw new ObjcError("internal_error", "NSString is missing");
    const instance = this.allocateInstance(klass);
    this.memory.write(
      instance + BigInt(STRING_POINTER),
      8,
      text === 0n ? this.internString("") : text,
    );
    return instance;
  }

  /**
   * Read a string argument. The shim accepts both a bare C string and an
   * NSString instance, so older shim calls keep working while apps can pass
   * objects. Objects are recognised by their class chain.
   */
  private stringValue(address: bigint): string {
    if (address === 0n) return "";
    if (this.instanceKindOf(address, "NSString")) {
      const pointer = this.memory.read(address + BigInt(STRING_POINTER), 8);
      return pointer === 0n ? "" : this.memory.readCString(pointer, 4096);
    }
    return this.memory.readCString(address, 4096);
  }

  private instanceKindOf(instance: bigint, name: string): boolean {
    let klass = this.instances.get(instance);
    while (klass) {
      if (klass.name === name) return true;
      if (klass.superclass === 0n) return false;
      klass = this.byAddress.get(klass.superclass);
    }
    return false;
  }

  private readCString(address: bigint): string {
    if (address === 0n) throw new ObjcError("bad_selector", "null selector");
    return this.memory.readCString(address, 512);
  }

  private readRect(cpu: Arm64Cpu): Rect {
    return {
      x: cpu.readVectorDouble(0),
      y: cpu.readVectorDouble(1),
      width: cpu.readVectorDouble(2),
      height: cpu.readVectorDouble(3),
    };
  }

  private writeRectToRegisters(cpu: Arm64Cpu, rect: Rect): void {
    cpu.writeVectorDouble(0, rect.x);
    cpu.writeVectorDouble(1, rect.y);
    cpu.writeVectorDouble(2, rect.width);
    cpu.writeVectorDouble(3, rect.height);
  }

  private writeRect(receiver: bigint, rect: Rect): void {
    this.memory.write(receiver + BigInt(VIEW_FRAME_X), 8, doubleBits(rect.x));
    this.memory.write(receiver + BigInt(VIEW_FRAME_Y), 8, doubleBits(rect.y));
    this.memory.write(receiver + BigInt(VIEW_FRAME_WIDTH), 8, doubleBits(rect.width));
    this.memory.write(receiver + BigInt(VIEW_FRAME_HEIGHT), 8, doubleBits(rect.height));
  }

  private readStoredRect(receiver: bigint): Rect {
    return {
      x: this.readDouble(receiver, VIEW_FRAME_X),
      y: this.readDouble(receiver, VIEW_FRAME_Y),
      width: this.readDouble(receiver, VIEW_FRAME_WIDTH),
      height: this.readDouble(receiver, VIEW_FRAME_HEIGHT),
    };
  }

  private writeDouble(receiver: bigint, offset: number, value: number): void {
    this.memory.write(receiver + BigInt(offset), 8, doubleBits(value));
  }

  private readDouble(receiver: bigint, offset: number): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, this.memory.read(receiver + BigInt(offset), 8), true);
    return view.getFloat64(0, true);
  }

  private addSubview(parent: bigint, child: bigint, index?: number): void {
    if (child === 0n) return;
    const list = this.children.get(parent) ?? [];
    if (list.includes(child)) return;
    if (list.length >= MAX_CHILDREN) {
      throw new ObjcError("view_limit", `a view already has ${MAX_CHILDREN} subviews`);
    }
    if (index === undefined || index >= list.length) list.push(child);
    else list.splice(Math.max(0, index), 0, child);
    this.children.set(parent, list);
  }

  private controllerView(controller: bigint): bigint {
    if (controller === 0n) return 0n;
    const existing = this.memory.read(controller + BigInt(CONTROLLER_VIEW), 8);
    if (existing !== 0n) return existing;
    const klass = this.classes.get("UIView");
    if (!klass) return 0n;
    const view = this.allocateInstance(klass);
    this.writeRect(view, { x: 0, y: 0, width: this.width, height: this.height });
    this.memory.write(controller + BigInt(CONTROLLER_VIEW), 8, view);
    if (!this.loadedControllers.has(controller))
      this.queueLifecycle(controller, view, "viewDidLoad");
    return view;
  }

  /**
   * Queue a lifecycle callback. Callbacks are coalesced per controller and
   * sent in order by a single generated guest stub, so a caller that triggers
   * several of them in one message (create view, add it to a visible window)
   * still resumes normally afterwards.
   */
  private queueLifecycle(controller: bigint, view: bigint, selector: string): void {
    const pending = this.pendingLifecycle.get(controller) ?? { view, selectors: [] };
    pending.view = view;
    if (!pending.selectors.includes(selector)) pending.selectors.push(selector);
    this.pendingLifecycle.set(controller, pending);
  }

  /** Mark a controller as appeared once its view is in a visible window. */
  private requestAppearance(controller: bigint): void {
    if (controller === 0n || this.appearedControllers.has(controller)) return;
    const view = this.memory.read(controller + BigInt(CONTROLLER_VIEW), 8);
    if (view === 0n) return;
    this.appearedControllers.add(controller);
    this.queueLifecycle(controller, view, "viewWillAppear:");
    this.queueLifecycle(controller, view, "viewDidAppear:");
  }

  /**
   * Build one guest stub that calls the queued lifecycle selectors with the
   * controller's view in x0, restores the caller's stack, and returns the view.
   * The host method that queued them returns a plain value; the CPU resumes at
   * this stub and comes back to the guest caller after the callbacks run.
   */
  private flushLifecycle(controller: bigint, cpu: Arm64Cpu): void {
    if (this.controllerDepth > 0) return;
    const pending = this.pendingLifecycle.get(controller);
    if (!pending) return;
    this.pendingLifecycle.delete(controller);
    for (const selector of pending.selectors) {
      if (selector === "viewDidLoad") this.loadedControllers.add(controller);
    }
    const calls: Array<{ receiver: bigint; selector: bigint; argument: bigint }> = [];
    for (const name of pending.selectors) {
      const method = this.resolve(controller, name);
      if (!method || this.hostMethods.has(method.imp)) continue;
      calls.push({ receiver: controller, selector: this.internString(name), argument: 0n });
    }
    const stub = this.emitCallStub(this.lifecyclePool, calls, pending.view);
    if (stub === null) return;
    cpu.writeRegister(0, pending.view);
    cpu.pc = stub;
  }

  private uiApplicationMain(cpu: Arm64Cpu): SyscallResult {
    const delegateName =
      cpu.readRegister(3) === 0n ? "AppDelegate" : this.readCString(cpu.readRegister(3));
    const delegateClass = this.classes.get(delegateName);
    if (!delegateClass) {
      throw new ObjcError(
        "missing_delegate_class",
        `UIApplicationMain asks for ${delegateName}, which the image does not define`,
      );
    }
    const applicationClass = this.classes.get("UIApplication");
    if (!applicationClass) throw new ObjcError("internal_error", "UIApplication is missing");

    const application = this.allocateInstance(applicationClass);
    const delegate = this.allocateInstance(delegateClass);
    this.sharedApplication = application;
    this.applicationDelegate = delegate;

    const method = this.resolveFrom(delegateClass, "application:didFinishLaunchingWithOptions:");
    if (method) {
      if (this.stubCount >= MAX_STUBS) {
        throw new ObjcError("stub_limit", `more than ${MAX_STUBS} UIApplicationMain calls`);
      }
      const messageSend = this.symbols.get("_objc_msgSend");
      if (!messageSend) throw new ObjcError("internal_error", "objc_msgSend is not registered");
      const becomesActive = this.resolveFrom(delegateClass, "applicationDidBecomeActive:") !== null;
      const willTerminate = this.resolveFrom(delegateClass, "applicationWillTerminate:") !== null;
      const stub = this.writeApplicationStub(becomesActive, willTerminate);
      cpu.writeRegister(0, delegate);
      cpu.writeRegister(1, this.internString("application:didFinishLaunchingWithOptions:"));
      cpu.writeRegister(2, application);
      cpu.writeRegister(3, 0n);
      cpu.pc = stub;
      return { value: delegate };
    }
    this.present();
    return { value: 0n };
  }

  /**
   * Guest stub: delegate callback, then a bounded event loop.
   *
   *   send application:didFinishLaunchingWithOptions:   (objc_msgSend)
   *   present
   *   loop:
   *     record = nextEvent()                            (host trap, 0 = done)
   *     if (!record) break
   *     [record.view touchesBegan:record.touches withEvent:record.event]
   *     present
   *     [record.view touchesEnded:...]
   *     present
   *   return 0
   *
   * The stub owns the ABI: every guest callback is a normal `blr` through
   * `objc_msgSend`, so +initialize, categories, and overrides all apply.
   */
  private writeApplicationStub(becomesActive: boolean, willTerminate: boolean): bigint {
    const messageSend = this.symbols.get("_objc_msgSend");
    if (!messageSend) throw new ObjcError("internal_error", "objc_msgSend is not registered");
    const address = this.stubCursor;
    if (this.stubCursor + 256n > this.stubPage + BigInt(STUB_PAGE)) {
      throw new ObjcError("stub_limit", "the ObjC stub page overflowed");
    }
    const code: number[] = [];
    const literals: bigint[] = [];
    const literalRefs: Array<{ index: number; register: number; slot: number }> = [];
    const loadLiteral = (register: number, value: bigint): void => {
      literalRefs.push({ index: code.length, register, slot: literals.length });
      literals.push(value);
      code.push(0);
    };

    code.push(stpPre(29, 30, 31, -16));
    code.push(stpPre(19, 20, 31, -16));
    code.push(stpPre(21, 22, 31, -16));
    code.push(stpPre(23, 24, 31, -16));
    code.push(movReg(19, 0));
    code.push(movReg(20, 1));
    code.push(movReg(21, 2));
    code.push(movReg(22, 3));
    code.push(movReg(23, 0));
    code.push(movReg(24, 2));

    loadLiteral(16, messageSend);
    code.push(movReg(0, 19));
    code.push(movReg(1, 20));
    code.push(movReg(2, 21));
    code.push(movReg(3, 22));
    code.push(blr(16));

    if (becomesActive) {
      code.push(movReg(0, 23));
      loadLiteral(1, this.internString("applicationDidBecomeActive:"));
      code.push(movReg(2, 24));
      code.push(movz(3, 0));
      loadLiteral(16, messageSend);
      code.push(blr(16));
    }

    loadLiteral(16, this.presentAddress);
    code.push(blr(16));

    const loopStart = code.length;
    loadLiteral(16, this.nextEventAddress);
    code.push(blr(16));
    const doneCheck = code.length;
    code.push(cbz(0, 0));
    code.push(movReg(19, 0));
    code.push(ldrUnsigned(20, 19, 0));
    code.push(ldrUnsigned(21, 19, 8));
    code.push(ldrUnsigned(22, 19, 16));
    code.push(ldrUnsigned(1, 19, 24));
    code.push(movReg(0, 20));
    code.push(movReg(2, 21));
    code.push(movReg(3, 22));
    loadLiteral(16, messageSend);
    code.push(blr(16));
    loadLiteral(16, this.presentAddress);
    code.push(blr(16));
    const back = code.length;
    code.push(b(0));
    const done = code.length;
    if (willTerminate) {
      code.push(movReg(0, 23));
      loadLiteral(1, this.internString("applicationWillTerminate:"));
      code.push(movReg(2, 24));
      code.push(movz(3, 0));
      loadLiteral(16, messageSend);
      code.push(blr(16));
    }
    code.push(movz(0, 0));
    code.push(ldpPost(23, 24, 31, 16));
    code.push(ldpPost(21, 22, 31, 16));
    code.push(ldpPost(19, 20, 31, 16));
    code.push(ldpPost(29, 30, 31, 16));
    code.push(ret());
    code[doneCheck] = cbz(0, (done - doneCheck) * 4);
    code[back] = b((loopStart - back) * 4);

    const literalStart = code.length * 4;
    for (const ref of literalRefs) {
      code[ref.index] = ldrLiteral(ref.register, literalStart + ref.slot * 8 - ref.index * 4);
    }
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    literals.forEach((value, index) =>
      this.memory.write(address + BigInt(literalStart + index * 8), 8, value),
    );
    this.stubCount += 1;
    this.stubCursor += 256n;
    return address;
  }

  /** Prepare the next touch callback and return `{view, touches, event, selector}`. */
  private nextEvent(_cpu: Arm64Cpu): SyscallResult {
    const step = this.touchScript[this.eventIndex];
    if (this.pendingCallbacks.length === 0) this.collectDelayedCalls();
    if (!step && this.pendingCallbacks.length === 0) return { value: 0n };
    if (this.pendingCallbacks.length > 0) {
      return this.dispatchCallback(this.pendingCallbacks.shift()!);
    }
    if (!step) return { value: 0n };
    if (step.kind === "tick" && !this.tickAdvanced) {
      this.tickAdvanced = true;
      this.clock += TICK_SECONDS;
      this.collectDelayedCalls();
      this.collectDueTimers();
      if (this.pendingCallbacks.length > 0) {
        return this.dispatchCallback(this.pendingCallbacks.shift()!);
      }
    }
    this.eventIndex += 1;
    if (step.kind === "tick") this.tickAdvanced = false;

    let receiver: bigint | null;
    if (step.kind === "tick") {
      receiver = this.applicationDelegate;
    } else {
      const window = this.keyWindow ?? this.windows.at(-1) ?? null;
      receiver = window === null ? null : this.hitTest(window, step, 0, 0);
    }
    if (receiver === null) return { value: 0n };

    const record = this.memory.allocate(32, { tag: "objc-event" });
    this.memory.write(record, 8, receiver);
    if (step.kind === "touch") {
      const touchClass = this.classes.get("UITouch");
      const setClass = this.classes.get("NSSet");
      const uiEventClass = this.classes.get("UIEvent");
      if (!touchClass || !setClass || !uiEventClass) {
        throw new ObjcError("internal_error", "event objects are not registered");
      }
      const touch = this.allocateInstance(touchClass);
      this.memory.write(touch + 8n, 8, doubleBits(step.x));
      this.memory.write(touch + 16n, 8, doubleBits(step.y));
      const touches = this.allocateInstance(setClass);
      this.memory.write(touches + 8n, 8, touch);
      const uiEvent = this.allocateInstance(uiEventClass);
      this.memory.write(record + 8n, 8, touches);
      this.memory.write(record + 16n, 8, uiEvent);
    }
    this.memory.write(record + 24n, 8, this.internString(step.selector));
    return { value: record };
  }

  /** Build the event record that makes the loop send a scheduled callback. */
  private dispatchCallback(call: {
    target: bigint;
    selector: bigint;
    argument: bigint;
  }): SyscallResult {
    const record = this.memory.allocate(32, { tag: "objc-timer-event" });
    this.memory.write(record, 8, call.target);
    this.memory.write(record + 8n, 8, call.argument);
    this.memory.write(record + 16n, 8, 0n);
    this.memory.write(record + 24n, 8, call.selector);
    return { value: record };
  }

  private hitTest(
    view: bigint,
    point: { x: number; y: number },
    originX: number,
    originY: number,
  ): bigint | null {
    if (this.memory.read(view + BigInt(VIEW_HIDDEN), 1) !== 0n) return null;
    const frame = this.readStoredRect(view);
    const absoluteX = originX + frame.x;
    const absoluteY = originY + frame.y;
    const clipped =
      this.memory.read(view + BigInt(VIEW_CLIPS), 1) !== 0n &&
      !containsPoint(frame, { x: point.x - originX, y: point.y - originY });
    if (clipped) return null;
    const children = this.children.get(view) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (
        !containsPoint(this.readStoredRect(child), {
          x: point.x - absoluteX,
          y: point.y - absoluteY,
        })
      ) {
        continue;
      }
      const childOriginX = absoluteX - this.scrollOffsetX(view);
      const childOriginY = absoluteY - this.scrollOffsetY(view);
      const hit = this.hitTest(child, point, childOriginX, childOriginY);
      if (hit !== null) return hit;
    }
    return containsPoint(frame, { x: point.x - originX, y: point.y - originY }) ? view : null;
  }

  private present(): void {
    if (this.frames.length >= this.maxFrames) return;
    const window = this.keyWindow ?? this.windows.at(-1) ?? null;
    if (window === null) return;
    const clip = { x: 0, y: 0, width: this.width, height: this.height };
    const framebuffer = new Framebuffer(this.width, this.height);
    framebuffer.clear(WHITE);
    this.paint(window, framebuffer, 0, 0, clip, 1);
    const digest = framebuffer.digest();
    if (this.frames.at(-1)?.digest === digest) return;
    this.frames.push({
      width: this.width,
      height: this.height,
      pixels: framebuffer.pixels.slice(),
      digest,
    });
  }

  private paint(
    view: bigint,
    framebuffer: Framebuffer,
    originX: number,
    originY: number,
    clip: { x: number; y: number; width: number; height: number },
    parentAlpha: number,
  ): void {
    if (this.memory.read(view + BigInt(VIEW_HIDDEN), 1) !== 0n) return;
    const rect = this.readStoredRect(view);
    const absoluteX = originX + rect.x;
    const absoluteY = originY + rect.y;
    const alpha = Math.max(0, Math.min(1, this.readDouble(view, VIEW_ALPHA))) * parentAlpha;
    if (alpha <= 0 || rect.width <= 0 || rect.height <= 0) return;
    const color = this.colorOf(view);
    if (color && color.a > 0) {
      framebuffer.fillRect(
        absoluteX,
        absoluteY,
        rect.width,
        rect.height,
        { ...color, a: color.a * alpha },
        clip,
      );
    }
    const klass = this.instances.get(view);
    if (klass?.name === "UISwitch") {
      this.paintSwitch(view, framebuffer, absoluteX, absoluteY, rect, clip, alpha);
    } else if (klass?.name === "UISlider") {
      this.paintSlider(view, framebuffer, absoluteX, absoluteY, rect, clip, alpha);
    }
    if (klass?.name === "UILabel") {
      const textPointer = this.memory.read(view + BigInt(LABEL_TEXT), 8);
      if (textPointer !== 0n) {
        const text = this.stringValue(textPointer);
        const colorPointer = this.memory.read(view + BigInt(LABEL_COLOR), 8);
        const color = colorPointer === 0n ? BLACK : (this.colorAtPointer(colorPointer) ?? BLACK);
        const scale = Math.max(1, Math.min(8, Math.round(this.readDouble(view, LABEL_SCALE) || 2)));
        const width = textWidth(text, scale);
        const alignment = Number(this.memory.read(view + BigInt(LABEL_ALIGNMENT), 8));
        const offset =
          alignment === 1
            ? Math.max(0, (rect.width - width) / 2)
            : alignment === 2
              ? Math.max(0, rect.width - width - scale * 2)
              : scale * 2;
        drawText(framebuffer, absoluteX + offset, absoluteY + scale * 2, text, {
          scale,
          color,
        });
      }
    }
    const childClip =
      this.memory.read(view + BigInt(VIEW_CLIPS), 1) === 0n
        ? clip
        : intersectClip(clip, {
            x: absoluteX,
            y: absoluteY,
            width: rect.width,
            height: rect.height,
          });
    const childOriginX = absoluteX - this.scrollOffsetX(view);
    const childOriginY = absoluteY - this.scrollOffsetY(view);
    for (const child of this.children.get(view) ?? []) {
      this.paint(child, framebuffer, childOriginX, childOriginY, childClip, alpha);
    }
  }

  /** Draw a pill track and a round knob: deterministic, no images or layers. */
  private paintSwitch(
    view: bigint,
    framebuffer: Framebuffer,
    x: number,
    y: number,
    rect: { width: number; height: number },
    clip: { x: number; y: number; width: number; height: number },
    alpha: number,
  ): void {
    const on = this.memory.read(view + BigInt(SWITCH_ON), 1) !== 0n;
    const height = rect.height;
    const radius = height / 2;
    const track: Rgba = on
      ? { r: 52, g: 199, b: 89, a: 255 * alpha }
      : { r: 200, g: 200, b: 205, a: 255 * alpha };
    for (let row = 0; row < height; row += 1) {
      const dy = row + 0.5 - radius;
      const inset = radius - Math.sqrt(Math.max(0, radius * radius - dy * dy));
      const left = x + inset;
      const right = x + rect.width - inset;
      if (right > left) framebuffer.fillRect(left, y + row, right - left, 1, track, clip);
    }
    const diameter = Math.max(2, height - 4);
    const knobRadius = diameter / 2;
    const centreX = on ? x + rect.width - 2 - knobRadius : x + 2 + knobRadius;
    const centreY = y + height / 2;
    this.fillCircle(
      framebuffer,
      centreX,
      centreY,
      knobRadius,
      {
        r: 255,
        g: 255,
        b: 255,
        a: 255 * alpha,
      },
      clip,
    );
  }

  /** Rasterise a filled circle one horizontal span at a time. */
  private fillCircle(
    framebuffer: Framebuffer,
    centreX: number,
    centreY: number,
    radius: number,
    color: Rgba,
    clip: { x: number; y: number; width: number; height: number },
  ): void {
    for (let row = 0; row < radius * 2; row += 1) {
      const dy = row + 0.5 - radius;
      const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
      if (half <= 0) continue;
      framebuffer.fillRect(centreX - half, centreY - radius + row, half * 2, 1, color, clip);
    }
  }

  /** Draw a filled track and a knob at the slider's value. */
  private paintSlider(
    view: bigint,
    framebuffer: Framebuffer,
    x: number,
    y: number,
    rect: { width: number; height: number },
    clip: { x: number; y: number; width: number; height: number },
    alpha: number,
  ): void {
    const min = this.readDouble(view, SLIDER_MIN);
    const max = this.readDouble(view, SLIDER_MAX);
    const span = max - min;
    const ratio =
      span === 0 ? 0 : Math.min(1, Math.max(0, (this.readDouble(view, SLIDER_VALUE) - min) / span));
    const radius = Math.max(3, Math.min(rect.height / 2, 11));
    const left = x + radius;
    const right = x + rect.width - radius;
    const centreY = y + rect.height / 2;
    const trackHeight = Math.max(2, Math.round(rect.height / 6));
    const knobX = left + (right - left) * ratio;
    framebuffer.fillRect(
      left,
      centreY - trackHeight / 2,
      right - left,
      trackHeight,
      {
        r: 200,
        g: 200,
        b: 205,
        a: 255 * alpha,
      },
      clip,
    );
    framebuffer.fillRect(
      left,
      centreY - trackHeight / 2,
      Math.max(0, knobX - left),
      trackHeight,
      {
        r: 52,
        g: 199,
        b: 89,
        a: 255 * alpha,
      },
      clip,
    );
    this.fillCircle(
      framebuffer,
      knobX,
      centreY,
      radius,
      { r: 190, g: 190, b: 195, a: 255 * alpha },
      clip,
    );
    this.fillCircle(
      framebuffer,
      knobX,
      centreY,
      Math.max(1, radius - 2),
      {
        r: 255,
        g: 255,
        b: 255,
        a: 255 * alpha,
      },
      clip,
    );
  }

  private scrollOffsetX(view: bigint): number {
    return this.instances.get(view)?.name === "UIScrollView"
      ? this.readDouble(view, SCROLL_OFFSET_X)
      : 0;
  }

  private scrollOffsetY(view: bigint): number {
    return this.instances.get(view)?.name === "UIScrollView"
      ? this.readDouble(view, SCROLL_OFFSET_Y)
      : 0;
  }

  private colorOf(view: bigint): Rgba | null {
    return this.colorAtPointer(this.memory.read(view + BigInt(VIEW_BACKGROUND), 8));
  }

  private colorAtPointer(pointer: bigint): Rgba | null {
    if (pointer === 0n) return null;
    const klass = this.instances.get(pointer);
    if (!klass || klass.name !== "UIColor") return null;
    return {
      r: this.readDouble(pointer, COLOR_RED) * 255,
      g: this.readDouble(pointer, COLOR_GREEN) * 255,
      b: this.readDouble(pointer, COLOR_BLUE) * 255,
      a: this.readDouble(pointer, COLOR_ALPHA) * 255,
    };
  }

  private internString(value: string): bigint {
    const existing = this.strings.get(value);
    if (existing) return existing;
    const address = this.allocBytes(value.length + 1);
    this.memory.writeCString(address, value);
    this.strings.set(value, address);
    return address;
  }

  private readonly strings = new Map<string, bigint>();

  private allocBytes(size: number): bigint {
    const aligned = (this.arenaCursor + 7n) & ~7n;
    const end = aligned + BigInt(size);
    if (end > this.arenaEnd) {
      throw new ObjcError("arena_exhausted", "the ObjC host arena is full");
    }
    this.arenaCursor = end;
    return aligned;
  }

  private writeU32(address: bigint, value: number): void {
    this.memory.write(address, 4, BigInt(value));
  }

  private writeU64(address: bigint, value: bigint | number): void {
    this.memory.write(address, 8, BigInt(value));
  }
}

function buildTouchScript(events: readonly InputEvent[]): TouchStep[] {
  const steps: TouchStep[] = [];
  const began = "touchesBegan:withEvent:";
  const moved = "touchesMoved:withEvent:";
  const ended = "touchesEnded:withEvent:";
  for (const event of events) {
    if ("kind" in event) {
      steps.push({ kind: "tick", x: 0, y: 0, selector: "tick:" });
      continue;
    }
    if ("x" in event) {
      steps.push({ kind: "touch", x: event.x, y: event.y, selector: began });
      steps.push({ kind: "touch", x: event.x, y: event.y, selector: ended });
      continue;
    }
    const samples = Math.max(2, Math.min(event.steps ?? 4, 64));
    steps.push({ kind: "touch", x: event.fromX, y: event.fromY, selector: began });
    for (let index = 1; index < samples - 1; index += 1) {
      const ratio = index / (samples - 1);
      steps.push({
        kind: "touch",
        x: event.fromX + (event.toX - event.fromX) * ratio,
        y: event.fromY + (event.toY - event.fromY) * ratio,
        selector: moved,
      });
    }
    steps.push({ kind: "touch", x: event.toX, y: event.toY, selector: ended });
  }
  return steps;
}

function depth(classes: ReadonlyMap<bigint, ObjcClass>, klass: ObjcClass): number {
  let current: ObjcClass | undefined = klass;
  let levels = 0;
  while (current && levels < 64) {
    levels += 1;
    current = classes.get(current.superclass);
  }
  return levels;
}

interface Association {
  readonly value: bigint;
  readonly policy: number;
}

function retainsAssociation(policy: number): boolean {
  return (policy & 0x1) !== 0;
}

function intersectClip(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(outer.x, inner.x);
  const y = Math.max(outer.y, inner.y);
  const right = Math.min(outer.x + outer.width, inner.x + inner.width);
  const bottom = Math.min(outer.y + outer.height, inner.y + inner.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function containsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

function loadImmediate(register: number, value: number): number[] {
  const words = [movz(register, value & 0xffff)];
  for (let shift = 16; shift < 64; shift += 16) {
    const chunk = Math.floor(value / 2 ** shift) & 0xffff;
    if (chunk !== 0) words.push(movk(register, chunk, shift));
  }
  return words;
}

function doubleBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}
