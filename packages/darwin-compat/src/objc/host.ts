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
  blr,
  ldpPost,
  ldrLiteral,
  ldrUnsigned,
  movReg,
  movz,
  ret,
  stpPre,
  svc,
} from "../arm64/assembler.js";
import {
  CLASS_RO_SIZE,
  CLASS_T_SIZE,
  RO_META,
  RO_ROOT,
  parseObjcClasses,
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

export interface ObjcHostOptions {
  readonly memory: VirtualMemory;
  readonly width?: number;
  readonly height?: number;
  readonly maxFrames?: number;
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
  readonly frames: CapturedFrame[] = [];
  readonly width: number;
  readonly height: number;

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
  private readonly children = new Map<bigint, bigint[]>();
  private readonly windows: bigint[] = [];
  private keyWindow: bigint | null = null;
  private sharedApplication: bigint | null = null;
  private applicationDelegate: bigint | null = null;
  private readonly presentAddress: bigint;

  constructor(options: ObjcHostOptions) {
    this.memory = options.memory;
    this.width = options.width ?? DEFAULT_SCREEN.width;
    this.height = options.height ?? DEFAULT_SCREEN.height;
    this.maxFrames = options.maxFrames ?? MAX_FRAMES;
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
  }

  /** Register the classes of every loaded image. */
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

    for (const name of [
      "_objc_retain",
      "_objc_release",
      "_objc_autorelease",
      "_objc_retainAutorelease",
      "_objc_retainAutoreleasedReturnValue",
      "_objc_autoreleaseReturnValue",
      "_objc_unsafeClaimAutoreleasedReturnValue",
      "_objc_retainBlock",
      "_objc_opt_self",
    ]) {
      this.registerSymbol(name, (cpu) => ({ value: cpu.readRegister(0) }));
    }

    this.registerSymbol("_objc_autoreleasePoolPush", () => ({ value: 1n }));
    this.registerSymbol("_objc_autoreleasePoolPop", () => ({ value: 0n }));
    this.registerSymbol("_objc_sync_enter", () => ({ value: 0n }));
    this.registerSymbol("_objc_sync_exit", () => ({ value: 0n }));

    this.registerSymbol("_objc_storeStrong", (cpu) => {
      this.memory.write(cpu.readRegister(0), 8, cpu.readRegister(1));
      return { value: cpu.readRegister(1) };
    });
    this.registerSymbol("_objc_storeWeak", (cpu) => {
      this.memory.write(cpu.readRegister(0), 8, cpu.readRegister(1));
      return { value: cpu.readRegister(1) };
    });
    this.registerSymbol("_objc_loadWeakRetained", (cpu) => ({
      value: this.memory.read(cpu.readRegister(0), 8),
    }));
    this.registerSymbol("_objc_destroyWeak", () => ({ value: 0n }));

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
        { selector: "retain", types: "@16@0:8", run: self },
        { selector: "release", types: "v16@0:8", run: () => undefined },
        { selector: "autorelease", types: "@16@0:8", run: self },
        { selector: "retainCount", types: "Q16@0:8", run: (cpu) => cpu.writeRegister(0, 1n) },
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
        { selector: "initialize", types: "v16@0:8", run: () => undefined },
      ],
    });
    this.registerClass(object);

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
            cpu.writeRegister(0, instance);
          },
        },
        this.constantColor("redColor", { r: 1, g: 0, b: 0, a: 1 }),
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
    return address;
  }

  private messageSend(cpu: Arm64Cpu): SyscallResult {
    const receiver = cpu.readRegister(0);
    if (receiver === 0n) {
      cpu.writeRegister(0, 0n);
      return { value: 0n };
    }
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
    const superclass = this.memory.read(superPointer + 8n, 8);
    const selector = this.readCString(cpu.readRegister(1));
    const start = this.byAddress.get(superclass);
    if (!start) {
      throw new ObjcError("bad_receiver", `objc_msgSendSuper2 superclass is not registered`);
    }
    const method = this.resolveFrom(start, selector);
    if (!method) {
      throw new ObjcError("unrecognized_selector", `superclass does not respond to ${selector}`);
    }
    return this.invoke(method, cpu);
  }

  private invoke(method: ObjcMethod, cpu: Arm64Cpu): SyscallResult {
    const host = this.hostMethods.get(method.imp);
    if (host) return host(cpu);
    if (method.imp === 0n) {
      throw new ObjcError("bad_objc_metadata", `method ${method.selector} has a null IMP`);
    }
    // Guest IMP: tail-call it with the argument registers untouched. The
    // return address already points at the caller of objc_msgSend.
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
      const stub = this.writeApplicationStub(method.imp, this.presentAddress);
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
   * Guest stub that runs the delegate callback and then the host presenter:
   *
   *   stp x19, x20, [sp, #-16]!
   *   mov x19, x0            ; delegate
   *   mov x20, x1            ; selector
   *   ldr x16, =imp
   *   mov x0, x19
   *   mov x1, x20
   *   blr x16
   *   ldr x16, =present
   *   blr x16
   *   ldp x19, x20, [sp], #16
   *   ret
   *
   * A normal `bl` keeps the guest ABI intact: the delegate's own stack frame
   * and callee-saved registers are the application's business.
   */
  private writeApplicationStub(imp: bigint, present: bigint): bigint {
    const address = this.stubCursor;
    const code = [
      stpPre(29, 30, 31, -16),
      stpPre(19, 20, 31, -16),
      movReg(19, 0),
      movReg(20, 1),
      ldrLiteral(16, 40),
      movReg(0, 19),
      movReg(1, 20),
      blr(16),
      movz(0, 0),
      ldrLiteral(16, 28),
      blr(16),
      ldpPost(19, 20, 31, 16),
      ldpPost(29, 30, 31, 16),
      ret(),
    ];
    code.forEach((word, index) => this.memory.write(address + BigInt(index * 4), 4, BigInt(word)));
    this.memory.write(address + 56n, 8, imp);
    this.memory.write(address + 64n, 8, present);
    this.stubCount += 1;
    this.stubCursor += 64n;
    if (this.stubCursor > this.stubPage + BigInt(STUB_PAGE)) {
      throw new ObjcError("stub_limit", "the ObjC stub page overflowed");
    }
    return address;
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

function doubleBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}
