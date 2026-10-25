---

title: "ADR 0005: Token auth, loopback by default, no in-process TLS"
sidebar_position: 5
description: The v0.1 security posture and why transport security is delegated.
---

# ADR 0005: Token auth, loopback by default, no in-process TLS

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Engineering, security

## Context

The host can boot devices, install apps, inject input, capture screenshots, and read logs. It must
not be an unauthenticated service. At the same time, v0.1 should be easy to run on a developer's
Mac and through an SSH tunnel.

Options:

1. No auth (loopback only).
2. Shared bearer token.
3. Per-user tokens + accounts.
4. mTLS.
5. In-process TLS + token.

## Decision

- Require a **shared bearer token** by default (generated on first run, stored `0600`).
- Bind to **127.0.0.1** by default.
- Refuse `--no-auth` on a non-loopback bind.
- Do **not** implement TLS in-process in v0.1. Recommend an **SSH tunnel** (primary) or a TLS
  reverse proxy (LAN).
- Allow `?token=` for WebSocket/SSE because browsers cannot set headers; document the leakage
  risk and prefer the viewer's token prompt.

## Consequences

### Positive

- Simple to operate and test.
- Safe default: no port exposed unless the operator changes the bind.
- Works with the browser viewer without a certificate setup.
- Transport security can be added without changing the auth model.

### Negative

- One long-lived shared secret; no per-user revocation.
- Token in a URL can leak via history/proxies.
- Plain HTTP on a LAN is interceptable if the operator ignores the tunnel guidance.
- No rate limiting or account lockout.

### Neutral

- A reverse proxy can add TLS and client certs later.
- Per-user tokens and short-lived tokens are Phase 2/3.

## Alternatives

| Option            | Why not v0.1                                                 |
| ----------------- | ------------------------------------------------------------ |
| No auth           | Too dangerous; a misconfigured bind exposes the host         |
| Per-user accounts | Needs storage, lifecycle, UI; premature                      |
| mTLS              | Strong, but certificate distribution is heavy for a dev tool |
| In-process TLS    | Adds cert management and config; SSH/proxy covers the need   |
| OAuth/OIDC        | Overkill for a single host                                   |

## Follow-ups

- Add short-lived tokens and rotation.
- Add rate limits and audit logs.
- Add optional TLS or document a hardened proxy configuration.
- Redact tokens from logs and error messages.
- Revisit when multi-user hosting is introduced.
