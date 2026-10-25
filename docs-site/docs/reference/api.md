---

title: API reference
sidebar_position: 2
description: HTTP and WebSocket endpoints, payloads, errors, and limits.
---

# API reference

Base URL: `http://<host>:7777`. All JSON is UTF-8. The current version is `/v1`.

## Authentication

Every `/v1` route except `GET /v1/health` requires the token:

```http
Authorization: Bearer <token>
```

WebSocket and SSE clients may pass `?token=<token>` because browsers cannot set headers on those
connections. The viewer page itself is public; its API calls are not.

```bash
curl -H "Authorization: Bearer $IOS_SIM_TOKEN" http://127.0.0.1:7777/v1/devices
```

Missing/invalid token:

```json
{ "error": { "code": "unauthorized", "message": "Missing or invalid access token." } }
```

## Errors

```json
{
  "error": {
    "code": "no_booted_device",
    "message": "No simulator is booted on the host."
  }
}
```

| Code                      | Status | Meaning                            |
| ------------------------- | -----: | ---------------------------------- |
| `unauthorized`            |    401 | Missing/wrong token                |
| `invalid_request`         |    400 | Schema validation failed           |
| `missing_udid`            |    400 | Route parameter missing            |
| `app_bundle_missing`      |    400 | Upload contains no `.app`          |
| `unsupported_media_type`  |    415 | Upload is not gzip                 |
| `device_not_found`        |    404 | Unknown UDID/name                  |
| `no_booted_device`        |    404 | `booted` selector with none booted |
| `multiple_booted_devices` |    409 | `booted` selector ambiguous        |
| `not_found`               |    404 | Unknown route                      |
| `input_unavailable`       |    501 | `idb` not installed/working        |
| `input_failed`            |    502 | `idb` command failed               |
| `simctl_failed`           |    502 | Apple tool failed                  |
| `internal_error`          |    500 | Unexpected failure                 |

Validation messages include the field path, e.g. `x: Too big: expected number to be <=1`.

## Endpoints

### `GET /v1/health`

Public. Reports host identity and capabilities.

```json
{
  "ok": true,
  "service": "ios-sim-host",
  "version": "0.1.0",
  "platform": "darwin",
  "backend": "simctl",
  "hostname": "mac-studio",
  "uptimeSeconds": 42,
  "capabilities": {
    "input": true,
    "install": true,
    "logs": true,
    "streaming": true
  }
}
```

`capabilities.input` is `false` when `idb` is unavailable. The client should treat input as
best-effort.

### `GET /v1/runtimes`

Returns an array of runtimes (not wrapped):

```json
[
  {
    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    "name": "iOS 26.4",
    "version": "26.4",
    "platform": "iOS",
    "isAvailable": true
  }
]
```

### `GET /v1/devices`

```json
{
  "devices": [
    {
      "udid": "7AD86EEA-A3F1-4103-B010-C8264B2AC6C6",
      "name": "iPhone 16 Pro",
      "runtime": "iOS 18.4",
      "runtimeIdentifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
      "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      "state": "Booted",
      "isAvailable": true
    }
  ]
}
```

`state` is passed through from `simctl` (`Booted`, `Shutdown`, `Booting`, `Shutting Down`, …).
Unknown values are preserved rather than rejected.

### `POST /v1/devices`

Create a device. `deviceTypeIdentifier` and `runtimeIdentifier` are optional; the host picks the
latest available iOS runtime and the first iPhone device type when omitted.

```json
{ "name": "CI iPhone", "runtimeIdentifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-4" }
```

Response: a single `Device` object.

### `POST /v1/devices/:udid/boot`

Boots and waits for `bootstatus`. Response: the updated `Device`.

### `POST /v1/devices/:udid/shutdown`

Shuts down. `204 No Content`.

### `POST /v1/devices/:udid/erase`

Shuts down (if needed) and erases. `204`.

### `DELETE /v1/devices/:udid`

Shuts down (if needed) and deletes the device. `204`.

### `GET /v1/devices/:udid/apps`

```json
{
  "apps": [
    {
      "bundleIdentifier": "com.example.hello-sim",
      "name": "Hello Sim",
      "path": "/Users/.../HelloSim.app",
      "version": "1.0",
      "build": "1"
    }
  ]
}
```

`path` is host-side and may be omitted for system apps.

### `POST /v1/devices/:udid/apps`

Upload and install a simulator `.app` directory as a gzip tarball.

```http
POST /v1/devices/<udid>/apps
Content-Type: application/gzip
Authorization: Bearer <token>

<gzip tar bytes>
```

The archive must contain the `.app` directory (at the root or within three levels). The host
extracts into a temp directory, finds the first `*.app`, calls `simctl install`, and deletes the
temp directory.

```json
{ "installed": "HelloSim.app" }
```

Limits: 512 MiB default body limit; no `.app` → 400; non-gzip → 415.

### `POST /v1/devices/:udid/launch`

```json
{
  "bundleId": "com.example.hello-sim",
  "args": ["-AppleLanguages", "(en)"],
  "environment": { "MY_FLAG": "1" },
  "console": false
}
```

`console` is accepted for forward compatibility but the host does not attach a console in v0.1
(use the logs endpoint). Environment variables are passed as `SIMCTL_CHILD_*`.

Response:

```json
{ "pid": 4242 }
```

### `POST /v1/devices/:udid/terminate`

```json
{ "bundleId": "com.example.hello-sim" }
```

`204`.

### `GET /v1/devices/:udid/display`

```json
{
  "widthPx": 1206,
  "heightPx": 2622,
  "scale": 3,
  "widthPoints": 402,
  "heightPoints": 874,
  "format": "jpeg"
}
```

`widthPoints`/`heightPoints` are derived from the runtime's `SIMULATOR_MAINSCREEN_*` values.
Use them to convert point coordinates to normalized input.

### `GET /v1/devices/:udid/screenshot`

Query: `format=jpeg|png` (default `jpeg`).

Response: `image/jpeg` or `image/png`, `Cache-Control: no-store`.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:7777/v1/devices/$UDID/screenshot?format=png" -o shot.png
```

### `POST /v1/devices/:udid/input`

All coordinates are normalized to the display: `(0,0)` top-left, `(1,1)` bottom-right. Values
outside `[0,1]` are rejected.

Tap:

```json
{ "type": "tap", "x": 0.5, "y": 0.5 }
```

Swipe:

```json
{
  "type": "swipe",
  "from": { "x": 0.5, "y": 0.8 },
  "to": { "x": 0.5, "y": 0.2 },
  "durationMs": 300
}
```

Text / key / button:

```json
{ "type": "text", "text": "hello" }
{ "type": "key", "key": "H" }
{ "type": "button", "button": "home" }
```

Buttons: `home`, `lock`, `side`, `siri`. Response: `204`. Requires `idb`; otherwise 501.

### `GET /v1/devices/:udid/logs`

Server-Sent Events. Query: `level` (e.g. `debug`, `info`, `error`) and `predicate` (NSPredicate).
Values are capped at 1000 characters.

```text
content-type: text/event-stream

data: {"timestamp":"...","eventMessage":"..."}

: ping
```

The stream is a `simctl spawn <udid> log stream --style ndjson` process. It closes when the client
disconnects or the device shuts down.

### `GET /v1/devices/:udid/stream` (WebSocket)

Query: `fps` (1–10, default 2), `format` (`jpeg`/`png`), `token` (required if auth is on).

On connect, the server sends a JSON text message:

```json
{
  "type": "config",
  "display": {
    "widthPx": 1206,
    "heightPx": 2622,
    "scale": 3,
    "widthPoints": 402,
    "heightPoints": 874
  },
  "fps": 4,
  "format": "jpeg"
}
```

Then binary frames (JPEG or PNG bytes). On capture failure:

```json
{ "type": "error", "message": "..." }
```

and the socket closes with 1011. Invalid token → close 1008. The server skips frames when the
socket buffer exceeds 4 MiB and never runs two captures concurrently per connection.

### `GET /`

The embedded browser viewer (HTML). Public; it prompts for a token if needed.

## Limits and defaults

| Item                     | Value          |
| ------------------------ | -------------- |
| Default port             | 7777           |
| Default bind             | 127.0.0.1      |
| Default stream FPS       | 2              |
| Max stream FPS           | 10             |
| Upload body limit        | 512 MiB        |
| Log query length         | 1000 chars     |
| Request timeout (client) | 30 s           |
| Capture backpressure     | 4 MiB buffered |

## Versioning

- `/v1` is stable within the 0.x series; fields may be added, not removed.
- A breaking change uses `/v2` with a deprecation window.
- Clients should ignore unknown fields and treat unknown enum values defensively.
- `GET /v1/health` is the capability handshake; do not infer capabilities from the version alone.
