# QEMU / macOS VM feasibility

This directory records the result of the "just run macOS in QEMU on Linux" idea. It is not a
supported deployment option for this project.

## What was evaluated

QEMU's `vmapple` machine model emulates the device model exposed by Apple's
Virtualization.framework. Per the [QEMU documentation](https://www.qemu.org/docs/master/system/arm/vmapple.html),
it requires:

- an Apple Silicon host;
- macOS 12.0 or above on the host;
- an already installed Virtualization.framework macOS **12** guest (newer guests are not
  supported by the documented guest-side path);
- Apple's `AVPBooter.vmapple2.bin`.

That is not a path to a current Xcode 27 / macOS 27 host on an ARM64 Linux machine. In addition,
Apple's macOS licence restricts virtualisation to Apple hardware, so even a technical workaround
would fail the project's legal gate.

## What would be needed

1. A hypervisor that supports current macOS guests on non-Apple ARM64 hardware.
2. GPU/display acceleration good enough for the simulator's Metal path.
3. A licence-compatible way to obtain and run macOS on that hardware.
4. A maintenance plan for macOS/Xcode upgrades.

None of these exists today. Do not treat old x86 macOS-on-QEMU projects as evidence; they target
a different architecture, a different macOS era, and a different licence posture.

## If you still want to experiment

Use a **licensed Apple Silicon Mac** and Apple's Virtualization.framework (or UTM) to run a macOS
VM. That is a supported Apple-on-Apple setup and is useful for isolating a build host, but it does
not move the simulator to Linux.

For a Linux host, use the remote bridge in this repository instead.
