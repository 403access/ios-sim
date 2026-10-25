---
title: "ADR 0002: TypeScript and Bun"
sidebar_position: 2
description: Why the host, protocol, CLI, and toolchain are TypeScript on Bun.
---

# ADR 0002: TypeScript and Bun

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Engineering

## Context

The bridge needs:

- A macOS host that can spawn `simctl`/`idb`, serve HTTP/WebSocket/SSE, and handle uploads.
- A client that runs on Linux, macOS, and in containers with minimal installation friction.
- Shared types and runtime validation so the host and client cannot drift.
- A browser viewer with no build step.
- Fast tests and documentation builds in CI.
- One package manager and one formatter, without a separate Node/npm toolchain.

Candidate stacks: Swift/Go host + TypeScript client; Go everything; Rust; TypeScript
everywhere.

## Decision

Use TypeScript on **Bun** for the protocol, host, CLI, tests, and documentation tooling. Bun owns
dependency installation (`bun install`), scripts (`bun run`), and formatting (`bun fmt`). Use
Docusaurus (React) for documentation. Keep the browser viewer as a single dependency-free
HTML/JS page served by the host.

The compiled JavaScript is Node-API-compatible and can still be run with `node` if needed, but
Bun is the supported toolchain.

## Consequences

### Positive

- One language and type system across the wire boundary.
- Zod provides runtime validation and inferred types (DRY).
- Bun installs dependencies and runs scripts substantially faster than npm.
- `bun fmt` removes the Biome dependency and formats JS/TS/JSON/Markdown/MDX consistently.
- `bunx` invokes tooling (REA, Docusaurus) without a separate npm install.
- The same client library powers the CLI and tests.
- No build step for the viewer.

### Negative

- Bun is younger than Node; a dependency may occasionally need a Node fallback.
- The host still uses Node-compatible APIs (`node:fs`, `node:child_process`, `node:readline`);
  Bun supports them, but compatibility must be tested on upgrades.
- Bun's formatter is newer than Biome/Prettier; formatting churn is possible across releases.
- The host still requires macOS; the language does not change the platform constraint.

### Neutral

- The protocol is language-agnostic; a future Swift/Go host can implement it.
- `package.json` remains the manifest format, so npm-compatible publishing is still possible.

## Alternatives

| Stack               | Why not now                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| npm + Node + Biome  | Previous setup; slower installs, two toolchains, extra formatter dependency                                            |
| Swift host          | Best Apple integration, but a second language and macOS-only dev experience; client still needs a cross-platform stack |
| Go host + TS client | Good performance, but duplicates types and validation; more moving parts                                               |
| Rust                | Strong performance/safety, slower iteration for this scope                                                             |
| Python              | Weaker typing/ergonomics for a streaming server; packaging friction                                                    |

## Follow-ups

- Test Bun upgrades against the Linux E2E and macOS integration suites.
- Benchmark a native video path before adding one.
- Keep the protocol as the contract, not the implementation.
- Pin and audit dependencies; use `bun audit`.
