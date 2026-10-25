#!/usr/bin/env bash
# Measure capture and input latency on the local Mac.
# Usage: scripts/measure-macos.sh [UDID]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script needs macOS with Xcode." >&2
  exit 1
fi

UDID="${1:-booted}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$UDID" "$TMP" <<'PY'
import json, os, statistics, subprocess, sys, time

udid, tmp = sys.argv[1], sys.argv[2]
environ = dict(os.environ)

def timed(cmd, runs):
    samples = []
    for i in range(runs):
        start = time.perf_counter()
        result = subprocess.run(cmd, capture_output=True, env=environ)
        elapsed = time.perf_counter() - start
        if result.returncode != 0:
            print(result.stderr.decode(errors="replace"), file=sys.stderr)
            raise SystemExit(f"command failed: {' '.join(cmd)}")
        samples.append(elapsed)
    return samples

shot_path = os.path.join(tmp, "frame.jpg")
shots = timed(["xcrun", "simctl", "io", udid, "screenshot", "--type=jpeg", shot_path], 10)
size = os.path.getsize(shot_path)

report = {
    "udid": udid,
    "screenshot": {
        "runs": len(shots),
        "first_s": round(shots[0], 3),
        "median_s": round(statistics.median(shots[1:]), 3),
        "bytes": size,
        "max_polling_fps": round(1 / statistics.median(shots[1:]), 2),
        "mb_per_s_at_2fps": round(size * 2 / (1024 * 1024), 2),
    },
}

try:
    taps = timed(["idb", "ui", "tap", "200", "400", "--udid", udid], 5)
    report["tap"] = {
        "runs": len(taps),
        "first_s": round(taps[0], 3),
        "median_s": round(statistics.median(taps[1:]), 3),
    }
except (FileNotFoundError, SystemExit):
    report["tap"] = {"available": False}

print(json.dumps(report, indent=2))
PY
