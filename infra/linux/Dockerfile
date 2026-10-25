# Linux client test image.
#
# This image contains no Apple software. It exists to prove that the protocol,
# CLI, and mock host run on a plain Linux userland under Bun.
FROM oven/bun:1.4.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so dependency installation is cached.
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/darwin-compat/package.json packages/darwin-compat/package.json
COPY apps/host/package.json apps/host/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/native/package.json apps/native/package.json
COPY docs-site/package.json docs-site/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Fail the build if any Apple/macOS artifact leaked into the image.
RUN test ! -e /Applications/Xcode.app && ! find . -name '*.simruntime' -print -quit | grep -q .

CMD ["bash", "scripts/linux-e2e.sh"]
