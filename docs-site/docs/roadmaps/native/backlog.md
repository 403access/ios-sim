---
title: Native backlog
sidebar_position: 4
description: "The live task queue for the Option A substrate: current status, ready work, blockers, and the exact pick-next protocol."
---

# Native backlog

This page owns **status** for the native track. Scope and acceptance live in the
[technical roadmap](./technical.md). If the two disagree, the technical roadmap defines the
task and this page is corrected.

**Last updated:** 2026-10-26 · **Branch:** `option-a-roadmaps` (based on
`option-a-native-darwin` @ `83b9af1`)

## 1. Current state

| State             | Meaning                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| A0 substrate      | **Done.** Generated and real-clang arm64 Mach-O programs execute; Mach/XPC/syscalls/launchd have tests.     |
| A1 kernel/threads | **Not started.** `KRN-001` is next.                                                                         |
| A2 loader/runtime | **Partially startable.** Legacy bindings, fuzzing, diagnostics, and signing parse can proceed in parallel.  |
| A3–A7             | **Blocked or proposed.** Do not start until their gates/dependencies clear.                                 |
| Shipping bridge   | **Unchanged.** Native work is isolated; do not destabilise `apps/host`, `apps/cli`, or `packages/protocol`. |

**Totals (scheduled work):** 19 done · 1 next · 21 ready · remaining blocked/proposed.

## 2. Ready queue

Pick from the top. A task marked with `*` needs a licensed-Mac observation window; it can be
started by a human with host access, not by a Linux-only agent.

| Order | ID         | Workstream    | Size | Depends    | Deliverable / acceptance                                                                      |
| ----: | ---------- | ------------- | ---- | ---------- | --------------------------------------------------------------------------------------------- |
|     1 | `KRN-001`  | Kernel        | S    | A0         | ADR + spike comparing C11/FFI, Rust/cdylib, separate host; blocking call works on Linux/macOS |
|     2 | `LDR-001`  | Loader        | M    | A0         | Legacy `LC_DYLD_INFO` rebase/bind decoder; opcode fixtures resolve correctly                  |
|     3 | `QA-001`   | Quality       | M    | A0         | Deterministic/coverage-guided fuzz harness; 1M mutations without host crash                   |
|     4 | `OBS-001`  | Observability | S    | A0         | Versioned event schema with JSON output tests                                                 |
|     5 | `LEG-001`  | Legal         | S    | A0         | Provenance ledger for every runtime claim/artifact                                            |
|     6 | `REL-001`  | Release       | S    | A0         | Native CI job on Linux (and macOS evidence job); skip reasons visible                         |
|     7 | `QA-003`   | Quality       | M    | A0         | Generated Mach-O corpus covering load commands/fixup formats                                  |
|     8 | `QA-004`   | Quality       | M    | A0         | Performance baseline suite with machine metadata and budgets                                  |
|     9 | `DX-003`   | DX            | S    | A0         | Capability `doctor` JSON schema and tests                                                     |
|    10 | `LDR-010`  | Loader        | M    | A0         | Code-signature parser for ad-hoc/signed fixtures (no verification yet)                        |
|    11 | `LDR-013`  | Loader        | S    | A0         | Missing image/symbol report surfaced by CLI                                                   |
|    12 | `STO-001`  | Storage       | L    | A0         | APFS read-only parser against a generated fixture image                                       |
|    13 | `DX-001`   | DX            | M    | A0         | `inspect --disasm` with addresses for arm64 fixtures                                          |
|    14 | `DX-005`   | DX            | S    | A0         | Native quickstart: demo then real clang fixture                                               |
|    15 | `OBS-002`  | Observability | S    | A0         | Runtime counters for syscalls/Mach/faults/memory                                              |
|    16 | `REL-005`  | Release       | S    | A0         | Docs build/link check in CI                                                                   |
|    17 | `LEG-004`  | Legal         | S    | A0         | Claims audit; no "runs the simulator" language                                                |
|    18 | `GFX-001`* | Graphics      | M    | Mac access | Metal API usage inventory from a licensed runtime                                             |
|    19 | `CS-001`*  | CoreSimulator | M    | Mac access | XPC service/routine inventory with evidence                                                   |
|    20 | `INP-001`* | Input         | M    | Mac access | HID/Indigo/CGEvent inventory                                                                  |
|    21 | `LDR-006`* | Loader        | L    | Mac access | Shared-cache format parser against a local licensed cache                                     |

After `KRN-001` closes, `KRN-002` becomes the critical-path `next` task. After `LDR-001` closes,
`LDR-002` becomes ready. Do not start two critical-path tasks at once.

### First twelve sessions

This is the intended cadence for one engineer/agent. A session ends at a green targeted test and
a backlog update, not at an arbitrary clock time. The parallel task is optional but keeps
non-critical progress moving.

| Session | Critical path | Parallel (independent) | Expected outcome                              |
| ------: | ------------- | ---------------------- | --------------------------------------------- |
|       1 | `KRN-001`     | `LEG-001`              | Boundary ADR/spike; provenance ledger seeded  |
|       2 | `KRN-002`     | `QA-001`               | Host ABI vectors; fuzz harness skeleton       |
|       3 | `KRN-003`     | `OBS-001`              | Native task/port/right objects; event schema  |
|       4 | `KRN-004`     | `DX-003`               | Message queue/copy; capability doctor         |
|       5 | `KRN-005`     | `QA-003`               | Blocking/timeouts; generated Mach-O corpus    |
|       6 | `THR-001`     | `REL-001`              | Thread/thread-port objects; native CI job     |
|       7 | `THR-002`     | `OBS-002`              | Scheduler/run queue; runtime counters         |
|       8 | `THR-003`     | `QA-004`               | Blocking syscall bridge; performance baseline |
|       9 | `LDR-001`     | `LDR-010`              | Legacy dyld opcodes; signature parser         |
|      10 | `LDR-002`     | `LDR-013`              | Lazy/weak binding; loader diagnostics         |
|      11 | `LDR-003`     | `DX-001`               | Initializers/terminators; disassembler        |
|      12 | `KRN-012`     | `QA-005`               | Native stress/soak; concurrency suite start   |

After session 12, re-read the gate tables. Do not start A2 runtime (`RT-*`) until `LDR-004`
exists and `KRN-005` is stable. Do not start A3 until `CS-001`/`CS-007` have evidence.

## 3. Scheduled tasks

### A0 — substrate (done)

| ID              | Task                                         | Evidence                                                               |
| --------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `A0-MACHO-01`   | Mach-O 64/fat parser                         | `packages/darwin-compat/src/macho/parse.test.ts`                       |
| `A0-FIXUP-01`   | Chained fixups (64/64-offset/arm64e)         | `src/macho/fixups.test.ts`, `src/dyld/loader.test.ts`                  |
| `A0-EXPORT-01`  | Export trie decoder                          | `src/macho/parse.test.ts`                                              |
| `A0-BUILD-01`   | Fixture Mach-O writer                        | `src/macho/build.ts`, `src/testing/fixtures.ts`                        |
| `A0-VM-01`      | Sparse 64-bit VM                             | `src/dyld/vm.ts`, runtime tests                                        |
| `A0-DYLD-01`    | User-space loader, slides, binds             | `src/dyld/loader.test.ts`                                              |
| `A0-CPU-01`     | A64 integer interpreter                      | `src/arm64/cpu.test.ts`                                                |
| `A0-ASM-01`     | A64 assembler for fixtures                   | `src/arm64/assembler.ts`                                               |
| `A0-MACH-01`    | Ports/rights/messages/replies                | `src/mach/kernel.test.ts`                                              |
| `A0-BOOT-01`    | Bootstrap registry + MIG-lite                | `src/mach/bootstrap.ts`, `src/mach/kernel.test.ts`                     |
| `A0-XPC-01`     | XPC-style codec/connection                   | `src/xpc/xpc.test.ts`                                                  |
| `A0-SYS-01`     | Darwin syscalls + jail                       | `src/syscall/kernel.test.ts`                                           |
| `A0-LAUNCHD-01` | Plist jobs/MachServices/KeepAlive            | `src/launchd/launchd.test.ts`                                          |
| `A0-RUNTIME-01` | Process orchestrator                         | `src/runtime/process.ts`, `src/dyld/loader.test.ts`                    |
| `A0-CLI-01`     | `ios-sim-native` CLI                         | `apps/native/src/cli.test.ts`                                          |
| `A0-QA-01`      | Unit/integration/robustness tests            | `bun run test:native` (72 tests at baseline)                           |
| `A0-REL-01`     | Build/CI hooks, Dockerfile, Linux E2E script | `bun run build`, `scripts/native-smoke.sh`                             |
| `A0-DOC-01`     | Overview/architecture/ABI/limitations/ADR    | `docs-site/docs/native/`, ADR 0006                                     |
| `A0-REAL-01`    | Real clang Mach-O smoke test                 | `scripts/build-native-fixtures.sh`, `tests/native/macos-clang.test.ts` |

### A1 — kernel, threads, observability, quality foundation

| ID        | Task                           | Priority | Size | Status    | Depends          | Acceptance / evidence                             |
| --------- | ------------------------------ | -------- | ---- | --------- | ---------------- | ------------------------------------------------- |
| `KRN-001` | Native boundary decision       | P0       | S    | **next**  | A0               | ADR + spike; blocking call from TS; build via Bun |
| `KRN-002` | Host ABI v1                    | P0       | M    | blocked   | KRN-001          | Golden vectors; version mismatch fails            |
| `KRN-003` | Native task/port/right objects | P0       | L    | blocked   | KRN-002          | TS oracle parity; 100k create/send/teardown       |
| `KRN-004` | Message queues/copy            | P0       | L    | blocked   | KRN-003          | Fuzz lengths; overflow error                      |
| `KRN-005` | Blocking send/receive/timeouts | P0       | M    | blocked   | KRN-004          | 2 threads; ±5 ms timeout; interrupt               |
| `KRN-006` | Port sets/notifications        | P1       | M    | blocked   | KRN-005          | 100-port select; one notification                 |
| `KRN-007` | Descriptors in transit         | P1       | M    | blocked   | KRN-004          | COPY_SEND/MAKE_SEND_ONCE tests                    |
| `KRN-008` | MIG wire compatibility         | P1       | L    | blocked   | KRN-007          | Reference vectors; unknown routine report         |
| `KRN-009` | Memory objects/shared memory   | P1       | L    | blocked   | KRN-003          | Shared/COW/unmap tests                            |
| `KRN-010` | Mach trap parity table         | P1       | M    | blocked   | KRN-005          | Success/error vectors; fuzz                       |
| `KRN-011` | Quotas/resource accounting     | P2       | S    | blocked   | KRN-005          | Quota teardown; no cross-task impact              |
| `KRN-012` | Native stress/soak             | P1       | M    | blocked   | KRN-005          | 16 threads/1M messages, leak-free                 |
| `THR-001` | Threads/thread ports           | P0       | M    | blocked   | KRN-003          | Create/join/terminate; stable identity            |
| `THR-002` | Scheduler/run queue            | P0       | L    | blocked   | THR-001          | No starvation; trace switches                     |
| `THR-003` | Blocking syscall bridge        | P0       | M    | blocked   | KRN-005, THR-002 | Block/wake/timeout                                |
| `THR-004` | pthread/libSystem shim         | P1       | L    | blocked   | THR-001/2        | 8-worker fixture                                  |
| `THR-005` | Signals                        | P1       | L    | blocked   | THR-001          | Handler/mask/queue cases                          |
| `THR-006` | fork/exec/waitpid/groups       | P1       | L    | blocked   | THR-001          | Parent/child status, groups                       |
| `THR-007` | posix_spawn attributes         | P2       | M    | blocked   | THR-006          | Redirected fds/argv/env                           |
| `THR-008` | kqueue/timers                  | P2       | L    | blocked   | THR-003          | Precision/wakeup, no busy wait                    |
| `THR-009` | Clock/timebase                 | P2       | S    | blocked   | THR-003          | Timebase/sleep accuracy                           |
| `THR-010` | Jetsam/memory pressure         | P2       | M    | blocked   | KRN-009          | Pressure/kill policy                              |
| `THR-011` | Roles/sessions/contracts       | P2       | M    | blocked   | THR-006          | Job identity/ports/teardown                       |
| `THR-012` | Concurrency stress             | P1       | M    | blocked   | THR-004          | 64 threads/processes, no leak                     |
| `OBS-001` | Event schema                   | P1       | S    | **ready** | A0               | Schema + JSON tests                               |
| `OBS-002` | Runtime statistics             | P1       | S    | **ready** | A0               | Counters in doctor/stats                          |
| `OBS-003` | Missing symbol/MIG report      | P1       | M    | blocked   | OBS-001          | Actionable boot failure                           |
| `OBS-004` | Trace export                   | P2       | M    | blocked   | OBS-001          | Chrome/JSON trace                                 |
| `OBS-005` | `trace/stats/why` CLI          | P2       | M    | blocked   | OBS-004          | Commands + redaction                              |
| `OBS-006` | Fault diagnostics              | P1       | M    | blocked   | OBS-001          | PC/encoding/maps on fault                         |
| `OBS-007` | Metrics endpoint (optional)    | P3       | S    | proposed  | OBS-002          | Loopback-only                                     |
| `QA-001`  | Fuzz harness                   | P0       | M    | **ready** | A0               | 1M mutations, no host crash                       |
| `QA-002`  | Differential harness           | P0       | L    | blocked   | QA-001, Mac      | ≥100 cases match                                  |
| `QA-003`  | Generated Mach-O corpus        | P1       | M    | **ready** | A0               | Covers commands/fixups                            |
| `QA-004`  | Performance benchmarks         | P1       | M    | **ready** | A0               | Machine metadata + budgets                        |
| `QA-005`  | Concurrency/stress suite       | P1       | M    | blocked   | THR-012          | No deadlock/leak                                  |
| `QA-006`  | Leak/resource checks           | P1       | M    | blocked   | QA-004           | 24h soak flat                                     |
| `QA-007`  | Coverage targets               | P2       | S    | blocked   | REL-001          | ≥90% parsers                                      |
| `QA-008`  | Compatibility matrix           | P2       | M    | blocked   | QA-002           | Per-cell pass/skip/fail                           |
| `REL-001` | Native CI job                  | P0       | S    | **ready** | A0               | PR job, visible skips                             |
| `REL-002` | Reproducible fixtures          | P1       | S    | blocked   | QA-003           | Byte-identical builds                             |
| `REL-003` | Packaging                      | P2       | M    | blocked   | REL-001          | Install artifact                                  |
| `REL-004` | Versioning policy              | P2       | S    | blocked   | REL-003          | Mismatch fails                                    |
| `REL-005` | Docs gates                     | P1       | S    | **ready** | A0               | Broken links fail                                 |
| `REL-006` | Supply-chain checks            | P2       | S    | blocked   | REL-001          | Audit/lockfile                                    |
| `REL-007` | Maintenance calendar           | P2       | S    | blocked   | SB-008           | Quarterly runbook                                 |
| `LEG-001` | Provenance ledger              | P0       | S    | **ready** | A0               | Every claim sourced                               |
| `LEG-002` | Runtime legal review           | P0       | M    | blocked   | LEG-001          | Written gate                                      |
| `LEG-003` | Hosting/deployment model       | P1       | M    | blocked   | LEG-002          | Allowed patterns                                  |
| `LEG-004` | Claims audit                   | P1       | S    | **ready** | A0               | No false simulator claims                         |
| `LEG-005` | Kill/continue log              | P1       | S    | blocked   | gates            | Written outcomes                                  |
| `DX-001`  | Disassembler                   | P1       | M    | **ready** | A0               | `inspect --disasm`                                |
| `DX-002`  | Trace UX                       | P2       | S    | blocked   | OBS-005          | Filtered trace                                    |
| `DX-003`  | Capability doctor              | P2       | S    | **ready** | A0               | JSON schema/tests                                 |
| `DX-004`  | Repro bundle                   | P2       | M    | blocked   | OBS-004          | Reproduce on another host                         |
| `DX-005`  | Native quickstart              | P1       | S    | **ready** | A0               | Demo + clang fixture                              |
| `DX-006`  | Roadmap validator              | P2       | S    | proposed  | backlog          | CI catches stale IDs/status                       |

### A2 — loader and runtime

| ID        | Task                            | Priority | Size | Status     | Depends          | Acceptance                               |
| --------- | ------------------------------- | -------- | ---- | ---------- | ---------------- | ---------------------------------------- |
| `LDR-001` | Legacy dyld opcodes             | P0       | M    | **ready**  | A0               | Fixtures resolve correctly               |
| `LDR-002` | Lazy/weak binding               | P0       | M    | blocked    | LDR-001          | Lazy/weak tests                          |
| `LDR-003` | Initializers/terminators        | P0       | M    | blocked    | LDR-002          | Once/order/failure                       |
| `LDR-004` | dlopen/dlsym/dlclose            | P1       | M    | blocked    | LDR-003          | Load/resolve/close                       |
| `LDR-005` | Namespaces/interposition        | P1       | L    | blocked    | LDR-004          | Collision/order                          |
| `LDR-006` | Shared-cache parser             | P1       | L    | **ready*** | Mac              | Parse licensed cache; no bytes committed |
| `LDR-007` | Split/subcache/slide            | P1       | L    | blocked    | LDR-006          | Resolve from cache                       |
| `LDR-008` | Cache fixups/symbols            | P1       | L    | blocked    | LDR-007          | Differential symbols                     |
| `LDR-009` | dyld env/closure                | P2       | M    | blocked    | LDR-004          | Closure matches                          |
| `LDR-010` | Code-signature parser           | P1       | M    | **ready**  | A0               | Parse ad-hoc/signed                      |
| `LDR-011` | Entitlements/policy hooks       | P1       | M    | blocked    | LDR-010          | Entitlements visible                     |
| `LDR-012` | Fileset/bundle/dSYM metadata    | P3       | S    | **ready**  | A0               | Fixture parse                            |
| `LDR-013` | Loader diagnostics              | P1       | S    | **ready**  | A0               | Actionable report                        |
| `LDR-014` | Differential loader suite       | P1       | M    | blocked    | LDR-005/008, Mac | ≥50 cases match                          |
| `RT-001`  | ObjC runtime core               | P0       | L    | blocked    | LDR-004          | Class/selector/method tests              |
| `RT-002`  | Message send/cache              | P0       | L    | blocked    | RT-001           | Dispatch matrix                          |
| `RT-003`  | Ivars/properties/ARC            | P0       | L    | blocked    | RT-002           | ARC fixture                              |
| `RT-004`  | Categories/protocols/exceptions | P1       | M    | blocked    | RT-002           | Override/unwind                          |
| `RT-005`  | Blocks/associations             | P1       | M    | blocked    | RT-003           | Lifetime tests                           |
| `RT-006`  | Foundation strings/collections  | P1       | L    | blocked    | RT-003           | 100-case conformance                     |
| `RT-007`  | Foundation files/URL/JSON/plist | P1       | L    | blocked    | RT-006           | Jail round-trip                          |
| `RT-008`  | CF bridging/run loop            | P1       | L    | blocked    | RT-006           | Bridge/run loop                          |
| `RT-009`  | Swift runtime/metadata          | P1       | L    | blocked    | RT-002           | Swift fixture runs                       |
| `RT-010`  | libSystem/libc/malloc/pthread   | P1       | L    | blocked    | THR-004          | C fixture passes                         |
| `RT-011`  | Runtime conformance             | P1       | M    | blocked    | RT-007           | 200 assertions                           |
| `RT-012`  | Runtime performance             | P2       | M    | blocked    | RT-011           | Budgets met                              |

### A3–A7 — system, graphics, UI, security, storage

These are **blocked or proposed** until their gates clear. Start only the inventory tasks marked
ready, and only with a licensed-Mac evidence window.

| Phase                     | IDs                                                                                      | Status                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| A3 CoreSimulator          | `CS-001` (ready*), `CS-002`–`CS-010`                                                     | inventory only                           |
| A4 Graphics               | `GFX-001` (ready*), `GFX-002`–`GFX-012`                                                  | proposed                                 |
| A5 UI                     | `UI-001`–`UI-009`                                                                        | proposed                                 |
| A6 Input/security/storage | `INP-001` (ready*), `INP-002`–`006`; `SEC-001`–`008`; `STO-001` (ready), `STO-002`–`006` | proposed, except inventories/APFS reader |
| A7 SpringBoard            | `SB-001`–`SB-008`                                                                        | proposed                                 |

## 4. Blocked-queue summary

| Blocker             | Blocks                                      | Unblocks when                     |
| ------------------- | ------------------------------------------- | --------------------------------- |
| KRN-001 decision    | KRN-002, native host, threads               | ADR + spike accepted              |
| KRN-005 blocking    | THR-003, INP-002, many runtime paths        | Native receive/send with timeouts |
| LDR-004 dlopen      | RT-001, RT-009, most runtime work           | Runtime image loading             |
| GFX-G1              | UI-002, UI-003, SB                          | Stable Metal/IOSurface frame      |
| CS-G1               | SB, runtime boot                            | launchd_sim/CoreSimulator path    |
| SEC-G1              | SB, untrusted input                         | Signing/TCC/keychain/sandbox      |
| STO-G1              | SB persistence                              | APFS image + containers           |
| Mac evidence window | QA-002, LDR-006/014, GFX/CS/INP inventories | Scheduled licensed-Mac host time  |
| LEG-002             | A3+ continuation                            | Legal gate passed                 |

## 5. Pick-next protocol

1. Read the top of the ready queue.
2. If the task has a `*`, confirm the Mac evidence window; otherwise skip it for a Linux-only
   session.
3. Check every dependency in the technical roadmap. If any is not `done`, mark the task
   `blocked` with the missing ID and move on.
4. Claim the task: change status to `next` (or `in_progress` in a worktree-only note), create a
   branch/worktree if needed.
5. Write the test/fixture first.
6. Implement the smallest slice that meets acceptance.
7. Run the task command and `bun run verify`.
8. Add an evidence line: `Evidence: <command> → <result> @ <commit>`.
9. Update docs/ABI/ADR if the contract changed.
10. Mark `done`, commit, and promote the next unblocked task.

**WIP:** one critical-path task + one independent task. Never two tasks that both edit the same
ABI file.

## 6. Evidence format

Every `done` task needs one line in this page or the PR description:

```text
Evidence: bunx vitest run packages/darwin-compat/src/macho/fixups.test.ts → 5 passed @ 83b9af1
Evidence: ./scripts/native-smoke.sh fixtures/darwin-hello/build/hello → "hello from a real Mach-O" @ 83b9af1
```

For visual/graphics work, attach a golden image or hash; for Mac-only work, record Xcode/runtime
versions and the observation, never the Apple binary.

## 7. Adding or changing tasks

- New task: add it to the technical roadmap with an ID, scope, dependencies, deliverable, and
  acceptance, then add a row here with status `proposed` or `ready`.
- Split task: use `IDa`, `IDb`; keep the original ID retired with a note.
- Drop task: mark `dropped`, record why, and keep the ID unused.
- Re-plan: only after a gate; update the technical roadmap first, then the backlog, then the
  high-level roadmaps if the phase changed.

## 8. What not to do

- Do not fake blocking with busy-wait loops to make a test pass.
- Do not claim the simulator runs because a fixture renders a rectangle.
- Do not commit an Apple SDK, runtime, shared cache, app, or device data.
- Do not start A3–A7 implementation before their gates.
- Do not leave a task `done` without an acceptance command or observable evidence.
- Do not update status in the workstream docs; this page is canonical.
- Do not mix bridge and native changes in one commit unless the bridge is genuinely affected.

## 9. Change log

| Date       | Change                                                                         |
| ---------- | ------------------------------------------------------------------------------ |
| 2026-10-26 | Backlog created from A0 baseline; KRN-001 promoted to next; ready queue seeded |
