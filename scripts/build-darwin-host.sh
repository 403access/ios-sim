#!/usr/bin/env bash
# Build the native DarwinHost kernel-boundary library and C tests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
make -C "$ROOT/packages/darwin-host" clean all test
