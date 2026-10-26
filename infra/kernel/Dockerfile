# Linux image for the native DarwinHost kernel-boundary test.
FROM oven/bun:1.4.4

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/darwin-host ./packages/darwin-host
COPY scripts/build-darwin-host.sh ./scripts/build-darwin-host.sh
COPY scripts/test-darwin-host.sh ./scripts/test-darwin-host.sh

RUN chmod +x scripts/build-darwin-host.sh scripts/test-darwin-host.sh \
  && ./scripts/test-darwin-host.sh

CMD ["./scripts/test-darwin-host.sh"]
