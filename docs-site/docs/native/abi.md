---
title: Compatibility ABI
sidebar_position: 3
description: The exact machine, syscall, Mach, XPC, and launchd contract a program can rely on today.
---

# Compatibility ABI

This page is the contract between the compatibility layer and a program. It is intentionally
narrow. Anything not listed is unsupported and should fail with a named error rather than
"sort of" working.

The native kernel boundary has its own C11/Bun-FFI ABI: see [Native host ABI](./host-abi.md).

## Machine model

- AArch64 user mode, little-endian, integer registers only.
- 64-bit virtual addresses; 16 KiB pages; a 512 MiB per-process mapping budget by default.
- No threads. A process is one CPU and one Mach task.
- The host CPU never runs guest code; all instructions are interpreted.
- Instruction budget: 20,000,000 by default. Deadline: 15,000 ms by default.

### Entry ABI

After loading `LC_MAIN` (or an arm64 `LC_UNIXTHREAD`), the runtime starts with:

| Register | Value                                                  |
| -------- | ------------------------------------------------------ |
| `pc`     | image entry point                                      |
| `sp`     | 16-byte aligned initial stack                          |
| `x0`     | `argc`                                                 |
| `x1`     | pointer to `argv[0]`                                   |
| `x2`     | pointer to `envp[0]`                                   |
| `x3`     | 0                                                      |
| `x16`    | 0; a program loads a syscall number before `svc #0x80` |

The initial stack contains NUL-terminated strings, then `argc`, `argv` pointers, a null
terminator, `envp` pointers, and a null terminator. A real dyld would call a libSystem `start`
routine; this layer documents its own entry contract instead of pretending libSystem exists.

## Syscalls

`svc #0x80` with the number in `x16`. BSD calls take arguments in `x0..x5`. On success the result
is in `x0`; on error the layer returns a positive errno in `x0` and sets the carry flag, matching
Darwin's ABI. Mach traps return a `kern_return_t` in `x0` without touching carry.

| Number | Name           | Status | Notes                                            |
| -----: | -------------- | ------ | ------------------------------------------------ |
|      1 | `exit`         | ✓      | halts; status is `x0 & 0xff`                     |
|      3 | `read`         | ✓      | stdin is an in-memory buffer; files use the jail |
|      4 | `write`        | ✓      | fds 1/2 go to sinks; files use the jail          |
|      5 | `open`         | ✓      | Darwin flags; relative paths resolve under root  |
|      6 | `close`        | ✓      | fds ≤ 2 cannot be closed                         |
|     10 | `unlink`       | ✓      |                                                  |
|     20 | `getpid`       | ✓      |                                                  |
|     24 | `getuid`       | ✓      | fixed 501                                        |
|     25 | `geteuid`      | ✓      | fixed 501                                        |
|     33 | `access`       | ✓      | read access only                                 |
|     39 | `getppid`      | ✓      | fixed 1                                          |
|     41 | `dup`          | ✓      | shares the descriptor entry                      |
|     43 | `getegid`      | ✓      | fixed 20                                         |
|     47 | `getgid`       | ✓      | fixed 20                                         |
|     73 | `munmap`       | ✓      | page-rounded                                     |
|     74 | `mprotect`     | ✓      | recorded but not enforced                        |
|     90 | `dup2`         | ✓      |                                                  |
|     92 | `fcntl`        | ✓      | returns 0; options are not interpreted           |
|    116 | `gettimeofday` | ✓      | two 64-bit fields                                |
|    136 | `mkdir`        | ✓      |                                                  |
|    189 | `fstat`        | ✗      | `ENOSYS`                                         |
|    197 | `mmap`         | ✓      | anonymous and file-backed; `MAP_FIXED` with hint |
|    199 | `lseek`        | ✓      | per-descriptor position                          |
|    202 | `sysctl`       | ✗      | `ENOSYS`                                         |
|    327 | `issetugid`    | ✓      | returns 0                                        |
|    500 | `getentropy`   | ✓      | up to 256 bytes                                  |

Everything else is `ENOSYS` in lenient mode and a hard `unsupported_syscall` error in strict
mode.

### Mach traps

| `x16` | Name                      | Notes                                    |
| ----: | ------------------------- | ---------------------------------------- |
|   -26 | `mach_reply_port`         | receive+send port, name returned in `x0` |
|   -27 | `thread_self_trap`        | task port name (one thread per task)     |
|   -28 | `task_self_trap`          | name 1                                   |
|   -29 | `host_self_trap`          | send right to the host port              |
|   -31 | `mach_msg_trap`           | send and/or receive                      |
|   -32 | `mach_msg_overwrite_trap` | alias of -31                             |

`mach_msg_trap` options: `MACH_SEND_MSG` (1), `MACH_RCV_MSG` (2). Send reads `send_size` bytes
from `x0`; receive copies up to `rcv_size` bytes into `x0` from receive right `x4`. No blocking:
an empty queue returns `KERN_RECEIVE_TIMED_OUT`.

## Mach messages

Header, 24 bytes, little-endian:

```text
u32 msgh_bits
u32 msgh_size          // includes the header
u32 msgh_remote_port   // destination name in the sender
u32 msgh_local_port    // reply-port name in the sender
u32 msgh_voucher_port
i32 msgh_id
```

Special names: `0` null, `1` task self, `2` bootstrap. A reply port is a single name carrying
receive and send rights. On receive, the kernel inserts a send right to the sender's reply port
into the receiver and returns its name in `msgh_local_port`.

`kern_return_t` values are stable in this layer (they mirror Apple's naming, not its complete
table): `0` success, `0x10000004` invalid argument, `0x10000011` invalid destination,
`0x10000012` invalid right, `0x1000000d` resource shortage, `0x10004002` receive timeout,
`0x10004003` message too large.

## Chained fixups

Supported load command: `LC_DYLD_CHAINED_FIXUPS` with header version 0, imports formats 1, 2, 3
(`DYLD_CHAINED_IMPORT`, `_ADDEND`, `_ADDEND64`), uncompressed symbol pool, and pointer formats
`PTR_64` (2), `PTR_64_OFFSET` (6), `ARM64E` (1), `ARM64E_USERLAND` (9), `ARM64E_USERLAND24` (12).

The loader applies each operation to the mapped image at `slide + segment offset`. Multi-start
chains and unsupported pointer formats are hard errors.

Legacy `LC_DYLD_INFO`/`LC_DYLD_INFO_ONLY` rebase and bind opcode streams are decoded by
`src/macho/legacy-fixups.ts` and applied at load time (LDR-001). The decoder validates stream
bounds, ULEB/SLEB encoding, segment references, and symbol names. Rebase opcodes mark locations;
the existing pointer is slid only when it points inside the image. Bind opcodes resolve through
their dependency ordinal exactly like chained binds.

Lazy-bind streams are decoded into `LoadedProgram.lazyBindings`; the loader does not write them
until `bindLazy(address)` is called, which returns `true` once and `false` on repeat calls
(no double-patch). This is the first-call semantic without generating executable lazy-stub
trampolines yet. Weak-bind streams resolve in the flat namespace; a missing weak symbol writes
null. General weak-definition coalescing and real stub trampolines remain future work. dyld3
threaded binds fail with `legacy_threaded_bind_unimplemented`.

Module initializers come from `__DATA,__mod_init_func` (and the legacy
`LC_ROUTINES_64` init address); terminators come from `__DATA,__mod_term_func`. The loader reads
the pointer arrays after fixups, deduplicates addresses, runs initializers dependency-first
(reverse load order), then `main`, then terminators main-first. The runtime attributes an
instruction-limit or deadline failure to `stage: "initializer" | "terminator"`.

`DynamicLoader` (`src/dyld/dlopen.ts`) adds `open`/`symbol`/`close` handles over one
`ImageLoader`. Opening the same image twice increments a reference count; closing the last handle
unmaps its segments and evicts it from the image cache. Dependencies are retained and released
with the parent. Main-program images are pinned and never unloaded. This is the semantic layer
only: guest `dlopen`/`dlsym` syscalls, `RTLD_GLOBAL`, constructors on open, and interposition are
not wired yet.

Two-level binds use the dependency ordinal, so `_collide` from dependency A and B stays distinct;
flat (`-2`/`-3`) lookup walks the image graph in load order and the first match wins.
`__DATA,__interpose` pairs replace a resolved target with the replacement for all subsequent
binds, and `dynamicLoader.symbol` applies the same table. Registration order is exposed as
`LoadedProgram.interpositions`; later pairs for the same target do not override earlier ones.

Embedded signatures (`LC_CODE_SIGNATURE`) are parsed by `src/macho/code-signature.ts` (LDR-010):
superblob index, CodeDirectory (identifier, team id, flags, hash type/size, page size, code limit,
slot counts, optional executable segment), XML entitlements, requirements, DER entitlements, and
the signature wrapper presence. **Nothing is verified**: hashes, certificates, CMS, and
entitlement policy are deliberately out of scope until a later security task.

`ImageLoader.diagnose(path)` returns `{ ok, program, diagnostic, stats }` instead of throwing.
Diagnostics name the code, stage, path, unresolved dependency or symbol, and one concrete next
action; `formatLoaderDiagnostic` renders it for the CLI. `ios-sim-native run` prints the same
report on a loader failure.

`parseBundle` (`src/macho/bundle.ts`) reads an in-memory app bundle: `Info.plist`
(identifier/executable/version), the executable's UUID and `LC_FILESET_ENTRY` records, and an
optional `Contents/Resources/DWARF/<exe>` dSYM with `N_OSO` debug-map objects. UUID mismatches and
missing plists are reported as warnings. DWARF line tables, code-signature validation, and
execution are not part of this pass.

## MIG-lite

`MigWriter`/`MigReader` are 4-byte aligned and bounded:

| Type   | Encoding                                 |
| ------ | ---------------------------------------- |
| `u32`  | 4 bytes little-endian                    |
| `u64`  | 8 bytes little-endian                    |
| string | `u32` byte length, UTF-8, 4-byte padding |
| bytes  | `u32` byte length, data, 4-byte padding  |

A reply body starts with a `u32` status (`0` success), followed by routine-specific bytes.
Message id is `subsystem + routine`. This is explicitly **not** Apple's generated MIG layout.

### Bootstrap subset

Subsystem `0x44410000` on port name `2`:

| Routine | Request                                      | Reply                               |
| ------: | -------------------------------------------- | ----------------------------------- |
|       0 | string service name                          | `u32 status`, `u32 send-right name` |
|       1 | string service name, `u32` receive port name | `u32 status`                        |
|       2 | none                                         | `u32 status`, `u32 count`, names    |

`lookup` inserts a send right into the caller and returns its task-local name. `register`
requires the caller to own the supplied port name with receive rights. This capability flow is
covered by unit tests and is used by `Launchd` to expose `MachServices`.

## XPC-style encoding

Envelope header (20 bytes):

```text
u32 magic 0x58454e31 ("XEN1")
u16 version (1)
u16 flags (0)
u32 request id
u8  kind (0 request, 1 reply, 2 event)
u8  reserved
u16 reserved
u32 payload length
payload (XPC value)
```

Value encoding is a type byte followed by a fixed or length-prefixed body; see
`packages/darwin-compat/src/xpc/codec.ts`. It is bounded and versioned, but **not**
byte-compatible with Apple XPC.

## launchd manifest subset

Accepted keys:

| Key                    | Type              | Behaviour                                 |
| ---------------------- | ----------------- | ----------------------------------------- |
| `Label`                | string            | required, unique, service-name syntax     |
| `Program`              | string            | executable path, or first argument        |
| `ProgramArguments`     | string array      | full argv; first entry may be the program |
| `EnvironmentVariables` | string dictionary | passed to the child                       |
| `RunAtLoad`            | boolean           | run during `boot()`                       |
| `KeepAlive`            | boolean           | retry failed runs up to the budget        |
| `MachServices`         | dictionary        | names registered on the launchd host task |
| `ThrottleInterval`     | number            | recorded; no sleep in this prototype      |
| `WorkingDirectory`     | string            | recorded; not applied to the host process |
| `StandardOutPath`      | string            | recorded; output is captured in memory    |
| `StandardErrorPath`    | string            | recorded; output is captured in memory    |

Unknown keys are ignored. Sockets, on-demand launch, sessions, and environment expansion beyond
plain `KEY=VALUE` are not implemented.

## Error codes

Errors are `CompatError` subclasses with a stable `code`. Examples: `memory_fault`,
`unsupported_instruction`, `unsupported_syscall`, `path_escape`, `dependency_not_found`,
`symbol_not_found`, `legacy_fixups_*`, `legacy_threaded_bind_unimplemented`, `instruction_limit`, `deadline`,
`xpc_truncated`, `plist_duplicate_key`. The CLI prints the code; tests assert on it.
