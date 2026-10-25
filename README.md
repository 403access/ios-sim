# iOS Sim Bridge

**Run a real iOS Simulator from a Linux machine — over the network, not by pretending the
simulator runs on Linux.**

Apple's iOS Simulator is a stack of arm64 Darwin user-space processes that depends on Mach/XPC,
launchd, `dyld_sim`, Metal, IOSurface and private Apple frameworks. It cannot run natively on
Linux without reimplementing a large part of Darwin. This repository documents that finding, then
ships the practical alternative: a macOS host daemon that exposes CoreSimulator over HTTP and
WebSocket, a Linux-friendly CLI, and a browser viewer.

## What you get

- **Host (macOS):** device lifecycle, screenshots, app upload/install, launch/terminate, logs,
  and optional HID input via `idb`.
- **Client (Linux/macOS/Windows):** `ios-sim` CLI plus a browser viewer. No Apple libraries.
- **Protocol:** small, typed, versioned, tested. `/v1` HTTP + WebSocket + SSE.
- **Docs:** research, feasibility matrix, legal notes, ADRs, execution plan, test strategy,
  runbooks. Built with Docusaurus.
- **Tests:** unit/contract tests on any OS, Linux container E2E, gated macOS integration with a
  real simulator and a fixture UIKit app.

## Quickstart

On the Mac:

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
npm ci
npm run build
node apps/host/dist/bin.js --bind 127.0.0.1
```

On Linux:

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
npm ci
npm run build
node apps/cli/dist/bin.js connect http://127.0.0.1:7777 --token '<token from the host>'
node apps/cli/dist/bin.js doctor
node apps/cli/dist/bin.js open
```

With an SSH tunnel, keep the host on loopback:

```bash
ssh -N -L 7777:127.0.0.1:7777 you@mac-host
```

See the [quickstart](https://403access.github.io/ios-sim/docs/guides/quickstart) for details.

## Why not native?

| Option                            | Result                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Native Darwin compatibility layer | Years of Mach/XPC/launchd/Metal/framework work; no current-runtime path                |
| macOS VM on ARM64 Linux           | QEMU `vmapple` needs an Apple Silicon/macOS host and a macOS 12 guest; licence blocked |
| **Remote Mac bridge**             | **Works today; implemented here**                                                      |
| Commercial device cloud           | Viable buy option, not the reference implementation                                    |
| Physical devices                  | Different fidelity; complementary                                                      |

The evidence (including Mach-O dependencies collected with [REA](https://github.com/morluto/rea))
is in the [findings](docs-site/docs/research/findings.md).

## Repository layout

```text
apps/host          macOS daemon (Fastify, simctl, idb)
apps/cli           ios-sim CLI
packages/protocol  Zod schemas + typed client
docs-site          Docusaurus research, plans, guides, ADRs
scripts            E2E, smoke, measurement, REA evidence
infra              Linux test image, OrbStack/QEMU notes
fixtures           minimal UIKit app for integration tests
tests/macos        real-simulator integration suite
```

## Development

Requires Node.js 22.22+ or 24.x. The tested version is 24.22.1 (see `.nvmrc`).

```bash
npm ci
npm run build
npm run lint
npm run typecheck
npm test                  # unit + contract, any OS
npm run test:linux        # Docker/OrbStack Linux E2E
npm run test:macos        # real simulator (macOS, gated)
npm run docs:build
npm run verify            # local full check
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
- [Feasibility matrix](docs-site/docs/research/feasibility-matrix.md)
- [Execution plan](docs-site/docs/plans/execution-plan.md)
- [Testing strategy](docs-site/docs/plans/testing-strategy.md)
- [Threat model](docs-site/docs/security/threat-model.md)

Run the site locally:

```bash
npm run dev:docs
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
