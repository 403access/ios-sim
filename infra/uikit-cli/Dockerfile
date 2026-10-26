# Linux image for the full `ios-sim-native window` integration test.
#
# It contains Bun, X11, and Xvfb. The CLI builds and launches the native
# UIKitLite X11 process; there is no browser or web view in the path.
FROM oven/bun:1.4.4

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    imagemagick \
    libx11-dev \
    pkg-config \
    xdotool \
    xvfb \
    x11-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/darwin-compat/package.json packages/darwin-compat/package.json
COPY apps/host/package.json apps/host/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/native/package.json apps/native/package.json
COPY docs-site/package.json docs-site/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build \
  && bun run build:uikit

CMD ["bash", "packages/uikit-native/tests/x11-cli-smoke.sh"]
