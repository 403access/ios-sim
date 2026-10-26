#!/usr/bin/env bash
# Build the real-clang ObjC fixture for the native track.
#
# macOS + Xcode only: it produces a Mach-O image and rewrites its libSystem
# load command to the repository's runtime stub, so the compatibility layer
# never opens an Apple binary. The output is not committed.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "skip: the clang ObjC fixture needs macOS and Xcode" >&2
  exit 1
fi
if ! command -v clang >/dev/null 2>&1; then
  echo "skip: clang is not installed" >&2
  exit 1
fi
if ! command -v install_name_tool >/dev/null 2>&1; then
  echo "skip: install_name_tool is not installed" >&2
  exit 1
fi

build="${1:-fixtures/objc-window/build}"
rm -rf "$build"
mkdir -p "$build"

bun scripts/build-objc-shim.ts "$build"

# The clang fixture loads UIImage assets relative to its own directory.
bun scripts/make-fixture-image.ts "$build/assets/icon.png" >/dev/null
mkdir -p "$build/assets"

build_app() {
  local output="$1"
  local fixups="$2"
  clang \
    -target arm64-apple-macos13 \
    -fobjc-runtime=macosx-13.0 \
    -fobjc-arc \
    -fobjc-relative-method-lists \
    -nostdinc \
    -isystem fixtures/objc-window/shim \
    -nostdlib \
    -L"$build" \
    -lSystem \
    -Wl,-e,_main \
    -Wl,-undefined,dynamic_lookup \
    "$fixups" \
    -Wl,-no_adhoc_codesign \
    -o "$output" \
    fixtures/objc-window/main.m
  install_name_tool \
    -change /usr/lib/libSystem.B.dylib @loader_path/libSystemShim.dylib \
    "$output"
}

build_app "$build/ObjcWindow" -Wl,-fixup_chains
build_app "$build/ObjcWindowLegacy" -Wl,-no_fixup_chains

echo "built $build/ObjcWindow and $build/ObjcWindowLegacy"
