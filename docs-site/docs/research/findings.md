---
title: Findings
sidebar_position: 2
description: Evidence-based findings on the simulator's architecture, dependencies, Linux porting surface, and measured behaviour.
---

# Findings

These findings are based on the machine described in the [analysis plan](./analysis-plan.md),
not on a generic Xcode installation. Commands and versions are recorded so the results can be
reproduced and re-checked when Xcode changes.

## 1. Summary

1. The iOS Simulator is **not an emulator and not a virtual machine**. It is a set of arm64
   macOS processes: CoreSimulator services, `SimulatorTrampoline`, `launchd_sim`, SpringBoard,
   and the app under test. They execute on the host Darwin kernel and use Mach IPC.
2. Its dependency surface is **Darwin-specific at every layer**: Mach ports and XPC for control,
   launchd for process management, `dyld_sim` and a shared cache for loading, Metal and IOSurface
   for rendering, IOKit/CGEvent for input, and Apple's private frameworks for everything else.
3. **Linux has no compatible implementation** of that core. Darling reproduces a useful subset of
   macOS user space, but not current iOS runtimes, Metal, or the CoreSimulator service stack.
4. A macOS VM on ARM64 Linux is **not a supported path**: QEMU's `vmapple` model documents an
   Apple Silicon host and a macOS 12 guest, and Apple's licence restricts macOS virtualisation
   to Apple hardware. This is both a technical and a licensing gate.
5. A **remote Mac bridge is viable today** and is the chosen architecture. `simctl` provides
   lifecycle, capture, install, launch and logs; `idb` provides HID input. Measured capture is
   ~0.36 s per JPEG (~370–430 KB), and a warm tap is ~0.22 s, which supports a 2 fps viewer and
   interactive control.
6. The bridge does not need private code in the Linux client. The client speaks a small HTTP/
   WebSocket protocol; all Apple-specific behaviour stays on the Mac behind an adapter.

## 2. What the simulator actually is

### 2.1 Process evidence

A booted simulator appears as ordinary host processes, not a VM:

```text
PID    PPID   COMMAND
53996  1      .../CoreSimulator.framework/.../com.apple.CoreSimulator.CoreSimulatorService
54049  1      .../XPCServices/SimLaunchHost.arm64.xpc/Contents/MacOS/SimLaunchHost.arm64
54050  1      .../XPCServices/SimulatorTrampoline.xpc/Contents/MacOS/SimulatorTrampoline
62734  1      launchd_sim
62738  62734  .../iOS 18.4.simruntime/.../SpringBoard.app/SpringBoard
62740  62734  .../iOS 18.4.simruntime/.../assistantd
```

`launchd_sim` is a child of the host's `launchd` (PID 1), not a guest kernel. Its children are
loaded from the runtime root inside the `.simruntime` bundle. The simulator is therefore a
**host-process compatibility environment**, closer to a chroot plus a private loader and IPC
namespace than to QEMU.

The runtime bundle layout confirms this:

```text
.../iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/
├── sbin/launchd_sim
├── usr/lib/dyld_sim
├── System/Library/CoreServices/SpringBoard.app/...
└── System/Library/Frameworks/...
```

### 2.2 Host services

`ps` also shows the host-side services that make the simulated device work:

| Process                           | Role                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `CoreSimulatorService`            | Device lifecycle, runtime registration, XPC control plane |
| `SimLaunchHost.arm64`             | Launches simulator processes with host-side setup         |
| `SimulatorTrampoline`             | Bridges the simulator UI/runtime to the host              |
| `SimStreamProcessorService`       | Stream/framebuffer processing                             |
| `SimRenderServer`, `SimMetalHost` | Rendering, including Metal                                |
| `SimAudioProcessorService`        | Audio                                                     |
| `simdiskimaged`                   | Disk image management                                     |

The presence of `SimMetalHost` is decisive for the porting question: the framebuffer path is
tied to the host GPU and Metal. A Linux port would need a Metal-compatible rendering stack, not
just a framebuffer copy.

### 2.3 `simctl` is a control client, not the simulator

`xcrun simctl` talks to CoreSimulator over XPC. It does not contain the runtime. This is why
`simctl` works headlessly without `Simulator.app` open, and why a remote client can use it as the
host-side control surface.

## 3. The dependency surface

REA was used to inspect three representative Mach-O images. The raw evidence IDs are retained in
the REA session; the facts below are reproducible with the commands in
[§8](#8-reproducing-the-evidence).

### 3.1 `SimulatorKit.framework`

- Path: `/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit`
- Architecture: `arm64e` (thin), 64-bit little-endian, Mach-O executable, 52 load commands.
- SHA-256: `3d2a3c65504c261ef6c8e48aca28ca47b35e9c6e313a0bd88e856ff4e5dd19a9`.
- Linked dependencies: 35. Notable entries:

| Dependency                                   | Why it blocks a naive port                 |
| -------------------------------------------- | ------------------------------------------ |
| `QuartzCore.framework`                       | Core Animation, layer tree, display link   |
| `AppKit.framework`                           | Host UI toolkit                            |
| `Metal.framework`                            | GPU command submission and rendering       |
| `IOSurface.framework`                        | Cross-process GPU-backed buffers           |
| `IOKit.framework`                            | HID event plumbing (`IOHIDEvent*`)         |
| `CoreSimulator.framework`                    | Device lifecycle and private simulator API |
| `CoreGraphics.framework`                     | Drawing, bitmap contexts, event conversion |
| `AccessibilityPlatformTranslation.framework` | Accessibility bridge                       |
| `libswiftXPC.dylib`                          | Swift XPC bindings                         |
| `libswiftMetal.dylib`                        | Swift Metal bindings                       |

- Imported symbols include `CGEventCopyIOHIDEvent`, `IOHIDEventSystemClientCreateWithType`,
  `CFMachPortCreateRunLoopSource`, `CGBitmapContext*`, and Metal/QuartzCore entry points. These
  are not portable shims; they are the host event and rendering model.

### 3.2 `CoreSimulator.framework`

- Path: `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator`
- Architecture: `arm64e`, Mach-O executable, 50 load commands.
- SHA-256: `6062b655fb1c1d6ac3d219693aca473428e9ba1dc759ff36587682521d54840f`.
- Linked dependencies: 34, including:

| Dependency                    | Implication                                  |
| ----------------------------- | -------------------------------------------- |
| `CoreSimDeviceIO.framework`   | Device I/O abstraction (display, HID, audio) |
| `ROCKit.framework`            | Remote-object / IPC support                  |
| `SimPasteboardPlus.framework` | Simulated pasteboard                         |
| `ServiceManagement.framework` | launchd service registration                 |
| `MobileGestalt.framework`     | Device identity/gestalt                      |
| `libRosetta.dylib`            | Rosetta-related support                      |
| `libswiftXPC.dylib`           | XPC                                          |
| `AppKit.framework`            | Host UI integration                          |
| `DeviceIdentity.framework`    | Device identity                              |
| `DiskArbitration.framework`   | Disk images                                  |

CoreSimulator is not a standalone service that could be dropped onto Linux. It is a macOS
framework that assumes launchd, XPC, AppKit, disk arbitration and Apple identity services.

### 3.3 `launchd_sim`

- Path inside the iOS 26.4 runtime:
  `.../RuntimeRoot/sbin/launchd_sim`
- Architecture: `arm64`, Mach-O executable, 25 load commands, entry point present.
- SHA-256: `5f493ea8ab7f8ba8bdf11eb5cc4397506abfbaa95999b849a4ae827c71629847`.
- Imports include:
  - `_mach_msg`, `_mach_port_construct`, `_mach_port_insert_right`, `_mach_port_mod_refs`,
    `_mach_ports_register`, `_mach_task_self_`
  - `_xpc_*` and `__xpc_*` symbols, including Mach-send rights in XPC dictionaries
  - `_posix_spawnattr_setarchpref_np`, `_posix_spawnattr_setprocesstype_np`,
    `_posix_spawnattr_set_darwin_role_np`
  - `__dyld_get_shared_cache_uuid`, `__dyld_get_image_uuid`

`launchd_sim` is the init process of the simulated environment. It expects Mach port rights,
XPC, Darwin-specific spawn attributes and Apple's shared-cache loader. Linux cannot satisfy those
interfaces without a compatibility kernel.

### 3.4 Runtime metadata

```text
$ xcrun simctl list -j runtimes
iOS 18.4  (22E238)  supportedArchitectures: x86_64, arm64
iOS 18.5  (22F77)
iOS 26.4  (23E244, 23E254a)
```

The presence of `x86_64` in an older runtime is a reminder that the simulator is an architecture-
specific user-space runtime, not a device firmware image. The host architecture still determines
what can execute natively; Apple Silicon Macs run the arm64 slice.

## 4. What Linux would have to provide

A native port is not one missing library. It is a stack of missing contracts.

| Layer                     | Darwin requirement                               | Linux equivalent                    | Gap                                         |
| ------------------------- | ------------------------------------------------ | ----------------------------------- | ------------------------------------------- |
| IPC                       | Mach ports, task ports, bootstrap namespace, MIG | Unix sockets, pidfd, D-Bus          | No Mach semantics; XPC is built on Mach     |
| Service management        | launchd, bootstrap registration, XPC services    | systemd, D-Bus                      | No compatible bootstrap/port namespace      |
| Loader                    | `dyld`, `dyld_sim`, shared cache, chained fixups | `ld.so`, ELF                        | Different binary format and loader ABI      |
| Objective-C/Swift runtime | Apple `objc4`, Swift runtime, Foundation         | libobjc2/GNUstep, swift-corelibs    | Partial and ABI-incompatible                |
| Graphics                  | Metal, IOSurface, QuartzCore/CoreAnimation       | Vulkan/OpenGL, DMA-BUF, compositors | No Metal; IOSurface semantics missing       |
| Window/UI                 | AppKit, UIKit (simulator build), Accessibility   | X11/Wayland, AT-SPI                 | Different toolkit and accessibility model   |
| Input                     | IOKit HID, CGEvent, Indigo/DTUHID                | evdev, libinput, uinput             | Different event model and private protocols |
| Security                  | codesign, entitlements, TCC, keychain            | none built-in                       | Trust and privacy model must be recreated   |
| Storage                   | APFS, disk images, `simdiskimaged`               | ext4/btrfs, loop devices            | Disk image and snapshot semantics differ    |
| Device identity           | MobileGestalt, DeviceIdentity                    | none                                | Device identity services are Apple-specific |

Even if each row had a partial substitute, the simulator's private frameworks call the Apple
APIs directly. A compatibility layer would need to implement enough of each API that SpringBoard
and UIKit boot, render, and accept input — not just enough to link a CLI tool.

### 4.1 Why Darling is not a shortcut

Darling is the most mature Darwin-on-Linux layer. Its own documentation describes a Mach-O
loader, a userspace kernel server implementing Mach IPC/POSIX/Darwin syscalls, and
reimplementations of Foundation and AppKit. That is the right architecture for running macOS
CLI tools. It is not a drop-in iOS Simulator host:

- The simulator needs CoreSimulator's XPC services, `launchd_sim`, and a current iOS runtime,
  not a macOS prefix.
- It needs Metal/IOSurface and QuartzCore, which are GPU and window-system services.
- It needs Apple's private frameworks and their exact SPI, which are neither open source nor
  stable.
- Current iOS runtimes are arm64 and tightly coupled to Apple's loader and security model.

Darling is therefore useful prior art and a possible long-term host for a research spike, but it
is not a path to a working current simulator in this project's timeframe.

## 5. Runtime experiments

### 5.1 Lifecycle and headless operation

`simctl` can boot, list, install, launch, terminate, screenshot and stream logs without
`Simulator.app`. This is essential for a remote host: the Mac does not need a logged-in GUI
session for the basic workflow, although `idb` and some UI features may behave differently
without the Simulator window. In this environment the simulator was already booted and all
tested commands worked headlessly.

### 5.2 Display and capture

```text
$ xcrun simctl io booted enumerate
Screen ID: 1
Name: LCD
Pixel Size: {1206, 2622}
Preferred UI Scale: 3
Pixel Format: 'BGRA'

$ xcrun simctl getenv booted SIMULATOR_MAINSCREEN_SCALE
3.000000
```

Screen geometry is available from the runtime, so the bridge can expose both pixel and point
coordinates. This avoids the classic "tap lands in the wrong place on a 3× display" bug.

### 5.3 Video

`simctl io recordVideo` exists and supports H.264/HEVC, but it writes a QuickTime file and is
designed for recording, not low-latency streaming. The reference implementation uses periodic
JPEG screenshots and documents H.264/WebRTC as future work. See
[ADR 0004](../adr/jpeg-websocket-stream.md).

### 5.4 Input

`simctl` has no public touch API. Input is available through:

- `idb` (Meta's iOS Development Bridge), which uses private HID/DTUHID paths and handles Xcode
  changes.
- Apple's XCUITest, which requires a test bundle and is not suitable for arbitrary remote control.
- Private `SimulatorKit`/Indigo APIs, which would be a maintenance liability.

`idb` is the pragmatic choice, and it is optional: the viewer degrades to view-only when `idb` is
not installed.

## 6. Measured behaviour

Measurements on the test machine, local loopback, iPhone 16 Pro simulator (1206 × 2622):

| Operation                 | Sample      | Result                                                  |
| ------------------------- | ----------- | ------------------------------------------------------- |
| JPEG screenshot           | 10 runs     | 0.36 s median (0.71 s first run), ~370–430 KB per frame |
| `idb ui tap`              | 5 warm runs | ~0.22 s each (0.54 s first run)                         |
| Effective polling capture | derived     | ~2.7 fps maximum, ~0.8 MB/s at 2 fps                    |
| Display                   | runtime     | 1206 × 2622 px, 3× scale, 402 × 874 points              |

Implications:

- JPEG polling is perfectly adequate for a developer viewer and for inspection.
- A 2 fps default leaves headroom and avoids saturating the host with `simctl` processes
  (~0.8 MB/s at that rate).
- For 30–60 fps interaction or video playback, the transport should move to a persistent H.264
  stream (recordVideo, ScreenCaptureKit, or a WebRTC pipeline), which is a later milestone.
- Input at ~0.22 s is noticeable but workable for taps/typing; it is not suitable for twitch
  gameplay.

These numbers are environment-specific. Re-run `scripts/measure-macos.sh` on the target host and
record the result in the deployment notes.

## 7. Consequences for the design

| Finding                               | Design consequence                                                |
| ------------------------------------- | ----------------------------------------------------------------- |
| Simulator is Darwin-only              | Host daemon must run on macOS; Linux client must be protocol-only |
| Control plane is XPC/`simctl`         | Hide `simctl` behind a typed backend adapter                      |
| Rendering/input are private           | Treat `simctl`/`idb` as unstable adapters and contract-test them  |
| Screenshots are fast enough for 2 fps | Use JPEG over WebSocket for v0.1; keep a transport seam           |
| Input needs `idb`                     | Make input capability explicit; return 501 when unavailable       |
| Display scale matters                 | Expose display metadata; use normalized coordinates on the wire   |
| Apps can be large                     | Stream gzip tarballs with a configurable body limit               |
| Host is valuable/trusted              | Token auth, loopback default, SSH tunnel guidance                 |

## 8. Reproducing the evidence

```bash
# 1. Show the process model
ps ax -o pid,ppid,comm | grep -E 'launchd_sim|SimulatorTrampoline|CoreSimulator|SpringBoard'

# 2. Inspect the runtime layout
find /Library/Developer/CoreSimulator/Volumes -name launchd_sim | head
xcrun simctl list -j runtimes

# 3. Inspect Mach-O dependencies and imports with REA
bunx rea-agents@latest inspect-macho \
  /Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit --format json
bunx rea-agents@latest inspect-macho \
  /Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator --format json
bunx rea-agents@latest inspect-macho \
  "/Library/Developer/CoreSimulator/Volumes/iOS_23E254a/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/sbin/launchd_sim" --format json

# 4. Measure capture and input
scripts/measure-macos.sh
```

See [REA setup](../guides/rea.md) for the exact setup used here and the limitations of static
inspection.

## 9. Open questions

These do not change the v0.1 decision, but they matter for later versions:

- How stable is `idb`'s DTUHID path across Xcode 27.x minor releases?
- Can `ScreenCaptureKit` or `recordVideo` provide a low-latency H.264 stream without a visible
  Simulator window?
- What is the minimum macOS/launchd surface a Darling-style layer would need for a _minimal_
  UIKit app, and is that a useful research milestone even if full SpringBoard is out of reach?
- How do multiple concurrent clients affect CoreSimulator stability and capture latency?
- Which Apple licence terms apply to a company-hosted Mac accessible by Linux developers? This
  needs legal review, not engineering guesswork.
