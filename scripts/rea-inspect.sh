#!/usr/bin/env bash
# Reproduce the REA Mach-O evidence used in the research docs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/artifacts/rea}"
cd "$ROOT"
mkdir -p "$OUT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script needs macOS with Xcode." >&2
  exit 1
fi

REA=(bunx rea-agents@latest)

"${REA[@]}" inspect-macho \
  /Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit \
  --format json > "$OUT/simulator-kit.json"

"${REA[@]}" inspect-macho \
  /Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator \
  --format json > "$OUT/core-simulator.json"

LAUNCHD="$(find /Library/Developer/CoreSimulator/Volumes -name launchd_sim -print -quit)"
if [[ -z "$LAUNCHD" ]]; then
  echo "Could not find launchd_sim; install an iOS runtime first." >&2
  exit 1
fi
"${REA[@]}" inspect-macho "$LAUNCHD" --format json > "$OUT/launchd-sim.json"

echo "Wrote REA evidence to $OUT"
