---

title: Overview
sidebar_position: 1
description: What this project is, what it proves, and how to read the documentation.
---

# iOS Simulator on Linux: what is actually possible

**Short answer:** Apple's iOS Simulator cannot run natively on Linux. It is not a CPU
emulator and it is not a standalone application. It is a set of arm64 Darwin processes —
`launchd_sim`, `SimulatorTrampoline`, SpringBoard, the app under test — running on the macOS
kernel and linking against private Apple frameworks such as CoreSimulator, SimulatorKit,
QuartzCore, Metal, IOSurface and IOKit. Moving it to Linux means reimplementing a large part of
Darwin, not porting a binary.

This repository does three things instead of pretending otherwise:

1. **Documents the research** that establishes the constraint, with evidence from the actual
   Xcode 27.1 / iOS 26.4 installation on the development Mac.
2. **Evaluates the real alternatives** — a native Darwin compatibility layer, a macOS VM on
   ARM64 Linux, commercial device farms, and a remote Mac bridge — and makes an explicit
   decision.
3. **Ships a working reference implementation of the recommended option**: a macOS host daemon
   that exposes `simctl` + `idb` over an authenticated HTTP/WebSocket API, a Linux-friendly CLI,
   and a browser viewer. The simulator still runs on a Mac; the Linux machine gets the pixels,
   input, apps, and logs.

:::tip The one-sentence architecture
Keep the iOS Simulator on macOS where Apple supports it; move the developer's _interaction_ to
Linux over a small, tested protocol.
:::

## Why not "just port it"?

| Requirement                                          | Where it comes from                                      | Linux status                                |
| ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Mach ports, task ports, bootstrap ports              | `launchd_sim` imports `mach_msg`, `mach_port_*`, `xpc_*` | Linux has no Mach IPC                       |
| XPC services and launchd jobs                        | CoreSimulator, `launchd_sim`, SpringBoard                | No compatible XPC/launchd                   |
| Apple `dyld` shared cache                            | runtime root ships `dyld_sim` and a shared cache         | Linux `ld.so` is unrelated                  |
| Metal + IOSurface + QuartzCore                       | SimulatorKit links all three                             | No Metal; IOSurface has no Linux equivalent |
| IOKit HID / CGEvent                                  | input injection                                          | Different input stack                       |
| Apple frameworks (AppKit, Foundation, Security, TCC) | simulator host and guest processes                       | Partial open-source substitutes only        |
| Code signing, entitlements, simulated keychain       | runtime and app launch                                   | No Apple trust stack                        |

The [findings](./research/findings.md) page walks through the evidence, including Mach-O
dependency and import data collected with [REA](https://github.com/morluto/rea).

## The options at a glance

| Option                               | What it really is                                                      | Verdict                                          |
| ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------ |
| A. Native Darwin compatibility layer | Reimplement Mach/XPC/launchd/Metal/frameworks on Linux (Darling-style) | Research project, not a product; years of work   |
| B. macOS VM on ARM64 Linux           | Boot macOS under QEMU/other hypervisor, run Xcode inside               | Blocked by hardware/guest support and licensing  |
| **C. Remote Mac bridge**             | macOS host runs the simulator; Linux streams and controls it           | **Recommended and implemented here**             |
| D. Commercial device cloud           | Corellium, BrowserStack, Sauce Labs, AWS, MacStadium                   | Buy instead of build; useful fallback            |
| E. Physical device farm              | Real iPhones over USB/network                                          | Best fidelity, worst ergonomics, not a simulator |

The full comparison, including cost and risk, is in
[Architecture options](./research/architecture-options.md) and the
[feasibility matrix](./research/feasibility-matrix.md).

## What ships in this repository

| Component         | Path                             | Purpose                                                               |
| ----------------- | -------------------------------- | --------------------------------------------------------------------- |
| Protocol + client | `packages/protocol`              | Typed HTTP/WebSocket contract, Zod validation, shared client          |
| macOS host        | `apps/host`                      | `simctl` lifecycle, screenshots, app upload, logs, input via `idb`    |
| Linux CLI         | `apps/cli`                       | `ios-sim devices`, `boot`, `install`, `tap`, `stream`, `open`, `logs` |
| Browser viewer    | `apps/host/src/web.ts`           | Stream + tap/swipe/type from any browser on Linux                     |
| Tests             | `apps/*/src/*.test.ts`, `tests/` | Unit, contract, macOS integration, Linux container E2E                |
| Docs              | `docs-site`                      | This Docusaurus site: research, plans, ADRs, guides                   |
| Infrastructure    | `infra/`, `scripts/`             | Linux Docker/OrbStack smoke test, fixture app, QEMU notes             |

## Status and scope

- **Phase 0 (research): complete.** Evidence and decision recorded.
- **Phase 1 (bridge MVP): implemented and tested** on macOS 27.0.1, Xcode 27.1, iOS 26.4, and
  in a Linux container through OrbStack.
- **Not implemented:** H.264/WebRTC video, multi-tenant isolation, native Linux simulator.
  These are deliberate roadmap items, not accidental omissions. See the
  [roadmap](./plans/roadmap.md).

## Who this is for

- Teams with Linux developer workstations and one or more Mac build hosts.
- CI systems that need a reproducible simulator without giving every job a Mac desktop.
- Researchers who want a documented starting point for a native Darwin port, with the hard
  problems named instead of hand-waved.

## Read next

1. [Analysis plan](./research/analysis-plan.md) — the questions and methods behind the research.
2. [Findings](./research/findings.md) — what the binaries and the running system actually show.
3. [Execution plan](./plans/execution-plan.md) — phases, acceptance criteria, and risks.
4. [Quickstart](./guides/quickstart.md) — run the bridge in about five minutes.
