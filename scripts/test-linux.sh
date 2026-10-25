#!/usr/bin/env bash
# Build and run the Linux client smoke test using OrbStack/Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. Install Docker or use OrbStack." >&2
  exit 1
fi

docker build -f infra/linux/Dockerfile -t ios-sim-linux-test .
docker run --rm ios-sim-linux-test
