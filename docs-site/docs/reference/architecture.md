---

title: Architecture
sidebar_position: 1
description: Components, data flows, deployment topologies, and trust boundaries.
---

# Architecture

## 1. Components

```mermaid
flowchart TB
  subgraph Client["Linux / macOS / Windows client"]
    CLI[ios-sim CLI]
    Web[Browser viewer]
    Lib[IosSimClient]
  end

  subgraph Host["macOS host"]
    HTTP[Fastify HTTP + WS]
    Auth[Token auth]
    Stream[Stream loop]
    Upload[App upload]
    Backend[HostBackend]
    Simctl[Simctl adapter]
    IDB[IdbInput adapter]
    WebUI[Embedded viewer HTML]
  end

  subgraph Apple["Apple software"]
    CS[CoreSimulator]
    RT[iOS runtime]
    GPU[Metal / IOSurface]
    IDBTool[idb / idb_companion]
  end

  CLI --> Lib
  Web --> Lib
  Lib -->|HTTP /v1| HTTP
  Lib -->|WS /v1/.../stream| HTTP
  HTTP --> Auth
  HTTP --> Stream
  HTTP --> Upload
  HTTP --> WebUI
  Stream --> Backend
  Upload --> Backend
  Backend --> Simctl
  Backend --> IDB
  Simctl --> CS
  IDB --> IDBTool
  CS --> RT
  CS --> GPU
```

| Component           | Responsibility                               | Must not know about                              |
| ------------------- | -------------------------------------------- | ------------------------------------------------ |
| `@ios-sim/protocol` | Schemas, typed client, URL construction      | macOS, `simctl`                                  |
| Host HTTP/WS        | Auth, routing, validation, streaming, errors | Simulator internals beyond the backend interface |
| `SimctlBackend`     | Lifecycle, capture, display, apps, logs      | HTTP                                             |
| `IdbInput`          | HID input                                    | HTTP, device lifecycle                           |
| CLI                 | UX, coordinate conversion, tar packaging     | Apple frameworks                                 |
| Viewer              | Rendering, pointer mapping                   | Apple frameworks                                 |

## 2. Request flow: screenshot

```mermaid
sequenceDiagram
  participant C as Client
  participant H as Host
  participant S as simctl
  C->>H: GET /v1/devices/:udid/screenshot?format=jpeg
  H->>H: auth + validate
  H->>S: xcrun simctl io <udid> screenshot --type=jpeg <tmp>
  S-->>H: JPEG file
  H->>H: read + delete temp dir
  H-->>C: image/jpeg
```

## 3. Request flow: app install

```mermaid
sequenceDiagram
  participant C as CLI
  participant H as Host
  participant T as tar
  participant S as simctl
  C->>C: tar.gz the .app directory
  C->>H: POST /v1/devices/:udid/apps (application/gzip)
  H->>H: body limit + auth
  H->>T: extract into temp dir
  H->>H: find *.app
  H->>S: simctl install <udid> <temp>/MyApp.app
  S-->>H: ok
  H->>H: rm -rf temp dir
  H-->>C: {"installed": "..."}
```

## 4. Input flow

```mermaid
sequenceDiagram
  participant V as Viewer/CLI
  participant H as Host
  participant S as simctl (display)
  participant I as idb
  V->>H: POST input {type:"tap", x:0.5, y:0.5}
  H->>S: getenv width/height/scale
  S-->>H: 1206, 2622, 3
  H->>H: normalized -> points (603, 1311)
  H->>I: idb ui tap 603 1311 --udid ...
  I-->>H: ok
  H-->>V: 204
```

Normalized coordinates are the wire contract. Points/pixels are a client concern.

## 5. Deployment topologies

### A. Loopback + SSH tunnel (recommended)

```mermaid
flowchart LR
  L[Linux] -->|localhost:7777| T[SSH tunnel] -->|127.0.0.1:7777| H[Mac host]
```

- Host binds `127.0.0.1`.
- No port exposed beyond SSH.
- Token still required (defence in depth).

### B. Private LAN with TLS

```mermaid
flowchart LR
  L[Linux] -->|https/wss| P[TLS proxy] -->|http/ws 127.0.0.1| H[Mac host]
```

- Proxy terminates TLS and forwards WebSocket upgrades.
- Firewall restricts clients.
- Token required.

### C. CI runner

```mermaid
flowchart LR
  J[CI job] -->|HTTP| H[Mac host or macOS runner]
  J -->|artifacts| A[(screenshots/logs)]
```

- The CLI is installed in the job image.
- The host is long-lived, or the job starts `ios-sim-host` on a macOS runner.
- Pin Xcode/runtime/bridge versions.

## 6. Ports and protocols

| Port | Protocol         | Purpose              | Default bind    |
| ---- | ---------------- | -------------------- | --------------- |
| 7777 | HTTP + WebSocket | API, viewer, stream  | `127.0.0.1`     |
| 7777 | SSE              | Logs                 | Same            |
| 22   | SSH              | Tunnel (recommended) | Host SSH config |
| 443  | HTTPS/WSS        | TLS proxy (optional) | Proxy           |

No database, message broker, or external service is required.

## 7. State

| State          | Location                               | Lifetime               |
| -------------- | -------------------------------------- | ---------------------- |
| Token          | `~/.config/ios-sim/token` (0600)       | Until rotated          |
| Client config  | `~/.config/ios-sim/client.json` (0600) | Persistent             |
| Uploaded app   | Host temp dir                          | Deleted after install  |
| Screenshot     | Host temp dir                          | Deleted after read     |
| Simulator data | CoreSimulator device directory         | Managed by Apple/Xcode |
| Stream frames  | Memory / client disk                   | Ephemeral              |

The host is stateless apart from the token file. Restarting it does not reset simulators.

## 8. Failure modes

| Failure             | Effect                            | Recovery                                |
| ------------------- | --------------------------------- | --------------------------------------- |
| `idb` missing       | Input 501; view/install/logs work | Install idb; restart host               |
| `idb` crashes       | Input 502                         | `idb kill`; retry; restart              |
| Simulator shut down | Capture/launch fail               | `ios-sim boot`                          |
| Runtime removed     | Device unavailable                | Reinstall runtime in Xcode              |
| Host restarts       | Clients reconnect                 | `ios-sim open` / retry                  |
| Network drops       | WS closes                         | Viewer reconnects; CLI retries manually |
| Token leak          | Unauthorized control              | Rotate token; audit logs                |
| Disk full           | Install/screenshot fail           | Free space; monitor                     |

## 9. Scaling

v0.1 is one process, one host, no shared capture loop. Each viewer opens its own polling loop.

Phase 2 introduces a per-device capture loop shared by subscribers. Phase 3 adds a real video
pipeline and device scheduling. Scaling beyond one host is a matter of routing clients to hosts
(e.g., a simple registry), not changing the client protocol.

## 10. Why the protocol is small

- No custom binary framing beyond WebSocket messages.
- JPEG is universally decodable; debugging is trivial.
- JSON errors and SSE logs work through proxies.
- Versioned `/v1`; additive changes only.
- The transport seam allows H.264/WebRTC later without breaking lifecycle/input APIs.

See [Protocol](./protocol.md) and [API](./api.md) for the exact contract.
