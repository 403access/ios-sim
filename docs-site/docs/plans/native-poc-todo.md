---
title: Native PoC working checklist
sidebar_position: 3
description: Live checklist and decision log for the UIKit proof of concept. Update it with evidence, not optimism.
---

# Native PoC working checklist

Status legend: `[x]` implemented and tested, `[~]` implemented with a documented gap, `[ ]` not
started.

## P0 — execution fidelity

- [x] Vector register file (32 × 128-bit) and lane accessors
- [x] `fmov` register/immediate, `fadd`, `fsub`, `fmul`, `fdiv`, `fneg`, `fabs`, `fsqrt`
- [x] `fcmp` (register and zero), `fcsel`
- [x] `scvtf`, `ucvtf`, `fcvtzs`, `fcvtzu`, `fcvt`
- [x] Scalar FP loads/stores: unsigned, unscaled, pre/post, literal, pair (S/D/Q)
- [x] Exclusive load/store, LSE atomics (`ldadd`, `swp`, `cas`), `tpidr_el0`
- [~] FP register-offset addressing (not emitted by the fixtures; throws visibly)
- [ ] SIMD lane arithmetic beyond scalar (not needed for the PoC)

## Loader

- [x] `LC_DYLD_INFO` rebase, bind, weak-bind, and lazy-bind opcodes
- [x] Eager lazy resolution and `dyld_stub_binder` handling
- [ ] arm64 threaded binds (rejected by name)

## P1 — Objective-C ABI

- [x] Parse `__objc_classlist`, `class_t`, `class_ro_t`
- [x] Absolute and relative method lists
- [x] Selector resolution through `__objc_selrefs`
- [x] `objc_msgSend`, `objc_msgSendSuper2` (guest superclass, `objc_super` container semantics)
- [x] `performSelector:`, `performSelector:withObject:`, `...withObject:withObject:`
- [x] Superclass `+initialize` chain, root-first, in one resend stub
- [x] `+alloc`, `-init`, `-class`, `-isKindOfClass:`, `-respondsToSelector:`
- [x] `+initialize` once per class through a register-saving resend stub
- [x] `+load` before the entry point through a generated prologue
- [x] Categories (`__objc_catlist`) merged into classes
- [x] Absolute and relative ivar lists parsed and exposed
- [x] Protocol lists, inherited protocols, and `conformsToProtocol:`
- [x] Associated objects (`set`/`get`/`remove`, assign/retain policies)
- [x] Zeroing weak references (`storeWeak`/`loadWeakRetained`/`destroyWeak`)
- [x] Guest `-dealloc` stub on direct release to zero
- [x] `NSAutoreleasePool` (`+new`/`-drain`/`-release`)
- [x] `NSLog` to the process stderr sink
- [x] Runtime entry points: retain/release refcounts, autorelease pools, storeStrong, opt_self, sel_registerName
- [x] Guest IMP tail call preserves arguments and return address
- [~] Exceptions (personality stub; unwind fails by name)

## P2 — framework shim and frame

- [x] Host classes: `NSObject`, `UIView`, `UIWindow`, `UIViewController`, `UIColor`, `UIApplication`
- [x] `UIApplicationMain` → `application:didFinishLaunching:`
- [x] Solid-colour view tree → RGBA framebuffer
- [x] Deterministic PNG and PPM encoders
- [x] Bounded frame capture, de-duplicated
- [x] Hit-testing and touch delivery with one frame per callback
- [x] Taps and multi-sample drags (`touchesMoved:`)
- [x] Scripted ticks (`tick:` to the delegate) with an animated view
- [x] `UIButton` target/action dispatch on touch-up
- [x] Application lifecycle: didFinishLaunching, didBecomeActive, willTerminate
- [x] `UIView` alpha and parent-alpha compositing
- [x] Parent-relative frames with nested painting and hit-testing
- [x] `clipsToBounds` clipping for painting and hit-testing
- [x] `UIScrollView` content offset (painting and hit-testing)
- [x] `UILabel` with a 3×5 bitmap font (left/centre/right alignment)
- [~] Real event source, timers, display link, text, a live window
- [~] Run loop, input, text, CoreAnimation, a live host window (headless one-shot frame only)

## P3 — real compiler

- [x] Fixture headers and source that do not use the Apple SDK
- [x] Gated clang test with a printed skip reason
- [x] Script that builds the fixture into `fixtures/objc-window/build/`

## Evidence

- `bun apps/native/src/bin.ts uikit-demo --out frame.png` →
  `frame 375x667 sha256=<deterministic>` (asserted by tests, not pinned)
- `bunx vitest run tests/native/objc-clang.test.ts` → clang app digest equals the generated
  digest (macOS + Xcode only; prints its skip reason elsewhere).
- `bun apps/native/src/bin.ts run fixtures/objc-window/build/ObjcWindow --out clang.png` →
  same digest, exit 0.

## Tooling

- [x] `inspect --objc` reports classes, categories, protocols, ivars, fixup format
- [x] `objcStats` in the process result and CLI JSON (host/guest dispatch split)
- [x] `inspect` lists legacy `LC_DYLD_INFO` imports as well as chained imports

## Documentation

- [x] `native/poc.md` plan and gates
- [x] ADR 0007
- [x] Update `native/overview.md`, `limitations.md`, `roadmap.md`, `abi.md`
- [x] Update `doctor` and README
- [x] Update the test strategy page

## Decision log

| Date       | Decision                                                                | Why                                                                                                 |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-10-26 | Host-side ObjC semantics, not real `libobjc2`                           | libobjc2 needs threads/TLS/atomics before the first message send; the ABI is the thing being proved |
| 2026-10-26 | Host shim classes are real metadata with trampoline IMPs                | Keeps `_OBJC_CLASS_$_UIView` a genuine class object and lets `inspect` see it                       |
| 2026-10-26 | Absolute method lists in generated fixtures, relative in clang fixtures | Both are Apple ABI; the pair exercises both parsers                                                 |
| 2026-10-26 | Headless PNG before a window                                            | Roadmap A4 says headless first; avoids a native SDL dependency and its ADR                          |
| 2026-10-26 | One-shot `UIApplicationMain`                                            | No run loop yet; returning after one frame keeps the gate honest and testable                       |
