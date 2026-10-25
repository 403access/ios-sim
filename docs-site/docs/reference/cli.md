---
title: CLI reference
sidebar_position: 3
description: Commands, options, environment variables, and output formats.
---

# CLI reference

```text
ios-sim <command> [options]
```

Every device-scoped command accepts `--device <selector>` (UDID, name, or `booted`) and every
command accepts `--url`, `--token`, `--json`, and `--timeout` (milliseconds).

## Global options

| Option                | Env              | Default                 | Meaning         |
| --------------------- | ---------------- | ----------------------- | --------------- |
| `--url <url>`         | `IOS_SIM_URL`    | `http://127.0.0.1:7777` | Host URL        |
| `--token <token>`     | `IOS_SIM_TOKEN`  | config/token file       | Access token    |
| `--device <selector>` | `IOS_SIM_DEVICE` | `booted`                | Device selector |
| `--json`              |                  | off                     | Print raw JSON  |
| `--timeout <ms>`      |                  | `30000`                 | HTTP timeout    |
| `--version`           |                  |                         | Print version   |
| `--help`              |                  |                         | Help            |

Precedence: flags → environment → `~/.config/ios-sim/client.json` → `~/.config/ios-sim/token` →
defaults.

## Commands

### `doctor`

Checks connectivity, capabilities, and devices.

```bash
ios-sim doctor
ios-sim doctor --json
```

JSON:

```json
{
  "health": { "ok": true, "backend": "simctl", "capabilities": { "input": true } },
  "devices": [{ "name": "iPhone 16 Pro", "state": "Booted" }]
}
```

### `connect <url>`

Verifies the host and saves the URL/token to `client.json`.

```bash
ios-sim connect http://mac.local:7777 --token '<token>'
```

### `devices` (alias `ls`)

Lists simulators.

```bash
ios-sim devices
ios-sim --json devices | jq -r '.devices[] | select(.state=="Booted") | .udid'
```

### `boot [selector]`

Boots and waits for readiness. Defaults to `--device`/`IOS_SIM_DEVICE`/`booted`.

```bash
ios-sim boot "iPhone 16 Pro"
ios-sim boot 7AD86EEA-A3F1-4103-B010-C8264B2AC6C6
```

### `shutdown [selector]`

Shuts a simulator down.

### `erase [selector]`

Shuts down and erases all content/settings.

### `delete [selector]`

Shuts down and deletes the simulator.

### `create <name>`

Creates a simulator. The host chooses the latest iOS runtime and first iPhone device type unless
specified.

```bash
ios-sim create "CI iPhone"
ios-sim create "CI iPhone" \
  --runtime com.apple.CoreSimulator.SimRuntime.iOS-26-4 \
  --device-type com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro
```

### `apps [selector]`

Lists installed applications.

### `install <path>`

Uploads and installs a simulator `.app` directory.

```bash
ios-sim install ./build/Build/Products/Debug-iphonesimulator/MyApp.app
```

The CLI creates a gzip tarball in memory, uploads it, and prints the installed bundle name. It
does not accept `.ipa` files.

### `launch <bundleId>`

```bash
ios-sim launch com.example.MyApp
ios-sim launch com.example.MyApp --arg -AppleLanguages --arg '(en)' --env DEBUG=1
```

`--arg` and `--env` are repeatable. Environment variables are passed through `SIMCTL_CHILD_*`.

### `terminate <bundleId>`

Terminates a running app.

### `screenshot [file]`

```bash
ios-sim screenshot                    # simulator-<timestamp>.jpg
ios-sim screenshot shot.png --format png
ios-sim screenshot - > shot.jpg       # stdout
```

Default format: JPEG.

### `tap <x> <y>`

```bash
ios-sim tap 200 400                   # points (default)
ios-sim tap 600 1200 --unit pixel
ios-sim tap 0.5 0.5 --unit normalized
```

The client fetches display metadata and converts to normalized protocol coordinates.

### `swipe <x1> <y1> <x2> <y2>`

```bash
ios-sim swipe 200 700 200 200
ios-sim swipe 200 700 200 200 --unit point --duration 400
```

### `text <text>`

Types text into the focused field. Quote text containing spaces.

### `key <key>`

Presses an `idb` keycode (e.g. `H`, `Return`, `Escape`). See `idb ui key --help` for the accepted
names.

### `button <button>`

`home`, `lock`, `side`, or `siri`.

### `stream`

Saves JPEG frames to a directory.

```bash
ios-sim stream --out /tmp/frames --fps 2 --duration 10
```

Options: `--out` (default `ios-sim-frames`), `--fps` (1–10), `--duration` seconds (`0` = until
Ctrl+C). Frames are named `frame-00001.jpg`.

### `open`

Opens the browser viewer (uses `xdg-open`, `open`, or `explorer`).

```bash
ios-sim open
ios-sim open --device "iPhone 16 Pro"
```

### `logs`

Follows device logs over SSE.

```bash
ios-sim logs
ios-sim logs --level debug --predicate 'process == "MyApp"'
```

## Output

Human output is plain text. `--json` prints the raw API payload for the operation:

| Command                                     | JSON shape                       |
| ------------------------------------------- | -------------------------------- |
| `doctor`                                    | `{ health, devices }`            |
| `devices`                                   | `{ devices }`                    |
| `apps`                                      | `{ apps }`                       |
| `boot` / `create`                           | `Device`                         |
| `install`                                   | `{ installed }`                  |
| `launch`                                    | `{ pid }`                        |
| `screenshot`                                | `{ file, bytes }` (not with `-`) |
| `tap` / `swipe` / `text` / `key` / `button` | `{ ok: true }` or `{ ok, ... }`  |
| `stream`                                    | `{ frames, directory }`          |
| `open`                                      | `{ url }`                        |

## Exit codes

| Code | Meaning                                   |
| ---: | ----------------------------------------- |
|    0 | Success                                   |
|    1 | Error (connection, auth, API, validation) |

Errors are printed to stderr; `--json` does not wrap errors in JSON in v0.1.

## Environment variables

| Variable             | Purpose                   |
| -------------------- | ------------------------- |
| `IOS_SIM_URL`        | Default host URL          |
| `IOS_SIM_TOKEN`      | Access token              |
| `IOS_SIM_DEVICE`     | Default device selector   |
| `IOS_SIM_CONFIG_DIR` | Override config directory |

## Examples

### CI

```bash
ios-sim boot "iPhone 16 Pro"
ios-sim install "$ARTIFACT/MyApp.app"
ios-sim launch com.example.MyApp
sleep 3
ios-sim screenshot artifacts/launch.jpg
ios-sim logs --level error > artifacts/logs.txt &
LOG_PID=$!
# ... run checks ...
kill $LOG_PID
ios-sim terminate com.example.MyApp
```

### Pick a booted device

```bash
UDID=$(ios-sim --json devices | jq -r '.devices[] | select(.state=="Booted") | .udid' | head -1)
ios-sim --device "$UDID" tap 0.5 0.5 --unit normalized
```

### Demo without a Mac

```bash
# On any OS
bun apps/host/dist/bin.js --backend mock --port 7777
ios-sim --url http://127.0.0.1:7777 doctor
ios-sim --url http://127.0.0.1:7777 tap 0.5 0.5 --unit normalized
```

The mock backend is for tests and demos; it does not run an iOS runtime.
