---
title: Limitations and gates
sidebar_position: 4
description: The honest boundary between the implemented substrate and a simulator, with kill criteria.
---

# Limitations and gates

The layers on this branch are real, but they are the **foundation**, not the building.
[From shim apps to unmodified .ipa](../plans/ipa-readiness.md) turns each gap into a measured
milestone; this page remains the per-area boundary. This page
exists so no reader can mistake the substrate for a working iOS Simulator.

## Status by area

| Area                | Required by the simulator                                         | This branch                                                                                                       | Gate to advance                                                                                  |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Kernel interface    | Mach ports/task ports, MIG, kqueue, Darwin VM semantics           | User-space port model and a syscall shim; no kernel                                                               | A real kernel boundary (microkernel host, or kernel module) with blocking threads and VM objects |
| IPC                 | XPC client/server, port rights in messages, launchd registration  | Semantic ports, rights, reply ports, bootstrap registry, MIG-lite                                                 | Port/memory descriptors, port sets, notifications, byte-compatible MIG/XPC                       |
| Process model       | `launchd_sim`, `posix_spawn` attributes, roles, jetsam            | Single-threaded jobs, bounded KeepAlive                                                                           | Threads, signals, process groups, memory pressure, spawn attributes                              |
| Loader              | `dyld_sim`, shared cache, chained fixups, code signing            | Thin/fat parse, user-space loading, chained + legacy fixups, export tries                                         | Shared-cache mapping, threaded binds, initializers, `dlopen`, signature validation               |
| Runtimes            | Objective-C runtime ABI, Swift runtime, Foundation/CoreFoundation | ObjC 2 metadata, `objc_msgSend`, categories, `+initialize`, ivar metadata; no Foundation, Swift, or ARC semantics | A libobjc2/Foundation-compatible substrate, then Swift metadata and Foundation conformance       |
| Graphics            | Metal, IOSurface, QuartzCore/CoreAnimation, display link, colour  | CPU RGBA framebuffer with deterministic PNG/PPM; solid rectangles only                                            | A Metal-on-Vulkan-class implementation with stable frames and IOSurface sharing                  |
| UI                  | AppKit host, UIKit simulator build, accessibility                 | Clean-room shim: `UIApplicationMain`, window, view, colour                                                        | Real UIKit build plus AppKit-replacement windowing/accessibility                                 |
| Input               | IOKit HID, Indigo/DTUHID, CGEvent                                 | None in this layer                                                                                                | HID transport and event translation compatible with SimulatorKit                                 |
| Security            | Codesign, entitlements, TCC, keychain, device identity            | None; signatures are parsed but not verified                                                                      | Trust model, entitlement evaluation, TCC database, keychain                                      |
| Storage             | APFS-compatible disk images, snapshots, `simdiskimaged`           | Jailed host files only                                                                                            | APFS image format and snapshot semantics                                                         |
| Real Apple software | CoreSimulator, simulator runtime, SpringBoard                     | Not loaded, not redistributed                                                                                     | A licence-compatible path and a maintained compatibility surface                                 |

## What the end-to-end tests actually prove

1. A generated arm64 Mach-O is parsed, mapped, linked, interpreted, and exits with the expected
   status and stdout.
2. A chained bind from the main image resolves to a symbol in a second image; calling through
   the relocated pointer prints `helper!` and returns.
3. Interpreted code creates a Mach reply port, sends a message to the bootstrap port, receives a
   host reply, validates the body, and exits 0.
4. A real `clang`-produced static Mach-O prints its message and exits 0 on macOS (the test skips
   elsewhere and prints why).
5. launchd-style plists register services, run RunAtLoad jobs, and retry failed KeepAlive jobs a
   bounded number of times.
6. The jail rejects `../` path traversal; the runtime rejects unmapped memory, unknown
   instructions, unsupported syscalls, oversized messages, and runaway instruction counts.
7. A generated ObjC image with a class list, a class/metaclass, and an absolute method list sends
   `objc_msgSend`, runs a guest IMP, calls the shim, and renders a deterministic frame.
8. On macOS, the same application compiled by Apple clang (relative method lists, ARC entry
   points, chained fixups) renders the **identical frame digest** as the generated fixture.

They do **not** prove that SpringBoard can boot, that Apple UIKit renders, that Metal exists, or
that an Apple runtime can execute. The UIKit used here is a shim whose methods are listed in the
[ABI page](./abi.md). Linux CI exercises relative method lists with a hand-built image; only the
macOS-gated test runs compiler output end to end.

## Known correctness limits

- **No threads or blocking.** A receive on an empty port returns a timeout even when the caller
  asked to wait forever. Servers are synchronous handlers.
- **No signals, `fork`, `exec`, `posix_spawn`, or `kqueue`.** These return `ENOSYS` in lenient
  mode and fail in strict mode.
- **No `fstat`.** Programs that need file metadata fail with `ENOSYS`.
- **One thread per task.** `thread_self_trap` returns the task port name.
- **PAC is decoded, not enforced.** arm64e authenticated pointers are treated as ordinary
  pointers after stripping the signature fields.
- **No shared cache.** Every image is loaded from its own file; system dylibs are not mapped.
- **No initializers.** `LC_ROUTINES`/mod-init sections are not executed.
- **`MAP_FIXED` trusts the hint.** The VM does not implement replacement semantics.
- **`dup` shares the descriptor entry.** Closing either descriptor closes the underlying host
  file; a real kernel would use reference counts.
- **XPC/MIG are not byte-compatible with Apple.** They are versioned research protocols.
- **launchd output paths and working directories are recorded, not applied.**
- **The run loop is scripted and headless.** `UIApplicationMain` runs the delegate callback, then
  a bounded loop over CLI-supplied taps, drags, and ticks, rendering after each callback. There is
  no real event source, display link, wall-clock timer, multitouch, gesture recognisers, or host
  window.
- **ARC is approximated, not implemented.** Retain/release update a refcount, autorelease pools
  drain on pop, weak slots are zeroed at zero count, and direct releases call a guest `-dealloc`
  override. Zero-count objects are not reclaimed, and bookkeeping releases skip `-dealloc`.
  Objects live until the process exits; the PoC is short-lived.
- **Selectors are C strings.** The shim follows the modern direct-selector convention; a selector
  registered as an opaque `objc_selector` struct is not supported.
- **Classes are realised eagerly.** `+load`, categories, `+initialize`, protocol conformance,
  associated objects, and zeroing weak references are implemented. Exceptions are not. A missing
  method fails with `unrecognized_selector`, not a message-send crash.
- **Ivar metadata is parsed, not synthesised.** Instances get an `isa` and the class's
  `instanceSize`; compiler-assigned ivar offsets work because the guest uses its own layout. The
  shim does not provide reflective ivar access, and its own ivars are fixed offsets.
- **The frame is headless.** It is written as PNG/PPM; there is no host window, colour management,
  text, fonts, paths, or CoreAnimation transactions. `CALayer` does not exist.
- **Performance is interpreter-grade.** There is no JIT; the goal is correctness and
  inspectability, not speed.

## Security posture

This is a research tool, not a sandbox for untrusted code.

- The file jail is path-based, not an OS sandbox. A host vulnerability or a future native helper
  could escape it. Do not run untrusted Mach-O files.
- Guest code cannot issue network syscalls because they are not implemented and strict mode is
  the default.
- The CLI does not spawn host processes and does not load Apple binaries.
- There is no code-signing check, so a loaded binary is trusted by construction.
- Execution budgets limit accidental loops, not adversarial resource exhaustion.

If this layer is ever exposed to untrusted input, it needs an OS-level sandbox (seatbelt,
containers, or a separate unprivileged UID), a real syscall allowlist, and fuzzing of every
parser. That work is not done here.

## Legal boundaries

- No Apple SDK, runtime, shared cache, firmware, `.app`, or device data is committed.
- The optional fixture is compiled from this repository's assembly on the developer's Mac.
- Using a real iOS runtime would require a licensed Mac and a legal review of the hosting model;
  this branch does not distribute or bypass any Apple licence.
- The native layer is original code under the repository's MIT licence.

## Kill criteria

The native research track stops if any of these becomes true:

1. No path to boot even a minimal UIKit app on this substrate after a bounded spike, once the
   missing kernel/loader/runtime layers are prototyped.
2. Metal/IOSurface turns out to be a hard blocker with no plausible open implementation at
   usable fidelity.
3. The work requires redistributing Apple binaries or reverse-engineered firmware.
4. Apple ships a supported Linux simulator or a documented remote-simulator API.
5. Maintenance cost per Xcode release exceeds the value of local execution for the target team.

The shipping alternative on `main` (remote Mac bridge) remains the answer while these gates are
open. The native track earns its place by passing gates, not by existing.

## What would change the verdict

- A maintained project boots a current iOS runtime on Linux with Metal-class rendering.
- A legal, supported macOS guest appears on non-Apple ARM64 hardware.
- Apple exposes CoreSimulator through a documented cross-platform API.
- The team's hard requirement becomes local execution with no Mac host, and the budget is
  explicitly multi-year.

See the [roadmap](./roadmap.md) for the next gates and estimates.
