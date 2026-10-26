#!/usr/bin/env bash
# Build the freestanding C guest-libc fixture (RT-010).
# macOS-only on purpose: it needs clang's arm64-apple Mach-O target.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/fixtures/darwin-libc/hello.c"
OUT_DIR="$ROOT/fixtures/darwin-libc/build"
OUT="$OUT_DIR/hello"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: freestanding C fixture needs macOS clang (uname=$(uname -s))" >&2
  exit 0
fi
if ! command -v clang >/dev/null 2>&1; then
  echo "skip: clang is not installed" >&2
  exit 0
fi
mkdir -p "$OUT_DIR"
clang -target arm64-apple-macos13 -nostdlib -static -fno-builtin \
  -Wl,-e,__start -o "$OUT" "$SRC"
echo "built $OUT"
