#!/usr/bin/env bash
# Build and run the full native UIKitLite X11 CLI integration test in Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. Install Docker or OrbStack." >&2
  exit 1
fi

docker build -f infra/uikit-cli/Dockerfile -t ios-sim-uikit-cli-test .
docker run --rm ios-sim-uikit-cli-test
