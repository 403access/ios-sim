---

title: References
sidebar_position: 7
description: Primary sources, local evidence, and further reading.
---

# References

Accessed 25 October 2026 unless noted. Local paths refer to the test machine (macOS 27.0.1,
Xcode 27.1).

## Primary sources

| Topic                              | Source                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xcode 27 / simulator release notes | [Apple Developer — Xcode](https://developer.apple.com/xcode/)                                                                                             |
| Simulator user guide               | [Apple Developer — Simulator](https://developer.apple.com/documentation/xcode/simulator)                                                                  |
| `simctl` documentation             | `xcrun simctl help` on the host; [Apple Developer — simctl](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device) |
| Running apps in Simulator          | [Apple Developer](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device)                                           |
| ScreenCaptureKit                   | [Apple Developer](https://developer.apple.com/documentation/screencapturekit)                                                                             |
| Metal                              | [Apple Developer](https://developer.apple.com/documentation/metal)                                                                                        |
| IOSurface                          | [Apple Developer](https://developer.apple.com/documentation/iosurface)                                                                                    |
| macOS licence / virtualisation     | [Apple legal — macOS Sequoia licence](https://www.apple.com/legal/sla/docs/macOSSequoia.pdf) (check the version that applies to your host)                |
| Xcode licence                      | [Apple Developer terms](https://developer.apple.com/support/terms/)                                                                                       |

## QEMU and virtualisation

| Topic                          | Source                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| VMApple machine model          | [QEMU documentation — VMApple](https://www.qemu.org/docs/master/system/arm/vmapple.html) |
| QEMU Arm system emulation      | [QEMU documentation](https://www.qemu.org/docs/master/system/target-arm.html)            |
| Apple Virtualization.framework | [Apple Developer](https://developer.apple.com/documentation/virtualization)              |
| Asahi Linux                    | [asahilinux.org](https://asahilinux.org/)                                                |

The QEMU page is the source for the "Apple Silicon host / macOS 12 guest" prerequisite quoted in
[Architecture options](./architecture-options.md#option-b-macos-vm-on-arm64-linux).

## Darwin-on-Linux and iOS tooling

| Topic                               | Source                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Darling                             | [github.com/darlinghq/darling](https://github.com/darlinghq/darling)                                   |
| Darling documentation               | [docs.darlinghq.org](https://docs.darlinghq.org/)                                                      |
| idb                                 | [github.com/facebook/idb](https://github.com/facebook/idb)                                             |
| idb documentation                   | [fbidb.io](https://fbidb.io/)                                                                          |
| FBSimulatorControl / HID transports | [fbidb.io/idb/fbsimulatorcontrol](https://fbidb.io/idb/fbsimulatorcontrol)                             |
| Appium                              | [appium.io](https://appium.io/)                                                                        |
| WebDriverAgent                      | [github.com/appium/WebDriverAgent](https://github.com/appium/WebDriverAgent)                           |
| libimobiledevice                    | [libimobiledevice.org](https://libimobiledevice.org/)                                                  |
| ios-simulator-embed (VS Code)       | [github.com/mkloouo/vscode-ios-simulator-embed](https://github.com/mkloouo/vscode-ios-simulator-embed) |

## Commercial context

| Topic                          | Source                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Corellium platform             | [corellium.com/platform](https://www.corellium.com/platform)                                    |
| Microsoft Remote iOS Simulator | [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/ios/remote-simulator)           |
| MacStadium                     | [macstadium.com](https://www.macstadium.com/)                                                   |
| AWS EC2 Mac                    | [AWS documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html) |

## Tools used in this project

| Tool       | Source                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| REA        | [github.com/morluto/rea](https://github.com/morluto/rea) · [rea.tools](https://rea.tools/) |
| OrbStack   | [orbstack.dev](https://orbstack.dev/)                                                      |
| Docusaurus | [docusaurus.io](https://docusaurus.io/)                                                    |
| Fastify    | [fastify.dev](https://fastify.dev/)                                                        |
| Zod        | [zod.dev](https://zod.dev/)                                                                |
| Node.js    | [nodejs.org](https://nodejs.org/)                                                          |

## Local evidence

Artifacts inspected with REA:

```text
/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit
  SHA-256 3d2a3c65504c261ef6c8e48aca28ca47b35e9c6e313a0bd88e856ff4e5dd19a9
  arm64e, 35 dependencies, 767 imports, 2072 exports

/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator
  SHA-256 6062b655fb1c1d6ac3d219693aca473428e9ba1dc759ff36587682521d54840f
  arm64e, 34 dependencies

.../iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/sbin/launchd_sim
  SHA-256 5f493ea8ab7f8ba8bdf11eb5cc4397506abfbaa95999b849a4ae827c71629847
  arm64, Mach-O executable, Mach/XPC/posix_spawn imports
```

Runtime commands:

```bash
xcrun simctl list -j runtimes
xcrun simctl io booted enumerate
xcrun simctl getenv booted SIMULATOR_MAINSCREEN_SCALE
ps ax -o pid,ppid,comm | grep -E 'launchd_sim|SimulatorTrampoline|SpringBoard'
```

Measurement script: `scripts/measure-macos.sh`.

## Notes on evidence quality

- Apple's public documentation describes supported behaviour, not private SPI. Where this
  project relies on private behaviour (`idb` HID), it is labelled and isolated.
- REA's Mach-O inspection combines `dyld_info` and `nm`; stripped symbols may be absent. Counts
  are therefore lower bounds for imports/exports, not proof of the full symbol set. The dependency
  list (load commands) is structural and reliable.
- Vendor pages are used for market context, not as proof of technical feasibility.
- Prices and product capabilities change; re-check before a build-vs-buy decision.
