# Roadmap

The canonical roadmap system is in **[docs-site/docs/roadmaps/index.md](docs-site/docs/roadmaps/index.md)**.

It is layered so the same document is not asked to answer every planning question:

| Altitude | Document                                                                      | Use                                             |
| -------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| L0       | [Product roadmap](docs-site/docs/plans/roadmap.md)                            | Outcomes, releases, non-goals                   |
| L1       | [Native platform roadmap](docs-site/docs/native/roadmap.md)                   | Native phases, gates, critical path             |
| L1       | [Engineering quality roadmap](docs-site/docs/roadmaps/engineering-quality.md) | Fuzzing, differential testing, CI, performance  |
| L1       | [Research and legal roadmap](docs-site/docs/roadmaps/research-legal.md)       | Evidence, provenance, licensing gates           |
| L2       | [Native technical roadmap](docs-site/docs/roadmaps/native/technical.md)       | Workstreams, work packages, acceptance criteria |
| L3       | [Bridge backlog](docs-site/docs/roadmaps/bridge/backlog.md)                   | Live shipping queue and next bridge task        |
| L3       | [Native backlog](docs-site/docs/roadmaps/native/backlog.md)                   | Live status, ready queue, pick-next protocol    |

**Current next tasks:** `LDR-003` (loader initializers) and `THR-012` (concurrency stress).
Use separate worktrees per track.

**Recently completed:** `KRN-001..005` (C11/Bun-FFI kernel boundary), `THR-001..004` (thread
objects, scheduler, blocking bridge, pthread core), and `UI-000` (clean-room native X11 blank
window). None of these is Apple UIKit or a simulator.

The native track is a research programme. It does not run the iOS Simulator; see
[limitations](docs-site/docs/native/limitations.md).
