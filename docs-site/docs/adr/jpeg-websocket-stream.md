---
title: "ADR 0004: JPEG frames over WebSocket"
sidebar_position: 4
description: Why v0.1 streams full JPEG frames instead of MJPEG, H.264, or WebRTC.
---

# ADR 0004: JPEG frames over WebSocket

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Engineering

## Context

The viewer needs pixels from a simulator that may be headless. Options:

1. **JPEG screenshots polled at N fps**, sent over WebSocket.
2. **MJPEG** (`multipart/x-mixed-replace`) over HTTP.
3. **H.264/HEVC** via `simctl io recordVideo` or ScreenCaptureKit.
4. **WebRTC** with a custom capture source.
5. **VNC** to the macOS desktop.

Measured on the test host: ~0.36 s per JPEG screenshot, ~370–430 KB per frame at 1206 × 2622.
That caps polling at ~2.7 fps.

## Decision

For v0.1, capture JPEG screenshots on the host at a configurable FPS (default 2, max 10) and send
each frame as a binary WebSocket message. Send a JSON `config` message first with display
metadata and stream settings. Use PNG only for lossless one-off screenshots.

## Consequences

### Positive

- Works headlessly with `simctl`; no Simulator window or ScreenCaptureKit permission.
- Frames are independently decodable; trivial browser/CLI clients.
- Easy to debug (save a frame, open it).
- No codec/signalling/NAT complexity.
- Backpressure and single-flight capture are simple.

### Negative

- Low frame rate (~2–4 fps); not suitable for video/60 fps.
- Full frames use bandwidth (~0.8 MB/s at 2 fps).
- CPU cost of spawning `simctl` per frame.
- No delta compression or audio.

### Neutral

- H.264/WebRTC can be added as a new endpoint or message type without changing lifecycle/input.
- `recordVideo` is not a low-latency streaming API; it writes a file.

## Alternatives

| Option              | Why not v0.1                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| MJPEG               | Similar quality, but WS gives one connection and explicit config/backpressure; no proxy buffering surprises |
| `recordVideo` H.264 | File-oriented; parsing/fragmentation and latency unclear; needs a codec pipeline                            |
| ScreenCaptureKit    | Requires a GUI window/permissions and macOS-specific code; future                                           |
| WebRTC              | Best latency, but signalling, NAT, codecs, and test complexity are premature                                |
| VNC                 | Whole desktop, poor isolation, no app-level API                                                             |

## Follow-ups

- Phase 3 spike: compare `recordVideo`, ScreenCaptureKit, and WebRTC on glass-to-glass latency.
- Add a shared per-device capture loop before increasing FPS.
- Keep the `format`/`fps` query and `config` message stable for clients.
