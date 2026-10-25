#!/usr/bin/env bash
# Build the optional real-toolchain Mach-O fixture with Xcode clang.
#
# This is macOS-only on purpose: the committed repository contains no Mach-O
# output. The fixture source and build command are the evidence; the binary is
# generated into fixtures/darwin-hello/build and ignored by git.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/fixtures/darwin-hello/hello.s"
OUT_DIR="$ROOT/fixtures/darwin-hello/build"
OUT="$OUT_DIR/hello"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: real Mach-O fixture needs macOS clang (uname=$(uname -s))" >&2
  exit 0
fi

if ! command -v clang >/dev/null 2>&1; then
  echo "skip: clang is not installed" >&2
  exit 0
fi

mkdir -p "$OUT_DIR"
bun run --cwd "$ROOT/packages/darwin-compat" build
clang -target arm64-apple-macos13 -nostdlib -static -Wl,-e,_start -o "$OUT" "$SRC"
echo "built $OUT"
file "$OUT"
"$ROOT/scripts/native-smoke.sh" "$OUT"
