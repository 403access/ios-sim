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
| L3       | [Native backlog](docs-site/docs/roadmaps/native/backlog.md)                   | Live status, ready queue, pick-next protocol    |

**Current next task:** `KRN-001` — choose and spike the native kernel boundary.

The native track is a research programme. It does not run the iOS Simulator; see
[limitations](docs-site/docs/native/limitations.md).
