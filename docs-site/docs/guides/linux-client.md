---
title: Linux client
sidebar_position: 3
description: Install and use the CLI and browser viewer on a Linux workstation or container.
---

# Linux client

The client is a TypeScript CLI plus a browser viewer. It has no Apple dependencies and never
loads macOS binaries. It talks to the host over HTTP and WebSocket.

## 1. Prerequisites

| Component | Requirement                                                |
| --------- | ---------------------------------------------------------- |
| OS        | Any modern Linux (x86_64 or arm64)                         |
| Bun       | 1.4.4+                                                     |
| Network   | Reachability to the host, preferably through an SSH tunnel |
| Browser   | Any Chromium/Firefox/Safari for the viewer                 |

Install Bun:

```bash
curl -fsSL https://bun.com/install | bash
bun --version
```

## 2. Install the CLI

The packages are currently workspace-private. Clone and build:

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
bun install --frozen-lockfile
bun run build

# Put `ios-sim` on PATH for this user
cd apps/cli
bun link
cd ../..
ios-sim --version
```

Without linking, use `bun apps/cli/dist/bin.js` in place of `ios-sim` in every command.

When the packages are published, this becomes `bun add -g @ios-sim/cli` (planned; see the
[roadmap](../plans/roadmap.md)).

## 3. Connect

```bash
# Direct LAN
ios-sim connect http://mac-host.local:7777 --token '<token>'

# Or loopback through an SSH tunnel
ssh -N -L 7777:127.0.0.1:7777 you@mac-host &
ios-sim connect http://127.0.0.1:7777 --token '<token>'

ios-sim doctor
```

`connect` verifies `/v1/health`, then writes `~/.config/ios-sim/client.json` with the URL and
token (mode `0600`). You can also use environment variables, which override the file:

```bash
export IOS_SIM_URL=http://127.0.0.1:7777
export IOS_SIM_TOKEN='<token>'
export IOS_SIM_DEVICE=booted
```

Precedence: command flags → environment → `client.json` → host token file → default URL.

## 4. Common commands

```bash
ios-sim devices                     # list simulators
ios-sim boot "iPhone 16 Pro"        # boot and wait
ios-sim screenshot shot.jpg         # capture JPEG
ios-sim screenshot shot.png --format png
ios-sim open                        # browser viewer
ios-sim tap 200 400                 # points
ios-sim text "hello"
ios-sim button home
ios-sim swipe 200 700 200 200
ios-sim logs --level info
ios-sim install ./MyApp.app
ios-sim launch com.example.MyApp
ios-sim apps
ios-sim stream --out /tmp/frames --fps 2 --duration 10
```

Use `--device` on any device-scoped command, or set `IOS_SIM_DEVICE`:

```bash
ios-sim screenshot --device "iPhone 16 Pro" shot.jpg
ios-sim --json devices | jq '.devices[] | {name, state, udid}'
```

## 5. Coordinates

By default, `tap`/`swipe` take **device points** (the units iOS uses, e.g. 402 × 874 for an
iPhone 16 Pro). The client fetches display metadata and converts to the normalized coordinates
the protocol uses.

```bash
ios-sim tap 600 1200 --unit pixel       # screenshot pixels
ios-sim tap 0.5 0.5 --unit normalized   # 0..1
```

This avoids the 3× scale mismatch that plagues naive screenshot-based tools.

## 6. SSH tunnel recipe

Add this to `~/.ssh/config`:

```sshconfig
Host ios-sim-host
  HostName mac-host.local
  User you
  LocalForward 7777 127.0.0.1:7777
  ServerAliveInterval 30
```

Then:

```bash
ssh -N ios-sim-host &
ios-sim connect http://127.0.0.1:7777 --token "$(cat ~/.config/ios-sim/token.remote)"
```

Keep the token out of your shell history:

```bash
read -rs IOS_SIM_TOKEN && export IOS_SIM_TOKEN
```

## 7. Docker / OrbStack

Build the client image (used by the E2E tests):

```bash
docker build -f infra/linux/Dockerfile -t ios-sim-client .
```

Run it against a host on your LAN:

```bash
docker run --rm -it \
  -e IOS_SIM_URL=http://mac-host.local:7777 \
  -e IOS_SIM_TOKEN='<token>' \
  ios-sim-client doctor
```

On macOS with OrbStack/Docker Desktop, `host.docker.internal` points to the Mac:

```bash
docker run --rm -e IOS_SIM_URL=http://host.docker.internal:7777 -e IOS_SIM_TOKEN='<token>' ios-sim-client doctor
```

The host must bind to an address reachable from the container (`--bind 0.0.0.0` or the host's
LAN IP) for this mode. For a loopback-only host, use an SSH tunnel on the Linux machine instead.

## 8. CI usage

```bash
export IOS_SIM_URL=http://sim-host.internal:7777
export IOS_SIM_TOKEN="$IOS_SIM_TOKEN"
ios-sim boot "iPhone 16 Pro"
ios-sim install "$ARTIFACT/MyApp.app"
ios-sim launch com.example.MyApp
ios-sim screenshot artifacts/launch.jpg
ios-sim terminate com.example.MyApp
```

Pin the CLI version and the host Xcode/runtime version in CI. The API is versioned under `/v1`;
`doctor` is the preflight check.

## 9. Troubleshooting

| Symptom                   | Fix                                                 |
| ------------------------- | --------------------------------------------------- |
| `unauthorized`            | Wrong/missing token; re-run `connect`, check env    |
| `ECONNREFUSED`            | Host not running, wrong port, tunnel down, firewall |
| `no_booted_device`        | `ios-sim boot "iPhone 16 Pro"`                      |
| `multiple_booted_devices` | Pass `--device <udid>`                              |
| `input_unavailable`       | Install `idb` on the host                           |
| Screenshot timeout        | Simulator busy/hung; check `simctl` on host         |
| Viewer black              | Stream error; check `ios-sim doctor` and host logs  |

More in [Troubleshooting](./troubleshooting.md).
