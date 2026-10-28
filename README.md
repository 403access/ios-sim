# iOS Sim Bridge

**Run a real iOS Simulator from a Linux machine — over the network, not by pretending the
simulator runs on Linux.**

Apple's iOS Simulator is a stack of arm64 Darwin user-space processes that depends on Mach/XPC,
launchd, `dyld_sim`, Metal, IOSurface and private Apple frameworks. It cannot run natively on
Linux without reimplementing a large part of Darwin. This repository documents that finding, then
ships the practical alternative: a macOS host daemon that exposes CoreSimulator over HTTP and
WebSocket, a Linux-friendly CLI, and a browser viewer.

> **This branch (`option-a-uikit-poc`, based on `option-a-native-darwin`) implements Option A.**
> It contains a real, tested user-space Darwin substrate: Mach-O loader, chained fixups, AArch64
> interpreter, Mach ports, XPC-style RPC, jailed syscalls, and launchd-style jobs. It also parses
> Objective-C metadata, dispatches `objc_msgSend`, and renders a deterministic frame through a
> clean-room UIKit shim. It executes generated and real `clang`-built arm64 Mach-O programs. It
> does **not** run the iOS Simulator, CoreSimulator, Apple UIKit, Foundation, or Metal. See the
> [native track overview](docs-site/docs/native/overview.md),
> [proof of concept](docs-site/docs/native/poc.md), and
> [limitations](docs-site/docs/native/limitations.md). The remote bridge remains the shipping
> workflow on `main`.

## What you get

- **Host (macOS):** device lifecycle, screenshots, app upload/install, launch/terminate, logs,
  and optional HID input via `idb`.
- **Client (Linux/macOS/Windows):** `ios-sim` CLI plus a browser viewer. No Apple libraries.
- **Protocol:** small, typed, versioned, tested. `/v1` HTTP + WebSocket + SSE.
- **Docs:** research, feasibility matrix, legal notes, ADRs, execution plan, test strategy,
  runbooks. Built with Docusaurus.
- **Tests:** unit/contract tests on any OS, Linux container E2E, gated macOS integration with a
  real simulator and a fixture UIKit app.
- **Native research track (this branch):** `packages/darwin-compat` and `apps/native`, with
  per-layer tests, generated Mach-O fixtures, and a real-clang smoke test.

## Quickstart

Install [Bun](https://bun.com) 1.4.4+ on both machines.

On the Mac:

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
bun install --frozen-lockfile
bun run build
bun apps/host/dist/bin.js --bind 127.0.0.1
```

On Linux:

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
bun install --frozen-lockfile
bun run build
bun apps/cli/dist/bin.js connect http://127.0.0.1:7777 --token '<token from the host>'
bun apps/cli/dist/bin.js doctor
bun apps/cli/dist/bin.js open
```

With an SSH tunnel, keep the host on loopback:

```bash
ssh -N -L 7777:127.0.0.1:7777 you@mac-host
```

See the [quickstart](https://403access.github.io/ios-sim/docs/guides/quickstart) for details.

## Native track (Option A)

This branch does more than document the native option. It implements the first layers and runs
programs:

```bash
bun install --frozen-lockfile
bun run --cwd packages/darwin-compat build

bun apps/native/src/bin.ts doctor
bun apps/native/src/bin.ts demo                 # generated arm64 Mach-O, exit 42
bun apps/native/src/bin.ts inspect <macho>      # segments, imports, fixups, exports
bun apps/native/src/bin.ts inspect <macho> --objc  # ObjC classes/categories/protocols/ivars
bun apps/native/src/bin.ts run <macho>          # jailed, budgeted execution
bun apps/native/src/bin.ts launchd <plist>      # launchd-style jobs
bun apps/native/src/bin.ts uikit-demo --out frame.png
                                                # generated ObjC app -> rendered frame
bun apps/native/src/bin.ts uikit-demo --tap 30,30 --out-dir frames
                                                # tap -> red, blue, green frames
bun apps/native/src/bin.ts uikit-demo --drag 30,30,60,60,3 --out-dir drag
                                                # drag -> red, blue, yellow, green frames
bun apps/native/src/bin.ts uikit-demo --tick 4 --out-dir ticks
                                                # ticks -> the view moves across four frames

# optional: build a real Mach-O from our assembly with Xcode clang
./scripts/build-native-fixtures.sh
# optional: build the real ObjC app with clang (macOS + Xcode)
./scripts/build-objc-fixture.sh
bun apps/native/src/bin.ts run fixtures/objc-window/build/ObjcWindow --out clang.png
```

Implemented: Mach-O parsing and chained fixups, user-space dyld with slides and dependency
linking, an AArch64 integer and scalar floating-point interpreter, Mach rights/messages/reply
ports/bootstrap services, MIG-lite, an XPC-style codec, a Darwin syscall subset, launchd-style
plists, an Objective-C 2 metadata/dispatch subset, a 45-class clean-room UIKit/Foundation shim
(controls, text, images, navigation, tables, transforms, literals), and deterministic PNG frame
capture. The generated ObjC app and a clang-built ObjC app render the same digest across 13
scenarios.

Status, measured: **164 hermetic tests** (6 macOS-gated), **31/31** symbols for the minimal
stock-SDK app, and the app's own ABI measured. The measurement proved the ivar-slot contract, and the
runtime now realizes guest classes and patches `_OBJC_IVAR_$` slots (the clang fixture proves a
guest ivar moves from the placeholder 8 to 64 and still renders). The [architecture dashboard](docs-site/docs/native/dashboard.md) is the
single-screen view; the [M1 charter](docs-site/docs/plans/m1-replacement-images.md) is the next
block.

Not implemented: threads/blocking Mach receive, the shared cache, real
Apple Objective-C/Swift runtimes, Foundation, Apple UIKit/AppKit, Metal/IOSurface/QuartzCore,
code signing, TCC, `launchd_sim`, CoreSimulator, SpringBoard, and APFS images. It cannot run the
simulator or an unmodified Apple app. The [roadmap](docs-site/docs/native/roadmap.md) sequences the remaining multi-year
work with kill criteria.

## Why not native as the shipping product?

| Option                            | Result                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Native Darwin compatibility layer | Foundations implemented on this branch; threads/Metal/frameworks/CoreSimulator remain blockers |
| macOS VM on ARM64 Linux           | QEMU `vmapple` needs an Apple Silicon/macOS host and a macOS 12 guest; licence blocked         |
| **Remote Mac bridge**             | **Works today; implemented here**                                                              |
| Commercial device cloud           | Viable buy option, not the reference implementation                                            |
| Physical devices                  | Different fidelity; complementary                                                              |

The evidence (including Mach-O dependencies collected with [REA](https://github.com/morluto/rea))
is in the [findings](docs-site/docs/research/findings.md).

## Repository layout

```text
apps/host          macOS daemon (Fastify, simctl, idb)
apps/cli           ios-sim CLI
apps/native        ios-sim-native CLI for the Option A research track
packages/darwin-compat/src/objc  ObjC ABI, dispatch, UIKit shim, generated app
packages/darwin-compat/src/ui    framebuffer and PNG/PPM encoders
packages/protocol  Zod schemas + typed client
packages/darwin-compat  Mach-O, dyld, arm64, Mach, XPC, syscalls, launchd
docs-site          Docusaurus research, plans, guides, ADRs
scripts            E2E, smoke, measurement, REA evidence
infra              Linux test image, OrbStack/QEMU notes
fixtures           UIKit app for integration tests; clang Mach-O fixture source
tests/macos        real-simulator integration suite
tests/native       optional real-clang Mach-O integration (skips with a reason)
```

## Development

Requires Bun 1.4.4+. Bun owns dependency installation, scripts, formatting, the CLI, the host,
and the test/docs toolchain.

```bash
bun install --frozen-lockfile
bun run build
bun fmt                 # format everything
bun run format:check    # CI check
bun run typecheck
bun run test            # unit + contract, any OS
bun run test:linux      # Docker/OrbStack Linux E2E
bun run test:macos      # real simulator (macOS, gated)
bun run test:native     # native substrate tests only
bun run native          # build and run the native CLI
bun run docs:build
bun run verify          # local full check
bun run architecture:build  # regenerate the architecture/progress dashboard
```

The native track's architecture dashboard is a single-screen view of the goal, the nine layers,
shipped/open work, milestones, and recent progress. It is generated from
`scripts/architecture-progress.ts` by `bun run architecture:build` (and by every `docs:build`) at
`docs-site/static/architecture-progress.html`.

Input requires `idb` on the host:

```bash
brew tap facebook/fb
brew install idb-companion
pipx install fb-idb
```

## Documentation

- [Overview](docs-site/docs/intro.md)
- [Analysis plan](docs-site/docs/research/analysis-plan.md)
- [Findings](docs-site/docs/research/findings.md)
- [Architecture options](docs-site/docs/research/architecture-options.md)
- [Native track overview](docs-site/docs/native/overview.md)
- [Native architecture](docs-site/docs/native/architecture.md)
- [Native ABI](docs-site/docs/native/abi.md)
- [Native limitations](docs-site/docs/native/limitations.md)
- [Feasibility matrix](docs-site/docs/research/feasibility-matrix.md)
- [Execution plan](docs-site/docs/plans/execution-plan.md)
- [Testing strategy](docs-site/docs/plans/testing-strategy.md)
- [Threat model](docs-site/docs/security/threat-model.md)

Run the site locally:

```bash
bun run dev:docs
```

## Security

The host controls a simulator and can read its screen and data. Defaults are deliberately
conservative:

- bind to `127.0.0.1`;
- require a token on every `/v1` route except health;
- refuse `--no-auth` on a non-loopback bind;
- recommend SSH tunnels or TLS for remote access;
- cap upload size and stream FPS.

Read the [threat model](docs-site/docs/security/threat-model.md) before sharing a host.

## Legal

This project ships no Apple binaries, SDKs, runtimes, or firmware. The host must be a licensed Mac
with Xcode installed. It does not bypass code signing or App Store restrictions. See the
[legal note](docs-site/docs/research/legal-and-licensing.md). Not affiliated with Apple.

## License

MIT. See [LICENSE](LICENSE).
