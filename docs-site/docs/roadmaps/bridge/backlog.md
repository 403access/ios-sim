---
title: Bridge backlog
sidebar_position: 7
description: "The live queue for the shipping remote bridge: v0.2 hardening and v1.0 scale work with stable IDs."
---

# Bridge backlog

This is the execution queue for the **shipping remote Mac bridge** (Option C). The bridge design
and phase acceptance live in the [execution plan](../../plans/execution-plan.md); product
outcomes live in the [product roadmap](../../plans/roadmap.md). This page owns status and order.

**Current:** v0.1 is delivered. v0.2 hardening is the next bridge release. The native track is
the current research focus; bridge work can proceed in its own worktree without mixing commits.

## 1. Track policy

| Rule                   | Detail                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| One track per worktree | Do not mix bridge and native changes in one commit unless the bridge is genuinely affected |
| Native next            | `KRN-001` (see [native backlog](../native/backlog.md))                                     |
| Bridge next            | `BR-HOST-01` upload hardening                                                              |
| WIP                    | One critical task per track; do not run two bridge releases at once                        |
| Evidence               | Bridge evidence is a test command, soak result, or latency measurement with host metadata  |
| Release gate           | Quality/security gates in the [engineering quality roadmap](../engineering-quality.md)     |

## 2. Ready queue (v0.2)

| Order | ID           | Area                | Size | Depends      | Acceptance                                                     |
| ----: | ------------ | ------------------- | ---- | ------------ | -------------------------------------------------------------- |
|     1 | `BR-HOST-01` | Upload hardening    | M    | v0.1         | Size/entry/path/symlink/content-type tests; traversal rejected |
|     2 | `BR-HOST-02` | Shared capture loop | M    | v0.1         | Two viewers share one loop; CPU stable; no per-frame spawn     |
|     3 | `BR-HOST-03` | Rate limits/quotas  | M    | v0.1         | Configurable per-IP/token; 429 tests                           |
|     4 | `BR-HOST-04` | Reconnect/backoff   | S    | v0.1         | CLI/viewer resume after blip; no leaked timers                 |
|     5 | `BR-HOST-05` | Error taxonomy      | S    | v0.1         | Stable codes; no raw stacks; docs updated                      |
|     6 | `BR-HOST-06` | Observability       | M    | v0.1         | Request IDs, structured logs, health detail                    |
|     7 | `BR-HOST-07` | Service units       | S    | v0.1         | launchd + systemd examples; tunnel guide                       |
|     8 | `BR-HOST-08` | Optional TLS        | M    | `BR-HOST-07` | HTTPS/WSS; token still required                                |
|     9 | `BR-CI-01`   | CI matrix           | S    | v0.1         | Linux unit/E2E + docs per PR; macOS on release                 |
|    10 | `BR-REL-01`  | Release automation  | M    | `BR-CI-01`   | Versioned packages, changelog, tags                            |
|    11 | `BR-SEC-01`  | Security review     | M    | `BR-HOST-01` | Threat model checklist signed off                              |
|    12 | `BR-QA-01`   | 30-minute soak      | S    | `BR-HOST-02` | Two clients, no leak/unbounded memory                          |

## 3. v1.0 queue (proposed)

| ID            | Area                      | Size | Depends                     | Acceptance                                                    |
| ------------- | ------------------------- | ---- | --------------------------- | ------------------------------------------------------------- |
| `BR-SCALE-01` | H.264/WebRTC source spike | L    | `BR-QA-01`                  | 30 fps, under 150 ms glass-to-glass on LAN or a written no-go |
| `BR-SCALE-02` | Push capture pipeline     | L    | `BR-SCALE-01`, `BR-HOST-02` | No per-frame `simctl`; CPU per client measured                |
| `BR-SCALE-03` | Multi-device scheduling   | L    | `BR-HOST-02`                | N devices with fair CPU/GPU; load test                        |
| `BR-SCALE-04` | Session isolation/leases  | L    | `BR-SEC-01`                 | Per-user tokens/leases; cleanup test                          |
| `BR-SCALE-05` | Audit log/retention       | M    | `BR-SCALE-04`               | Who booted/installed/launched; retention policy               |
| `BR-SCALE-06` | Metrics/alerts            | M    | `BR-HOST-06`                | Latency/errors/queue depth/saturation                         |
| `BR-VIEW-01`  | Viewer reconnect polish   | S    | `BR-HOST-04`                | Stream resumes; no duplicate input                            |
| `BR-CLI-01`   | CLI reconnect polish      | S    | `BR-HOST-04`                | Retry/backoff; clear errors                                   |
| `BR-QA-02`    | Flake budget              | S    | `BR-CI-01`                  | Flaky test is a bug; no retries to hide                       |
| `BR-DOC-01`   | Deployment runbook        | S    | `BR-SCALE-04`               | Host setup/rollback/incident checklist                        |

## 4. Done (v0.1)

| Area                                | Evidence                                          |
| ----------------------------------- | ------------------------------------------------- |
| Protocol + client                   | `packages/protocol`, contract tests               |
| host lifecycle/screenshot/apps/logs | `apps/host`, unit/contract tests, Linux E2E       |
| input adapter                       | `apps/host/src/idb.ts`, explicit 501 when absent  |
| CLI + viewer                        | `apps/cli`, `apps/host/src/web.ts`                |
| security defaults                   | token auth, loopback default, threat model        |
| tests/docs                          | unit/contract, Linux E2E, macOS gated, docs build |

## 5. Bridge definition of done

- Endpoint/behaviour has a contract test and a Linux E2E path where applicable.
- Security defaults are unchanged or reviewed.
- Error codes are documented.
- Latency/soak evidence includes host and network.
- Docs/API/CLI references updated.
- `bun run verify` passes; macOS integration is run before release.

## 6. Links

- [Execution plan](../../plans/execution-plan.md)
- [Product roadmap](../../plans/roadmap.md)
- [Testing strategy](../../plans/testing-strategy.md)
- [Threat model](../../security/threat-model.md)
- [Engineering quality roadmap](../engineering-quality.md)
- [Roadmap hub](../index.md)
