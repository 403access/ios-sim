---
title: Feasibility matrix
sidebar_position: 5
description: Weighted decision matrix, evidence, sensitivity analysis, and the gates each option must pass.
---

# Feasibility matrix

The matrix is a decision aid, not a substitute for the evidence. Each score is explained, and the
result is checked for sensitivity to plausible changes in weights.

## 1. Criteria and weights

Weights reflect a small engineering organisation that wants a usable simulator workflow for Linux
developers within weeks, while keeping maintenance and legal risk acceptable.

| Criterion              | Weight | Definition                                                                    |
| ---------------------- | -----: | ----------------------------------------------------------------------------- |
| Fidelity               |    20% | Does it run the same simulator and iOS runtimes as Xcode on a Mac?            |
| Time to first workflow |    20% | Days/weeks until a developer can boot, view, interact, install, and read logs |
| Linux UX               |    15% | How natural is the workflow on a Linux workstation?                           |
| Maintenance            |    15% | Ongoing engineering and breakage risk per year                                |
| Cost                   |    10% | Hardware, licences, cloud minutes, engineering                                |
| Legal/compliance       |    10% | Licence and policy risk for hosting and distribution                          |
| Latency                |     5% | Input-to-pixel latency for interactive use                                    |
| CI/automation          |     5% | Ability to run headless, scriptable, parallel jobs                            |

Scores: 1 (poor) to 5 (excellent). Higher is better for every criterion, including cost (5 = cheap)
and legal (5 = low risk).

## 2. Scores

| Criterion              |   Weight | A Native | B macOS VM | C Remote bridge |  D Cloud | E Devices |
| ---------------------- | -------: | -------: | ---------: | --------------: | -------: | --------: |
| Fidelity               |      20% |        5 |          5 |               5 |        3 |         2 |
| Time to first workflow |      20% |        1 |          1 |               5 |        4 |         2 |
| Linux UX               |      15% |        5 |          3 |               4 |        4 |         2 |
| Maintenance            |      15% |        1 |          2 |               4 |        4 |         2 |
| Cost                   |      10% |        2 |          2 |               4 |        2 |         2 |
| Legal/compliance       |      10% |        4 |          1 |               4 |        4 |         5 |
| Latency                |       5% |        5 |          3 |               3 |        2 |         5 |
| CI/automation          |       5% |        3 |          3 |               5 |        4 |         2 |
| **Weighted**           | **100%** | **2.55** |   **2.35** |        **4.45** | **3.45** |  **2.35** |

## 3. Evidence behind the scores

### A. Native Darwin compatibility layer

| Criterion   | Score | Evidence                                                                                         |
| ----------- | ----: | ------------------------------------------------------------------------------------------------ |
| Fidelity    |     5 | Would run the real simulator if it worked                                                        |
| Time        |     1 | Requires Mach/XPC/launchd/Metal/framework work; no shipping project does it for current runtimes |
| Linux UX    |     5 | Fully local                                                                                      |
| Maintenance |     1 | Tracks every Xcode/runtime change; private SPI; huge surface                                     |
| Cost        |     2 | Multi-year engineering; high opportunity cost                                                    |
| Legal       |     4 | Open-source layer is legal to build, but Apple framework redistribution is not                   |
| Latency     |     5 | Local                                                                                            |
| CI          |     3 | Potentially good, but only after years                                                           |

**Confidence:** high on the blockers; low on any completion estimate. The estimate is "years",
not "quarters". This is why it is excluded from the delivery plan.

### B. macOS VM on ARM64 Linux

| Criterion   | Score | Evidence                                                            |
| ----------- | ----: | ------------------------------------------------------------------- |
| Fidelity    |     5 | If it booted current macOS, Xcode would behave normally             |
| Time        |     1 | QEMU `vmapple` requires Apple Silicon + macOS host + macOS 12 guest |
| Linux UX    |     3 | Remote desktop into a macOS VM; not native                          |
| Maintenance |     2 | Hypervisor, GPU, and macOS upgrade fragility                        |
| Cost        |     2 | Apple hardware or unsupported emulation; licences                   |
| Legal       |     1 | Apple licence restricts macOS virtualisation to Apple hardware      |
| Latency     |     3 | GPU passthrough/paravirtualisation is hard                          |
| CI          |     3 | Possible but expensive and fragile                                  |

**Confidence:** high. The QEMU documentation is explicit, and the licence issue is independent
of the technical one.

### C. Remote Mac bridge

| Criterion   | Score | Evidence                                                               |
| ----------- | ----: | ---------------------------------------------------------------------- |
| Fidelity    |     5 | Uses the actual CoreSimulator and runtime                              |
| Time        |     5 | Reference implementation exists and is tested                          |
| Linux UX    |     4 | CLI + browser; not a local window, but natural enough                  |
| Maintenance |     4 | Small protocol; Apple-specific code isolated in two adapters           |
| Cost        |     4 | One Mac can serve several developers; no per-minute cloud fees         |
| Legal       |     4 | Host must be licensed; no runtime redistribution; review hosting terms |
| Latency     |     3 | ~0.36 s capture, ~0.22 s tap on loopback; network adds                 |
| CI          |     5 | Headless `simctl`, scriptable API, Docker-testable client              |

**Confidence:** high for lifecycle/capture/install/logs; medium for input because it depends on
`idb` and Apple SPI.

### D. Commercial cloud

| Criterion   | Score | Evidence                                                    |
| ----------- | ----: | ----------------------------------------------------------- |
| Fidelity    |     3 | Device clouds vary; Corellium is not the Apple Simulator    |
| Time        |     4 | Fast to start, integration work remains                     |
| Linux UX    |     4 | Browser/API                                                 |
| Maintenance |     4 | Vendor-managed                                              |
| Cost        |     2 | Per-minute or expensive plans                               |
| Legal       |     4 | Vendor handles hosting; data/compliance review still needed |
| Latency     |     2 | WAN-dependent                                               |
| CI          |     4 | Usually good APIs                                           |

**Confidence:** medium; vendor capabilities and pricing change frequently.

### E. Physical devices

| Criterion   | Score | Evidence                                            |
| ----------- | ----: | --------------------------------------------------- |
| Fidelity    |     2 | Real device, but not a simulator; different purpose |
| Time        |     2 | Provisioning, signing, device management            |
| Linux UX    |     2 | Requires Apple tooling for build/sign/debug         |
| Maintenance |     2 | Hardware, iOS updates, cables                       |
| Cost        |     2 | Devices and device farm operations                  |
| Legal       |     5 | Least licensing ambiguity                           |
| Latency     |     5 | Local device                                        |
| CI          |     2 | Hard to parallelise and maintain                    |

**Confidence:** high. This is a complement, not a substitute.

## 4. Sensitivity analysis

Would the decision change if the weights changed?

| Scenario                        |        A |    B |        C |    D |    E | Winner             |
| ------------------------------- | -------: | ---: | -------: | ---: | ---: | ------------------ |
| Base weights                    |     2.55 | 2.35 | **4.45** | 3.45 | 2.35 | C                  |
| Fidelity 40%, time 10%          |     3.50 | 3.50 | **4.60** | 3.10 | 2.40 | C                  |
| Time 40%, fidelity 10%          |     1.95 | 1.75 | **4.60** | 3.50 | 2.30 | C                  |
| Cost 30%, time 20%              |     2.10 | 1.90 | **4.00** | 2.80 | 2.30 | C                  |
| Maintenance 30%, legal 20%      |     1.85 | 1.55 | **4.25** | 3.60 | 2.55 | C                  |
| "Must be local" hard constraint | **5.00** | 3.00 |     1.00 | 1.00 | 3.00 | A (but infeasible) |

The bridge wins under every plausible weighting. The only scenario where native wins is one with a
hard "must run locally" constraint — and that scenario is not feasible with current technology,
so the constraint would have to be relaxed or the project funded as multi-year research.

## 5. Gates

| Gate                                 | A Native | B macOS VM | C Bridge      | D Cloud          | E Devices          |
| ------------------------------------ | -------- | ---------- | ------------- | ---------------- | ------------------ |
| Technical feasibility today          | ✗        | ✗          | ✓             | ✓                | ✓                  |
| Licence-compatible                   | Partial  | ✗          | ✓ with review | ✓                | ✓                  |
| Testable in this repo                | Hard     | Hard       | ✓             | Vendor-dependent | Hardware-dependent |
| Meets latency target (under 1 s tap) | ✓        | Partial    | ✓ on LAN      | WAN-dependent    | ✓                  |
| Meets CI target                      | Partial  | Partial    | ✓             | ✓                | ✗                  |
| Clear maintenance owner              | ✗        | ✗          | ✓             | Vendor           | Hardware team      |

## 6. Decision and kill criteria

**Decision:** C, remote Mac bridge.

**Kill criteria for C** (move to D or re-plan):

- `idb` stops working on current Xcode and no replacement HID path exists within one release
  cycle, **and** view-only is insufficient for the users.
- Capture latency exceeds ~1 s on a LAN for a sustained period, making interaction unusable.
- Apple's licence terms prohibit the intended hosting model after legal review.
- Operating Mac hosts becomes more expensive than a commercial cloud at the actual usage level.

**Kill criteria for the native research track** (stop spending):

- No path to boot even a minimal UIKit app on a Darling-like layer after a bounded spike.
- Metal/IOSurface proves to be a hard blocker with no plausible open implementation.
- The work requires redistributing Apple binaries or reverse-engineered firmware.

## 7. What would need to be true for native

For completeness, a native port would need all of the following:

1. A Darwin compatibility layer with working Mach ports, XPC, and launchd semantics.
2. A current-runtime-capable `dyld`/shared-cache implementation.
3. Metal and IOSurface implementations good enough for UIKit/SpringBoard.
4. Apple framework replacements with compatible private SPI.
5. Input, accessibility, and privacy/TCC equivalents.
6. A legal path to obtain and use the runtime on non-Apple hardware.
7. A maintenance model that tracks Xcode releases.

Each is a project. Together they are a platform.
