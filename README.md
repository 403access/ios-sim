# iOS Sim Bridge

**Run a real iOS Simulator from a Linux machine — over the network, not by pretending the
simulator runs on Linux.**

Apple's iOS Simulator is a stack of arm64 Darwin user-space processes that depends on Mach/XPC,
launchd, `dyld_sim`, Metal, IOSurface and private Apple frameworks. It cannot run natively on
Linux without reimplementing a large part of Darwin. This repository documents that finding, then
ships the practical alternative: a macOS host daemon that exposes CoreSimulator over HTTP and
WebSocket, a Linux-friendly CLI, and a browser viewer.

> **This branch (`option-a-native-darwin`) implements Option A.** It contains a real, tested
> user-space Darwin substrate: Mach-O loader, chained fixups, AArch64 interpreter, Mach ports,
> XPC-style RPC, jailed syscalls, and launchd-style jobs. It executes generated arm64 Mach-O
> programs and a real `clang`-built fixture. It does **not** run the iOS Simulator, CoreSimulator,
> UIKit, or Metal. See the [native track overview](docs-site/docs/native/overview.md) and
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
- **Native research track (this branch):** `packages/darwin-compat`, `apps/native`, and the
  clean-room `packages/uikit-native` native X11 window, with per-layer tests, generated Mach-O
  fixtures, a real-clang smoke test, and a Linux Xvfb window test.

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
bun apps/native/src/bin.ts run <macho>          # jailed, budgeted execution
bun apps/native/src/bin.ts launchd <plist>      # launchd-style jobs
bun run build:uikit
bun apps/native/src/bin.ts window                # native X11 blank window (clean-room UIKit)

# optional: build a real Mach-O from our assembly with Xcode clang
./scripts/build-native-fixtures.sh
```

Implemented: Mach-O parsing and chained fixups, user-space dyld with slides and dependency
linking, an AArch64 integer interpreter, Mach rights/messages/reply ports/bootstrap services,
MIG-lite, an XPC-style codec, a Darwin syscall subset, launchd-style plists, a native C11/Bun-FFI
kernel boundary (tasks/ports/queues/blocking/thread objects), a cooperative guest scheduler, and
a clean-room UIKit-compatible native X11 blank window (software renderer, no web view).

Not implemented: guest syscall integration with native blocking (THR-003), legacy dyld bindings,
the shared cache, Objective-C/Swift/Foundation, Metal/IOSurface/QuartzCore, Apple UIKit/AppKit,
code signing, TCC,
`launchd_sim`, CoreSimulator, SpringBoard, and APFS images. It cannot run the simulator or an
Apple app. The [native platform roadmap](docs-site/docs/native/roadmap.md) sequences the
remaining multi-year work, the [technical roadmap](docs-site/docs/roadmaps/native/technical.md)
decomposes it into workstreams and acceptance criteria, and the
[backlog](docs-site/docs/roadmaps/native/backlog.md) tracks the next task.

## Planning

The repository uses four planning altitudes:

| Altitude | Document                                                                      | Use                                            |
| -------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| L0       | [Product roadmap](docs-site/docs/plans/roadmap.md)                            | Outcomes, releases, non-goals                  |
| L1       | [Native platform roadmap](docs-site/docs/native/roadmap.md)                   | Phases, gates, critical path                   |
| L1       | [Engineering quality roadmap](docs-site/docs/roadmaps/engineering-quality.md) | Fuzzing, differential testing, CI, performance |
| L1       | [Research and legal roadmap](docs-site/docs/roadmaps/research-legal.md)       | Evidence, provenance, licensing gates          |
| L2       | [Native technical roadmap](docs-site/docs/roadmaps/native/technical.md)       | Workstreams, work packages, acceptance         |
| L3       | [Native backlog](docs-site/docs/roadmaps/native/backlog.md)                   | Live status and next ready task                |

Start at the [roadmap system](docs-site/docs/roadmaps/index.md) if you are picking up the project.

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
bun run coverage        # parser coverage gate (>=90%)
bun run build:uikit     # build the native X11 UIKitLite window
bun run test:uikit      # Linux X11 CLI/window integration (Docker)
bun run test:kernel     # native C11 kernel boundary + Bun FFI smoke
bun run build:libc      # freestanding C fixture (macOS clang; skip reason elsewhere)
bun run test:kernel:linux
bun run fuzz             # deterministic parser fuzzing (1M/target by default)
bun run fuzz:1m          # explicit alias for the 1M evidence run
bun run corpus           # generate build/corpus + manifest.json
bun run bench            # performance baseline with machine metadata + budgets
bun run soak --seconds 30  # resource soak; use --hours 24 for the full run
bun run repro            # rebuild fixtures twice and compare SHA-256
bun run native boot <file> --service <name>  # actionable boot report
bun run native          # build and run the native CLI
bun run docs:check      # relative-link gate
bun run docs:build
bun run package:native   # build build/packages/*.tgz + manifest.json
bun run provenance       # verify claims' evidence paths
bun run claims           # no false simulator claims
bun run roadmap:check    # backlog IDs/statuses are consistent
bun run versions         # workspace + ABI/schema versions agree
bun run supply-chain     # manifests, lockfile, ignore rules, frozen install
bun run repro:bundle     # tar.gz with doctor/corpus/bench + SHA-256
bun run quickstart       # demo + optional real-clang fixture
bun run native trace <file> --chrome  # runtime events as a Chrome trace
bun run native why <file>             # explain loader outcome
bun run native cache <file>           # inspect a synthetic/real cache header
bun run verify          # local full check
```

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
- [Native UIKit window spike](docs-site/docs/native/uikit-window.md)
- [Native host ABI](docs-site/docs/native/host-abi.md)
- [Roadmap system](docs-site/docs/roadmaps/index.md)
- [Native technical roadmap](docs-site/docs/roadmaps/native/technical.md)
- [Native backlog](docs-site/docs/roadmaps/native/backlog.md)
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
