---
title: M1 ABI table (measured)
sidebar_position: 6
description: What the stock app's metadata does and does not reveal, the ivar-slot contract, and what must be measured with a reference run.
---

# M1 ABI table (measured)

Step 1 of the [M1 charter](./m1-replacement-images.md) is provenance. This page records what was
measured from the minimal stock-SDK app, and — just as important — what the numbers **do not**
mean.

```bash
bun run abi:measure     # reads fixtures/ios-app/build/SpikeApp, writes fixtures/ios-app/abi.json
```

The binary is built locally and never committed; `abi.json` holds only names and numbers.

## Measured from `class_ro_t`

| Class                                 | Emitted instance size | First ivar(s)            | Note                          |
| ------------------------------------- | --------------------: | ------------------------ | ----------------------------- |
| `AppDelegate`                         |                    24 | `_window@8`, `_label@16` | app class, two strong ivars   |
| `SampleView : UIView`                 |                    16 | `_sampleView@8`          | one measurement ivar          |
| `SampleLabel : UILabel`               |                    16 | `_sampleLabel@8`         | one measurement ivar          |
| `SampleButton : UIButton`             |                    16 | `_sampleButton@8`        | one measurement ivar          |
| `SampleWindow : UIWindow`             |                    16 | `_sampleWindow@8`        | one measurement ivar          |
| `SampleController : UIViewController` |                    16 | `_sampleController@8`    | one measurement ivar          |
| SDK                                   |  iPhoneSimulator 27.1 |                          | pinned to the installed Xcode |
| Fixups                                |               chained |                          | `LC_DYLD_CHAINED_FIXUPS`      |

## The important correction: these are placeholders, not Apple's sizes

`SampleView` is _not_ 16 bytes and `UIView` is _not_ 8 bytes. Those numbers come from the
compiler's inability to know an external superclass's size under the non-fragile ABI. What clang
emits is a **placeholder**, and compiled code does **not** use it as a constant:

```asm
adrp x9, _OBJC_IVAR_$_SampleView._sampleView@PAGE
ldrsw x9, [x9, _OBJC_IVAR_$_SampleView._sampleView@PAGEOFF]
add   x0, x8, x9          ; object + offset
```

The app exports `_OBJC_IVAR_$<Class>._<ivar>` slots and loads the offset from them at runtime. The
runtime is therefore expected to **realize classes and patch those slots** — which is exactly what
Apple's runtime does.

**Consequences:**

1. A binary-compatible runtime does **not** need to reproduce Apple's absolute `UIView`/`UILabel`/
   `UIButton` instance sizes to support this app's own ivars. It needs to realize the app's classes
   with a consistent layout and patch the `_OBJC_IVAR_$` slots before the app touches them.
2. Our shim's `UIResponder` being 8 bytes is compatible with the emitted placeholders by
   construction (`AppDelegate`'s ivars land at 8/16), but it is not evidence of Apple's size.
3. The earlier plan item "measure `UIView`'s instance size with subclasses" was based on a wrong
   assumption. The subclass experiment now serves to _demonstrate_ the slot contract (see the
   disassembly above), not to derive sizes.

## What still needs a licensed reference run

| Area                                                       | Why it is needed                                                                         | Blocking for M1?                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| Real Apple instance sizes                                  | Only if a path calls `class_getInstanceSize` or reads a superclass ivar directly         | No for this app                               |
| CF-backed `NSString`/`NSArray`/`NSDictionary` object sizes | Toll-free bridging and allocator behaviour outside the literal structs we already handle | Only if a path instantiates them via CF       |
| `NSObject` retain-count/weak layout                        | `objc_retain`/`weak` must interoperate with guest objects                                | Needs a documented model; not measured yet    |
| UIKit's own ivars and method bodies                        | Cannot be measured without Apple binaries                                                | Out of reach; M1 only needs the app's surface |

## What this buys the next step

- The runtime contract for guest ivars is now explicit: **realize, then patch**.
- The app's own layout is known relative to its superclass: two 8-byte strong ivars after the
  superclass, so a realized `AppDelegate` is `superclassSize + 16`, aligned to 8.
- `AppDelegate`'s class methods and the 31 symbols are covered; what remains is the realization
  path, the replacement images, and the runtime calls the app reaches.

## Realize-and-patch is implemented

The runtime now realizes every guest class at load time: it walks classes superclass-first,
computes `instanceSize` and ivar offsets from **our** superclass sizes, writes each offset into its
`_OBJC_IVAR_$` slot, and uses the realized size for allocation.

Proven by the clang fixture's `TapView : BaseView : UIView`:

```text
placeholder offset for _pressed: 8        (in the image)
after realization:               64       (after UIView's 64 bytes)
```

The fixture asserts the slot reads 64, writes `_pressed` from `touchesBegan:`, reads it in
`touchesEnded:`, and still produces the same green frame as the generated app — so the guest ivar
landed after the shim's view layout instead of corrupting `frame.x`.

## Next targets

1. Generate the five replacement images (`UIKit`, `Foundation`, `libobjc`, `libSystem`,
   `CoreFoundation`) so the stock app links without Apple dylibs.
2. Reach `main`: fill the runtime calls the app hits, one reported symbol at a time.
3. Add the gated stock-app E2E (frame digest + tap updates the label).

The lesson is recorded here so the next reader does not spend a day chasing "UIView = 8 bytes":
the metadata is a contract to patch, not a table of Apple's layouts.
