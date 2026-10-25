---
title: Roadmap
sidebar_position: 3
description: Now, next, later — with explicit non-goals and revisit triggers.
---

# Roadmap

The roadmap is intentionally short. The goal is a dependable Linux workflow, not a simulator
platform.

## Now — v0.1 (delivered)

- macOS host over `simctl` + optional `idb`.
- HTTP/WebSocket protocol with Zod schemas and a typed client.
- Linux CLI: devices, lifecycle, apps, screenshots, input, streaming, logs, `open`.
- Browser viewer: stream, tap/swipe, text, buttons, logs.
- Tests: unit, contract, Linux container E2E, gated macOS integration.
- Documentation: research, options, matrix, legal, execution, testing, API, security, ADRs.

**Known limits:** 2 fps JPEG polling; no TLS in-process; single host; token auth only; input
requires `idb`; no session isolation.

## Next — v0.2 (hardening)

| Item                                            | Why                                  | Exit criteria                                      |
| ----------------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| TLS termination guide + optional in-process TLS | Safe access beyond loopback          | HTTPS/WSS works; tests                             |
| SSH tunnel and launchd/systemd units            | Zero-exposure deployment             | A new user can follow the guide unaided            |
| Shared capture loop per device                  | Avoid N processes for N viewers      | Two viewers, one capture loop, stable CPU          |
| Upload hardening                                | Treat app bundles as untrusted input | Size/entry/path/symlink tests pass                 |
| Rate limits and quotas                          | Protect a shared Mac                 | Configurable; tested                               |
| CI matrix                                       | Prevent Linux regressions            | Linux unit/E2E + docs on each PR; macOS on release |
| Better observability                            | Operate a shared host                | Request IDs, structured logs, health detail        |
| Release automation                              | Consumable packages                  | Versioned packages + changelog                     |

## Later — v1.0 (performance and multi-user)

| Item                                  | Why                                | Risk                                       |
| ------------------------------------- | ---------------------------------- | ------------------------------------------ |
| H.264/WebRTC streaming                | Smooth interaction, video playback | Complexity; codec/GPU support; NAT         |
| ScreenCaptureKit/`recordVideo` source | Avoid per-frame `simctl` spawn     | macOS-only; window visibility requirements |
| Device leases and per-user tokens     | Fair sharing                       | State, authz, cleanup                      |
| Audit log and retention               | Compliance                         | Privacy; storage                           |
| Multi-device scheduling               | Throughput per Mac                 | GPU/CPU contention                         |
| Windows viewer polish                 | Cross-platform teams               | Browser compatibility                      |

Video work starts with a spike, not a rewrite: measure glass-to-glass latency for each source,
then choose. The protocol keeps a transport seam so the API shape does not change.

## Research track (separate, gated)

A native Darwin compatibility layer is **not** on the product roadmap. It is a separate track with
explicit kill criteria. Branch `option-a-native-darwin` implements the A0 substrate (loader,
interpreter, Mach, syscalls, launchd jobs) and documents the remaining gates in the
[native roadmap](../native/roadmap.md). The next spikes are:

1. Run `launchd_sim` under the substrate far enough to report its version.
2. Render a trivial UIKit view offscreen with a Metal-on-Vulkan shim.
3. Identify the minimal CoreSimulator XPC surface for boot.
4. Legal review of a compatibility layer.

If a spike fails its time box, it stops. No product commitments depend on it.

## Explicit non-goals

- Running iOS apps on Linux without a Mac (not feasible with current technology).
- Redistributing Apple runtimes or SDKs.
- Jailbreak, DRM circumvention, or device activation.
- A general-purpose remote desktop.
- A SaaS control plane in v1.
- Android or cross-platform emulation.

## Metrics that matter

| Metric                         | Target             | Why                      |
| ------------------------------ | ------------------ | ------------------------ |
| Time to first frame (new user) | < 10 min from docs | Onboarding               |
| Tap latency p95 on LAN         | < 500 ms           | Usability                |
| Frame age at 2 fps             | < 1 s              | Perceived responsiveness |
| Host crashes per week          | 0                  | Trust                    |
| Auth failures investigated     | 100%               | Security                 |
| Linux CI pass rate             | > 99%              | Portability              |

## Revisit triggers

Re-run the [analysis](../research/analysis-plan.md) if:

- Apple ships a supported Linux simulator or remote-simulator API.
- A maintained project boots current iOS runtimes on Linux with Metal-class rendering.
- QEMU/another hypervisor supports current macOS guests on non-Apple ARM64 **and** licensing is
  resolved.
- `idb` is unmaintained with no replacement.
- A commercial cloud becomes cheaper than operating Mac hosts for the team.
- Demand shifts from "develop on Linux" to "run iOS apps on Linux" (a different, much harder
  product).
