---
title: Native track roadmap
sidebar_position: 5
description: A phased path from the implemented substrate to a real local simulator, with gates and kill criteria.
---

# Native track roadmap

The current branch covers **Phase A0/A1** of the native track: a working user-space substrate for
self-contained arm64 Mach-O programs. Reaching a current iOS Simulator remains a multi-year
platform effort. The phases below are ordered so each one is independently testable and can be
stopped without leaving a half-integrated mess.

Estimates are engineer-months for one experienced systems engineer, with low confidence. They
are planning aids, not commitments.

:::info Where we are (2026-10-28)
A0 and A0.5 are complete: a user-space substrate plus a clean-room shim with **45 host classes**,
**164 hermetic tests**, and **13 clang differential scenarios**. The M1 symbol surface is closed
(**31 of 31**), and the ivar-slot ABI contract is measured and implemented: guest classes are
realized and their `_OBJC_IVAR_$` slots patched. The [architecture dashboard](./dashboard.md) is
the single-screen status; [limitations](./limitations.md) is the per-area boundary.
:::

## A0 — Substrate (implemented on this branch)

**Deliverables**

- Mach-O parser, chained fixups, export tries, fixture writer.
- Sparse 64-bit VM, user-space dyld, slides, binds/rebases.
- AArch64 integer interpreter with budgets.
- Mach ports/rights/replies, bootstrap services, MIG-lite.
- XPC-style codec and request/reply.
- Darwin syscall subset with a jailed file layer.
- launchd-style plist jobs and bounded supervision.
- CLI, inspect report, generated end-to-end fixtures, real-clang smoke test.
- ADR, ABI, limitations, tests.

**Acceptance**

- Generated and real clang Mach-O programs run end-to-end.
- Cross-image bind, Mach bootstrap round-trip, jail escape rejection, and budget failures are
  covered by tests.
- Linux tests pass without Apple binaries.

**Status:** complete on this branch.

## A0.5 — UIKit proof of concept (implemented on this branch)

**Deliverables**

- Apple-ABI ObjC 2 metadata parser (absolute and relative method lists).
- `objc_msgSend`/`objc_msgSendSuper2` with guest-IMP tail calls and host-IMP traps.
- Instance allocation, `+alloc`, `-init`, `respondsToSelector:`, `isKindOfClass:`.
- Clean-room shim classes: 45 host classes, including `NSObject`, `NSString`/`NSNumber`/collections
  (and literal strings/arrays/dictionaries), `NSData`, `NSJSONSerialization`, `NSBundle`,
  `NSUserDefaults`, notifications, timers, images, and `UIApplicationMain`.
- UIKit shim: window/view tree, labels (bitmap text, wrapping), button/switch/slider/segmented
  control/progress view, scroll view with drag, tap/pan gestures, navigation controller, row-based
  table, `CALayer` corner radius, affine transforms, and legacy + block animations on a virtual
  clock.
- Deterministic RGBA/PNG/PPM frame capture from the view tree, with per-frame digests.
- A generated ObjC app and a gated real-clang app that render the same digest across 13 scenarios.

**Acceptance**

- `bun apps/native/src/bin.ts uikit-demo --out frame.png` renders the documented frame.
- The clang fixture links with chained fixups and relative method lists, runs through the same
  runtime, and produces the same digest (macOS-gated).

**Status:** complete on this branch. It is a proof of the ABI and the pipeline, with a deliberately
small but broad shim — not a claim of UIKit fidelity. Class layouts and selector semantics remain
this repository's own, so none of it is binary-compatible with Apple's frameworks.

## A0.6 — Stock-app ABI and replacement images (in progress)

**Deliverables**

- A measured ABI table for the minimal SDK app (instance sizes, ivar offsets, provenance).
- Five replacement dylibs with Apple install names, implemented as host-backed thunks.
- A gated end-to-end test that runs the stock app and records a frame.

**Progress**

- 31/31 undefined symbols covered (classes, runtime, blocks, literals, stack guard).
- `bun run abi:measure` reports the app's emitted layouts and proved the **ivar-slot contract**:
  code loads offsets from `_OBJC_IVAR_$` slots, so the runtime must realize classes and patch
  them; Apple's absolute sizes are not baked in ([table](../plans/m1-abi-table.md)).
- Fixed `ivar_t.offset` parsing (a pointer to an int32 slot, not the value) — required for any real
  binary.
- **Realize-and-patch**: guest classes are realized superclass-first and their `_OBJC_IVAR_$` slots
  are patched with our offsets; the clang fixture proves `_pressed` moves 8 → 64 and still renders.
- Not started: the five replacement images and the E2E gate.

**Next:** implement realize-then-patch for guest classes (using the five `Sample*` subclasses as
the corpus), then generate the five replacement images and start the E2E. The full charter is
[plans/m1-replacement-images.md](../plans/m1-replacement-images.md).

## A1 — Kernel boundary and threads (2–4 months)

**Why:** every interesting simulator process is multi-threaded and blocks in Mach calls.

- Move Mach ports, tasks, and memory objects behind a native boundary (a small C/Rust
  microkernel host, or a kernel module on Linux).
- Implement blocks, blocking receive/send, timeouts, port sets, notifications.
- Add threads, thread ports, thread groups, and a scheduler fair enough for tests.
- Add signals, `kqueue`, `fork`/`exec`, `posix_spawn` attributes, process groups.
- Keep the current TypeScript layer as the semantic model and test oracle.

**Acceptance:** a multi-threaded test harness blocks on receive, wakes on send, observes timeout
and interruption, and survives scheduling stress. No user-space busy-wait fakes.

**Kill:** the boundary cannot preserve Mach semantics without an impractical amount of native
code, or performance is worse than a VM alternative.

## A2 — Loader and runtime services (3–6 months)

- Real `dyld` semantics: lazy stubs, initializers/terminators, `dlopen`, weak coalescing,
  two-level namespaces. (Classic rebase/bind/weak/lazy opcodes are already implemented.)
- Shared-cache reader and mapping, including split caches and chained fixups in the cache.
- Code-signature parsing and an ad-hoc validation policy; entitlement evaluation hooks.
- A minimal Objective-C runtime compatible with Apple's ABI (classes, selectors, message send,
  associated objects, exceptions), then Foundation/CoreFoundation replacements with a conformance
  suite. **Partially delivered in A0.5/A0.6:** metadata, message send, categories, `+load`,
  `+initialize`, protocol conformance, and ivar metadata exist; ARC, exceptions, and Foundation do
  not.
- Swift runtime linkage and metadata discovery.

**Acceptance:** a nontrivial Objective-C and Swift CLI program (no UI) runs with a documented
subset of Foundation; symbol resolution matches a reference list; initializers run exactly once.

**Kill:** the Apple ABI surface proves impossible to track without private headers or
redistributed binaries.

## A3 — CoreSimulator boundary (2–4 months)

- Map the CoreSimulator XPC services and the minimum `launchd_sim` job graph.
- Implement service registration, peer authentication placeholders, and environment contracts.
- Build a diagnostic mode that reports every missing MIG routine and framework symbol instead of
  crashing.
- Decide whether to reimplement services or drive a remote CoreSimulator under a licence.

**Acceptance:** `launchd_sim` reaches a stable bootstrap point far enough to report its version
and enumerate a device, with a complete missing-symbol report.

**Kill:** the service graph requires AppKit/ServiceManagement semantics with no substitute.

## A4 — Graphics and display (6–12 months)

- Metal API over Vulkan (or another GPU backend) for the subset UIKit uses.
- IOSurface sharing, texture formats, synchronization, and colour management.
- QuartzCore/CoreAnimation transaction and display-link model.
- A headless framebuffer target first, then a window.
- Deterministic frame-capture tests; a golden-image corpus.

**Acceptance:** a trivial UIKit app renders a stable frame offscreen for 10,000 frames, with
correct colour and no leaks. Then a window shows it at interactive latency.

**Progress in A0.5:** deterministic frames with rectangles, alpha, clipping, rounded corners,
images, bitmap text, and affine transforms are captured from the view tree. There is no
CoreAnimation layer tree, no Metal/IOSurface, no display link, and no 10,000-frame soak; the GPU
path, the window, and the frame loop remain open.

**Kill:** no stable frame after the bounded spike, or GPU fidelity is too low for UIKit.

## A5 — UIKit and host UI (6–12 months)

- Build or obtain a UIKit-compatible layer for the simulator runtime. **A0.5 delivered a
  clean-room shim (45 classes: views, controls, text, images, navigation, tables)** — not a UIKit
  implementation, and not binary-compatible with Apple's.
- AppKit replacement for host windows, menus, and pasteboard.
- Accessibility translation and a test harness.
- Text, fonts, locale, and input-method plumbing.

**Acceptance:** a fixture UIKit app boots, renders, accepts taps/text, and exposes an
accessibility tree. This is the first "minimal UIKit app" gate.

**Kill:** UIKit/private-SPI dependency cannot be satisfied without Apple binaries.

## A6 — Input, security, storage (4–8 months)

- IOKit HID/Indigo-compatible input path; CGEvent translation.
- TCC database, keychain, device identity, entitlement enforcement.
- APFS-compatible images, snapshots, and `simdiskimaged` semantics.
- Per-app data containers and privacy boundaries.

**Acceptance:** the fixture app can use the keychain, request a permission, persist data across
reboots of the simulated device, and receive touches through the same path as the real
simulator.

## A7 — SpringBoard and a real runtime (6–18 months)

- Boot SpringBoard, install a `.app`, launch it, rotate, background/foreground, and read logs.
- Handle runtime updates and Xcode release churn with a compatibility matrix.
- Establish a maintenance model and a conformance suite against a licensed Mac.

**Acceptance:** a current iOS runtime boots on Linux and runs a signed fixture app with the same
observable behaviour as the Mac simulator for the covered scenarios.

**Kill:** any step requires redistributing Apple binaries, bypassing signing, or violating the
macOS/iOS licence.

## Cross-cutting work

| Track         | Work                                                                 |
| ------------- | -------------------------------------------------------------------- |
| Testing       | Fuzzing for every parser; differential tests against a Mac simulator |
| Performance   | JIT or native execution for hot code; GPU command submission         |
| Observability | Structured traces, missing-symbol reports, syscall/Mach statistics   |
| Security      | OS sandbox, syscall allowlist, capability model, secret handling     |
| Legal         | Licence review for each runtime artefact and hosting model           |
| Maintenance   | CI matrix per Xcode release; pinned compatibility fixtures           |

## Decision points

1. **After A1:** is the thread/kernel boundary viable, or does it collapse into a VM?
2. **After A3:** can CoreSimulator be satisfied, or is a licensed remote runtime the only path?
3. **After A4:** is Metal fidelity sufficient for UIKit, or is the graphics gate fatal?
4. **After A5:** does a minimal UIKit app boot? If not, invoke the kill criteria.

Each decision gets a written go/no-go with evidence, not a vibe. The default answer remains
"no" until a gate is demonstrated.

## What this branch does not promise

It does not promise that the remaining phases will succeed. It promises that the implemented
layers are real, tested, documented, and a useful base for anyone continuing the work—or for
anyone who needs to prove to themselves why the remote bridge is the practical choice.
