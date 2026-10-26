---
title: Compatibility ABI
sidebar_position: 3
description: The exact machine, syscall, Mach, XPC, and launchd contract a program can rely on today.
---

# Compatibility ABI

This page is the contract between the compatibility layer and a program. It is intentionally
narrow. Anything not listed is unsupported and should fail with a named error rather than
"sort of" working.

## Machine model

- AArch64 user mode, little-endian. Integer registers, scalar floating point (`s`/`d`), and a
  128-bit vector register file used for `movi`/`mov`/`ldp`/`stp` aggregate traffic.
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

`x30` is zero at entry. A `ret` that targets zero halts the process and uses `x0 & 0xff` as the
exit status, mirroring `exit(main(...))` for compiler-produced entry points. Programs may also
call `exit` explicitly.

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

### Legacy `LC_DYLD_INFO`

Classic rebase, bind, weak-bind, and lazy-bind opcode streams are implemented. Bindings are
applied eagerly: lazy symbol pointers are resolved at load, so `dyld_stub_binder` is bound to
zero and never called. Rebase pointers that fall inside the image's preferred range receive the
slide; other values are left untouched.

The arm64 threaded-bind opcode (`0xD0`) is rejected with
`legacy_threaded_binds_unimplemented`; link with chained fixups for those images. Unknown opcodes
and truncated streams fail with `bad_legacy_bind`/`bad_legacy_rebase`.

## Objective-C 2 subset

The runtime reads Apple-ABI metadata and implements message send. It does not run a real
`libobjc` and does not provide Foundation.

### Metadata

| Structure          | Fields used                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `__objc_classlist` | 8-byte class pointers, any segment                                                          |
| `class_t`          | `isa`, `superclass`, `data` (low flag bits masked)                                          |
| `class_ro_t`       | `flags`, `instanceStart`, `instanceSize`, `name`, `baseMethods`                             |
| method list        | absolute (`entsize` 24) or relative (`entsize` with bit 31 set)                             |
| `method_t`         | name, types, IMP; relative offsets are from each field                                      |
| selector           | direct C string; a relative name offset points at a selref slot, which is dereferenced once |

Classes are realised eagerly when their image loads. `+initialize`, categories, `+load`,
protocols, associated objects, exceptions, and weak references are not implemented. A duplicate
class name is a `duplicate_class` error.

### Message send

`objc_msgSend` and `objc_msgSendSuper2` are bound to generated trampolines:

```text
movz x16, #0x90NN
svc  #0x80
ret
```

The trap resolves the selector against the class hierarchy. A host IMP (framework method) is
called in TypeScript and returns through the trampoline. A guest IMP is entered by setting `pc`
and leaving `x0..x7`, `v0..v7`, `sp`, and `x30` untouched, so it is a true tail call and the
callee returns directly to the original caller. `objc_msgSendSuper2` reads the receiver and the class
containing the method from the `objc_super` struct (the `objc_msgSendSuper2` convention), starts
lookup at that class's superclass, and rewrites `x0` to the receiver before the IMP runs. The
fixtures use a guest `BaseView` superclass to keep this path on every touch.

Recognised runtime entry points: `objc_retain`, `objc_release`, `objc_autorelease`,
`objc_autoreleasePoolPush/Pop`, `objc_storeStrong`, `objc_storeWeak`, `objc_loadWeakRetained`,
`objc_retainAutoreleasedReturnValue`, `objc_autoreleaseReturnValue`, `objc_opt_self`,
`objc_opt_class`, `objc_opt_isKindOfClass`, `objc_alloc`, `sel_registerName`, `objc_getClass`,
`objc_setAssociatedObject`, `objc_getAssociatedObject`, `objc_removeAssociatedObjects`,
`objc_storeWeak`, `objc_loadWeakRetained`, `objc_loadWeak`, `objc_destroyWeak`,
`objc_sync_enter/exit`. Retain/release update a host-side refcount (objects start at 1; convenience
constructors return autoreleased objects), and autorelease pools are real stacks drained on pop.
When a direct `-release`/`objc_release` reaches zero and the class overrides `-dealloc`, a generated
stub calls it and returns to the release caller. Bookkeeping releases (pool drain, storeStrong,
associated values) mark the object dead without running guest code, and guest memory is never
reclaimed. An autoreleased object with no pool is leaked, matching the runtime's warning. Counts are exposed
as `objcStats` in the process result and CLI JSON: allocations, retains, releases,
autoreleases, pool pushes/pops, deallocs, associations, weak stores/loads/zeroings, and
message dispatch totals split into host and guest IMPs.

### Shim classes

These are original metadata with host IMP trampolines, not Apple classes:

| Class              | Methods (instance unless marked +)                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NSObject`         | `-init`, `-dealloc`, `-class`, `-self`, `-isKindOfClass:`, `-respondsToSelector:`, `-retain`, `-release`, `-autorelease`, `-retainCount`, `+alloc`, `+new`    |
| `UIView`           | `-init`, `-initWithFrame:`, `-setFrame:`, `-frame`, `-setBackgroundColor:`, `-backgroundColor`, `-addSubview:`, `-setHidden:`, `-isHidden`, `-layoutSubviews` |
| `UIWindow`         | `-initWithFrame:`, `-makeKeyAndVisible`, `-setRootViewController:`, `-rootViewController`                                                                     |
| `UIViewController` | `-init`, `-view`, `-setView:`, `-loadView`                                                                                                                    |
| `UIColor`          | `+redColor`, `+whiteColor`, `+blackColor`, `+clearColor`, `+colorWithRed:green:blue:alpha:`                                                                   |
| `UIApplication`    | `+sharedApplication`, `-setDelegate:`, `-delegate`                                                                                                            |

`UILabel` stores a C string (not `NSString`), a colour object at offset 72, a scale at offset 80,
and alignment at offset 88 (0 left, 1 centre, 2 right); its instance size is 96. The renderer draws text with a built-in 3×5 uppercase/digit bitmap
font at the label's frame. This is a proof of text reaching the framebuffer, not CoreText.
`UIButton` stores one target/action pair; only touch-up dispatch is performed. Action methods receive
the button as the sender. `UIView` ivars are fixed by this shim: frame doubles at 8/16/24/32, background object at 40,
hidden byte at 48, alpha double at 56, instance size 64. Frames are **parent-relative**: painting
and hit-testing accumulate origins down the tree, so a child inside a container lands at
`container.origin + child.origin`. `clipsToBounds` intersects a view's clip with its frame for
child painting and hit-testing; it is off by default. The renderer multiplies a view's alpha by its parent's and
composites in order. `UIColor` stores four doubles at 8/16/24/32. Application
classes get an `isa` and their declared `instanceSize`; the shim does not lay out arbitrary ivars.

### UIApplicationMain

`int UIApplicationMain(int argc, char **argv, id principal, const char *delegateClassName)`.
The fourth argument is a C string, a documented deviation from Apple's `NSString *`. The host:

1. allocates the `UIApplication` and delegate instances;
2. generates a guest stub that sends `application:didFinishLaunchingWithOptions:` and, when the
   delegate implements them, `applicationDidBecomeActive:` and `applicationWillTerminate:`,
   through `objc_msgSend`;
3. then runs a bounded event loop: `nextEvent` (host trap) returns a record of
   `{receiver, touches, event, selector}` or zero; the stub sends that selector to the receiver
   and renders after each callback. Touch records target the hit view; tick records target the
   application delegate (`tick:`);
4. jumps to the stub with `x0 = delegate`, `x1 = selector`, `x2 = application`, `x3 = 0`.

The loop is driven by the CLI's scripted `--tap x,y`, `--drag x1,y1,x2,y2[,steps]`, and
`--tick N` events, not by a display server. Each touch step is hit-tested against the view tree
(topmost child whose frame contains the point) and delivered to the deepest hit view. A tap
expands to began+ended; a drag to began, interpolated moved samples, and ended; a tick is a
`tick:` message to the delegate. The stub owns the ABI: every callback is a normal
`blr` through `objc_msgSend`, so `+initialize`, categories, and overrides apply. When the events
are exhausted, the stub returns zero to `main`.

### Frames

The presenter composites visible `UIView` instances (window children, in insertion order) into an
RGBA8 framebuffer at 375×667. Colours are normalised doubles multiplied by 255 and rounded once.
Identical frames are de-duplicated; at most eight frames are retained. The CLI encodes the last
frame as PNG (filter 0, zlib level 9) or PPM (P6). The digest is SHA-256 over the RGBA bytes.

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
`symbol_not_found`, `legacy_threaded_binds_unimplemented`, `bad_legacy_bind`, `instruction_limit`, `deadline`,
`xpc_truncated`, `plist_duplicate_key`. The CLI prints the code; tests assert on it.
