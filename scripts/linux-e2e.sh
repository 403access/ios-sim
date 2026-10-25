#!/usr/bin/env bash
# End-to-end smoke test that runs *inside* the Linux test container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${IOS_SIM_E2E_PORT:-7788}"
TOKEN="linux-e2e-token"
BASE="http://127.0.0.1:$PORT"
LOG="$(mktemp)"
OUT="$(mktemp -d)"

cleanup() {
  if [[ -n "${HOST_PID:-}" ]]; then
    kill "$HOST_PID" 2>/dev/null || true
    wait "$HOST_PID" 2>/dev/null || true
  fi
  rm -rf "$OUT"
  rm -f "$LOG"
}
trap cleanup EXIT

contains() {
  case "$1" in
    *"$2"*) ;;
    *) echo "expected '$2' in output: $1" >&2; exit 1 ;;
  esac
}

export IOS_SIM_URL="$BASE"
export IOS_SIM_TOKEN="$TOKEN"

bun apps/host/dist/bin.js --backend mock --port "$PORT" --token "$TOKEN" >"$LOG" 2>&1 &
HOST_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "$BASE/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

echo "== native substrate =="
set +e
NATIVE_OUT="$(bun apps/native/dist/bin.js demo)"
NATIVE_STATUS=$?
set -e
[[ $NATIVE_STATUS -eq 42 ]] || { echo "native demo expected status 42, got $NATIVE_STATUS" >&2; exit 1; }
contains "$NATIVE_OUT" 'hello from darwin'
bun apps/native/dist/bin.js doctor --json | grep -q '"simulator": false'

echo "== health =="
HEALTH="$(curl -fsS "$BASE/v1/health")"
contains "$HEALTH" '"backend":"mock"'

echo "== auth =="
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/devices")"
[[ "$STATUS" == "401" ]] || { echo "expected 401, got $STATUS" >&2; exit 1; }

echo "== doctor =="
DOCTOR="$(bun apps/cli/dist/bin.js doctor)"
contains "$DOCTOR" 'Mock iPhone'

echo "== devices (json) =="
bun apps/cli/dist/bin.js --json devices > "$OUT/devices.json"
grep -q '"MOCK-BOOTED"' "$OUT/devices.json"
grep -q '"MOCK-SHUTDOWN"' "$OUT/devices.json"

echo "== screenshot =="
bun apps/cli/dist/bin.js screenshot "$OUT/shot.jpg"
[[ -s "$OUT/shot.jpg" ]]
bun -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);if(b[0]!==0xff||b[1]!==0xd8)process.exit(1)' "$OUT/shot.jpg"

echo "== display =="
DISPLAY="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/devices/MOCK-BOOTED/display")"
contains "$DISPLAY" '"widthPoints":402'

echo "== input =="
bun apps/cli/dist/bin.js tap 0.5 0.5 --unit normalized
bun apps/cli/dist/bin.js swipe 0.2 0.8 0.2 0.2 --unit normalized
bun apps/cli/dist/bin.js text "hello from linux"
bun apps/cli/dist/bin.js button home

echo "== install / launch =="
mkdir -p "$OUT/HelloSim.app"
printf '<plist/>' > "$OUT/HelloSim.app/Info.plist"
bun apps/cli/dist/bin.js install "$OUT/HelloSim.app"
LAUNCH="$(bun apps/cli/dist/bin.js launch com.example.hello-sim)"
contains "$LAUNCH" 'pid 4242'
APPS="$(bun apps/cli/dist/bin.js apps)"
contains "$APPS" 'com.example.hello-sim'

echo "== stream =="
bun apps/cli/dist/bin.js stream --out "$OUT/frames" --duration 1 >/dev/null
FRAMES="$(find "$OUT/frames" -name '*.jpg' | wc -l | tr -d ' ')"
[[ "$FRAMES" -gt 0 ]] || { echo "no frames captured" >&2; exit 1; }

echo "== logs =="
bun apps/cli/dist/bin.js logs --level info > "$OUT/logs.txt"
grep -q 'mock log line' "$OUT/logs.txt"

echo
echo "Linux E2E passed ($FRAMES frames)."
