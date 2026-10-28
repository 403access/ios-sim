---
title: M1 ABI table (measured)
sidebar_position: 6
description: The measured layout facts for the minimal stock-SDK app, what is derived, and what remains unverified.
---

# M1 ABI table (measured)

Step 1 of the [M1 charter](./m1-replacement-images.md) is provenance: every layout number must
come from a measurement, a licensed reference run, or public documentation — never a guess. This
page records the first measurements, taken from the app's own metadata with

```bash
bun run abi:measure     # reads fixtures/ios-app/build/SpikeApp, writes fixtures/ios-app/abi.json
```

The binary is built locally and never committed; `abi.json` holds only numbers and names.

## Measured

| Fact                        | Value                | Source                       |
| --------------------------- | -------------------- | ---------------------------- |
| `AppDelegate` instance size | **24 bytes**         | `class_ro_t.instanceSize`    |
| `AppDelegate` superclass    | `UIResponder`        | `class_ro_t.superclass`      |
| `_window` offset            | **8**                | `ivar_t.offset` → int32 slot |
| `_label` offset             | **16**               | `ivar_t.offset` → int32 slot |
| SDK used for the fixture    | iPhoneSimulator 27.1 | Xcode install                |
| Fixup format                | chained              | `LC_DYLD_CHAINED_FIXUPS`     |

## Derived

A subclass's first ivar offset is the aligned instance size of its superclass:

| Derived fact                | Value       | Why it follows                                         |
| --------------------------- | ----------- | ------------------------------------------------------ |
| `UIResponder` instance size | **8 bytes** | `_window` is the first `AppDelegate` ivar, at offset 8 |

That is the number a binary-compatible `UIResponder` must have, and it is small enough to be
believable (isa only). `UIView`, `UIWindow`, `UILabel`, `UIButton`, and `UIViewController` sizes do
not appear in this image because the app only messages them, it does not subclass them.

## Unverified (must not be guessed)

| Area                                                                               | Status                                               | How it will be resolved                                                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `UIView` / `UIWindow` / `UILabel` / `UIButton` / `UIViewController` instance sizes | unverified                                           | Add a fixture subclass for each in the app, or measure with `class_getInstanceSize` in a licensed reference run |
| CF-backed `NSString` / `NSArray` / `NSDictionary` instance sizes                   | unverified (literal layouts are measured separately) | Reference run plus the layouts already recorded in [ABI](../native/abi.md)                                      |
| `NSObject`/CF retain-count layout and weak-table semantics                         | unverified                                           | Reference run and Apple's open-source runtime where available                                                   |
| UIKit's own ivars and method implementations                                       | out of reach                                         | Cannot be measured without Apple binaries; M1 only needs the app's surface                                      |

Every row above stays `unverified` until the evidence exists. An unverified number is a blocker for
the step that needs it, not an invitation to pick a plausible value.

## What this already buys us

- **`UIResponder` must be 8 bytes** in any binary-compatible image; our shim's `UIResponder` is 8
  bytes too, so this one fact is already aligned.
- The app's two strong ivars sit at 8 and 16, which means **any `UIResponder` subclass layout we
  provide must keep those offsets**: `instanceSize = 8`, `_window` at 8, `_label` at 16, total 24.
- The measurement process works end to end, so the remaining classes can be measured the same way by
  adding subclasses to `fixtures/ios-app/main.m` — the cheapest way to learn Apple's sizes without
  private headers.

## Next measurement targets

1. Add `@interface SampleView : UIView { ... }` (and one subclass each for `UIWindow`, `UILabel`,
   `UIButton`, `UIViewController`) to the fixture, so their instance sizes and first-ivar offsets
   appear in `class_ro_t`.
2. Re-run `bun run abi:measure` and extend this table.
3. Only then generate replacement images with those sizes.
