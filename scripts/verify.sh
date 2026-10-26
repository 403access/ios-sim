#!/usr/bin/env bash
# Full local verification for the host. Skips macOS-only checks on Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== format =="
bun run format:check

echo "== typecheck =="
bun run typecheck

echo "== unit + contract =="
bun run test

echo "== docs links =="
bun run docs:check

echo "== docs =="
bun run docs:build

if [[ "$(uname -s)" == "Darwin" && "${IOS_SIM_MACOS_TESTS:-0}" == "1" ]]; then
  echo "== macOS integration =="
  bun run test:macos
fi

if [[ "${IOS_SIM_LINUX_TESTS:-0}" == "1" ]]; then
  echo "== Linux E2E =="
  bun run test:linux
fi

echo "Verification complete."
