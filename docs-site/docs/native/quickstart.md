---
title: Native quickstart
sidebar_position: 7
description: "Run the Option A substrate end to end: generated Mach-O demo, inspection, disassembly, fuzzing, and optional real-clang fixture."
---

# Native quickstart

This track runs user-space Darwin-compatibility layers, not the iOS Simulator or Apple UIKit.
Expect the generated demo to work everywhere and the real-clang fixture to run only on macOS with
clang installed.

## Prerequisites

- Bun 1.4.4 (`bun --version`)
- macOS with Xcode command-line tools for the optional real-clang fixture

## One command

```bash
bun install --frozen-lockfile
bun run quickstart
```

Expected output:

1. The hermetic demo prints `hello from darwin` and exits `42`.
2. `build/quickstart/doctor.json` contains `"simulator": false` and the versioned capability list.
3. On macOS with clang, a real arm64 Mach-O is built and run through `native-smoke.sh`.
4. On Linux, the clang step prints its skip reason and the quickstart still succeeds.

## Explore

```bash
bun apps/native/src/bin.ts doctor --json
bun apps/native/src/bin.ts inspect fixtures/darwin-hello/build/hello --disasm
bun apps/native/src/bin.ts boot <file> --service com.example.required
bun apps/native/src/bin.ts trace <file> --chrome
bun apps/native/src/bin.ts why <file>
```

Quality commands:

```bash
bun run corpus           # 23 generated Mach-O cases + manifest
bun run repro            # rebuild twice, compare SHA-256
bun run fuzz:1m          # 1M mutations per parser
bun run bench            # machine metadata + budgets
bun run soak --seconds 30
bun run provenance       # every claim points at evidence
```

## What success does not mean

`bun run quickstart` proves that the repository's Mach-O parser, loader, interpreter, and CLI run
end to end. It does **not** mean the simulator boots, Apple UIKit runs, or a real iOS app can be
installed. Those remain blocked by the licensed runtime and the platform work listed in
[Limitations](./limitations.md) and the [roadmap](./roadmap.md).
