---
title: Native host ABI
sidebar_position: 7
description: The C11/Bun FFI contract for the native kernel boundary, version 1.
---

# Native host ABI

`packages/darwin-host` implements the native kernel boundary. It is a C11 shared library loaded
by Bun through `bun:ffi`; there is no second process or wire protocol. The TypeScript binding is
`packages/darwin-host/src/ffi.ts`.

The ABI version is `DH_ABI_VERSION = 1`. The binding checks it at load time and refuses a
mismatch. This is a research ABI, not Mach's trap ABI.

## Build and test

```bash
bun run build:kernel        # C library + C tests (macOS/Linux)
bun run test:kernel         # C tests + Bun FFI smoke
bun run test:kernel:linux   # same inside a Linux container
```

Artifacts:

- `packages/darwin-host/build/libdarwin_host.dylib` (macOS)
- `packages/darwin-host/build/libdarwin_host.so` (Linux)
- `packages/darwin-host/build/test_darwin_host`

## Object model

| Object  | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| Task    | A guest process identity with a name table. Task IDs are host-local. |
| Name    | A task-local handle to a port plus a rights bitmask.                 |
| Port    | A queue plus an optional receive owner and label.                    |
| Message | A word body, message id, sender task, and optional reply port.       |
| Service | A bootstrap name mapped to a port id.                                |

Special seeded names per task: `1` is the task port (receive + send), `2` is the bootstrap port
(send). A reply port is a single name with receive + send rights.

Rights: `DH_RIGHT_SEND = 1`, `DH_RIGHT_RECEIVE = 2`, `DH_RIGHT_SEND_ONCE = 4`.

## Functions

| Function                                             | Purpose                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `dh_abi_version()`                                   | Return `1`.                                                       |
| `dh_kernel_reset()`                                  | Destroy all tasks/ports/messages/services and recreate bootstrap. |
| `dh_task_create(pid, &task)`                         | Create a task and seed names 1/2.                                 |
| `dh_task_destroy(task)`                              | Tear down names, owned ports, queued messages, services.          |
| `dh_task_interrupt(task)`                            | Wake a blocked receiver with `DH_ERR_INTERRUPTED`.                |
| `dh_port_create_receive(task, label, &name)`         | Create a receive right.                                           |
| `dh_reply_port(task, &name)`                         | Create a receive+send name.                                       |
| `dh_name_port_id(task, name, &port)`                 | Resolve a name to its port for a send right.                      |
| `dh_port_make_send(task, port, &name)`               | Add a send right.                                                 |
| `dh_name_deallocate(task, name)`                     | Drop a right; destroys a receive-owned port when last.            |
| `dh_service_register(task, service, name)`           | Register a receive name under a bootstrap service.                |
| `dh_service_lookup(task, service, &name)`            | Insert a send right for a service.                                |
| `dh_send(task, remote, local, id, words, count)`     | Queue a message; `local` is an optional reply name.               |
| `dh_receive(..., timeout_ms)`                        | Blocking receive with capacity/id/remote/reply outputs.           |
| `dh_kernel_stats(&tasks, &ports, &messages)`         | Counts for diagnostics.                                           |
| `dh_selftest_blocking()` / `dh_selftest_interrupt()` | Native thread/blocking self-tests.                                |

## Limits

| Limit          | Value                         |
| -------------- | ----------------------------- |
| Message body   | 1024 `uint32_t` words (4 KiB) |
| Queue depth    | 256 messages                  |
| Tasks          | 256                           |
| Ports          | 1024                          |
| Names per task | 256                           |
| Services       | 256                           |
| Label          | 63 characters + NUL           |
| Service name   | 255 characters + NUL          |

Limits are part of ABI v1. Exceeding one returns a stable status rather than growing without
bound.

## Status codes

| Code | Name                       | Meaning                                      |
| ---: | -------------------------- | -------------------------------------------- |
|    0 | `DH_OK`                    | success                                      |
|    1 | `DH_ERR_INVALID_ARGUMENT`  | null/bad length                              |
|    2 | `DH_ERR_INVALID_TASK`      | task does not exist                          |
|    3 | `DH_ERR_INVALID_NAME`      | name does not exist                          |
|    4 | `DH_ERR_INVALID_RIGHT`     | right does not permit the operation          |
|    5 | `DH_ERR_QUEUE_FULL`        | queue depth reached                          |
|    6 | `DH_ERR_MESSAGE_TOO_LARGE` | receive capacity too small; message retained |
|    7 | `DH_ERR_TIMEOUT`           | timeout expired                              |
|    8 | `DH_ERR_INTERRUPTED`       | task interrupt woke the receiver             |
|    9 | `DH_ERR_NO_SPACE`          | task/port/name/queue allocation failed       |
|   10 | `DH_ERR_DUPLICATE_SERVICE` | service name already registered              |
|   11 | `DH_ERR_NOT_FOUND`         | service not found                            |
|   12 | `DH_ERR_STATE`             | internal/version/platform state              |

## Blocking semantics

- `timeout_ms = 0` is non-blocking.
- `timeout_ms = UINT32_MAX` waits until a message, interrupt, or teardown.
- Any other value is a relative timeout.
- A send broadcasts the kernel condition variable; blocked receivers re-check their queue.
- A task destroy or reset wakes receivers; destroyed tasks return `DH_ERR_INVALID_TASK`.
- A too-small receive does **not** consume the message; retry with a larger capacity.

## Bun FFI example

```ts
import { NativeHost, DHStatus } from "@ios-sim/darwin-host";

const host = new NativeHost();
const task = host.createTask(42);
const receive = host.createReceivePort(task, "demo");
const reply = host.replyPort(task);
const send = host.makeSend(task, host.namePortId(task, receive));

host.sendOrThrow(task, send, reply, 7, Uint32Array.from([0xfeed]));
const message = host.receive(task, receive, 16, 1000);
if (message.status !== DHStatus.OK) throw new Error(`receive ${message.status}`);
console.log(message.body); // Uint32Array [ 65006 ]
host.destroyTask(task);
host.close();
```

The module is Bun-only because of `bun:ffi`; constants/types can be imported without loading the
library.

## Thread lifecycle

`THR-001` adds thread objects and thread ports to the native boundary. They are lifecycle
primitives: create, inspect, terminate, and join. Guest instruction execution and the scheduler
are **not** in the C host yet; THR-002/003 wire the guest CPU to these objects. A thread object
therefore proves the kernel-side identity/port/teardown contract, not real guest concurrency.

## Not implemented in v1

- port sets/notifications (KRN-006)
- port/memory descriptors in messages (KRN-007)
- Apple MIG wire compatibility (KRN-008)
- memory objects/shared memory (KRN-009)
- Mach trap-number parity (KRN-010)
- quotas beyond fixed limits (KRN-011)
- stress/soak automation (KRN-012)
- moving blocking calls off the Bun event loop (THR-003)
- scheduler, threads, signals, spawn/exec (THR)

See [ADR 0007](../adr/native-kernel-boundary.md) for the boundary decision and consequences.
