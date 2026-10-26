# UIKitLite native window

A clean-room, C11 UIKit-compatible subset that opens a **native X11 window** on Linux. This is
not Apple UIKit, not a web view, and not an iOS app runtime. It exists to de-risk the host
window/renderer boundary for the Option A native track.

```bash
bun run build:uikit
packages/uikit-native/build/uikit-window --width 402 --height 874 --color 1e1e2e
bun run test:uikit   # Linux container + Xvfb + CLI integration
```

- `include/uikit.h` — public API (`UIApplication`, `UIWindow`, `UIView`, `UIColor`, …)
- `src/uikit.c` — object model and software ARGB renderer
- `src/uikit_x11.c` — native X11 event loop and present
- `examples/blank_window.c` — blank-window app
- `tests/test_uikit.c` — renderer/object-model unit tests
- `tests/x11-cli-smoke.sh` — Xvfb/CLI integration
- `infra/uikit-cli/Dockerfile` — Linux Bun + X11 test image

Requires `cc`, `pkg-config`, and X11 development headers (`libx11-dev` on Debian/Ubuntu).
Wayland desktops need XWayland. See
[the native window guide](../../docs-site/docs/native/uikit-window.md).
