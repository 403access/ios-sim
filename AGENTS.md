# Agent guidance

This repository is a research-backed reference implementation. Keep it honest and small.

## Principles

1. **KISS.** Prefer one process, one protocol, one obvious code path. Do not add a database,
   queue, service mesh, or custom codec without an ADR.
2. **DRY.** The wire contract lives in `packages/protocol`. Host, CLI, tests, and viewers must use
   the shared schemas/client rather than duplicating types or URL building.
3. **Evidence over assertion.** If you change a research claim, cite a command, artifact, or
   primary source. Do not imply the simulator runs natively on Linux.
4. **Every script belongs in the repo.** No ad-hoc `/tmp` scripts for project work; add them under
   `scripts/` and document them.
5. **Tests are part of the change.** New endpoint → contract test; new parser → unit test; new
   platform behaviour → integration test or a documented skip.
6. **No Apple binaries.** Never commit SDKs, runtimes, `.app` builds, device data, or tokens.
7. **Security defaults.** Loopback bind, token auth, explicit capability reporting, no shell
   interpolation.
8. **Bun only.** Install and run everything with Bun (`bun install`, `bun run`, `bunx`). Format
   with `bun fmt`. Do not add npm, yarn, pnpm, Biome, or Prettier config/lockfiles.

## Layout

- `packages/protocol` — Zod schemas, typed client, shared constants.
- `packages/darwin-compat` — Option A research substrate: Mach-O/dyld, arm64, Mach, XPC, syscalls, launchd.
- `packages/uikit-native` — clean-room UIKit-compatible object model and native X11 window (C11; not Apple UIKit).
- `packages/darwin-host` — native C11 kernel boundary (tasks/ports/queues/blocking) via Bun FFI.
- `apps/host` — macOS daemon; `simctl`/`idb` adapters; embedded viewer.
- `apps/cli` — `ios-sim` commands, coordinate conversion, output.
- `apps/native` — `ios-sim-native` CLI for the Option A research track.
- `docs-site` — Docusaurus; research, plans, and roadmaps live here.
- `docs-site/docs/roadmaps` — roadmap hub, native technical roadmap, native backlog, quality/legal roadmaps.
- `scripts` — verify, Linux E2E, macOS smoke/measure, fixture build, REA evidence.
- `tests/macos` — gated real-simulator integration.
- `tests/native` — gated real-clang Mach-O integration; must print its skip reason.

## Commands

```bash
bun run build
bun fmt
bun run format:check
bun run typecheck
bun run test
bun run test:linux
bun run test:macos
bun run test:native
bun run build:uikit
bun run test:uikit
bun run build:kernel
bun run test:kernel
bun run test:kernel:linux
bun run docs:build
bun run verify
```

Bun 1.4.4 is the tested version. `bun install --frozen-lockfile` is the supported install.

## Picking up work

Start at `docs-site/docs/roadmaps/index.md`. Pick a track and use its backlog:
[bridge](docs-site/docs/roadmaps/bridge/backlog.md) or
[native](docs-site/docs/roadmaps/native/backlog.md). The backlog owns status and the next-task
queue; the [native technical roadmap](docs-site/docs/roadmaps/native/technical.md) and
[bridge execution plan](docs-site/docs/plans/execution-plan.md) define scope and acceptance. One
critical-path task plus one independent task is the work-in-progress limit. Record evidence and
update the backlog when a task is done.

## Change checklist

- [ ] Contract updated in `packages/protocol` (if the wire changed).
- [ ] Host and CLI use the shared client/schemas.
- [ ] Unit/contract tests added or updated.
- [ ] Linux E2E still passes for client changes.
- [ ] macOS integration/smoke run for Apple-tool changes.
- [ ] Docs/ADR updated for architectural or behavioural changes.
- [ ] No secrets, Apple binaries, or personal data committed.
- [ ] `bun run verify` passes.

## Things not to do

- Do not implement a native simulator port or claim one works. The Option A research track may
  implement documented user-space substrate layers (see `docs-site/docs/native/`), but it must
  state the remaining blockers and must never imply the simulator boots.
- Do not reimplement Indigo HID; use `idb` behind the adapter.
- Do not enable CORS, disable auth, or bind `0.0.0.0` by default.
- Do not run shell commands with interpolated user input; use argument arrays.
- Do not add WebRTC/H.264 until a measured spike justifies it (ADR first).
- Do not hide a skipped macOS test; print the reason.
