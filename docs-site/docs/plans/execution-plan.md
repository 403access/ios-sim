---
title: Execution plan
sidebar_position: 1
description: Phases, work breakdown, acceptance criteria, risks, and rollout for the remote simulator bridge.
---

# Execution plan

**Decision:** implement a remote Mac bridge (Option C). The simulator stays on macOS; Linux
clients get lifecycle, pixels, input, app upload, and logs over HTTP/WebSocket.

This is the bridge execution plan. The [roadmap system](../roadmaps/index.md) explains how it
connects to the product roadmap, the native technical roadmap, and the live backlog.

**Current state:** Phase 0 (research) and Phase 1 (bridge MVP) are complete in this repository.
Phases 2–4 are planned. This page is the plan of record, not a wish list: every phase has an
acceptance gate and a rollback.

## 1. Objectives and non-goals

### Objectives

1. A developer on Linux can list, boot, view, tap, type into, install to, and read logs from a
   simulator on a Mac without leaving the terminal or browser.
2. The Linux client has no Apple dependencies and runs in a plain Bun/Linux container.
3. The host is the only place that knows about `simctl`, `idb`, Xcode, or macOS.
4. The contract is typed, versioned, and covered by tests that run on Linux.
5. The design is honest about private SPI, licensing, and the native-port limit.

### Non-goals for v1

- 60 fps video or game streaming.
- Multi-tenant isolation, billing, or quotas.
- App building/signing on Linux.
- Native execution of the simulator on Linux.
- Physical device management.
- Windows-native GUI (the browser viewer covers Windows too, but the CLI is tested on
  macOS/Linux).

## 2. Workstreams

| Workstream                 | Owner role               | Scope                                          |
| -------------------------- | ------------------------ | ---------------------------------------------- |
| Host backend               | Backend engineer         | `simctl`, `idb`, app upload, logs, errors      |
| Protocol/client            | Platform engineer        | Schemas, HTTP/WS client, versioning            |
| CLI/UX                     | Developer-tools engineer | Commands, output, `open`, streaming            |
| Linux packaging            | DevOps                   | Docker/OrbStack tests, Bun support, CI         |
| Security                   | Security reviewer        | Token, bind rules, threat model, upload limits |
| Documentation              | Tech writer + engineers  | Research, plans, runbooks, ADRs                |
| Native research (optional) | Research engineer        | Darling/Metal spike, bounded                   |

One engineer can cover several roles at this size, but the review responsibilities must be
explicit.

## 3. Phase plan

### Phase 0 — Research and decision (complete)

| Task                             | Output                        | Acceptance                           |
| -------------------------------- | ----------------------------- | ------------------------------------ |
| Inventory toolchain and runtimes | Environment baseline          | Versions recorded                    |
| Inspect simulator binaries       | Mach-O evidence               | Dependencies/imports captured        |
| Evaluate options                 | Architecture options + matrix | At least four options, with blockers |
| Set legal constraints            | Legal note                    | Hosting/redistribution rules stated  |
| Choose architecture              | ADR 0001                      | Decision and consequences recorded   |

**Gate G0:** The research answers RQ1–RQ8 (see [analysis plan](../research/analysis-plan.md)) and
the chosen option passes technical and legal gates.

**Status:** passed.

### Phase 1 — Bridge MVP (complete)

**Goal:** a working end-to-end path from a Linux container to a real simulator.

| ID  | Task             | Deliverable                   | Acceptance                                                                           |
| --- | ---------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| 1.1 | Define protocol  | `packages/protocol`           | Zod schemas; typed client; shared by host/CLI/tests                                  |
| 1.2 | `simctl` backend | `apps/host/src/simctl.ts`     | List/boot/shutdown/erase/delete, apps, screenshot, display, logs                     |
| 1.3 | Input adapter    | `apps/host/src/idb.ts`        | Tap/swipe/text/key/button; explicit 501 when unavailable                             |
| 1.4 | HTTP/WS server   | `apps/host/src/server.ts`     | Auth, errors, raw gzip upload, SSE logs, binary WS stream                            |
| 1.5 | Browser viewer   | `apps/host/src/web.ts`        | Stream, tap/swipe, text, buttons, logs                                               |
| 1.6 | CLI              | `apps/cli`                    | `doctor`, devices, lifecycle, install, launch, input, screenshot, stream, open, logs |
| 1.7 | Tests            | `apps/**/*.test.ts`, `tests/` | Unit + contract + Linux E2E; macOS integration gated                                 |
| 1.8 | Docs             | `docs-site`                   | Research, plans, guides, API, security, ADRs                                         |
| 1.9 | Infra            | `scripts/`, `infra/`          | Linux container test, fixture app, measurement script                                |

**Gate G1:**

- [x] `bun run test` passes on macOS.
- [x] Linux container can `doctor`, list devices, screenshot, and tap against a mock host.
- [x] macOS integration test captures a real JPEG and resolves display metadata.
- [x] App upload path installs a bundle (integration test with a fixture app).
- [x] Unauthorized requests are rejected when a token is configured.
- [x] `bun run docs:build` succeeds with no broken links.
- [x] No Apple binaries are committed.

**Status:** passed on the test machine; CI wiring is part of Phase 2.

### Phase 2 — Hardening and team usability (next)

**Goal:** safe enough for a shared Mac on a private network, and boring to operate.

| ID   | Task                                                       | Acceptance                                                                   |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 2.1  | TLS termination guide (Caddy/nginx) + optional TLS in host | `https://`/`wss://` works; token still required                              |
| 2.2  | SSH tunnel quickstart and systemd/launchd units            | A Linux user can connect without opening a LAN port                          |
| 2.3  | Rate limits and request quotas                             | Configurable per-IP/per-token limits; tests                                  |
| 2.4  | Upload validation                                          | Size limit, entry count, path traversal, symlink policy, content-type; tests |
| 2.5  | Multi-client stream fairness                               | Shared capture loop per device; no thundering herd; load test                |
| 2.6  | Reconnect/backoff in CLI and viewer                        | Stream resumes after network blip; no leaked timers                          |
| 2.7  | Better errors                                              | Stable error codes documented; no raw stack traces                           |
| 2.8  | CI matrix                                                  | GitHub Actions: Linux unit/E2E + docs build; macOS integration on a runner   |
| 2.9  | Observability                                              | Structured logs, request IDs, health details, optional metrics               |
| 2.10 | Release automation                                         | Versioned packages, signed tags, changelog                                   |

**Status:** 2.8 is partially complete. `.github/workflows/ci.yml` runs Linux unit/contract/docs,
the Linux container E2E, and a macOS build/test job. The gated macOS integration job and the
release gate remain (`BR-CI-02` in the [bridge backlog](../roadmaps/bridge/backlog.md)).

**Gate G2:** Security review signed off; a 30-minute soak with two clients shows no leak or
unbounded memory; a Linux user can connect through an SSH tunnel using only the docs.

### Phase 3 — Performance and scale (later)

**Goal:** near-real-time viewing and multiple concurrent users.

| ID  | Task                                                             | Acceptance                                              |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| 3.1 | Evaluate H.264 sources (`recordVideo`, ScreenCaptureKit, WebRTC) | A 30 fps path under 150 ms glass-to-glass on LAN        |
| 3.2 | Replace polling capture with a push pipeline                     | CPU per client reduced; no `simctl` process per frame   |
| 3.3 | Multi-device scheduling                                          | N devices per host with fair CPU/GPU budgets            |
| 3.4 | Session isolation                                                | Per-user tokens, device leases, data cleanup            |
| 3.5 | Audit logging                                                    | Who booted/installed/launched what, retained per policy |
| 3.6 | Metrics and alerts                                               | Latency, errors, queue depth, host saturation           |

**Gate G3:** A 10-user pilot on one Mac Studio meets the agreed latency/error SLO, and the
licence/legal review covers the deployment model.

### Phase 4 — Native research track (optional, time-boxed)

**Goal:** answer whether a Darling-like layer can run a _minimal_ simulator workload, without
committing the product.

| Spike | Question                                                                 | Time box | Kill criterion                                                 |
| ----- | ------------------------------------------------------------------------ | -------- | -------------------------------------------------------------- |
| 4.1   | Can Darling run a current `launchd_sim` far enough to print its version? | 2 weeks  | No path after 2 weeks                                          |
| 4.2   | Can a trivial UIKit app render offscreen with a Metal-on-Vulkan shim?    | 4 weeks  | No stable frame after 4 weeks                                  |
| 4.3   | Which CoreSimulator XPC calls are strictly required for boot?            | 2 weeks  | Requires AppKit/ServiceManagement semantics with no substitute |
| 4.4   | Legal review of a compatibility layer                                    | parallel | No licence-compatible path                                     |

**Gate G4:** A written go/no-go with evidence. Default answer is "no"; the burden of proof is on
the spike.

#### Phase 4a — substrate (implemented on branch `option-a-native-darwin`)

This branch does not claim Gate G4. It implements the foundation the spikes would need, so the
next spike starts from executable code instead of a diagram:

| Deliverable                                 | Evidence                                       |
| ------------------------------------------- | ---------------------------------------------- |
| Mach-O parser, chained fixups, export tries | `packages/darwin-compat/src/macho`, unit tests |
| User-space dyld, slides, binds/rebases      | `src/dyld`, cross-image integration test       |
| AArch64 integer interpreter                 | `src/arm64`, instruction/flag/memory tests     |
| Mach ports, rights, bootstrap services      | `src/mach`, message/reply/service tests        |
| XPC-style RPC and MIG-lite                  | `src/xpc`, `src/mach/mig.ts`                   |
| Jailed Darwin syscalls                      | `src/syscall`, open/read/mmap/escape tests     |
| launchd-style jobs                          | `src/launchd`, plist/RunAtLoad/KeepAlive tests |
| CLI + generated fixtures                    | `apps/native`, `ios-sim-native demo`           |
| Real clang Mach-O smoke                     | `scripts/build-native-fixtures.sh`, gated test |

**Still open:** threads/blocking receive, shared cache, legacy dyld bindings, Apple runtime ABI,
Metal/IOSurface, UIKit/AppKit, code signing/TCC, CoreSimulator, SpringBoard. The
[native platform roadmap](../native/roadmap.md) orders them, the
[native technical roadmap](../roadmaps/native/technical.md) decomposes them, and the
[backlog](../roadmaps/native/backlog.md) tracks the next task.

## 4. Work breakdown and estimates

Estimates are engineer-weeks for one experienced engineer, with confidence ranges.

| Phase | Scope                                          |       Estimate | Confidence  |
| ----- | ---------------------------------------------- | -------------: | ----------- |
| 0     | Research and decision                          |            1–2 | High (done) |
| 1     | MVP (host, protocol, CLI, viewer, tests, docs) |            4–6 | High (done) |
| 2     | Hardening, TLS/tunnel, CI, release             |            3–4 | Medium      |
| 3     | Video/scale/isolation                          |           8–12 | Low–medium  |
| 4     | Native spike                                   | 8 (time-boxed) | Low         |

The MVP deliberately uses the simplest viable transport (JPEG polling) and the simplest deployment
(single host, token). This is what keeps the estimate in weeks rather than quarters.

## 5. Acceptance criteria (v0.1)

A release is acceptable when all of these are true:

### Functional

- [x] List devices and runtimes, including booted state and availability.
- [x] Boot, shutdown, erase, delete, and create devices.
- [x] Capture PNG/JPEG screenshots.
- [x] Stream JPEG frames over WebSocket with a configurable FPS cap.
- [x] Tap, swipe, type, key, and hardware buttons (when `idb` is available).
- [x] Install a `.app` directory as a gzip tarball.
- [x] Launch and terminate apps; list installed apps.
- [x] Stream device logs over SSE.
- [x] Browser viewer with device picker, stream, input, and logs.
- [x] `doctor` reports host, backend, capabilities, and devices.

### Non-functional

- [x] Token auth on every `/v1` route except health; WS token check.
- [x] Loopback bind by default; refuse `--no-auth` on non-loopback.
- [x] Request body limit and upload size limit.
- [x] Structured JSON errors with stable codes.
- [x] No Apple binaries in the repository.
- [x] Unit tests run on Linux.
- [x] macOS integration tests are gated by `IOS_SIM_MACOS_TESTS=1`.
- [x] Docs build with `onBrokenLinks: "throw"`.

### Operational

- [x] Host prints the URL, token path, and a ready-to-paste client command.
- [x] Client config can be saved with `connect`.
- [x] Troubleshooting guide covers the common failures.
- [x] Threat model documents residual risks.

## 6. Test gates

| Gate              | Command                   | Runs on               | Required                  |
| ----------------- | ------------------------- | --------------------- | ------------------------- |
| Format            | `bun run format:check`    | Any                   | Yes                       |
| Types             | `bun run typecheck`       | Any                   | Yes                       |
| Unit/contract     | `bun run test`            | Any                   | Yes                       |
| Docs              | `bun run docs:build`      | Any                   | Yes                       |
| Linux E2E         | `bun run test:linux`      | Linux container       | Yes (CI)                  |
| macOS integration | `bun run test:macos`      | macOS + Xcode         | Yes before release        |
| Manual smoke      | `scripts/macos-smoke.sh`  | macOS + booted device | Yes before release        |
| Security review   | Checklist in threat model | Human                 | Yes before shared hosting |

See [Testing strategy](./testing-strategy.md) for the full matrix and fixtures.

## 7. Risks and mitigations

| ID  | Risk                                      | Likelihood | Impact   | Mitigation                                              | Owner            |
| --- | ----------------------------------------- | ---------- | -------- | ------------------------------------------------------- | ---------------- |
| R1  | `idb` breaks on a new Xcode               | High       | Medium   | Optional input; adapter; contract tests; pin versions   | Host engineer    |
| R2  | Token leaks via URL/logs                  | Medium     | High     | Short-lived tokens later; redact logs; SSH tunnel; TLS  | Security         |
| R3  | Unauthenticated host exposed              | Medium     | Critical | Loopback default; refuse `--no-auth` off-loopback; docs | Security         |
| R4  | Upload path traversal or zip bomb         | Low        | High     | Body limit, entry count, tar filter, temp dir, tests    | Host engineer    |
| R5  | Capture polling saturates host            | Medium     | Medium   | FPS cap, per-device shared loop (Phase 2), backpressure | Host engineer    |
| R6  | Apple changes `simctl` output             | Medium     | Medium   | Zod parsing, fixtures, integration tests                | Host engineer    |
| R7  | Licence/hosting issue                     | Medium     | High     | Legal review; no runtime redistribution; document model | Product/legal    |
| R8  | Linux packaging drift                     | Low        | Medium   | CI container test; Bun engine; lockfile                 | DevOps           |
| R9  | Native-port scope creep                   | Medium     | High     | Separate track with kill criteria                       | Engineering lead |
| R10 | Shared simulator data leaks between users | Medium     | High     | Single-user v0.1; Phase 3 isolation; warning            | Product/security |

## 8. Rollout

### Internal pilot

1. Provision one Mac host (Apple Silicon, 16 GB+ RAM recommended, Xcode + runtime installed).
2. Install `idb-companion` and `fb-idb` if input is required.
3. Run `ios-sim-host --bind 127.0.0.1` and connect through an SSH tunnel.
4. Give 2–3 developers the quickstart and collect friction notes.
5. Measure capture latency, tap latency, and failure modes for a week.

### Team rollout

1. Bind to a private interface or keep loopback + tunnel.
2. Put TLS in front (Caddy/nginx) if the network is not fully trusted.
3. Add a launchd service for the host.
4. Document the host's Xcode/runtime update process.
5. Review logs and data retention with security.

### Rollback

- **Host:** stop the service (`launchctl bootout` or Ctrl+C). No simulator state is modified by
  the daemon beyond the commands the user issued.
- **Client:** uninstall the Bun package; it stores only `client.json` and optional frames.
- **Protocol:** `/v1` is additive; clients negotiate features through `/v1/health`. A breaking
  change becomes `/v2` with a deprecation window.
- **Data:** uploads go to a temp directory and are removed after install; no persistent copy is
  kept by the host.

## 9. Definition of done

- [x] Research, options, matrix, and legal note published.
- [x] ADRs for the four load-bearing decisions.
- [x] Host, protocol, CLI, viewer implemented.
- [x] Unit/contract tests and Linux E2E.
- [x] macOS integration tests (gated) and smoke script.
- [x] Docusaurus site builds and documents every public command.
- [ ] CI runs the full matrix on every PR (Phase 2).
- [ ] Security review for shared hosting (Phase 2).
- [ ] 30 fps transport evaluated (Phase 3).

## 10. First week after handover

| Day | Action                                                               |
| --- | -------------------------------------------------------------------- |
| 1   | Provision host; verify Xcode, runtime, `simctl`, `idb`; run `doctor` |
| 2   | Run macOS integration tests; record latency baseline                 |
| 3   | Pilot with two developers over SSH tunnel                            |
| 4   | Fix top three friction points; update docs                           |
| 5   | Decide whether Phase 2 starts with TLS, fairness, or CI              |

The project is intentionally small enough that this plan can be executed by one engineer with
review, rather than requiring a platform team.
