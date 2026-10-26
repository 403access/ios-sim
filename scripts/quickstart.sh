#!/usr/bin/env bash
# Native-track quickstart (DX-005).
#
# Runs the hermetic demo everywhere, then the real-clang fixture when macOS
# clang is available. The clang step prints its skip reason on other hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== build =="
bun run --cwd packages/darwin-compat build
bun run --cwd apps/native build

echo "== demo (generated Mach-O, no Apple binary) =="
set +e
bun apps/native/src/bin.ts demo
demo_status=$?
set -e
if [[ $demo_status -ne 42 ]]; then
  echo "quickstart: demo exited $demo_status, expected 42" >&2
  exit 1
fi

echo "== doctor and demo JSON =="
mkdir -p build/quickstart
bun apps/native/src/bin.ts doctor --json > build/quickstart/doctor.json
set +e
bun apps/native/src/bin.ts demo --json > build/quickstart/demo.json
demo_json_status=$?
set -e
if [[ $demo_json_status -ne 42 ]]; then
  echo "quickstart: demo --json exited $demo_json_status, expected 42" >&2
  exit 1
fi

echo "== real clang fixture (macOS only) =="
if ./scripts/build-native-fixtures.sh; then
  if [[ -x fixtures/darwin-hello/build/hello ]]; then
    echo "quickstart: clang fixture built and exercised by native-smoke.sh"
  fi
else
  echo "quickstart: clang fixture build failed" >&2
  exit 1
fi

echo
echo "next:"
echo "  bun apps/native/src/bin.ts doctor --json"
echo "  bun apps/native/src/bin.ts inspect <your-arm64-macho> --disasm"
echo "  bun run fuzz --iterations 100000"
echo "  bun run docs:dev"
