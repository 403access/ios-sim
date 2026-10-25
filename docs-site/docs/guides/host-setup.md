---

title: Host setup
sidebar_position: 2
description: Prepare a Mac to run the simulator bridge safely and reliably.
---

# Host setup

The host is the only machine that needs Apple software. Treat it as a shared development
appliance: install deliberately, expose it minimally, and keep it updated.

## 1. Prerequisites

| Component       | Version used here   | Notes                                     |
| --------------- | ------------------- | ----------------------------------------- |
| macOS           | 27.0.1 (26A434)     | Apple Silicon recommended                 |
| Xcode           | 27.1 (27A9275)      | Full Xcode, not only Command Line Tools   |
| iOS runtime     | 18.4 / 18.5 / 26.4  | Install via Xcode Settings → Components   |
| Node.js         | 24.22.1 (or 22.22+) | Runtime for host and CLI                  |
| `idb_companion` | 1.7.7               | Optional; required for input              |
| `fb-idb`        | 1.7.7               | Optional; Python CLI, install with `pipx` |

## 2. Verify Xcode and the simulator

```bash
xcode-select -p
# /Applications/Xcode.app/Contents/Developer

xcodebuild -version
xcrun simctl list runtimes
xcrun simctl list devices available
```

If no runtime is listed:

1. Open Xcode → Settings → Components.
2. Download an iOS Simulator runtime.
3. Re-run `xcrun simctl list runtimes`.

Boot one device to validate the toolchain:

```bash
xcrun simctl boot "iPhone 16 Pro"
xcrun simctl bootstatus "iPhone 16 Pro" -b
xcrun simctl io booted screenshot /tmp/check.jpg
```

`Simulator.app` is not required for the bridge. CoreSimulator can boot and render headlessly,
which is what makes a remote host practical. If you want the GUI for debugging, open it normally;
the bridge does not depend on it.

## 3. Install `idb` (input)

```bash
brew tap facebook/fb
brew install idb-companion

brew install pipx
pipx ensurepath
pipx install fb-idb
```

Open a new shell, then:

```bash
idb list-targets
idb ui tap 200 400 --udid <UDID>
```

If `idb` is not installed or fails, the bridge still works for viewing, installation, launch and
logs. `/v1/health` reports `input: false`, and input endpoints return
`501 input_unavailable`.

:::note
`idb` uses private Apple HID/DTUHID paths. Xcode 27 changed the event path; use a current
`idb`/`idb_companion` and re-test after Xcode updates. This is why input is an optional adapter,
not part of the protocol's guarantees.
:::

## 4. Install and start the host

```bash
git clone https://github.com/403access/ios-sim.git
cd ios-sim
npm ci
npm run build
node apps/host/dist/bin.js --bind 127.0.0.1
```

Options:

| Flag           | Default                      | Purpose                                |
| -------------- | ---------------------------- | -------------------------------------- |
| `--port`       | `7777` / `IOS_SIM_PORT`      | Listen port                            |
| `--bind`       | `127.0.0.1` / `IOS_SIM_BIND` | Bind address                           |
| `--token`      | env / token file             | Shared access token                    |
| `--token-file` | `~/.config/ios-sim/token`    | Token storage                          |
| `--backend`    | `simctl`                     | `mock` for demos/tests                 |
| `--no-auth`    | off                          | Loopback only; refused on non-loopback |
| `--log`        | off                          | Request logging                        |

The host prints the token, token path, and a ready-to-paste client command. The token file is
created with mode `0600`.

## 5. Run as a launchd service

Create `~/Library/LaunchAgents/dev.ios-sim.host.plist` (adjust paths and user):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ios-sim.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/ios-sim/apps/host/dist/bin.js</string>
    <string>--bind</string>
    <string>127.0.0.1</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/ios-sim-host.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/ios-sim-host.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ios-sim.host.plist
launchctl print gui/$(id -u)/dev.ios-sim.host
```

Stop/reload:

```bash
launchctl bootout gui/$(id -u)/dev.ios-sim.host
```

## 6. Network exposure

### Recommended: loopback + SSH tunnel

Keep `--bind 127.0.0.1`. On the client:

```bash
ssh -N -L 7777:127.0.0.1:7777 you@mac-host
ios-sim connect http://127.0.0.1:7777 --token '<token>'
```

This avoids opening a port and keeps the token inside the tunnel.

### LAN with a token

```bash
node apps/host/dist/bin.js --bind 0.0.0.0
```

Then:

- Put the Mac on a private/VPN network, not the public internet.
- Restrict the port in the macOS firewall to known client addresses.
- Use TLS (below) or keep using SSH tunnels.
- Rotate the token if a laptop is lost.

### TLS reverse proxy

Terminate TLS with Caddy or nginx and proxy to `127.0.0.1:7777`. WebSocket upgrade must be
allowed. Example Caddyfile:

```caddyfile
sim.example.internal {
  reverse_proxy 127.0.0.1:7777
}
```

Then clients use `https://sim.example.internal` and the client automatically uses `wss://` for
streams. Do not disable the token just because TLS is present.

## 7. Updates

| Component       | Update                                              | Re-test                                        |
| --------------- | --------------------------------------------------- | ---------------------------------------------- |
| Xcode / runtime | App Store / Xcode Settings                          | `npm run test:macos`, `scripts/macos-smoke.sh` |
| `idb`           | `brew upgrade idb-companion`, `pipx upgrade fb-idb` | tap/text/button                                |
| Node            | `nvm install` / package manager                     | `npm test`, Linux E2E                          |
| Bridge          | `git pull && npm ci && npm run build`               | `doctor`, smoke                                |

Record versions in the host runbook. Private SPI breaks silently; a quick tap test after every
Xcode update is cheaper than debugging a user report.

## 8. Resource guidance

| Resource | Recommendation                                                         |
| -------- | ---------------------------------------------------------------------- |
| RAM      | 16 GB minimum for one simulator; 32 GB+ for several                    |
| Disk     | 20 GB+ free for runtimes and device data                               |
| CPU      | Apple Silicon; avoid running heavy builds and many simulators together |
| GPU      | The simulator uses Metal; a headless Mac still needs GPU support       |
| Power    | Disable sleep for a shared host (`caffeinate` or Energy settings)      |

## 9. Checklist

- [ ] Xcode and an iOS runtime installed; `simctl` works.
- [ ] A device can boot and screenshot.
- [ ] Node 22.22+/24.x installed; repo built.
- [ ] `idb` installed if input is required; `idb ui tap` works.
- [ ] Token stored with `0600`; no token in shell history/scripts.
- [ ] Bind is loopback or a private interface.
- [ ] Firewall restricts the port; SSH tunnel or TLS in place.
- [ ] launchd service starts on boot and logs to a known path.
- [ ] macOS sleep disabled.
- [ ] Update/re-test procedure documented.
