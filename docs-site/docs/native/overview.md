---
title: Native track overview
sidebar_position: 1
description: What Option A actually implements on this branch, how to run it, and what it still cannot do.
---

# Option A, implemented as a substrate

This branch (`option-a-uikit-poc`, based on `option-a-native-darwin`) chooses **Option A** and
implements the foundational user-space layers of a Darwin compatibility layer. It is a real,
tested codebase, not a sketch. It is also **not an iOS Simulator**: there is no SpringBoard, no
Apple UIKit, no Metal, no CoreSimulator, and no `launchd_sim`. The UIKit on this branch is a
clean-room shim whose methods are documented in the [ABI page](./abi.md); the
[limitations](./limitations.md) page is part of the deliverable, not a disclaimer bolted on
afterwards.

:::caution What "runs natively" means here
`ios-sim-native run` executes self-contained arm64 Mach-O images that use the implemented syscall,
Mach, and Objective-C subset. It can render a frame from an Objective-C application built against
the repository's clean-room UIKit shim. It cannot run an Apple simulator runtime, `simctl`, or an
unmodified Apple app. The shipping workflow remains the remote Mac bridge on `main`. See
[From shim apps to unmodified .ipa](../plans/ipa-readiness.md) for what a stock binary would
require and the measured first milestone.
:::

:::info Architecture at a glance
The [architecture dashboard](./dashboard.md) is a single-screen view of the goal, the nine layers,
per-layer shipped/open work, milestones, and recent progress. It is generated from
`scripts/architecture-progress.ts` by `bun run architecture:build`, which `docs:build` runs too.
:::

## Proof, not a promise

The layer runs both generated fixtures and a binary produced by Xcode's own `clang`:

```bash
bun install --frozen-lockfile
bun run --cwd packages/darwin-compat build

# generated from this repository's A64 encoder and Mach-O writer
bun apps/native/src/bin.ts demo
# → hello from darwin
# → exit status 42

# optional: real clang output (macOS with Xcode)
./scripts/build-native-fixtures.sh
bun apps/native/src/bin.ts run fixtures/darwin-hello/build/hello
# → hello from a real Mach-O
```

The real fixture is built at test time and is not committed. Its source is
`fixtures/darwin-hello/hello.s`; the smoke test asserts the exact output and that the file is a
64-bit arm64 Mach-O.

## What works today

| Capability             | Evidence                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Mach-O parsing         | 64-bit/fat slices, load commands, segments, symbols, UUID, build version                    |
| App bundles            | `run Demo.app` reads `Info.plist`, launches `CFBundleExecutable`, jails to the bundle       |
| Chained fixups         | `DYLD_CHAINED_PTR_64`, `64_OFFSET`, arm64e (auth decoded, PAC not enforced)                 |
| Legacy fixups          | `LC_DYLD_INFO` rebase/bind/weak/lazy opcodes, eager lazy resolution                         |
| Export tries           | regular, absolute, thread-local, re-export entries                                          |
| User-space dyld        | dependency lookup, slides, binds/rebases, `LC_MAIN`/`LC_UNIXTHREAD`                         |
| AArch64 execution      | integer subset, branches, loads/stores, flags, syscall traps                                |
| Darwin syscalls        | file I/O in a jail, stdin/out/err, anonymous/file mmap, time, entropy                       |
| Mach IPC               | task/reply ports, rights, send/receive, send-once, bootstrap services                       |
| MIG-lite               | typed calls with status words, tested client/server                                         |
| XPC-style RPC          | typed object codec and request/reply over Mach                                              |
| launchd-style jobs     | XML plists, MachServices, RunAtLoad, bounded KeepAlive                                      |
| Objective-C 2          | class lists, absolute + relative method lists, selectors, instances                         |
| Message send           | `objc_msgSend`/`Super2`, guest IMP tail calls, framework IMP traps                          |
| UIKit shim             | 45 host classes: views, controls, text, images, navigation, tables, transforms              |
| ObjC literals          | constant `@"..."` strings, `@[]`, `@{}` with measured layouts                               |
| Stock-app surface (M1) | 31/31 symbols; realize-and-patch; the SDK app runs and renders with five replacement images |
| Frame capture          | deterministic 375×667 RGBA frames, PNG/PPM encoding, stable SHA-256                         |
| Inspection             | `inspect`: chained and legacy imports; `--objc` classes/categories/protocols/ivars          |
| Input                  | scripted taps/drags/ticks, hit-testing, began/moved/ended callbacks                         |
| Deterministic fixtures | generated Mach-O, hand-encoded A64, and a generated ObjC app                                |

## What is deliberately absent

The parts that make the simulator a simulator are missing: the dynamic shared cache, real Apple
Objective-C/Swift runtimes, Foundation, Apple UIKit/AppKit,
Metal/IOSurface/QuartzCore, code signing and entitlements, TCC, keychain, `launchd_sim`,
CoreSimulator XPC services, SpringBoard, jetsam, and APFS disk images. The UIKit on this branch is
a clean-room shim, not Apple's framework. See [Limitations](./limitations.md) for the full matrix,
the [proof of concept](./poc.md) for what the shim does, and the [roadmap](./roadmap.md) for the
order in which the remaining layers would be attacked.

## Repository map

```text
packages/darwin-compat/src/
  macho/     Mach-O, chained fixups, export trie, fixture writer
  arm64/     A64 encoder and integer interpreter
  mach/      ports, rights, messages, bootstrap registry, MIG-lite
  xpc/       typed codec and request/reply connection
  dyld/      sparse VM, image loading, fixups, export resolution
  syscall/   BSD syscalls + Mach traps, jailed file layer
  launchd/   plist jobs, services, RunAtLoad, KeepAlive
  objc/      ObjC metadata, dispatch, UIKit shim, generated ObjC app
  ui/        RGBA framebuffer and deterministic PNG/PPM encoding
  runtime/   process orchestrator (Mach task + loader + CPU + syscalls)
  inspect.ts structured inspection for the CLI
apps/native/ CLI: inspect, run, demo, launchd, doctor
tests/native/ optional real-clang integration (skipped without macOS + clang)
```

Each directory has unit tests next to the code. The integration tests in
`dyld/loader.test.ts` execute generated Mach-O programs from fetch to exit, including a chained
import that calls into a second image and a Mach bootstrap round-trip.

## Commands

```bash
bun apps/native/src/bin.ts doctor             # capability report, JSON optional
bun apps/native/src/bin.ts inspect <macho>    # segments, imports, fixups, exports
bun apps/native/src/bin.ts run <macho>        # execute with a jailed filesystem
bun apps/native/src/bin.ts launchd <plist>    # boot launchd-style jobs
bun apps/native/src/bin.ts demo               # generated end-to-end fixture
bun apps/native/src/bin.ts uikit-demo --out frame.png
                                              # generated ObjC app -> rendered frame
```

`run` accepts `--arg`, `--env KEY=VALUE`, `--stdin`, `--root`, `--max-instructions`,
`--timeout`, `--no-strict-syscalls`, `--trace`, and `--trace-syscalls`. Defaults are deliberately
small: 20 million instructions, 15 seconds, and strict syscalls (unimplemented calls fail the run
instead of silently returning `ENOSYS`).

## Safety and legal boundaries

- The CLI never loads an Apple binary, SDK, runtime, or shared cache by itself.
- The Objective-C shim is original code; the framework classes are generated metadata with host
  IMP trampolines, not Apple headers or binaries.
- File syscalls are confined to `--root` (or the binary's directory); traversal is rejected.
- Execution has instruction and wall-clock budgets.
- No network syscalls, no host process spawning, no PTYs, no dynamic code loading.
- The compatibility layer is original code. It does not redistribute Apple software.

The next page explains how the layers fit together; the [ABI page](./abi.md) records exactly what
a binary may rely on.
