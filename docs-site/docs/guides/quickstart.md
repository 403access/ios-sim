---

title: Quickstart
sidebar_position: 1
description: From a Mac host and a Linux client to a live simulator in about five minutes.
---

# Quickstart

## What you need

- **Mac host:** macOS with Xcode 27+ and at least one iOS simulator runtime. Apple Silicon
  recommended.
- **Linux client:** Node.js 22.22+ or 24.x. No Xcode, no Apple libraries.
- **Network:** both machines on the same LAN, or an SSH tunnel. Do not expose the host to the
  public internet without TLS and a token.

## 1. Build the host (Mac)

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
npm ci
npm run build
```

Start the host:

```bash
node apps/host/dist/bin.js --bind 127.0.0.1
```

It prints something like:

```text
ios-sim-host 0.1.0
backend: simctl (input: ready)
listening: http://127.0.0.1:7777
token: 3sP...Q
token file: ~/.config/ios-sim/token
```

The token is also written to `~/.config/ios-sim/token` (mode `0600`). Keep it.

If `input: unavailable`, install `idb` (optional, needed for taps/typing):

```bash
brew tap facebook/fb
brew install idb-companion
pipx install fb-idb
```

## 2. Connect from Linux

Copy the token from the Mac, or use an SSH tunnel so the token never crosses an untrusted network.

```bash
# On Linux
git clone https://github.com/403access/ios-sim.git
cd ios-sim
npm ci
npm run build

# Option A: direct LAN (host bound to a private interface)
node apps/cli/dist/bin.js connect http://mac-host.local:7777 --token '<token>'

# Option B: SSH tunnel (host stays on loopback)
ssh -N -L 7777:127.0.0.1:7777 you@mac-host &
node apps/cli/dist/bin.js connect http://127.0.0.1:7777 --token '<token>'
```

Verify:

```bash
node apps/cli/dist/bin.js doctor
```

You should see the host, backend, input capability, and a device table.

## 3. Boot and view

```bash
# List devices
node apps/cli/dist/bin.js devices

# Boot the first available device by name or UDID
node apps/cli/dist/bin.js boot "iPhone 16 Pro"

# Capture a screenshot
node apps/cli/dist/bin.js screenshot shot.jpg

# Open the browser viewer
node apps/cli/dist/bin.js open
```

The viewer streams JPEG frames, maps clicks to taps, drags to swipes, and provides text input plus
Home/Lock/Side/Siri buttons. Logs are behind “Show logs”.

## 4. Install and launch an app

Build an unsigned simulator `.app` on the Mac (or in your iOS build pipeline), then upload the
bundle from Linux:

```bash
node apps/cli/dist/bin.js install /path/to/MyApp.app
node apps/cli/dist/bin.js launch com.example.MyApp
node apps/cli/dist/bin.js apps
```

The CLI tars the `.app` directory, uploads it as gzip, and the host extracts it to a temporary
directory and calls `simctl install`. The temporary copy is deleted after installation; the
response reports the installed bundle name, not the deleted temp path.

## 5. Input

```bash
# Coordinates are in device points by default
node apps/cli/dist/bin.js tap 200 400

# Pixels or normalized coordinates
node apps/cli/dist/bin.js tap 600 1200 --unit pixel
node apps/cli/dist/bin.js tap 0.5 0.5 --unit normalized

node apps/cli/dist/bin.js text "hello from Linux"
node apps/cli/dist/bin.js button home
node apps/cli/dist/bin.js swipe 200 700 200 200
```

If input is unavailable, the host returns `501 input_unavailable` and the viewer is read-only.
Install `idb` on the Mac to enable it.

## 6. Stream frames to disk

```bash
node apps/cli/dist/bin.js stream --out /tmp/frames --fps 2 --duration 10
```

Useful for demos, bug reports, and CI artifacts.

## 7. Run the tests

```bash
npm test              # unit + contract (Mac or Linux)
npm run test:linux    # Linux container E2E (Docker/OrbStack)
npm run test:macos    # real simulator integration (macOS, gated)
npm run docs:build    # Docusaurus
```

## Next

- [Host setup](./host-setup.md) — Xcode, `idb`, launchd service, firewall.
- [Linux client](./linux-client.md) — installation, tunnels, Docker.
- [Browser viewer](./browser-viewer.md) — controls and limitations.
- [Troubleshooting](./troubleshooting.md) — when something fails.
