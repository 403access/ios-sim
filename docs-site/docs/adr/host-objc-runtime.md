---
title: "ADR 0007: Host-side Objective-C runtime and UIKit shim"
sidebar_position: 7
description: Why the proof of concept implements Apple's ObjC ABI semantics in TypeScript and ships a clean-room UIKit shim instead of running libobjc2.
---

# ADR 0007: Host-side Objective-C runtime and UIKit shim

- **Status:** Accepted on branch `option-a-uikit-poc`
- **Date:** 2026-10-26
- **Deciders:** Engineering
- **Depends on:** ADR 0006

## Context

ADR 0006 delivered a substrate that executes generated arm64 Mach-O programs. The next question
was whether an Objective-C application could link, send messages, read metadata, and produce a
visible result. Two implementations were possible:

1. **Run the real runtime.** Build `libobjc2` as a Mach-O dylib, map it, and execute its
   `objc_msgSend`, spinlocks, TLS, and initialisation code.
2. **Implement the ABI semantics on the host.** Parse Apple's metadata, implement selectors and
   classes in TypeScript, and keep the guest-facing boundary to a generated trampoline.

The substrate has no threads, no TLS, no atomics beyond a single-threaded approximation, and no
`dlopen`. `libobjc2` needs all four before the first message send. Option 1 would have made the
PoC a thread-and-loader project with the ABI still unproven.

## Decision

Implement the ABI **semantics** on the host and keep every boundary explicit:

- **Metadata is real.** The parser reads `__objc_classlist`, `class_t`, `class_ro_t`, absolute and
  relative method lists, and selector-reference slots exactly as clang emits them.
- **Dispatch is a trampoline.** `objc_msgSend` binds to `movz x16, #trap; svc; ret`. The trap
  resolves the selector. Host IMPs run in TypeScript; guest IMPs are entered by setting `pc`, so
  the call is a true tail call with argument registers and `LR` intact.
- **Framework classes are real objects.** `NSObject`, `UIView`, `UIWindow`, `UIViewController`,
  `UIColor`, and `UIApplication` are emitted as genuine class/metaclass/method-list structures in
  guest memory, with trampoline IMPs. `_OBJC_CLASS_$_UIView` is a class pointer, not a loader
  special case.
- **The framework is a shim.** It implements the methods listed in the ABI page, renders solid
  rectangles into an RGBA framebuffer, and encodes PNG/PPM. There is no Foundation, text,
  CoreAnimation, Metal, or run loop.
- **One-shot lifecycle.** `UIApplicationMain` runs a generated guest stub that calls
  `application:didFinishLaunchingWithOptions:`, then the presenter, then returns.

## Consequences

Positive:

- The ABI claim is testable on Linux with no Apple binaries and no threads.
- A real clang image (relative lists, ARC entry points, chained fixups) renders the identical
  digest as the generated image, so the metadata parser and dispatch are exercised by two
  independent producers.
- Every framework method is visible in one file (`objc/host.ts`) and in the ABI page.

Negative / accepted debt:

- Retain/release are no-ops; there is no ARC and no autorelease pool behaviour.
- `+initialize`, categories, protocols, weak references, and exceptions are absent.
- Application ivars are sized but not laid out; the shim's own ivars are fixed offsets.
- Selectors must be direct C strings; an opaque selector struct would need a registry.
- The shim is not UIKit: no layout engine, text, animation, input, or GPU path.
- The clang differential test is macOS-gated. Linux CI covers relative method lists with a
  hand-built image (`objc/abi.test.ts`), but it cannot reproduce compiler output end to end.

## Alternatives

- **Real `libobjc2`:** rejected for this gate; it requires threads, TLS, atomics, and a Mach-O
  runtime build before the first message send. It remains the A2 fidelity path.
- **Static stubs without metadata:** rejected because `inspect` and a future guest-side call would
  see fake classes, and the Apple ABI would not be exercised.
- **SDL/window first:** rejected; roadmap A4 says headless first, and a window adds a native
  dependency and a display-server assumption before the frame is proven.
