---

title: Prior art
sidebar_position: 4
description: Projects that solve adjacent problems, what we reuse, and what we deliberately do not.
---

# Prior art

No part of this problem is untouched. The useful question is which pieces can be reused without
inheriting a project's constraints.

## 1. Comparison

| Project                                                                                                          | What it does                                                                                                                                             | Relevance                                                    | Reuse?                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [Darling](https://github.com/darlinghq/darling)                                                                  | Darwin/macOS user-space layer on Linux: Mach-O loader, `darlingserver`, Mach IPC/POSIX/Darwin syscalls, partial Foundation/AppKit, early Metal-on-Vulkan | Closest thing to a native host; proves the shape of the work | **Research reference.** Not a dependency; GPL-3.0, and it does not host current iOS runtimes |
| [QEMU `vmapple`](https://www.qemu.org/docs/master/system/arm/vmapple.html)                                       | Emulates Apple's Virtualization.framework device model                                                                                                   | Explores the macOS-VM path                                   | **No.** Requires Apple Silicon host, macOS host, macOS 12 guest                              |
| [Corellium](https://www.corellium.com/)                                                                          | ARM-native iOS virtualisation with CHARM hypervisor                                                                                                      | Shows what full iOS virtualisation costs and requires        | **No.** Proprietary, different product, expensive                                            |
| [idb / FBSimulatorControl](https://github.com/facebook/idb)                                                      | CLI and companion for simulator/device automation, including HID input, video, accessibility                                                             | The practical input path on macOS                            | **Yes, as an optional adapter.** Private SPI, MIT                                            |
| Apple `simctl`                                                                                                   | Public command-line control of CoreSimulator                                                                                                             | Lifecycle, screenshots, install/launch, logs                 | **Yes, primary backend**                                                                     |
| [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)                                   | Low-level screen/window capture on macOS                                                                                                                 | Future low-latency video path                                | **Possible future**, macOS-only                                                              |
| [VS Code iOS Simulator Embed](https://github.com/mkloouo/vscode-ios-simulator-embed)                             | Streams Simulator window via ScreenCaptureKit and sends Indigo HID touches                                                                               | Validates the "stream + inject" pattern                      | **Pattern only**, macOS-only, private SPI                                                    |
| [Microsoft Remote iOS Simulator for Windows](https://learn.microsoft.com/en-us/dotnet/maui/ios/remote-simulator) | Visual Studio on Windows controls a simulator on a paired Mac                                                                                            | Commercial precedent for a remote bridge                     | **Pattern only**                                                                             |
| [Appium](https://appium.io/) / WebDriverAgent                                                                    | Cross-platform UI automation                                                                                                                             | Future test-automation integration                           | **Possible**, not a transport                                                                |
| [libimobiledevice](https://libimobiledevice.org/)                                                                | Talks to physical iOS devices over usbmux                                                                                                                | Device farms, not simulators                                 | **No** for this problem                                                                      |
| [WebRTC](https://webrtc.org/)                                                                                    | Low-latency media transport                                                                                                                              | Future 30–60 fps streaming                                   | **Planned evaluation**                                                                       |
| [OrbStack](https://orbstack.dev/)                                                                                | Linux containers/VMs on macOS                                                                                                                            | Runs the Linux client in tests                               | **Yes, test infrastructure**                                                                 |

## 2. What each project teaches

### Darling

Darling's architecture is the right mental model for a native port:

- A Mach-O loader loads Apple binaries.
- A userspace server implements Mach IPC and Darwin syscalls.
- Framework reimplementations sit on top.
- Prefixes isolate installations.

It also demonstrates the limits: reimplementing enough of AppKit and the Objective-C runtime is
already hard; reimplementing the simulator's private frameworks, Metal, IOSurface, and current
UIKit is a different scale. Darling's own README notes that GUI support is in active development,
with an initial Metal backend on Vulkan. That is promising research, not a current simulator host.

### QEMU `vmapple`

QEMU's device model is a technical achievement, but the documented prerequisites are explicit:
Apple Silicon host, macOS 12+ host, an already-installed Virtualization.framework macOS 12 guest.
It is not a route to Xcode 27 on an ARM64 Linux server. It is included here because "use QEMU"
is the most common suggested shortcut; the documentation is the antidote.

### Corellium

Corellium is sometimes described as "iOS on Linux". It is more accurate to say it is a managed
ARM-native virtualisation platform with its own hypervisor and virtual device models. It runs iOS,
not the iOS Simulator, and it is aimed at security research with root access. It is a valid buy
option for some teams, but it is neither open source nor a drop-in simulator replacement.

### idb / FBSimulatorControl

`idb` is the most important reusable piece. It provides:

- HID touch, swipe, keyboard, and hardware buttons.
- Accessibility queries and UI descriptions.
- App install/launch and process management.
- Video and screenshot paths.

The Xcode 27 transition matters: `FBSimulatorControl` added a pluggable `SimulatorHID` transport
because Xcode 27 changed the event path (Indigo button/keyboard events were dropped; touch became
unreliable) and introduced `dtuhidd` XPC. `idb` is actively tracking that change. This is exactly
why the bridge isolates input behind an adapter and makes it optional.

### ScreenCaptureKit / vscode extension

The VS Code extension demonstrates the same product shape as this repository: a live JPEG stream
plus host-side HID injection. It is macOS-only and explicitly warns that touch uses undocumented
Apple frameworks and may break. We reuse the pattern, not the code, and we do not claim the
private API is stable.

### Microsoft's remote simulator

Visual Studio's remote simulator is a useful existence proof: a non-macOS IDE can drive a
simulator on a paired Mac. It is proprietary and Windows-only, and it does not expose a general
Linux protocol. It confirms the architecture is commercially acceptable.

## 3. What we deliberately did not reuse

| Candidate                                | Reason                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Indigo HID reimplementation              | High maintenance, private wire format, breaks across Xcode versions; `idb` already handles it |
| `simctl` private frameworks directly     | Unstable ABI; public `simctl` covers lifecycle/capture/install                                |
| VNC to the macOS desktop                 | Whole-desktop exposure, poor isolation, no app-level API                                      |
| WebRTC in v0.1                           | Adds signalling, codecs, and NAT complexity before the product need is proven                 |
| Native port via Darling                  | Wrong scope for the execution plan; kept as a research track                                  |
| Docker-OSX / macOS on non-Apple hardware | Licence and support problems; not a foundation for a product                                  |

## 4. Lessons applied

1. **Separate control from pixels.** `simctl` is a good control plane; it is not a video codec.
2. **Make private dependencies optional.** The bridge works view-only without `idb`.
3. **Use normalized coordinates.** Display scale is a real source of bugs.
4. **Test the client in Linux, not just on the Mac.** A Node script that imports macOS modules is
   not a Linux client.
5. **Write down the legal gate.** Technical feasibility does not imply permission to operate.
6. **Keep a transport seam.** JPEG today; H.264/WebRTC tomorrow without changing the API shape.
