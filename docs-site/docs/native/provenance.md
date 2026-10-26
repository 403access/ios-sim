---
title: Provenance ledger
sidebar_position: 6
description: "Every native-track claim with the file, test, or command that backs it; partial and blocked work is labelled."
---

# Provenance ledger

This page mirrors `packages/darwin-compat/src/provenance/ledger.ts`. The code is canonical: tests
check that required claims exist and that every evidence path is present. `bun run provenance`
prints the table and fails on a missing path.

**Status vocabulary:** `implemented` means the claim is exercised by tests; `partial` means the
claim is true only with the stated limitation; `blocked` means the work cannot proceed without a
licence, Apple runtime, or other external gate.

| ID              | Status      | Claim                                                       | Evidence                                        | Limitation                                              |
| --------------- | ----------- | ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `A0-MACHO`      | implemented | Thin/fat arm64 Mach-O, load commands, symbols, export tries | `src/macho/parse.ts`, `parse.test.ts`           | —                                                       |
| `A0-FIXUPS`     | implemented | Chained fixups: PTR_64, PTR_64_OFFSET, arm64e               | `src/macho/fixups.ts`, `fixups.test.ts`         | —                                                       |
| `LDR-001`       | implemented | Legacy `LC_DYLD_INFO` rebase/bind opcodes                   | `src/macho/legacy-fixups.ts`, `loader.test.ts`  | —                                                       |
| `LDR-002`       | partial     | Lazy first-use binds, weak flat lookup, missing → null      | `src/dyld/loader.ts`, `loader.test.ts`          | No lazy-stub trampolines or general weak coalescing     |
| `LDR-003`       | implemented | `__mod_init_func`/`__mod_term_func`/`LC_ROUTINES_64`        | `src/dyld/loader.ts`, `src/runtime/process.ts`  | —                                                       |
| `LDR-004`       | partial     | Refcounted `dlopen`/`dlsym`/`dlclose` handles               | `src/dyld/dlopen.ts`, `loader.test.ts`          | No guest syscalls/`RTLD_GLOBAL`                         |
| `LDR-005`       | implemented | Ordinals, flat collisions, `__interpose` pairs              | `src/dyld/loader.ts`, `loader.test.ts`          | —                                                       |
| `LDR-010`       | partial     | Embedded signature, CodeDirectory, entitlements             | `src/macho/code-signature.ts`, test             | Hashes/certificates/CMS unverified                      |
| `LDR-012`       | implemented | Bundle `Info.plist`, filesets, `N_OSO` dSYM data            | `src/macho/bundle.ts`, test                     | No DWARF line tables                                    |
| `LDR-013`       | implemented | Structured loader diagnostics with next action              | `src/dyld/diagnostics.ts`, CLI                  | —                                                       |
| `THR-008`       | implemented | Guest timers and source wakeups without polling             | `src/runtime/event-loop.ts`, test               | —                                                       |
| `THR-009`       | implemented | Realtime/monotonic clocks, timebase, timer sleep            | `src/runtime/clock.ts`, test                    | —                                                       |
| `THR-012`       | implemented | 64 threads and 64 fork/exit/reap processes                  | `src/runtime/stress.test.ts`                    | —                                                       |
| `THR-010`       | partial     | Priority-ordered jetsam kills                               | `src/runtime/jetsam.ts`, test                   | Policy only; no host accounting/pressure delivery       |
| `KRN-001`       | implemented | C11 shared library via Bun FFI                              | ADR 0007, host header/C                         | —                                                       |
| `KRN-012`       | implemented | 16 threads, 1M messages, zero queued                        | `tests/stress_host.c`                           | —                                                       |
| `QA-001`        | implemented | 1M deterministic fuzz mutations per parser                  | `src/testing/fuzz.ts`, `scripts/fuzz-darwin.ts` | Outcome-guided, not edge coverage                       |
| `QA-003`        | implemented | 23 corpus cases, 15 commands, 5 pointer formats             | `src/testing/corpus.ts`, script                 | —                                                       |
| `QA-004`        | implemented | Seven benchmark cases with metadata and budgets             | `src/testing/benchmark.ts`, script              | —                                                       |
| `QA-006`        | implemented | Mach/loader/process soak counters flat                      | `src/testing/soak.ts`, script                   | 24h run is opt-in, not default CI                       |
| `OBS-001`       | implemented | Versioned JSON/NDJSON events with redaction                 | `src/observability/events.ts`, test             | —                                                       |
| `OBS-004`       | implemented | Chrome Trace Event JSON export                              | `src/observability/trace.ts`, test              | —                                                       |
| `DX-001`        | implemented | Integer/syscall disassembler, unknown → `.word`             | `src/arm64/disassemble.ts`, test                | No SIMD/FP                                              |
| `UI-000`        | partial     | Clean-room UIKit-compatible X11 blank window                | `packages/uikit-native`, `test:uikit`           | Not Apple UIKit                                         |
| `BLOCKED-UIKIT` | blocked     | Apple UIKit/Metal/CoreSimulator/SpringBoard runnable        | `limitations.md`, `roadmap.md`                  | Licensed runtime and multi-year work; no Apple binaries |

## What this ledger does not claim

The native track does not boot iOS, does not run Apple UIKit, and does not ship or link Apple
SDKs, runtimes, shared caches, or simulator services. `UI-000` is a clean-room object model and a
native X11 window; it does not satisfy the UI gate. The blocked row is part of the ledger on
purpose: a claim that silently disappears is harder to audit than one that says "blocked".
