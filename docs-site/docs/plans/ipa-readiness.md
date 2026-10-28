---
title: From shim apps to unmodified .ipa
sidebar_position: 4
description: The honest gap between this branch's shim-linked apps and running a stock .ipa, measured blocker by blocker.
---

# From shim apps to unmodified `.ipa`

This page is the bridge between the [UIKit proof of concept](../native/poc.md) and the repository's
original goal: **run an unmodified iOS app on a non-Apple host.** It states what is already true,
what is missing, which decisions gate the next phase, and what "done" would have to mean.

Read [limitations](../native/limitations.md) first. This page does not soften them.

:::tip Visual version
The [architecture dashboard](../native/dashboard.md) shows the same layer model with per-layer
progress, shipped/open work, milestones, and recent commits on one screen. Update
`scripts/architecture-progress.ts` when a milestone lands; `bun run architecture:build` (also part
of `docs:build`) regenerates the page.
:::

## Two goals, one branch

| Goal   | Statement                                                                                                      | Status                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **G1** | Run Objective-C apps **built against this repository's clean-room shim** and render their UI deterministically | Implemented and tested (146 tests, clang differential) |
| **G2** | Run an **unmodified `.ipa`** that links Apple's UIKit/Foundation                                               | Not started; blocked on binary compatibility           |

Nothing in G1 moves G2 forward by itself. The shim's classes have this repository's own ivar
offsets and sizes, its selectors are C strings, and its apps compile against `UIKitShim.h`. An
Apple-built binary expects Apple's layouts, Apple's runtime entry points, and Apple's frameworks.

## What blocks a stock `.ipa`, in dependency order

| #   | Blocker                     | Today                                                                            | Needed                                                                                                                                                                               |
| --- | --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Kernel/process substrate    | Single-threaded interpreter, scripted event loop, no blocking IPC                | Threads (`pthread`, Mach semaphores), real `mmap`/VM semantics, signals, `kqueue`, sockets, `posix_spawn`, `dlopen`                                                                  |
| 2   | Memory and ARC              | Refcounts only; objects are never reclaimed                                      | A real allocator; reclamation; exact ARC entry-point semantics (`objc_retainAutoreleasedReturnValue`, `objc_storeStrong`, autorelease return values)                                 |
| 3   | Exceptions                  | `__objc_personality_v0`/`_Unwind_Resume` are stubs; unwinding fails by name      | `objc_exception_throw`, `objc_begin_catch`/`objc_end_catch`, DWARF/compact unwinding, C++ interop                                                                                    |
| 4   | Runtime ABI                 | Host-side semantics for the subset we use                                        | Binary-compatible `libobjc`: isa layout, selector representation, blocks runtime, `NSInvocation`, KVO/`objc_setProperty`, swizzling, `objc_getClassList`, PAC/arm64e                 |
| 5   | Foundation + UIKit binaries | Clean-room source-compatible shim (~30 classes)                                  | Symbol- and layout-compatible implementations of every class an app links, including `NSObject`/`NSString` ABI, `NSBundle`, `NSFileManager`, `CALayer`                               |
| 6   | Loader                      | Thin/fat Mach-O, chained and legacy fixups, no cache                             | dyld shared cache mapping, threaded binds, auth chained fixups, weak/lazy binding, `dlopen`, signature validation or a documented bypass                                             |
| 7   | Graphics and input          | 375×667 RGBA buffer, rectangles, bitmap font, nearest-neighbour images, 8 frames | Layer tree (transforms, masks, corner radii), CoreAnimation/`CADisplayLink`, CoreText, Metal-on-something or a CPU fallback, HID-equivalent touch input, host window or frame stream |
| 8   | Packaging and security      | Nothing                                                                          | `.ipa`/`.app` extraction, `Info.plist`, app containers, `Assets.car`, entitlements/TCC/keychain, sandbox paths                                                                       |
| 9   | Swift/SwiftUI               | Nothing                                                                          | Swift runtime, metadata, SwiftUI — needed by most current apps                                                                                                                       |
| 10  | Legal path                  | No Apple runtime distributed or loaded                                           | A clean-room ABI-compatible rewrite, or a licensed runtime hosted on macOS (which contradicts the Linux goal)                                                                        |

Items 1–6 are the real gate. Item 9 is a second, larger project. Item 10 is a programme decision,
not an engineering task.

## What we measured

`scripts/spike-ios-symbols.ts` compiles [`fixtures/ios-app/main.m`](https://github.com/403access/ios-sim/blob/option-a-uikit-poc/fixtures/ios-app/main.m)
against the local iPhoneSimulator SDK and groups the binary's undefined symbols. It never commits
the binary, and it prints a skip reason without Xcode.

A deliberately boring app — window, view controller, label, button, `NSUserDefaults`, an array and
dictionary literal, one block animation, one `NSLog` — links against:

```text
sdk: iPhoneSimulator27.1.sdk
undefined symbols: 31
  Objective-C classes: 13
  protocols:            0
  objc runtime:         8
  blocks runtime:       1
  UIKit constants:      1
  other:                8
```

The 13 classes: `NSConstantArray`, `NSDictionary`, `NSNumber`, `NSString`, `NSUserDefaults`,
`UIButton`, `UIColor`, `UILabel`, `UIResponder`, `UIScreen`, `UIView`, `UIViewController`,
`UIWindow`.
The 8 runtime entry points: `objc_alloc`, `objc_alloc_init`, `objc_msgSend`, `objc_opt_class`,
`objc_release`, `objc_retain`, `objc_retainAutoreleasedReturnValue`, `objc_storeStrong`, plus the
blocks class `__NSConcreteStackBlock`.
The binary also loads UIKit, Foundation, libobjc, libSystem, and CoreFoundation. Its eight "other"
symbols are `NSLog`, `NSStringFromClass`, the `NSObject`/`UIResponder` metaclasses,
`___CFConstantStringClassReference`, `___stack_chk_fail`, `___stack_chk_guard`, and
`__objc_empty_cache`. The `@"..."` literals are the interesting one: the shim now exports
`___CFConstantStringClassReference` and reads the 32-byte literal layout, which the clang fixture
exercises (`[label setText:@"TAPPED"]`). Literal _collections_ (`@[]`, `@{}`) are still missing.

### Current coverage of that budget

Re-running the spike on 2026-10-28 and comparing each symbol with the runtime's exports gives
**31 of 31** symbols covered for the minimal app:

- 13 of 13 classes (`UIResponder` and `UIScreen` are now real shim classes);
- 8 of 8 Objective-C runtime entry points;
- the blocks class, `_UIApplicationMain`, `_NSLog`, `___CFConstantStringClassReference`,
  the `NSObject`/`UIResponder` metaclasses, `___stack_chk_fail`/`___stack_chk_guard`, and
  `__objc_empty_cache`.

The generated and clang fixtures assert the new services (`UIScreen` bounds/scale,
`NSStringFromClass`, the responder hierarchy) and still agree frame-for-frame.

Symbol presence is necessary, not sufficient: each class still needs Apple-compatible layout and
behaviour, and the app's five Apple dylib dependencies must be replaced. That replacement-image
work is the next M1 step; the symbol surface itself is closed.

**Reading the number honestly.** Thirty-one is the _link-time_ surface of that app, not the size of
the job. Each missing class must behave like Apple's at the ABI level, and the frameworks the app
loads must be replaced by something this runtime can map. The number is still useful: it is the
first concrete budget, and it shows that a symbol-level spike is small enough to attempt before
committing to a UIKit reimplementation.

## Open work in the shim track (G1)

These items have visible value even if G2 never lands:

**UIKit depth**

- Simultaneous recognition, gesture dependencies, and the view-controller responder step
  (superview forwarding, tap and pan recognisers are done).
- `UITabBarController`, a real table data source/delegate and cells, `UICollectionView`,
  `UIAlertController` (navigation and a host-managed table are in).
- Auto Layout/`NSLayoutConstraint`, `contentMode`, `transform`, `CALayer`,
  `bringSubviewToFront:`, multiple windows.
- Scroll physics and edge clamping; `CADisplayLink`.

**Foundation depth**

- `NSDate`, `NSURL`, `NSError`, `NSFileManager`, `NSJSONSerialization`,
  `NSKeyedArchiver`, `NSOperation`/GCD, `NSRunLoop`, `NSInvocation`, KVC/KVO.
- `NSString` beyond `UTF8String`/`length`/`isEqualToString:`/`integerValue`; `NSUserDefaults`
  beyond bool/int.

**Runtime**

- Exceptions, blocks beyond the current literal support (copies, global blocks, `__block`
  captures), property helpers, swizzling, `objc_getClassList`, per-thread pools, a real allocator
  with reclamation.

**Execution**

- Threads and dispatch, deadlines on a real clock, sockets/signals/`fstat`/spawn, `dlopen`, and a
  faster execution strategy than the interpreter.

**Renderer**

- Layer masks/compositing (corner radius and background transforms are in), richer text, JPEG/HEIC/`Assets.car`, gradients/masks/paths,
  colour management, more than eight frames, a host window or streaming surface.

## Decisions that must precede more G2 code

1. **Target declaration.** "Shim apps" versus "a named stock-SDK app". Recorded in
   [ADR 0008](../adr/ios-binary-compatibility.md).
2. **Runtime strategy.** Clean-room `libobjc`-compatible runtime versus `libobjc2` plus a
   compatibility layer; both need threads and exceptions first.
3. **Graphics strategy.** Deterministic CPU compositor with a layer API first, versus committing
   to Metal-on-Vulkan now. The layer API is required either way.
4. **Licensing path.** If the endpoint needs Apple binaries, the project is macOS-hosted and
   distribution-limited; the Linux claim must then be dropped explicitly.

## M1 charter

The concrete plan for the stock-binary gate — replacement images, the ABI table, the step
sequence, and the kill criteria — is in the [M1 charter](./m1-replacement-images.md). Step 1 is
done: the [measured ABI table](./m1-abi-table.md) records the emitted layouts **and** the
ivar-slot contract — the compiler emits placeholders and code loads offsets at runtime, so the
runtime must realize classes and patch the slots rather than reproduce Apple's absolute sizes.

## Milestones

**M1 — one stock-SDK app runs (the gate).**
The app in `fixtures/ios-app/main.m` executes through the loader with a clean-room,
ABI-compatible subset of the 13 classes and 8 runtime entry points it needs. Acceptance:

- the binary is loaded without Apple's dylibs (replacement images satisfy its five dependencies);
- `didFinishLaunchingWithOptions:` runs, the window appears, and the label/button render;
- a scripted tap updates the label through `NSUserDefaults`;
- a frame digest is recorded and the test is gated with its skip reason;
- the stubs and known deviations are listed in the docs, and the app is never committed.

If M1 cannot be reached in a bounded spike, the `.ipa` claim stays out of scope.

**M2 — a chosen app family runs.**
Pick two or three small real apps (one UIKit-only, one table-view-based). Extend Foundation,
UIKit, CoreAnimation, and the compositor until they run with a documented compatibility matrix.
No claim of "any app".

**M3 — platform breadth.**
Graphics acceleration (Metal translation or a documented software fallback), input, media,
networking, entitlements/keychain, and a host window or streaming surface. Swift/SwiftUI is a
separate decision after M2.

## Next steps (in order)

1. Land ADR 0008 and this page (done with this commit).
2. Keep the shim track moving: responder chain and gestures, `UINavigationController`/
   `UITableView`-lite, `NSBundle` plus app-directory loading, blocks, exceptions, then
   threads/dispatch.
3. Build the M1 replacement images: start with the 13 classes and 8 entry points above, then
   follow the next symbol report (the script re-runs in one command).
4. Add the compositor's layer properties and a frame surface, because every real app depends on
   them.

## Kill criteria

- M1's app cannot start after the loader, runtime, and framework replacements are prototyped and
  the remaining blocker is a closed Apple component (Metal, SpringBoard, CoreSimulator).
- A required Apple framework cannot be replaced without redistributing Apple code.
- The measured symbol budget grows faster than the implementation effort (report the counts and
  stop rather than implying progress).
