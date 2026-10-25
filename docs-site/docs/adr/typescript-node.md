---

title: "ADR 0002: TypeScript and Node.js"
sidebar_position: 2
description: Why the host, protocol, and CLI are TypeScript on Node.js.
---

# ADR 0002: TypeScript and Node.js

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Engineering

## Context

The bridge needs:

- A macOS host that can spawn `simctl`/`idb`, serve HTTP/WebSocket/SSE, and handle uploads.
- A client that runs on Linux, macOS, and in containers with minimal installation friction.
- Shared types and runtime validation so the host and client cannot drift.
- A browser viewer with no build step.
- Fast tests in CI.

Candidate stacks: Swift/Go host + TypeScript client; Go everything; Rust; TypeScript
everywhere.

## Decision

Use TypeScript on Node.js for the protocol, host, CLI, and tests. Use Docusaurus (React) for
documentation. Keep the browser viewer as a single dependency-free HTML/JS page served by the
host.

## Consequences

### Positive

- One language and type system across the wire boundary.
- Zod provides runtime validation and inferred types (DRY).
- Node 22/24 is easy to install on Linux and in CI.
- Fastify + `ws` are mature and small.
- The same client library powers the CLI and tests.
- No build step for the viewer.

### Negative

- Node is not the fastest option for high-frequency video; Phase 3 may introduce a native
  component (e.g., WebRTC) behind the same API.
- `simctl`/`idb` process spawning has overhead; polling is the bottleneck, not the language.
- npm supply chain must be managed.

### Neutral

- The host still requires macOS; the language does not change the platform constraint.
- The protocol is language-agnostic; a future Swift/Go host can implement it.

## Alternatives

| Stack               | Why not now                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Swift host          | Best Apple integration, but a second language and macOS-only dev experience; client still needs a cross-platform stack |
| Go host + TS client | Good performance, but duplicates types and validation; more moving parts                                               |
| Rust                | Strong performance/safety, slower iteration for this scope                                                             |
| Python              | Weaker typing/ergonomics for a streaming server; packaging friction                                                    |

## Follow-ups

- Benchmark a native video path before adding one.
- Keep the protocol as the contract, not the implementation.
- Pin and audit dependencies; publish with provenance.
