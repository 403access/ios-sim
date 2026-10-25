---

title: Troubleshooting
sidebar_position: 5
description: Diagnose host, client, input, streaming, and upload failures.
---

# Troubleshooting

Start with the two preflight commands:

```bash
# On the Mac
xcrun simctl list devices available
xcrun simctl io booted screenshot /tmp/check.jpg

# On Linux
ios-sim doctor
ios-sim screenshot /tmp/check.jpg
```

If the host command fails, the problem is macOS/Xcode. If only the client fails, the problem is
network/auth/protocol.

## 1. Error codes

| Code                      | HTTP | Meaning                 | Fix                                                |
| ------------------------- | ---: | ----------------------- | -------------------------------------------------- |
| `unauthorized`            |  401 | Missing/wrong token     | `ios-sim connect <url> --token …`; check env       |
| `not_found`               |  404 | Unknown route           | Check CLI/host versions                            |
| `device_not_found`        |  404 | Bad UDID/name           | `ios-sim devices`                                  |
| `no_booted_device`        |  404 | Nothing booted          | `ios-sim boot "iPhone 16 Pro"`                     |
| `multiple_booted_devices` |  409 | Ambiguous `booted`      | Use `--device <udid>`                              |
| `invalid_request`         |  400 | Schema/coordinate error | Read the message; coordinates are 0..1 on the wire |
| `unsupported_media_type`  |  415 | Upload is not gzip      | Use the CLI `install`, not raw `curl`              |
| `app_bundle_missing`      |  400 | Tar has no `.app`       | Upload a `.app` directory, not an `.ipa`           |
| `input_unavailable`       |  501 | `idb` missing/failing   | Install `idb_companion` + `fb-idb`                 |
| `input_failed`            |  502 | `idb` command failed    | Check `idb list-targets`; see §4                   |
| `simctl_failed`           |  502 | Apple tool failed       | Run the same command manually; read stderr         |
| `internal_error`          |  500 | Unexpected              | Host log + issue report                            |

## 2. Host will not start

### `xcrun: error: unable to find utility "simctl"`

- Use full Xcode: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
- Open Xcode once and accept the licence.
- Install an iOS runtime (Xcode → Settings → Components).

### `EADDRINUSE`

Another host is running, or the port is taken:

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN
node apps/host/dist/bin.js --port 7778
```

### `Refusing --no-auth on a non-loopback bind`

This is intentional. Use a token or an SSH tunnel. Do not disable auth on a LAN/public bind.

### `The simctl backend only runs on macOS`

The host is macOS-only. On Linux, use `--backend mock` for a demo, or run the host on a Mac.

### launchd service cannot find `xcrun`

launchd starts with a minimal `PATH`. Add `/usr/bin` and `/opt/homebrew/bin` to
`EnvironmentVariables.PATH` in the plist, and use absolute paths for `node`.

## 3. Connection and auth

### `unauthorized`

```bash
# On the Mac, show the token file location and token
ls -l ~/.config/ios-sim/token
cat ~/.config/ios-sim/token
```

Then reconnect on Linux:

```bash
IOS_SIM_TOKEN='<token>' ios-sim doctor
```

If the host was started with `--no-auth`, remove the client token; if the host has a token and the
client sends none, every `/v1` request fails.

### `ECONNREFUSED` / timeout

- Is the host running? `curl http://127.0.0.1:7777/v1/health`
- Is the bind address reachable? `--bind 127.0.0.1` is not reachable from another machine.
- Is the SSH tunnel up? `ssh -N -L 7777:127.0.0.1:7777 user@mac`
- Firewall/VPN blocking the port?
- Docker: use `host.docker.internal` on macOS, or the LAN IP on Linux.

### `401` only in the browser

The viewer stores the token in `sessionStorage`. Paste it into the prompt or include `?token=…`.
Opening a new tab requires re-entering it.

## 4. Input

### `input_unavailable` (501)

```bash
which idb idb_companion
idb list-targets
```

Install:

```bash
brew tap facebook/fb
brew install idb-companion
pipx install fb-idb
```

Ensure `~/.local/bin` is on `PATH` for the user running the host. If the host runs under launchd,
add it to the plist `PATH`.

### `input_failed` (502)

- Is the device booted? `idb list-targets`.
- Is another `idb_companion` stuck? `idb kill`, then retry.
- Xcode 27: use `idb` 1.7.7+ (the DTUHID transport is required for some events).
- macOS privacy: grant Accessibility/Automation permissions to the terminal or service running
  `idb` if prompted.
- Try the coordinate manually:

  ```bash
  idb ui tap 200 400 --udid <UDID>
  ```

### Taps land in the wrong place

The CLI defaults to **points**, not pixels. A 1206 × 2622 screenshot is 402 × 874 points at 3×.
Use `--unit pixel` if you are reading coordinates from an image editor, or `--unit normalized`.

The browser uses normalized coordinates automatically.

## 5. Streaming

### Black screen

1. `ios-sim screenshot /tmp/check.jpg` — does capture work?
2. Check the WS URL/token in the browser network tab.
3. Behind a proxy, enable WebSocket upgrades and disable buffering.
4. Is the device actually booted? `ios-sim devices`.

### Stream is slow / high CPU

Polling capture costs ~0.36 s/frame and ~370–430 KB. Use `--fps 1` or `2` in the viewer URL, or wait
for the Phase 3 H.264 path. Multiple viewers each open a capture loop in v0.1; close unused tabs.

### Stream closes with code 1011

The host could not capture a frame (device shut down, runtime removed, `simctl` error). Check the
host log, then `simctl io booted screenshot /tmp/x.jpg` manually.

## 6. Screenshots

### `simctl_failed` / empty image

- The device may be booting. Wait for `bootstatus` (the CLI `boot` does this).
- Run `xcrun simctl io <udid> enumerate` and check the display exists.
- Do not use `simctl io ... screenshot -` expecting stdout; write to a file (the host already
  uses a temp file).

### Wrong size/rotation

The host reports pixel size and points via `/v1/devices/:udid/display`. The viewer scales the
image; input is normalized, so rotation changes the mapping accordingly. If you cache dimensions,
refresh after a rotation or device change.

## 7. App install and launch

### `app_bundle_missing`

The CLI packs a `.app` directory. An `.ipa` is a zip of a device build and is not a simulator app.
Build for the simulator:

```bash
xcodebuild -scheme MyApp -sdk iphonesimulator -configuration Debug \
  -derivedDataPath build build
# then install build/Build/Products/Debug-iphonesimulator/MyApp.app
```

### Install succeeds, launch fails

- Bundle id mismatch: `ios-sim apps`.
- The app was built for device (`arm64-apple-ios`) instead of simulator
  (`arm64-apple-ios-simulator`).
- Missing simulator architecture; rebuild with `iphonesimulator` SDK.
- Check logs: `ios-sim logs --level debug`.

### Upload too large

The host defaults to a 512 MiB body limit. Large apps with assets may exceed it. Raise the limit
in the host configuration (Phase 2 exposes a flag) or trim the bundle. Do not disable the limit
without a trusted network.

## 8. Logs

### No log lines

`log stream` can be quiet. Trigger app activity, use `--level debug`, or add a predicate:

```bash
ios-sim logs --level debug --predicate 'process == "MyApp"'
```

### SSE disconnects

Proxies often buffer SSE. Set `proxy_buffering off` (nginx) or use Caddy's default streaming
behaviour. The host sends a heartbeat every 15 s.

## 9. Xcode updates

After updating Xcode/runtime:

1. `xcrun simctl list runtimes` — new runtime registered?
2. `scripts/macos-smoke.sh` — boot, screenshot, install fixture.
3. `npm run test:macos` — full integration.
4. Test tap/text/Home with `idb`; private HID paths are the most likely breakage.
5. Update the version table in the [host setup](./host-setup.md) and the
   [findings](../research/findings.md).

## 10. Reporting a bug

Include:

- Host macOS, Xcode, runtime, device, bridge version.
- Client OS, Node version, command.
- `ios-sim doctor --json` output (redact the token).
- The exact error code/message.
- Host log excerpt with the request id if available.
- Whether `simctl`/`idb` work manually.

Do not include tokens, screenshots with personal data, or full device logs without review.
