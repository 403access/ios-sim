# DarwinHost native kernel boundary

C11 shared library for tasks, port rights, bounded message queues, blocking receive, timeouts,
interruption, and bootstrap services. Loaded through Bun FFI; no second protocol. This is the
KRN-001 spike and the start of the native Mach boundary, not an Apple kernel.

```bash
bun run build:kernel        # C library + C tests
bun run test:kernel         # C tests + Bun FFI smoke
bun run test:kernel:linux   # Linux container
```

- `include/darwin_host.h` — ABI v1
- `src/host.c` — tasks, names, ports, queues, blocking, services
- `src/ffi.ts` — Bun FFI binding
- `tests/test_host.c` — C tests
- `tests/ffi-smoke.ts` — Bun FFI smoke
- `infra/kernel/Dockerfile` — Linux test image

See [ADR 0007](../../docs-site/docs/adr/native-kernel-boundary.md) and the
[host ABI guide](../../docs-site/docs/native/host-abi.md).
