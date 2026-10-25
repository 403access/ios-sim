---
title: "ADR 0006: Option A native research substrate"
sidebar_position: 6
description: Why this branch implements the foundational layers of a native Darwin compatibility layer, and what that does not change.
---

# ADR 0006: Option A native research substrate

- **Status:** Accepted on branch `option-a-native-darwin` (research track)
- **Date:** 2026-10-26
- **Deciders:** Engineering
- **Supersedes:** ADR 0001 for this branch only

## Context

ADR 0001 chose a remote Mac bridge because a native Darwin compatibility layer was estimated at
multiple years with an uncertain endpoint. The research was correct about the total cost. This
branch asks a different question: what does it look like to start that multi-year programme
seriously, with real code and tests instead of a slide?

The constraints remain:

1. No Apple binaries, SDKs, runtimes, or shared caches may be committed or redistributed.
2. The Linux client must not depend on Apple tooling.
3. Claims must be backed by an executable artifact or a primary source.
4. Any layer must be testable on a normal Linux machine, with macOS-only checks explicitly
   gated and explained.

## Decision

On this branch, implement **Option A** as a layered user-space substrate:

- Mach-O parsing, chained fixups, export tries, and a fixture writer.
- Sparse 64-bit virtual memory and user-space dyld with slides, binds, rebases, and dependency
  lookup.
- An AArch64 integer interpreter with instruction and deadline budgets.
- Mach port rights, messages, reply ports, bootstrap services, and MIG-lite dispatch.
- A typed XPC-style codec and request/reply transport.
- A Darwin syscall subset with a jailed filesystem and anonymous/file-backed `mmap`.
- launchd-style XML plist jobs with MachServices, RunAtLoad, and bounded KeepAlive.
- A CLI (`ios-sim-native`), a structured inspection report, and end-to-end tests.

The branch **does not** claim to run the iOS Simulator. The remaining layers (threads, shared
cache, runtime ABI, Metal, UIKit, code signing, TCC, CoreSimulator, SpringBoard) are named in
[Limitations](../native/limitations.md) and sequenced in the [roadmap](../native/roadmap.md).

The shipping decision on `main` remains ADR 0001 (remote Mac bridge). This ADR governs the
experimental branch and is not a product decision until the native gates pass.

## Why this shape

| Choice                            | Reason                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Implement semantics in TypeScript | Fast iteration, shared types, tests on Linux; the native boundary is a later phase       |
| Generated Mach-O fixtures         | Reproducible on any OS, reviewable instruction by instruction, no Apple binaries         |
| Chained fixups only               | Current Xcode binaries use them; legacy dyld opcodes are explicitly gated                |
| 16 KiB sparse pages               | Matches iOS; keeps a 64-bit address space cheap                                          |
| No threads in A0                  | Forces the scheduler/kernel boundary to be designed honestly in A1                       |
| Synchronous Mach handlers         | Deterministic tests; no fake blocking                                                    |
| Non-Apple XPC/MIG encoding        | The transport can be tested now; byte compatibility is a separate, clearly labelled task |
| Strict syscalls by default        | A missing call fails the run instead of producing a false positive                       |
| Jail + budgets                    | Research runs cannot wander the host filesystem or hang forever                          |

## Consequences

### Positive

- A real end-to-end path exists: parse → map → link → interpret → syscalls → Mach → exit.
- Each layer has unit tests; integration tests execute generated programs.
- A real clang-produced arm64 Mach-O runs on the development Mac, proving the stack is not
  limited to hand-encoded fixtures.
- The gaps are executable errors, not folklore.
- The work is a concrete starting point for A1–A7 and a test oracle for future native work.

### Negative

- The substrate is not a sandbox for untrusted code.
- Interpreted execution is slow and lacks SIMD/FP, so it cannot run real application code yet.
- The absence of threads makes Mach receive semantics intentionally incomplete.
- The non-Apple XPC/MIG encoding will need replacement before CoreSimulator interop.
- The branch adds a large surface that must be maintained if it is kept after the experiment.

### Neutral

- `main` continues to ship the remote bridge; this branch does not change the product.
- The protocol package is untouched; the native track is additive.
- The CLI is deliberately separate (`ios-sim-native`) from the shipping `ios-sim`.

## Alternatives considered

| Alternative                             | Why not on this branch                                                  |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Keep Option A as a document only        | Does not test any feasibility claim or produce reusable evidence        |
| Start with a native C/Rust kernel first | Slower to iterate; semantics would be guessed before they are exercised |
| Start with Metal-on-Vulkan              | No loader/runtime substrate to render; cannot test end-to-end           |
| Start by booting `launchd_sim`          | It immediately hits missing XPC/shared-cache/runtime layers             |
| Try to run a real Apple binary          | Violates the no-redistribution constraint and proves little             |
| Keep chasing a macOS VM                 | Separate option, blocked by prerequisites and licensing                 |

## Gates

Proceed past A0 only if:

1. The generated and real-clang tests stay green on Linux/macOS.
2. A1's native kernel boundary can implement blocking Mach receive without a busy-wait.
3. A2's runtime ABI work has a licence-compatible source of headers/behaviour.
4. A4 can show a stable frame before UI work begins.

Stop if the [kill criteria](../native/limitations.md#kill-criteria) are met.

## Follow-ups

- Add fuzzing for Mach-O, chained fixups, plist, XPC, and MIG decoders.
- Add a CI job for the native track on Linux; keep the clang test macOS-gated with a printed
  reason.
- Prototype A1's kernel boundary and record latency/blocking measurements.
- Publish the missing-symbol report format before attempting CoreSimulator.
- Revisit this ADR after each gate with evidence, not estimates.
