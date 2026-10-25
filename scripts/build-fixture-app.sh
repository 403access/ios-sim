#!/usr/bin/env bash
# Build the minimal simulator fixture app used by the macOS integration test.
# Usage: scripts/build-fixture-app.sh [output-directory]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/fixtures/hello-sim/build}"
APP="$OUT/HelloSim.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script needs macOS with Xcode installed." >&2
  exit 1
fi

if ! xcrun --find clang >/dev/null 2>&1; then
  echo "xcrun/clang not found. Install Xcode and select it with xcode-select." >&2
  exit 1
fi

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
rm -rf "$APP"
mkdir -p "$APP"
cp "$ROOT/fixtures/hello-sim/Info.plist" "$APP/Info.plist"

xcrun --sdk iphonesimulator clang \
  -fobjc-arc \
  -isysroot "$SDK" \
  -target arm64-apple-ios18.0-simulator \
  -framework UIKit \
  -framework Foundation \
  -framework CoreGraphics \
  "$ROOT/fixtures/hello-sim/main.m" \
  -o "$APP/HelloSim"

plutil -lint "$APP/Info.plist" >/dev/null
echo "$APP"
