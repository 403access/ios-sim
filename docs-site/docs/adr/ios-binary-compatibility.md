---
title: "ADR 0008: Shim apps now, measured binary compatibility next"
sidebar_position: 8
description: Why the branch keeps the clean-room shim as its deliverable and gates any unmodified-.ipa work behind a named app and a measured symbol budget.
---

# ADR 0008: Shim apps now, measured binary compatibility next

- **Status:** Accepted on branch `option-a-uikit-poc`
- **Date:** 2026-10-26
- **Deciders:** Engineering
- **Depends on:** ADR 0006, ADR 0007

## Context

ADR 0007 chose a clean-room UIKit shim so the Objective-C ABI could be proven without threads,
TLS, a shared cache, or Apple's runtime. That decision worked: the branch runs SDK-shaped
Objective-C apps and matches a real clang build frame for frame.

It also created a gap that the documentation must not blur. The shim is **not** ABI-compatible
with Apple's frameworks:

- shim classes use this repository's own ivar offsets and instance sizes;
- selectors are C strings, not Apple's selector representation;
- apps compile against `fixtures/objc-window/shim/UIKitShim.h`, not `UIKit.framework`;
- nothing maps UIKit, Foundation, libobjc, libSystem, or CoreFoundation.

The repository's original goal is an **unmodified `.ipa`**. Two endpoints are therefore in play:

- **G1:** run apps built against the shim (implemented, tested).
- **G2:** run a stock-SDK binary (not started, blocked on binary compatibility).

Continuing to add shim widgets is useful, but it will never, by itself, satisfy G2. Conversely,
attacking G2 without a bound invites a multi-year, unmeasurable programme.

## Decision

1. **The shim track (G1) is the shipped deliverable.** It remains the default subject of tests,
   fixtures, and documentation, and it is described as a shim everywhere. No page may imply that
   an unmodified `.ipa` runs.
2. **G2 is a measured track with named apps.** Every G2 step must name the binary it targets,
   record the undefined symbols it needs (see `scripts/spike-ios-symbols.ts`), and add only the
   symbols that app requires. No "implement UIKit" work items without a shortfall report.
3. **No Apple binary is redistributed or executed.** The spike compiles locally against an SDK on
   macOS and records symbol names and counts only. The built app stays in a git-ignored directory.
4. **The first G2 milestone is M1** — the app in `fixtures/ios-app/main.m` starts through this
   loader with a clean-room, ABI-compatible subset of the 31 symbols and 13 classes it references.
   Acceptance and non-goals are in
   [the readiness plan](../plans/ipa-readiness.md#milestones).
5. **M1 is time-boxed.** If the app cannot start after the loader, runtime, and replacement images
   are prototyped, and the remaining blocker is a closed Apple component, the `.ipa` claim stays
   out of scope and the project ships G1 with the blocker written down.

## Consequences

- The shim keeps its freedom to use fixed offsets and TypeScript semantics; we do not contort it
  into Apple's layout until M1 begins.
- Symbol counts become part of the evidence, not marketing. The current measurement is 31
  undefined symbols (13 classes, 8 runtime entry points, 1 block class, 1 UIKit constant, 8
  others) for a trivial app that also loads five Apple dylibs.
- The responder chain, navigation, table views, `NSBundle`, blocks, exceptions, threads, and the
  compositor remain the shim track's backlog and are valid work while M1 is being specified.
- A future reader can tell which claim a test supports: shim-linked fixtures prove G1; only the
  M1 app can ever prove G2.
