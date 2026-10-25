---

title: "ADR 0003: simctl for lifecycle, idb for input"
sidebar_position: 3
description: Why the host uses Apple's public CLI and an optional private-SPI tool.
---

# ADR 0003: `simctl` for lifecycle, `idb` for input

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Engineering

## Context

The host needs to:

- List/boot/shutdown/erase/delete devices.
- Capture screenshots and display metadata.
- Install/launch/terminate apps.
- Stream logs.
- Inject touch, text, keys, and hardware buttons.

Apple exposes `simctl` for most lifecycle and capture operations, but **no public touch API**.
Options for input:

1. XCUITest bundle — requires a test target and app-specific setup.
2. Private `SimulatorKit`/Indigo HID — undocumented, version-sensitive.
3. `idb` — a maintained CLI that implements HID/DTUHID and accessibility.
4. Host UI automation (CGEvent/AppleScript) — requires a visible Simulator window, fragile.

## Decision

Use `simctl` as the primary backend for lifecycle, capture, apps, and logs. Use `idb` as an
**optional input adapter**. If `idb` is unavailable or fails, report `input: false` in health and
return `501 input_unavailable` for input, while keeping the rest of the bridge functional.

## Consequences

### Positive

- Lifecycle/capture/apps/logs rely on a documented Apple CLI.
- Input works headlessly and across Xcode versions where `idb` is maintained.
- The Linux client has no Apple dependency.
- Failure is graceful and explicit.

### Negative

- `idb` uses private SPI and can break on Xcode updates.
- `idb` requires `idb_companion` (Homebrew) and `fb-idb` (Python/pipx), which is extra setup.
- Input is not available in environments where `idb` cannot run (e.g., restrictive CI images).

### Neutral

- The adapter interface allows a future native HID implementation or an XCUITest backend.
- Input tests skip when `idb` is missing rather than failing the suite.

## Alternatives

| Option              | Why not                                                    |
| ------------------- | ---------------------------------------------------------- |
| XCUITest only       | Requires a test bundle per app; not general remote control |
| Direct Indigo HID   | More control, more maintenance; duplicates idb             |
| CGEvent/AppleScript | Needs a GUI session and window; brittle                    |
| No input            | Unacceptable for a usable simulator                        |

## Follow-ups

- Contract-test input against each Xcode release.
- Watch `idb`/FBSimulatorControl for DTUHID changes (Xcode 27+).
- Document the exact `idb` versions in the host runbook.
- Consider a fallback adapter if `idb` becomes unmaintained.
