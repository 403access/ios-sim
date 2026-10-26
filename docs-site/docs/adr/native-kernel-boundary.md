---
title: "ADR 0007: Native kernel boundary via C11 and Bun FFI"
sidebar_position: 7
description: Why the native track uses a C11 shared library loaded through Bun FFI instead of a second protocol or a Node addon.
---

# ADR 0007: Native kernel boundary via C11 and Bun FFI

- **Status:** Accepted for the native research track
- **Date:** 2026-10-26
- **Deciders:** Engineering
- **Related:** ADR 0006, [Native host ABI](../native/host-abi.md)

## Context

The A0 substrate implements Mach semantics in TypeScript. That was useful for deterministic
tests, but it cannot provide:

- blocking receive that wakes another thread;
- real concurrent senders and receivers;
- timeouts with kernel-grade condition variables;
- a native boundary that can grow into memory objects and a scheduler.

KRN-001 asked for a boundary choice. The candidates were:

1. A C11 shared library loaded through Bun FFI.
2. A Rust `cdylib` loaded through Bun FFI.
3. A Node-API addon.
4. A separate native host process with a wire protocol.

The product runs on Bun. The project already builds with `cc` for the native UIKit spike, and the
repository has no Node/npm toolchain. A second protocol would add framing, lifecycle, and
debugging failure modes before the semantics are proven.

## Decision

Use a **C11 shared library** (`libdarwin_host`) loaded through **Bun FFI** (`bun:ffi`) for the
native kernel boundary.

The ABI is narrow and versioned (`DH_ABI_VERSION = 1`):

- tasks, names, and port rights;
- bounded message queues and word bodies;
- blocking receive with timeout/interruption;
- reply ports and bootstrap service lookup;
- stats and self-tests.

There is no second protocol. A `dh_send` or `dh_receive` call goes directly from Bun into C. The
library has no Bun or Node dependency and can be tested with a plain C harness.

## Evidence

The spike is implemented in `packages/darwin-host`:

- C unit tests: task/port rights, send/receive, timeout, message-too-large, services, blocking,
  interruption, teardown.
- Bun FFI smoke: ABI version, rights, send/receive, reply routing, timeout, service lookup,
  queue-full, blocking, interruption.
- Linux container: `bun run test:kernel:linux` passes both C and Bun FFI tests.
- Local macOS: `bun run test:kernel` passes both.

`dh_selftest_blocking` creates a native thread that sends after a delay while the caller blocks
in `dh_receive`; `dh_selftest_interrupt` wakes a blocked receiver with `dh_task_interrupt`. These
are not busy-wait loops.

## Consequences

### Positive

- Real blocking/concurrency exists without inventing a second protocol.
- The boundary is testable with a plain C harness and with Bun.
- No Node-API build dependency; `cc` and pthreads are enough.
- The ABI is small enough to audit and version.
- TypeScript remains the high-level runtime/oracle; native is only the kernel boundary.

### Negative

- A synchronous FFI call blocks the Bun event loop. A production host must move blocking calls
  to worker threads or a dedicated host thread. This ADR accepts that for the spike; THR-003 and
  the runtime integration must solve it before use in the interactive host.
- C memory safety is now in the trust boundary. The ABI must validate every length/name and the
  parser/codec tests do not cover C. Add sanitizer/fuzz runs before untrusted use.
- ABI/version drift is possible. The binding checks the version at load; changes require a
  version bump and vectors.
- Bun FFI is Bun-specific. The library itself is portable; a future Node-API adapter is possible
  if Bun ceases to be the host.

### Neutral

- The C library is not a Mach kernel and does not implement Apple's trap ABI yet.
- The TypeScript Mach model remains in `packages/darwin-compat` as a test oracle until the native
  path is wired into the runtime.

## Rejected alternatives

| Alternative           | Why not now                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust cdylib           | Stronger safety, but adds a second toolchain and slower iteration before semantics are proven. Revisit if C memory bugs dominate.                               |
| Node-API addon        | Works across Node/Bun, but adds node-gyp/header/toolchain friction and is not needed for a Bun-first product.                                                   |
| Separate host process | Cross-runtime and isolating, but adds a second protocol, lifecycle, and copy overhead before blocking semantics are proven. Revisit for multi-tenant isolation. |
| Keep TS-only Mach     | Cannot provide real blocking, wakeups, or thread safety. Fine as an oracle, not as the platform boundary.                                                       |

## Follow-ups

1. Wire `NativeHost` into the runtime behind the existing Mach API; keep the TS model as oracle.
2. Move blocking calls off the Bun event loop (worker/host thread) as part of THR-003.
3. Add sanitizer/fuzz builds for the C host.
4. Implement port sets/notifications (KRN-006), descriptors (KRN-007), MIG vectors (KRN-008),
   memory objects (KRN-009), traps (KRN-010), quotas (KRN-011), and stress (KRN-012).
5. Bump `DH_ABI_VERSION` for any layout/semantic change and add a mismatch test.
