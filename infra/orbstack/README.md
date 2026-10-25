# OrbStack

OrbStack is used in this repository as the **Linux test environment on the Mac**, not as a way to
run macOS on Linux.

## Linux client test

```bash
bun run test:linux
```

This builds `infra/linux/Dockerfile` and runs `scripts/linux-e2e.sh` inside the container. The
image contains only Bun, this repository, and a mock host. It proves that the CLI and protocol
do not depend on macOS.

## Optional: a real Linux machine

```bash
orbctl create ubuntu ios-sim-test
orbctl run ios-sim-test -- uname -a
```

Copy the repo or mount it, install Bun 1.4.4+, run `bun install --frozen-lockfile && bun run build`, and use
`scripts/linux-e2e.sh` or connect to a real Mac host. An OrbStack machine is a full Linux VM, so it
is a stronger check than a container for things like SSH tunnels and `xdg-open`.

## What OrbStack cannot do

OrbStack runs Linux on macOS. It cannot run macOS or the iOS Simulator on a Linux host. Do not
mistake "Linux VM on the Mac" for "macOS on Linux".
