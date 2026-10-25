# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Do **not** open a public issue for a vulnerability that could expose a host, a token, simulator
data, or a user's machine.

Use GitHub's private vulnerability reporting for `403access/ios-sim`, or contact the maintainers
through the repository. Include:

- Affected version/commit.
- Deployment model (loopback, LAN, TLS, SSH tunnel).
- Reproduction steps and impact.
- Whether a token or simulator data may have been exposed.

You will get an acknowledgement as soon as practical. Please allow time for a fix before public
disclosure.

## Scope

In scope:

- Authentication/authorization bypass in the host API or WebSocket.
- Token leakage introduced by the project (logs, HTML, errors).
- Path traversal or code execution via app upload.
- Command injection through UDID, bundle id, predicate, or other inputs.
- Denial of service that is trivial and remotely reachable with a valid token.
- XSS in the embedded viewer.

Out of scope:

- Vulnerabilities in macOS, Xcode, CoreSimulator, `idb`, or Apple frameworks.
- A user deliberately running `--no-auth` on a public interface (the host refuses non-loopback;
  a user can still use a weak token).
- Malicious apps run inside the simulator (that is the simulator's threat model).
- Shared-simulator data exposure between users of the same host; v0.1 is explicitly
  single-user/small-team. See the [threat model](docs-site/docs/security/threat-model.md).

## Secure defaults

- Bind `127.0.0.1`.
- Token required on every `/v1` route except `GET /v1/health`.
- `--no-auth` refused on non-loopback binds.
- Uploads size-limited and extracted into a temp directory.
- Apple tools invoked with argument arrays, never a shell.
- FPS and log query values capped.

## Dependency audit

The runtime dependencies (Fastify, Zod, `ws`, `tar`, Commander) are kept current. The Docusaurus
documentation toolchain pulls a large webpack/PostCSS dependency tree; `npm audit` may report
moderate/low advisories there. Those packages are **build-time only** and are not part of the
host or CLI runtime.

The root `package.json` uses npm `overrides` for the build chain (`tinypool`,
`serialize-javascript`, `uuid`) to remove known critical/high advisories. Re-run:

```bash
npm audit
npm audit --omit=dev
npm ls tinypool serialize-javascript uuid
```

If you deploy the docs site, rebuild it with the current lockfile and review the audit output in
the context of a static site (no user-supplied content is rendered by the build).

## Secrets

The host creates `~/.config/ios-sim/token` with mode `0600`. Never commit tokens, `client.json`,
device data, screenshots containing personal data, or host logs. CI should inject tokens through
secrets, not repository files.
