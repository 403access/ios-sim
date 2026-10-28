---
title: M1 replacement images — charter
sidebar_position: 5
description: The concrete plan for running the minimal stock-SDK app without Apple dylibs, including the ABI risks and acceptance tests.
---

# M1 replacement images — charter

This page is the working charter for **M1** in the
[readiness plan](./ipa-readiness.md): make `fixtures/ios-app/main.m` — a normal app compiled
against the real iOS Simulator SDK — run through this loader without loading an Apple binary.

The symbol surface is already closed: 31 of 31 undefined symbols for that app are provided or
understood. What remains is the part the symbol count hides: matching the **layouts and
behaviour** the compiler baked into the app, and satisfying its five library dependencies with
images we build ourselves.

## Why this is the hard step

A stock binary assumes:

1. its superclasses have specific **instance sizes** (its own ivar offsets are computed from them);
2. `NSString`, `NSDictionary`, `NSNumber` and friends are **CF-backed** with Apple's layouts;
3. `+[NSObject alloc]` returns memory it can message, retain, release, and store weakly;
4. `UIApplicationMain` runs a real event loop that its delegate expects to return into;
5. every framework symbol it binds lives in a dylib with the expected install name.

The shim satisfies none of 1–3 by construction: it uses this repository's layouts so it can stay
small. M1 must therefore introduce a **second, ABI-shaped layer** — not extend the shim's classes in
place, and not pretend the shim is already compatible.

## Deliverables

| #   | Artifact                            | Purpose                                                                                                                                                                                                         |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `scripts/build-ios-app-images.ts`   | Build replacement dylibs with the five install names (`UIKit`, `Foundation`, `libobjc`, `libSystem`, `CoreFoundation`) whose exports satisfy the app's two-level binds, implemented as thunks into host symbols |
| 2   | `packages/darwin-compat/src/abi/**` | An "Apple layout" class table for the 13 classes: instance size, ivar offsets used by the app, method surface, and documented provenance for every number                                                       |
| 3   | Loader support                      | Map the replacement images from a bundle-relative directory and resolve their exports before falling back to host symbols; a strict mode that reports every unresolved/incorrect bind                           |
| 4   | `tests/native/ios-app.test.ts`      | macOS-gated E2E: build the app, load it, run it, assert exit 0, a frame digest, the label text after a tap, and the symbol report; prints its skip reason elsewhere                                             |
| 5   | Evidence                            | `docs` page section with the measured frame, the symbol report, and the list of temporary stubs                                                                                                                 |

## Step plan

**M1.1 — link and load.** Replacement images exist, the loader maps them, and the app reaches
`main` with every bind resolved. Exit criterion: `inspect` shows all five images and zero unresolved
symbols; running stops at the first missing runtime call, reported by name.

**M1.2 — allocation and class layouts.** `+alloc`/`-init` return ABI-sized objects; the app's
`AppDelegate`, `UIWindow`, `UIView`, `UILabel`, `UIButton` instances have the sizes and offsets the
compiler assumed. Exit criterion: the app builds its view tree, and a marker proves the delegate
callback ran.

**M1.3 — render and input.** The window and subviews paint through the existing framebuffer (not
UIKit's render server), a scripted tap triggers the button target/action, and `NSUserDefaults`
persists the tap count. Exit criterion: the label changes from “Hello from UIKit” to “Taps: 1”.

**M1.4 — gate.** A hermetic where possible, macOS-gated where necessary test with a recorded
digest, plus a “missing behaviour” report. Exit criterion: the test runs in CI on macOS and skips
with a printed reason elsewhere.

## The ABI table is the crux

Every layout number must have provenance. Three acceptable sources:

1. **The app's own metadata** — `class_ro_t.instanceSize` for its classes, and the offsets its code
   actually touches (disassembly).
2. **A licensed reference run** — compare `class_getInstanceSize` on a Mac simulator for the SDK
   version the app was built against; record only numbers and method names, never binaries.
3. **Public documentation** — for documented ivars only.

If a number has no source, it is marked `unverified` and the test reports it. No guessing.

## Risks and unknowns

| Risk                             | Why it matters                                                       | Mitigation                                                                                      |
| -------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Superclass instance sizes        | A wrong size shifts every subclass ivar                              | Measure per SDK version; pin the fixture to one Xcode version                                   |
| CF-backed `NSString`/collections | Literals and toll-free bridging assume CF layouts                    | Teach the ABI layer the literal layouts already measured, and add CF-style structs where needed |
| Exceptions                       | UIKit/Foundation throw on misuse; the app does not                   | No exceptions required for this app; a thrown exception is a documented failure                 |
| Blocks copies                    | `animateWithDuration:animations:` may copy a stack block             | Implement `_Block_copy` for stack blocks if the app's block escapes                             |
| Run loop and timers              | `UIApplicationMain` may expect a run loop that outlives the delegate | Use the existing scripted loop; document the difference                                         |
| UIKit draw path                  | Real UIKit draws through layers/Metal                                | Draw the same geometry through the shim's framebuffer; do **not** claim UIKit fidelity          |
| SDK churn                        | Layouts and symbols change between Xcode releases                    | Pin the fixture to the installed Xcode and record the version                                   |

## Acceptance and evidence

- `bun apps/native/src/bin.ts run fixtures/ios-app/build/SpikeApp.app --json` exits 0 with a frame.
- The test asserts: the five replacement images are mapped, zero unresolved binds, the delegate ran,
  a tap updates the label, and the frame digest is recorded.
- `inspect --objc` lists the app's classes and the ABI table marks each layout as measured.
- The docs page records the Xcode version, the measured numbers, and every temporary stub.

## Time box and kill criteria

Time box: **one focused block per step**, each ending in a written report. Stop if:

1. a required Apple layout cannot be measured or inferred without private headers or Apple
   binaries; or
2. the app cannot reach `main` with all five replacement images because the loader needs
   shared-cache semantics; or
3. the remaining blocker is a closed component (Metal, SpringBoard, CoreSimulator).

In any of those cases M1 is declared blocked, the report is published, and the shim track remains
the shipped artifact.

## Out of scope for M1

Swift/SwiftUI, Metal, real UIKit internals, Core Animation, networking, entitlements, code signing,
and any app other than `fixtures/ios-app/main.m`. M2 starts with a second app only after M1 passes.

## Next actions

1. Land the ABI table skeleton with the app's own measured sizes (no guesses).
2. Generate the five replacement images and get the loader to `main`.
3. Fill the runtime calls the app reaches, one reported symbol at a time.
4. Write the gated E2E and publish the first stock-app frame.
