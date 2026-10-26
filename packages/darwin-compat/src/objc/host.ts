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
import { Framebuffer, WHITE, type Rgba } from "../ui/framebuffer.js";
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
const VIEW_INSTANCE_SIZE = 56;

const COLOR_RED = 8;
const COLOR_GREEN = 16;
const COLOR_BLUE = 24;
const COLOR_ALPHA = 32;
const COLOR_INSTANCE_SIZE = 40;

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
  /** Scripted taps delivered after `didFinishLaunching`. */
  readonly events?: readonly InputEvent[];
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
  private readonly deallocPage: bigint;
  private deallocCursor: bigint;
  private readonly autoreleasePools: bigint[][] = [];
  private readonly initializeStubs = new Map<bigint, bigint>();
  private readonly initializePage: bigint;
  private readonly loadStubPage: bigint;
  private initializeStubCursor: bigint;
  private readonly resendAddress: bigint;
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
          run: (_cpu, receiver) => {
            this.keyWindow = receiver;
            if (!this.windows.includes(receiver)) this.windows.push(receiver);
            this.present();
          },
        },
        {
          selector: "setRootViewController:",
          types: "v24@0:8@16",
          run: (cpu, receiver) => {
            const controller = cpu.readRegister(2);
            this.memory.write(receiver + BigInt(CONTROLLER_VIEW), 8, controller);
            const child = this.controllerView(controller);
            if (child !== 0n) this.addSubview(receiver, child);
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

    const controller = this.defineClass({
      name: "UIViewController",
      superclass: "NSObject",
      instanceSize: CONTROLLER_INSTANCE_SIZE,
      methods: [
        { selector: "init", types: "@16@0:8", run: self },
        {
          selector: "view",
          types: "@16@0:8",
          run: (cpu, receiver) => cpu.writeRegister(0, this.controllerView(receiver)),
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

  private readDouble(receiver: bigint, offset: number): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, this.memory.read(receiver + BigInt(offset), 8), true);
    return view.getFloat64(0, true);
  }

  private addSubview(parent: bigint, child: bigint): void {
    if (child === 0n) return;
    const list = this.children.get(parent) ?? [];
    if (list.includes(child)) return;
    if (list.length >= MAX_CHILDREN) {
      throw new ObjcError("view_limit", `a view already has ${MAX_CHILDREN} subviews`);
    }
    list.push(child);
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
    return view;
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
      const stub = this.writeApplicationStub();
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
  private writeApplicationStub(): bigint {
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
    code.push(movReg(19, 0));
    code.push(movReg(20, 1));
    code.push(movReg(21, 2));
    code.push(movReg(22, 3));

    loadLiteral(16, messageSend);
    code.push(movReg(0, 19));
    code.push(movReg(1, 20));
    code.push(movReg(2, 21));
    code.push(movReg(3, 22));
    code.push(blr(16));

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
    code.push(movz(0, 0));
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
    if (!step) return { value: 0n };
    this.eventIndex += 1;

    let receiver: bigint | null;
    if (step.kind === "tick") {
      receiver = this.applicationDelegate;
    } else {
      const window = this.keyWindow ?? this.windows.at(-1) ?? null;
      receiver = window === null ? null : this.hitTest(window, step);
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

  private hitTest(view: bigint, point: { x: number; y: number }): bigint | null {
    if (this.memory.read(view + BigInt(VIEW_HIDDEN), 1) !== 0n) return null;
    const children = this.children.get(view) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (!containsPoint(this.readStoredRect(child), point)) continue;
      const hit = this.hitTest(child, point);
      if (hit !== null) return hit;
    }
    return containsPoint(this.readStoredRect(view), point) ? view : null;
  }

  private present(): void {
    if (this.frames.length >= this.maxFrames) return;
    const window = this.keyWindow ?? this.windows.at(-1) ?? null;
    if (window === null) return;
    const clip = { x: 0, y: 0, width: this.width, height: this.height };
    const framebuffer = new Framebuffer(this.width, this.height);
    framebuffer.clear(WHITE);
    this.paint(window, framebuffer, clip);
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
    clip: { x: number; y: number; width: number; height: number },
  ): void {
    if (this.memory.read(view + BigInt(VIEW_HIDDEN), 1) !== 0n) return;
    const rect = this.readStoredRect(view);
    if (rect.width <= 0 || rect.height <= 0) return;
    const color = this.colorOf(view);
    if (color && color.a > 0) {
      framebuffer.fillRect(rect.x, rect.y, rect.width, rect.height, color, clip);
    }
    for (const child of this.children.get(view) ?? []) this.paint(child, framebuffer, clip);
  }

  private colorOf(view: bigint): Rgba | null {
    const pointer = this.memory.read(view + BigInt(VIEW_BACKGROUND), 8);
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
