#!/usr/bin/env bash
# Full local verification for the host. Skips macOS-only checks on Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== lint =="
npm run lint

echo "== typecheck =="
npm run typecheck

echo "== unit + contract =="
npm test

echo "== docs =="
npm run docs:build

if [[ "$(uname -s)" == "Darwin" && "${IOS_SIM_MACOS_TESTS:-0}" == "1" ]]; then
  echo "== macOS integration =="
  npm run test:macos
fi

if [[ "${IOS_SIM_LINUX_TESTS:-0}" == "1" ]]; then
  echo "== Linux E2E =="
  npm run test:linux
fi

echo "Verification complete."
