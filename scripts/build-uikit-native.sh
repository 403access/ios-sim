#!/usr/bin/env bash
# Build the native UIKitLite X11 window and its unit tests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/uikit-native"
make clean all test
echo "built packages/uikit-native/build/uikit-window"
