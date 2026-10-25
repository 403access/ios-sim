#!/usr/bin/env bash
# Smoke-test the Option A compatibility layer without Apple runtimes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f packages/darwin-compat/dist/index.js ]]; then
  bun run --cwd packages/darwin-compat build
fi

echo "== doctor =="
bun apps/native/src/bin.ts doctor

echo "== demo =="
set +e
bun apps/native/src/bin.ts demo
demo_status=$?
set -e
if [[ $demo_status -ne 0 && $demo_status -ne 42 ]]; then
  echo "demo failed with status $demo_status" >&2
  exit $demo_status
fi

if [[ $# -ge 1 ]]; then
  FILE="$1"
  echo "== inspect =="
  bun apps/native/src/bin.ts inspect "$FILE"
  echo "== run =="
  bun apps/native/src/bin.ts run "$FILE"
fi
