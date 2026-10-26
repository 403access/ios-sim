---
title: Native backlog
sidebar_position: 4
description: "The live task queue for the Option A substrate: current status, ready work, blockers, and the exact pick-next protocol."
---

# Native backlog

This page owns **status** for the native track. Scope and acceptance live in the
[technical roadmap](./technical.md). If the two disagree, the technical roadmap defines the
task and this page is corrected.

**Last updated:** 2026-10-26 · **Branch:** `option-a-kernel`

## 1. Current state

| State             | Meaning                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| A0 substrate      | **Done.** Generated and real-clang arm64 Mach-O programs execute; Mach/XPC/syscalls/launchd have tests.     |
| A1 kernel/threads | **In progress.** KRN-001..012 + THR-001..010/012 done; DX-004 is next.                                      |
| A2 loader/runtime | **Started.** LDR-001..004 done; namespaces, fuzzing, diagnostics, and signing remain.                       |
| A3–A7             | **Blocked or proposed.** Do not start until their gates/dependencies clear.                                 |
| Shipping bridge   | **Unchanged.** Native work is isolated; do not destabilise `apps/host`, `apps/cli`, or `packages/protocol`. |

**Totals:** 79 done · 1 next · remaining ready/blocked as listed.

## 2. Ready queue

Pick from the top. A task marked with `*` needs a licensed-Mac observation window; it can be
started by a human with host access, not by a Linux-only agent.

| Order | ID        | Workstream    | Size | Depends | Deliverable / acceptance                   |
| ----: | --------- | ------------- | ---- | ------- | ------------------------------------------ |
|     1 | `DX-002`  | Developer     | S    | OBS-005 | Trace UX; filtered trace                   |
|     2 | `QA-007`  | Quality       | S    | REL-001 | Coverage targets; ≥90% parsers             |

The full ready set is in the scheduled tables below. Mac-evidence tasks (`LDR-006`, `GFX-001`,
`CS-001`, `INP-001`) are ready but require a licensed-Mac window. `DX-002` is the next task;
`QA-007` remains in the quality lane. Do not start two critical-path tasks at once.

### Next sessions

Sessions 1-48 are complete through OBS-007 (substrate, loader, threads, quality, observability,
release, provenance, quickstart, diagnostics, claims, roadmap validation, version policy,
supply-chain checks, repro bundle, session roles, and metrics). This is the next cadence. A session ends at a green targeted test and a backlog update, not at an arbitrary
clock time. The parallel task is optional but keeps non-critical progress moving.

| Session | Critical path | Parallel (independent) | Expected outcome                       |
| ------- | ------------- | ---------------------- | -------------------------------------- |
| 14      | `LDR-002`     | `THR-012`              | Lazy/weak binding; concurrency stress  |
| 15      | `LDR-003`     | `OBS-001`              | Initializers; event schema             |
| 16      | `LDR-004`     | `QA-001`               | dlopen/dlsym; fuzz harness             |
| 17      | `LDR-010`     | `QA-003`               | Signature parser; generated corpus     |
| 18      | `LDR-005`     | `QA-004`               | Namespaces; benchmarks                 |
| 19      | `LDR-013`     | `OBS-002`              | Loader diagnostics; runtime statistics |
| 20      | `RT-001`      | `REL-001`              | ObjC runtime core; native CI           |

After session 20, re-read the gate tables. Do not start A2 runtime (`RT-*`) until `LDR-004`
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

### Spike — native UIKitLite window (out of order)

| ID       | Task                                                   | Status   | Evidence                                                                                                                             |
| -------- | ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `UI-000` | Clean-room UIKit-compatible blank window in native X11 | **done** | `bun run test:uikit` → native X11 window 402x874, pixel `srgb(30,30,46)`, resize 320x480; `bun run build:uikit` unit test 0 failures |

This spike does not satisfy UI-G1 or change the critical path. It exists to de-risk the host
window/software renderer boundary while KRN/LDR/RT gates remain open.

### Kernel boundary — KRN-001..012 (done)

| ID        | Task                           | Evidence                                                                |
| --------- | ------------------------------ | ----------------------------------------------------------------------- |
| `KRN-001` | Native boundary decision       | ADR 0007; C11/Bun-FFI spike                                             |
| `KRN-002` | Host ABI v1                    | `packages/darwin-host/include/darwin_host.h`, TS binding, version check |
| `KRN-003` | Task/port/right objects        | C/FFI tests for names, rights, teardown                                 |
| `KRN-004` | Bounded messages/copy          | C/FFI tests for body, queue full, too-large retention                   |
| `KRN-005` | Blocking/timeouts/interruption | `dh_selftest_blocking`, `dh_selftest_interrupt`; Linux pass             |
| `KRN-006` | Port sets/notifications        | `dh_receive_set_*`; dead-name notification C/FFI tests                  |
| `KRN-007` | Descriptors in transit         | `COPY_SEND`/`MAKE_SEND`/`MAKE_SEND_ONCE` descriptor tests               |
| `KRN-008` | MIG wire compatibility         | Blocked; needs reference vectors                                        |
| `KRN-009` | Memory objects/shared memory   | Shared mappings, clone isolation, unmap C/FFI tests                     |
| `KRN-010` | Mach trap parity               | Trap table/dispatch, unsupported vectors, fuzz dispatch                 |
| `KRN-011` | Quotas                         | `dh_task_set_quotas/get_usage`; port/message/memory enforcement         |
| `KRN-012` | Stress/soak                    | `tests/stress_host.c`: 16 threads, 1M messages, zero queue, teardown    |

Commands: `bun run test:kernel` and `bun run test:kernel:linux`.

### Threads — THR-001..009 (done)

| ID         | Task                                             | Evidence                                                                                    |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `THR-001`  | Thread lifecycle objects and native thread ports | `dh_thread_create/terminate/join/state`; C + Bun FFI tests; `dh_selftest_threads`           |
| `THR-002`  | Cooperative guest scheduler                      | `packages/darwin-compat/src/runtime/scheduler.ts`; round-robin, block/unblock, budget tests |
| `THR-003`  | Blocking Mach bridge                             | `packages/darwin-compat/src/runtime/blocking.ts`; sender wake, timeout, interrupt tests     |
| `THR-003a` | Runtime blocking wiring                          | `DarwinSyscallKernel` + `mach_msg_trap` integration test parks/resumes a guest thread       |
| `THR-004`  | pthread/libSystem shim                           | `runtime/pthread.ts`; create/join/mutex/cond tests; 8-worker fixture                        |
| `THR-005`  | Signals                                          | `runtime/signals.ts`; handler/mask/raise/kill, SIGCHLD model tests                          |
| `THR-006`  | fork/exec/waitpid/groups                         | `runtime/process-table.ts`; fork clone, exec, waitpid/reap, groups, kill tests              |
| `THR-006a` | Process syscall wiring                           | `runtime/process-runtime.ts` + `DarwinSyscallKernel` fork/exec/waitpid traps                |
| `THR-007`  | Spawn attributes                                 | `runtime/stack.ts` + `ProcessRuntime.spawn`; argv/env stack, stdio redirection              |
| `THR-008`  | Timers/event loop                                | `runtime/event-loop.ts`; deadline/source wakeups, scheduler integration                     |
| `THR-009`  | Clock/timebase                                   | `runtime/clock.ts`; realtime/monotonic, timebase conversion, event-loop sleep               |

### Loader — LDR-001 (done)

| ID        | Task                            | Evidence                                                                         |
| --------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `LDR-001` | Legacy dyld rebase/bind opcodes | `src/macho/legacy-fixups.ts`, `legacy-fixups.test.ts`, `loader.test.ts` fixtures |

### A1 — kernel, threads, observability, quality foundation

| ID         | Task                           | Priority | Size | Status    | Depends          | Acceptance / evidence                                      |
| ---------- | ------------------------------ | -------- | ---- | --------- | ---------------- | ---------------------------------------------------------- |
| `KRN-001`  | Native boundary decision       | P0       | S    | **done**  | A0               | ADR 0007 + C11/Bun-FFI spike; `bun run test:kernel`        |
| `KRN-002`  | Host ABI v1                    | P0       | M    | **done**  | KRN-001          | ABI v1 header + TS binding; version check; FFI vectors     |
| `KRN-003`  | Native task/port/right objects | P0       | L    | **done**  | KRN-002          | C/FFI names, rights, teardown; parity vectors              |
| `KRN-004`  | Message queues/copy            | P0       | L    | **done**  | KRN-003          | Bounded queues, body copy, too-large retention             |
| `KRN-005`  | Blocking send/receive/timeouts | P0       | M    | **done**  | KRN-004          | Native thread wake, timeout, interrupt; selftests          |
| `KRN-006`  | Port sets/notifications        | P1       | M    | **done**  | KRN-005          | Port sets + dead-name notification; C/FFI tests            |
| `KRN-007`  | Descriptors in transit         | P1       | M    | **done**  | KRN-004          | COPY_SEND/MAKE_SEND_ONCE descriptor tests                  |
| `KRN-008`  | MIG wire compatibility         | P1       | L    | blocked   | KRN-007          | Reference vectors; unknown routine report                  |
| `KRN-009`  | Memory objects/shared memory   | P1       | L    | **done**  | KRN-003          | Shared mappings, clone isolation, unmap tests              |
| `KRN-010`  | Mach trap parity table         | P1       | M    | **done**  | KRN-005          | Trap table/dispatch, unsupported vectors, fuzz             |
| `KRN-011`  | Quotas/resource accounting     | P2       | S    | **done**  | KRN-005          | Port/message/memory quotas, usage, enforcement             |
| `KRN-012`  | Native stress/soak             | P1       | M    | **done**  | KRN-005          | 16 threads/1M messages, zero queued, leak-free             |
| `THR-001`  | Threads/thread ports           | P0       | M    | **done**  | KRN-003          | Thread lifecycle objects/ports; C + FFI tests              |
| `THR-002`  | Scheduler/run queue            | P0       | L    | **done**  | THR-001          | Round-robin CPU scheduler, block/unblock, budgets          |
| `THR-003`  | Blocking syscall bridge        | P0       | M    | **done**  | KRN-005, THR-002 | `BlockingMachBridge` park/wake/timeout/interrupt tests     |
| `THR-003a` | Runtime blocking wiring        | P0       | M    | **done**  | THR-003          | `DarwinSyscallKernel` + real receive park/resume test      |
| `THR-004`  | pthread/libSystem shim         | P1       | L    | **done**  | THR-003a         | create/join/mutex/cond; 8-worker fixture                   |
| `THR-005`  | Signals                        | P1       | L    | **done**  | THR-001          | handler/mask/raise/kill, SIGCHLD model; waitpid in THR-006 |
| `THR-006`  | fork/exec/waitpid/groups       | P1       | L    | **done**  | THR-001          | ProcessTable fork/exec/waitpid/groups; status tests        |
| `THR-006a` | Process syscall wiring         | P1       | M    | **done**  | THR-006          | fork/exec/waitpid traps; ProcessRuntime integration test   |
| `THR-007`  | posix_spawn attributes         | P2       | M    | **done**  | THR-006a         | argv/env stack, stdout/stderr redirection, spawn API       |
| `THR-008`  | kqueue/timers                  | P2       | L    | **done**  | THR-003          | Timer/source event loop, park/wake, tick tests             |
| `THR-009`  | Clock/timebase                 | P2       | S    | **done**  | THR-003          | Realtime/monotonic, timebase conversion, timer sleep       |
| `THR-010`  | Jetsam/memory pressure         | P2       | M    | **done**  | KRN-009          | Priority-ordered kill policy                               |
| `THR-011`  | Roles/sessions/contracts       | P2       | M    | **done**  | THR-006          | Session identity/ports/idempotent teardown                 |
| `THR-012`  | Concurrency stress             | P1       | M    | **done**  | THR-004          | 64 threads/processes, no leak                              |
| `OBS-001`  | Event schema                   | P1       | S    | **done**  | A0               | Schema, redaction, NDJSON, process events                  |
| `OBS-002`  | Runtime statistics             | P1       | S    | **done**  | A0               | Counters + `stats` command                                 |
| `OBS-003`  | Missing symbol/MIG report      | P1       | M    | **done**  | OBS-001          | Unresolved symbols + missing services report               |
| `OBS-004`  | Trace export                   | P2       | M    | **done**  | OBS-001          | Chrome/JSON trace                                          |
| `OBS-005`  | `trace/stats/why` CLI          | P2       | M    | **done**  | OBS-004          | `trace`/`why` + existing `stats`                           |
| `OBS-006`  | Fault diagnostics              | P1       | M    | **done**  | OBS-001          | Fault snapshot in errors                                   |
| `OBS-007`  | Metrics endpoint (optional)    | P3       | S    | **done**  | OBS-002          | Loopback-only, bearer optional                             |
| `QA-001`   | Fuzz harness                   | P0       | M    | **done**  | A0               | 1M mutations, 0 crashes, corpus retained                   |
| `QA-002`   | Differential harness           | P0       | L    | blocked   | QA-001, Mac      | ≥100 cases match                                           |
| `QA-003`   | Generated Mach-O corpus        | P1       | M    | **done**  | A0               | 23 cases, 15 commands, 5 pointer formats                   |
| `QA-004`   | Performance benchmarks         | P1       | M    | **done**  | A0               | 7 cases, metadata, budgets, all pass                       |
| `QA-005`   | Concurrency/stress suite       | P1       | M    | **done**  | THR-012          | Mach wake, 8x8 process, interrupt tests                    |
| `QA-006`   | Leak/resource checks           | P1       | M    | **done**  | QA-004           | Soak flat; Mach port leak found/fixed                      |
| `QA-007`   | Coverage targets               | P2       | S    | **ready** | REL-001          | ≥90% parsers                                               |
| `QA-008`   | Compatibility matrix           | P2       | M    | blocked   | QA-002           | Per-cell pass/skip/fail                                    |
| `REL-001`  | Native CI job                  | P0       | S    | **done**  | A0               | Linux native job, visible skips, fuzz/corpus/bench         |
| `REL-002`  | Reproducible fixtures          | P1       | S    | **done**  | QA-003           | 23 SHA-256 fixtures identical                              |
| `REL-003`  | Packaging                      | P2       | M    | **done**  | REL-001          | CLI + runtime tarballs + SHA-256 manifest                  |
| `REL-004`  | Versioning policy              | P2       | S    | **done**  | REL-003          | Patch drift only; ABI/schema exact                         |
| `REL-005`  | Docs gates                     | P1       | S    | **done**  | A0               | Broken relative links fail                                 |
| `REL-006`  | Supply-chain checks            | P2       | S    | **done**  | REL-001          | Manifests, lockfile, ignore, frozen install                |
| `REL-007`  | Maintenance calendar           | P2       | S    | blocked   | SB-008           | Quarterly runbook                                          |
| `LEG-001`  | Provenance ledger              | P0       | S    | **done**  | A0               | 25 claims, evidence paths verified                         |
| `LEG-002`  | Runtime legal review           | P0       | M    | blocked   | LEG-001          | Written gate                                               |
| `LEG-003`  | Hosting/deployment model       | P1       | M    | blocked   | LEG-002          | Allowed patterns                                           |
| `LEG-004`  | Claims audit                   | P1       | S    | **done**  | A0               | Negation-aware audit gates CI                              |
| `LEG-005`  | Kill/continue log              | P1       | S    | blocked   | gates            | Written outcomes                                           |
| `DX-001`   | Disassembler                   | P1       | M    | **done**  | A0               | `inspect --disasm`                                         |
| `DX-002`   | Trace UX                       | P2       | S    | **next**  | OBS-005          | Filtered trace                                             |
| `DX-003`   | Capability doctor              | P2       | S    | **done**  | A0               | Versioned schema, JSON Schema, validator                   |
| `DX-004`   | Repro bundle                   | P2       | M    | **done**  | OBS-004          | Manifest + tar.gz on another host                          |
| `DX-005`   | Native quickstart              | P1       | S    | **done**  | A0               | One command, visible clang skip                            |
| `DX-006`   | Roadmap validator              | P2       | S    | **done**  | backlog          | CI catches stale IDs/status                                |

### A2 — loader and runtime

| ID        | Task                            | Priority | Size | Status     | Depends          | Acceptance                                           |
| --------- | ------------------------------- | -------- | ---- | ---------- | ---------------- | ---------------------------------------------------- |
| `LDR-001` | Legacy dyld opcodes             | P0       | M    | **done**   | A0               | Rebase/bind fixtures resolve; malformed streams fail |
| `LDR-002` | Lazy/weak binding               | P0       | M    | **done**   | LDR-001          | Lazy/weak tests                                      |
| `LDR-003` | Initializers/terminators        | P0       | M    | **done**   | LDR-002          | Once/order/failure                                   |
| `LDR-004` | dlopen/dlsym/dlclose            | P1       | M    | **done**   | LDR-003          | Load/resolve/close                                   |
| `LDR-005` | Namespaces/interposition        | P1       | L    | **done**   | LDR-004          | Collision/order                                      |
| `LDR-006` | Shared-cache parser             | P1       | L    | **ready*** | Mac              | Parse licensed cache; no bytes committed             |
| `LDR-007` | Split/subcache/slide            | P1       | L    | blocked    | LDR-006          | Resolve from cache                                   |
| `LDR-008` | Cache fixups/symbols            | P1       | L    | blocked    | LDR-007          | Differential symbols                                 |
| `LDR-009` | dyld env/closure                | P2       | M    | blocked    | LDR-004          | Closure matches                                      |
| `LDR-010` | Code-signature parser           | P1       | M    | **done**   | A0               | Parse ad-hoc/signed                                  |
| `LDR-011` | Entitlements/policy hooks       | P1       | M    | blocked    | LDR-010          | Entitlements visible                                 |
| `LDR-012` | Fileset/bundle/dSYM metadata    | P3       | S    | **done**   | A0               | Fixture parse                                        |
| `LDR-013` | Loader diagnostics              | P1       | S    | **done**   | A0               | Actionable report                                    |
| `LDR-014` | Differential loader suite       | P1       | M    | blocked    | LDR-005/008, Mac | ≥50 cases match                                      |
| `RT-001`  | ObjC runtime core               | P0       | L    | blocked    | LDR-004          | Class/selector/method tests                          |
| `RT-002`  | Message send/cache              | P0       | L    | blocked    | RT-001           | Dispatch matrix                                      |
| `RT-003`  | Ivars/properties/ARC            | P0       | L    | blocked    | RT-002           | ARC fixture                                          |
| `RT-004`  | Categories/protocols/exceptions | P1       | M    | blocked    | RT-002           | Override/unwind                                      |
| `RT-005`  | Blocks/associations             | P1       | M    | blocked    | RT-003           | Lifetime tests                                       |
| `RT-006`  | Foundation strings/collections  | P1       | L    | blocked    | RT-003           | 100-case conformance                                 |
| `RT-007`  | Foundation files/URL/JSON/plist | P1       | L    | blocked    | RT-006           | Jail round-trip                                      |
| `RT-008`  | CF bridging/run loop            | P1       | L    | blocked    | RT-006           | Bridge/run loop                                      |
| `RT-009`  | Swift runtime/metadata          | P1       | L    | blocked    | RT-002           | Swift fixture runs                                   |
| `RT-010`  | libSystem/libc/malloc/pthread   | P1       | L    | blocked    | THR-004          | C fixture passes                                     |
| `RT-011`  | Runtime conformance             | P1       | M    | blocked    | RT-007           | 200 assertions                                       |
| `RT-012`  | Runtime performance             | P2       | M    | blocked    | RT-011           | Budgets met                                          |

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
