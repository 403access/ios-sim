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

export IOS_SIM_URL="$BASE"
export IOS_SIM_TOKEN="$TOKEN"

node apps/host/dist/bin.js --backend mock --port "$PORT" --token "$TOKEN" >"$LOG" 2>&1 &
HOST_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "$BASE/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

echo "== health =="
HEALTH="$(curl -fsS "$BASE/v1/health")"
grep -q '"backend":"mock"' <<<"$HEALTH"

echo "== auth =="
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/devices")"
[[ "$STATUS" == "401" ]] || { echo "expected 401, got $STATUS" >&2; exit 1; }

echo "== doctor =="
DOCTOR="$(node apps/cli/dist/bin.js doctor)"
grep -q 'Mock iPhone' <<<"$DOCTOR"

echo "== devices (json) =="
node apps/cli/dist/bin.js --json devices |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);if(d.devices.length!==2)process.exit(1)})'

echo "== screenshot =="
node apps/cli/dist/bin.js screenshot "$OUT/shot.jpg"
[[ -s "$OUT/shot.jpg" ]]
node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);if(b[0]!==0xff||b[1]!==0xd8)process.exit(1)' "$OUT/shot.jpg"

echo "== display =="
DISPLAY="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/devices/MOCK-BOOTED/display")"
grep -q '"widthPoints":402' <<<"$DISPLAY"

echo "== input =="
node apps/cli/dist/bin.js tap 0.5 0.5 --unit normalized
node apps/cli/dist/bin.js swipe 0.2 0.8 0.2 0.2 --unit normalized
node apps/cli/dist/bin.js text "hello from linux"
node apps/cli/dist/bin.js button home

echo "== install / launch =="
mkdir -p "$OUT/HelloSim.app"
printf '<plist/>' > "$OUT/HelloSim.app/Info.plist"
node apps/cli/dist/bin.js install "$OUT/HelloSim.app"
LAUNCH="$(node apps/cli/dist/bin.js launch com.example.hello-sim)"
grep -q 'pid 4242' <<<"$LAUNCH"
APPS="$(node apps/cli/dist/bin.js apps)"
grep -q 'com.example.hello-sim' <<<"$APPS"

echo "== stream =="
node apps/cli/dist/bin.js stream --out "$OUT/frames" --duration 1 >/dev/null
FRAMES="$(find "$OUT/frames" -name '*.jpg' | wc -l | tr -d ' ')"
[[ "$FRAMES" -gt 0 ]] || { echo "no frames captured" >&2; exit 1; }

echo "== logs =="
node apps/cli/dist/bin.js logs --level info > "$OUT/logs.txt"
grep -q 'mock log line' "$OUT/logs.txt"

echo
echo "Linux E2E passed ($FRAMES frames)."
