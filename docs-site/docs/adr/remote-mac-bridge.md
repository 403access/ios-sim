---
title: "ADR 0001: Remote Mac bridge over a native port"
sidebar_position: 1
description: Why the simulator stays on macOS and Linux clients use a bridge.
---

# ADR 0001: Remote Mac bridge over a native port

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Engineering, product
- **Related:** [Findings](../research/findings.md), [Options](../research/architecture-options.md), [Matrix](../research/feasibility-matrix.md)

## Context

The goal is to make an iOS Simulator workflow available to Linux developers. Research shows the
simulator is a set of arm64 Darwin user-space processes that depend on Mach/XPC, launchd,
`dyld_sim`, Metal, IOSurface, IOKit and private Apple frameworks. Linux has no compatible core,
and macOS cannot be run in a supported/licence-compatible way on non-Apple ARM64 hardware.

At the same time, a Linux developer does not need the simulator binary locally; they need to
boot devices, see the screen, interact, install apps, and read logs.

## Decision

Keep the simulator on macOS and build a remote bridge:

- A macOS host daemon (`apps/host`) wraps `simctl` and optional `idb`.
- A versioned HTTP/WebSocket protocol (`packages/protocol`) carries lifecycle, pixels, input,
  app uploads, and logs.
- A Linux-friendly CLI (`apps/cli`) and a browser viewer are the clients.
- The host is the only component with Apple dependencies.

## Consequences

### Positive

- Works with the real CoreSimulator and current iOS runtimes.
- The Linux client is small, testable, and free of Apple libraries.
- The same protocol works for macOS, Windows (browser), and CI.
- Apple-specific fragility is isolated in two adapters.
- No Apple runtime is redistributed.

### Negative

- Requires at least one Mac host.
- Network latency and bandwidth affect the experience.
- Input depends on `idb`, which uses private SPI.
- v0.1 video is 2 fps JPEG, not 60 fps.
- Hosting raises licence, isolation, and data-handling questions.

### Neutral

- The host is stateless apart from a token file; restarting does not reset simulators.
- The protocol is intentionally small and can add a video track later.

## Alternatives considered

| Alternative                       | Why rejected                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Native Darwin compatibility layer | Multi-year systems work; no current-runtime path                                     |
| macOS VM on ARM64 Linux           | QEMU `vmapple` requires Apple Silicon/macOS host and macOS 12 guest; licence blocked |
| Commercial device cloud           | Viable fallback, not a reference implementation; cost/control                        |
| Physical device farm              | Different fidelity; not a simulator                                                  |
| VNC to the Mac desktop            | Whole-desktop exposure, no API, poor isolation                                       |

## Follow-ups

- H.264/WebRTC evaluation (ADR when chosen).
- TLS and per-user tokens.
- Shared capture loop and rate limits.
- CI matrix and release automation.
