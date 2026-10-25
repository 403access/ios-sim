#!/usr/bin/env bash
# Manual macOS smoke test: host + CLI against the real simulator.
# Usage: scripts/macos-smoke.sh [UDID|name]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script needs macOS with Xcode." >&2
  exit 1
fi

SELECTOR="${1:-booted}"
PORT="${IOS_SIM_SMOKE_PORT:-7791}"
TOKEN="${IOS_SIM_SMOKE_TOKEN:-macos-smoke-token}"
BASE="http://127.0.0.1:$PORT"
OUT="$(mktemp -d)"

cleanup() {
  kill "${HOST_PID:-}" 2>/dev/null || true
  wait "${HOST_PID:-}" 2>/dev/null || true
  rm -rf "$OUT"
}
trap cleanup EXIT

node apps/host/dist/bin.js --token "$TOKEN" --port "$PORT" >"$OUT/host.log" 2>&1 &
HOST_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "$BASE/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

export IOS_SIM_URL="$BASE"
export IOS_SIM_TOKEN="$TOKEN"
export IOS_SIM_DEVICE="$SELECTOR"

echo "== doctor =="
node apps/cli/dist/bin.js doctor
echo
echo "== screenshot =="
node apps/cli/dist/bin.js screenshot "$OUT/shot.jpg"
ls -l "$OUT/shot.jpg"
echo
echo "Host log: $OUT/host.log (removed on exit)"
echo "Press Ctrl+C to stop."
wait "$HOST_PID"
