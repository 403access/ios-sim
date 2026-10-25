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

## Layout

- `packages/protocol` — Zod schemas, typed client, shared constants.
- `apps/host` — macOS daemon; `simctl`/`idb` adapters; embedded viewer.
- `apps/cli` — `ios-sim` commands, coordinate conversion, output.
- `docs-site` — Docusaurus; research and plans live here.
- `scripts` — verify, Linux E2E, macOS smoke/measure, fixture build, REA evidence.
- `tests/macos` — gated real-simulator integration.

## Commands

```bash
npm run build
npm run lint
npm run typecheck
npm test
npm run test:linux
npm run test:macos
npm run docs:build
npm run verify
```

Node 24.22.1 is the tested version (`.nvmrc`). `npm ci` is the supported install.

## Change checklist

- [ ] Contract updated in `packages/protocol` (if the wire changed).
- [ ] Host and CLI use the shared client/schemas.
- [ ] Unit/contract tests added or updated.
- [ ] Linux E2E still passes for client changes.
- [ ] macOS integration/smoke run for Apple-tool changes.
- [ ] Docs/ADR updated for architectural or behavioural changes.
- [ ] No secrets, Apple binaries, or personal data committed.
- [ ] `npm run verify` passes.

## Things not to do

- Do not implement a native simulator port or claim one works.
- Do not reimplement Indigo HID; use `idb` behind the adapter.
- Do not enable CORS, disable auth, or bind `0.0.0.0` by default.
- Do not run shell commands with interpolated user input; use argument arrays.
- Do not add WebRTC/H.264 until a measured spike justifies it (ADR first).
- Do not hide a skipped macOS test; print the reason.
