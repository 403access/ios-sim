#!/usr/bin/env bash
# Build and test the native kernel boundary (C tests + Bun FFI smoke).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/scripts/build-darwin-host.sh"
make -C "$ROOT/packages/darwin-host" stress
cd "$ROOT"
bun packages/darwin-host/tests/ffi-smoke.ts
