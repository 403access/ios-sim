---
title: Native platform roadmap (high level)
sidebar_position: 5
description: The phase-level path from the implemented substrate to a real local simulator, with gates, dependencies, and kill criteria.
---

# Native platform roadmap (high level)

This is the **L1 native platform roadmap**. It defines phases, gates, and the critical path. It
does not define individual tasks: those live in the
[native technical roadmap](../roadmaps/native/technical.md) and the
[native backlog](../roadmaps/native/backlog.md). Quality is owned by the
[engineering quality roadmap](../roadmaps/engineering-quality.md); permissions and evidence are
owned by the [research and legal roadmap](../roadmaps/research-legal.md).

Branch `option-a-native-darwin` implements **Phase A0** (the substrate), not A1. A0 executes
self-contained arm64 Mach-O programs and a real clang-built fixture, but it is not a simulator.
Reaching a current iOS Simulator remains a multi-year platform effort. The phases below are
ordered so each one is independently testable and can be stopped without leaving a
half-integrated mess.

Estimates are engineer-months for one experienced systems engineer, with low confidence. They
are planning aids, not commitments.

## Phase map

| Phase | Theme                       | Effort      | Depends on             | Gate                   | Detail                                                                             |
| ----- | --------------------------- | ----------- | ---------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| A0    | Substrate                   | done        | —                      | A0 evidence            | [Technical §2](../roadmaps/native/technical.md#2-baseline-what-a0-actually-proves) |
| A1    | Kernel boundary and threads | 2–4 months  | A0                     | KRN-G1, THR-G1         | `KRN-*`, `THR-*`                                                                   |
| A2    | Loader and runtime          | 3–6 months  | A0, A1 for threads     | LDR-G1, RT-G1          | `LDR-*`, `RT-*`                                                                    |
| A3    | CoreSimulator boundary      | 2–4 months  | KRN-008, LDR-G1, RT-G1 | CS-G1                  | `CS-*`                                                                             |
| A4    | Graphics                    | 6–12 months | A1, A2 research        | GFX-G1                 | `GFX-*`                                                                            |
| A5    | UI                          | 6–12 months | RT-G1, GFX-G1          | UI-G1                  | `UI-*`                                                                             |
| A6    | Input, security, storage    | 4–8 months  | A1, A2                 | INP-G1, SEC-G1, STO-G1 | `INP-*`, `SEC-*`, `STO-*`                                                          |
| A7    | SpringBoard/runtime         | 6–18 months | A5, A6, A3             | SB-G1                  | `SB-*`                                                                             |

**Critical path:** `KRN-001 → KRN-002/3/4/5 → THR-001/2 → LDR-003 → CS-001/4 → GFX-002/5 →
UI-002/3 → SB-002/3 → SB-007`.

**Parallel lanes:** kernel (critical), loader/runtime, graphics inventory, CoreSimulator
inventory, quality, and research/legal. The [technical roadmap](../roadmaps/native/technical.md#parallel-lanes)
defines what can run beside what.

## A0 evidence

- Generated arm64 Mach-O execution: `bun apps/native/src/bin.ts demo`.
- Real clang arm64 Mach-O execution: `./scripts/build-native-fixtures.sh`.
- Cross-image chained bind and Mach bootstrap round-trip: native integration tests.
- Parser robustness, jail escape, budget failures, docs build: `bun run verify`.
- A0 task list and evidence: [backlog](../roadmaps/native/backlog.md#3-scheduled-tasks).

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
- Native tests are platform-neutral; the macOS run passes, and the Linux container path is scripted (tracked by `REL-001`/`QA-008`).

**Status:** complete on this branch.

## A1 — Kernel boundary and threads (2–4 months)

**Gate:** KRN-G1 and THR-G1. **Tasks:** `KRN-001..012`, `THR-001..012`.

**Status:** KRN-001..005 and THR-001 are implemented in `packages/darwin-host`: C11
tasks/ports/rights, bounded queues, blocking receive, timeouts, interruption, bootstrap services,
and thread lifecycle objects with thread ports, loaded through Bun FFI. THR-002 adds a
cooperative guest CPU scheduler, and THR-003 adds a blocking Mach bridge with park/wake/timeout/
interrupt tests in `packages/darwin-compat`. THR-003a (runtime wiring), KRN-006..012, and later
THR tasks remain. See the [host ABI](./host-abi.md) and
[ADR 0007](../adr/native-kernel-boundary.md).

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

**Gate:** LDR-G1 and RT-G1. **Tasks:** `LDR-001..014`, `RT-001..012`.

- Real `dyld` semantics: lazy-stub trampolines, weak coalescing, `dlopen`,
  weak coalescing, two-level namespaces.
- Shared-cache reader and mapping, including split caches and chained fixups in the cache.
- Code-signature parsing and an ad-hoc validation policy; entitlement evaluation hooks.
- A minimal Objective-C runtime compatible with Apple's ABI (classes, selectors, message send,
  associated objects, exceptions), then Foundation/CoreFoundation replacements with a conformance
  suite.
- Swift runtime linkage and metadata discovery.

**Acceptance:** a nontrivial Objective-C and Swift CLI program (no UI) runs with a documented
subset of Foundation; symbol resolution matches a reference list; initializers run exactly once.

**Kill:** the Apple ABI surface proves impossible to track without private headers or
redistributed binaries.

## A3 — CoreSimulator boundary (2–4 months)

**Gate:** CS-G1. **Tasks:** `CS-001..010`.

- Map the CoreSimulator XPC services and the minimum `launchd_sim` job graph.
- Implement service registration, peer authentication placeholders, and environment contracts.
- Build a diagnostic mode that reports every missing MIG routine and framework symbol instead of
  crashing.
- Decide whether to reimplement services or drive a remote CoreSimulator under a licence.

**Acceptance:** `launchd_sim` reaches a stable bootstrap point far enough to report its version
and enumerate a device, with a complete missing-symbol report.

**Kill:** the service graph requires AppKit/ServiceManagement semantics with no substitute.

## A4 — Graphics and display (6–12 months)

**Gate:** GFX-G1. **Tasks:** `GFX-001..012`.

- Metal API over Vulkan (or another GPU backend) for the subset UIKit uses.
- IOSurface sharing, texture formats, synchronization, and colour management.
- QuartzCore/CoreAnimation transaction and display-link model.
- A headless framebuffer target first, then a window.
- Deterministic frame-capture tests; a golden-image corpus.

**Acceptance:** a trivial UIKit app renders a stable frame offscreen for 10,000 frames, with
correct colour and no leaks. Then a window shows it at interactive latency.

**Kill:** no stable frame after the bounded spike, or GPU fidelity is too low for UIKit.

## A5 — UIKit and host UI (6–12 months)

**Gate:** UI-G1. **Tasks:** `UI-001..009`.

**Spike delivered:** `UI-000` implements a clean-room UIKit-compatible blank window in a native
X11 window (software renderer, no web view). It does not satisfy UI-G1; it de-risks the host
window/renderer boundary. See the [spike page](./uikit-window.md).

- Build or obtain a UIKit-compatible layer for the simulator runtime.
- AppKit replacement for host windows, menus, and pasteboard.
- Accessibility translation and a test harness.
- Text, fonts, locale, and input-method plumbing.

**Acceptance:** a fixture UIKit app boots, renders, accepts taps/text, and exposes an
accessibility tree. This is the first "minimal UIKit app" gate.

**Kill:** UIKit/private-SPI dependency cannot be satisfied without Apple binaries.

## A6 — Input, security, storage (4–8 months)

**Gates:** INP-G1, SEC-G1, STO-G1. **Tasks:** `INP-*`, `SEC-*`, `STO-*`.

- IOKit HID/Indigo-compatible input path; CGEvent translation.
- TCC database, keychain, device identity, entitlement enforcement.
- APFS-compatible images, snapshots, and `simdiskimaged` semantics.
- Per-app data containers and privacy boundaries.

**Acceptance:** the fixture app can use the keychain, request a permission, persist data across
reboots of the simulated device, and receive touches through the same path as the real
simulator.

## A7 — SpringBoard and a real runtime (6–18 months)

**Gate:** SB-G1. **Tasks:** `SB-001..008`.

- Boot SpringBoard, install a `.app`, launch it, rotate, background/foreground, and read logs.
- Handle runtime updates and Xcode release churn with a compatibility matrix.
- Establish a maintenance model and a conformance suite against a licensed Mac.

**Acceptance:** a current iOS runtime boots on Linux and runs a signed fixture app with the same
observable behaviour as the Mac simulator for the covered scenarios.

**Kill:** any step requires redistributing Apple binaries, bypassing signing, or violating the
macOS/iOS licence.

## Cross-cutting work

| Track         | Work                                                      | Owner roadmap                                   |
| ------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Testing       | Fuzzing, differential, stress/soak, performance budgets   | [Quality](../roadmaps/engineering-quality.md)   |
| Observability | Structured events, traces, missing-surface reports        | [Quality](../roadmaps/engineering-quality.md)   |
| Security      | Sandbox, syscall allowlist, signing/TCC/keychain, review  | [Quality](../roadmaps/engineering-quality.md)   |
| Legal         | Runtime provenance, licensing, hosting model, claim audit | [Research/legal](../roadmaps/research-legal.md) |
| Maintenance   | Xcode/runtime compatibility matrix and update runbook     | [Quality](../roadmaps/engineering-quality.md)   |
| Roadmap       | Task status, gate evidence, next queue                    | [Backlog](../roadmaps/native/backlog.md)        |

## Decision points

1. **After A1:** is the thread/kernel boundary viable, or does it collapse into a VM?
2. **After A3:** can CoreSimulator be satisfied, or is a licensed remote runtime the only path?
3. **After A4:** is Metal fidelity sufficient for UIKit, or is the graphics gate fatal?
4. **After A5:** does a minimal UIKit app boot? If not, invoke the kill criteria.

Each decision gets a written go/no-go with evidence, not a vibe. The default answer remains
"no" until a gate is demonstrated. The decision gates and risk register are in the
[technical roadmap](../roadmaps/native/technical.md#10-risks-and-decision-gates); the legal
gates are in the [research/legal roadmap](../roadmaps/research-legal.md#5-gate-table).

## What this branch does not promise

It does not promise that the remaining phases will succeed. It promises that the implemented
layers are real, tested, documented, and a useful base for anyone continuing the work—or for
anyone who needs to prove to themselves why the remote bridge is the practical choice.
