#!/usr/bin/env bash
# Linux integration test for the `ios-sim-native window` command.
#
# Starts Xvfb, launches the Bun CLI, which spawns the native UIKitLite X11
# process, then verifies the window and pixels. No web view is involved.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

DISPLAY_NUMBER=":99"
XVFB_PID=""
CLI_PID=""

cleanup() {
  set +e
  if [[ -n "$CLI_PID" ]]; then
    kill "$CLI_PID" 2>/dev/null
    wait "$CLI_PID" 2>/dev/null
  fi
  if [[ -n "$XVFB_PID" ]]; then
    kill "$XVFB_PID" 2>/dev/null
    wait "$XVFB_PID" 2>/dev/null
  fi
  set -e
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- cli log ---" >&2
  cat /tmp/uikit-cli.log >&2 2>/dev/null || true
  exit 1
}

packages/uikit-native/build/test_uikit

Xvfb "$DISPLAY_NUMBER" -screen 0 1024x1024x24 >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY="$DISPLAY_NUMBER"
for _ in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo >/dev/null 2>&1 || fail "Xvfb did not start"

bun apps/native/dist/bin.js window --width 402 --height 874 --color 1e1e2e \
  --title "UIKitLite CLI Window" >/tmp/uikit-cli.log 2>&1 &
CLI_PID=$!

WINDOW_ID=""
for _ in $(seq 1 100); do
  WINDOW_ID="$(xdotool search --name "UIKitLite CLI Window" 2>/dev/null | head -n 1 || true)"
  [[ -n "$WINDOW_ID" ]] && break
  sleep 0.1
done
[[ -n "$WINDOW_ID" ]] || fail "CLI window was not mapped"
grep -q "uikit: window ready 402x874" /tmp/uikit-cli.log || fail "CLI did not launch the native window"

GEOMETRY="$(xdotool getwindowgeometry --shell "$WINDOW_ID")"
grep -q "^WIDTH=402$" <<<"$GEOMETRY" || fail "CLI window width is not 402"
grep -q "^HEIGHT=874$" <<<"$GEOMETRY" || fail "CLI window height is not 874"

import -window "$WINDOW_ID" /tmp/uikit-cli.png
PIXEL="$(convert /tmp/uikit-cli.png -format '%[pixel:p{10,10}]' info:)"
echo "cli pixel(10,10)=$PIXEL"
[[ "$PIXEL" == "srgb(30,30,46)" ]] || fail "CLI window background is not 0x1e1e2e"

xdotool windowsize "$WINDOW_ID" 320 480
sleep 0.3
GEOMETRY="$(xdotool getwindowgeometry --shell "$WINDOW_ID")"
grep -q "^WIDTH=320$" <<<"$GEOMETRY" || fail "CLI resize width is not 320"
grep -q "^HEIGHT=480$" <<<"$GEOMETRY" || fail "CLI resize height is not 480"
import -window "$WINDOW_ID" /tmp/uikit-cli-resized.png
PIXEL="$(convert /tmp/uikit-cli-resized.png -format '%[pixel:p{5,5}]' info:)"
[[ "$PIXEL" == "srgb(30,30,46)" ]] || fail "CLI resized background is not 0x1e1e2e"

echo "uikit: native CLI window integration passed"
