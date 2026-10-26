#!/usr/bin/env bash
# Build and test the native kernel boundary inside a Linux container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. Install Docker or OrbStack." >&2
  exit 1
fi

docker build -f infra/kernel/Dockerfile -t ios-sim-kernel-test .
docker run --rm ios-sim-kernel-test
