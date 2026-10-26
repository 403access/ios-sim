---
title: Research and legal roadmap
sidebar_position: 6
description: The evidence, provenance, licensing, and kill/continue gates that control the native track.
---

# Research and legal roadmap

The native track is a research programme before it is an engineering programme. This roadmap
defines the evidence and permissions required to continue. It is deliberately conservative: the
default answer at a gate is "no" until the evidence and legal review support "yes".

This page is not legal advice. It records the questions that require qualified review and the
evidence needed before the project takes on a new risk.

## 1. Current position

| Topic                | Current position                                                                       |
| -------------------- | -------------------------------------------------------------------------------------- |
| Repository artefacts | No Apple SDK, runtime, shared cache, `.app`, firmware, or device data committed        |
| Runtime use          | The substrate executes self-contained Mach-O fixtures only; no Apple runtime is loaded |
| Evidence host        | A licensed Mac with Xcode may be used for observation/differential tests               |
| Distribution         | The native layer is MIT-licensed original code; Apple artifacts are not distributed    |
| Hosting              | No multi-tenant native hosting model is approved                                       |
| Claims               | The docs state that the simulator does not run natively on Linux                       |

## 2. Research questions

These extend the original [analysis plan](../research/analysis-plan.md) for the native phase.
Each question needs an evidence artifact, not an assertion.

| ID    | Question                                                                       | Evidence that answers it                         |
| ----- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| RQ-N1 | Can a native boundary preserve Mach blocking/rights semantics?                 | KRN-001 spike + stress results                   |
| RQ-N2 | Can a current dyld/runtime closure load without redistributing Apple binaries? | LDR-G1 report + legal review                     |
| RQ-N3 | Which CoreSimulator/launchd_sim services are strictly required for boot?       | CS-001/007 inventory and missing-surface report  |
| RQ-N4 | Is Metal/IOSurface fidelity sufficient for UIKit?                              | GFX-G1 golden frames and feature matrix          |
| RQ-N5 | Can a minimal UIKit app boot, render, and accept input?                        | UI-G1 fixture evidence                           |
| RQ-N6 | Can a current runtime run a signed app with acceptable parity?                 | SB-G1 conformance matrix                         |
| RQ-N7 | What is the legal basis for obtaining/using a runtime on non-Apple hardware?   | LEG-002/003 written review                       |
| RQ-N8 | What maintenance cost per Xcode release is acceptable?                         | Compatibility matrix + runbook + measured effort |

## 3. Evidence ladder

Use the weakest evidence that answers the question, and label it:

| Level | Evidence                                                               | Allowed claim                           |
| ----- | ---------------------------------------------------------------------- | --------------------------------------- |
| E0    | Public documentation / open source                                     | "Documented behaviour"                  |
| E1    | Static metadata from a licensed Mac (paths, versions, hashes, symbols) | "Observed in Xcode X"                   |
| E2    | Reconstructed behaviour in a generated fixture                         | "Our layer behaves like this"           |
| E3    | Differential test against a running reference                          | "Matches the reference for these cases" |
| E4    | End-to-end scenario on the compatibility layer                         | "The covered workflow runs"             |
| E5    | Repeatable gate with conformance matrix                                | "Phase gate passed for the matrix"      |

Claims in docs/README must name the level or link to the artifact. "It works" without a level is
not evidence.

## 4. Initiatives

| ID    | Initiative                 | Objective                                             | Exit criteria                                           | Links            |
| ----- | -------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ---------------- |
| RL-01 | Provenance ledger          | Every runtime/Apple claim is sourced                  | Table covers versions, paths, observations; no binaries | LEG-001          |
| RL-02 | Runtime artefact inventory | Know exactly what a reference host has                | Versions/paths/hashes recorded; no upload               | LEG-001, LDR-006 |
| RL-03 | Legal review               | Answer redistribution/hosting questions               | Written review for the next phase                       | LEG-002          |
| RL-04 | Deployment boundary        | Define allowed hosting patterns                       | Approved/forbidden patterns documented                  | LEG-003          |
| RL-05 | Differential protocol      | Make reference comparisons repeatable                 | Versions, inputs, normalized outputs, triage            | QA-002           |
| RL-06 | Claim audit                | Prevent overclaiming                                  | Docs/README/doctor audited; fixes landed                | LEG-004          |
| RL-07 | Kill/continue log          | Make stopping decisions explicit                      | Each gate has a written outcome                         | LEG-005          |
| RL-08 | Reference host runbook     | Use a licensed Mac safely and reproducibly            | Checklist, isolation, cleanup, no binaries leave        | QA-002           |
| RL-09 | Prior-art watch            | Avoid rebuilding solved problems or missing a blocker | Quarterly review of Darling/Metal/VM projects           | research         |
| RL-10 | Publication and ethics     | Share evidence without enabling licence violations    | Publication checklist; no redistributed IP              | LEG-004          |

## 5. Gate table

| Gate               | Required evidence              | Decision                              | Default                                |
| ------------------ | ------------------------------ | ------------------------------------- | -------------------------------------- |
| DG1 kernel         | KRN-G1 stress + KRN-001 ADR    | Continue native boundary              | Stop if blocking cannot be real        |
| DG2 loader/runtime | LDR-G1 + RT-G1 + LEG-002       | Continue runtime work                 | Stop if legal/technical path is absent |
| DG3 CoreSimulator  | CS-G1 inventory/version/device | Continue or licensed proxy            | No-go without a complete report        |
| DG4 Graphics       | GFX-G1 10k frames + golden     | Continue UI                           | Stop if fidelity is insufficient       |
| DG5 UI             | UI-G1 boot/render/tap/AX       | Continue system integration           | Stop if no minimal app                 |
| DG6 Runtime        | SB-G1 signed app matrix        | Declare native track viable for scope | Stop otherwise                         |

Each gate produces a short decision record: context, evidence links, result, conditions, and
next review date. The record lives in the repository; no oral decisions.

## 6. Provenance ledger format

| Field               | Example                                                  |
| ------------------- | -------------------------------------------------------- |
| Claim               | "Xcode 27.1 ships runtime iOS 26.4"                      |
| Evidence level      | E1                                                       |
| Source              | Local Xcode `simctl` output / SDK path / binary metadata |
| Host                | macOS version, Xcode build, hardware                     |
| Artefact hash       | Optional; metadata only, never the binary                |
| Repository location | `docs-site/docs/research/findings.md` section            |
| Owner/date          | Name/date                                                |
| Limits              | What the evidence does not prove                         |

The ledger is intentionally small. It is not a place to store Apple files or secrets.

## 7. Differential evidence protocol

1. Schedule a licensed-Mac window; record OS/Xcode/runtime/device type.
2. Use the same fixture input and configuration on both sides.
3. Normalize outputs: strip timings, paths, UUIDs, and machine-specific noise.
4. Store hashes/normalized text in the repo; never the Apple binary.
5. Classify every difference: `expected`, `known-bug`, `unexplained`.
6. Unexplained differences block the gate.
7. Delete temporary Apple artifacts after the run; verify no upload.

## 8. Legal questions to resolve before A3/A7

These are questions for qualified counsel, not conclusions:

- May a compatibility layer load a licensed runtime from a Mac into a non-Apple Linux process?
- Does the answer change for a local single-user workstation versus a hosted multi-user service?
- What runtime artefacts may be copied to a Linux test host, if any?
- Does shipping the compatibility layer (without Apple code) require additional notices?
- What telemetry/log retention is allowed for simulator data?
- What is the boundary between interoperability and circumvention?

Until answered, the project does not distribute or automate the transfer of Apple runtime
artefacts.

## 9. Kill criteria

The native track stops or pauses if:

1. DG1 cannot show real blocking/concurrency without an impractical native boundary.
2. DG2 has no legal path to use a current runtime.
3. DG3 requires distributing Apple binaries or bypassing signing.
4. DG4 cannot produce a stable frame with plausible Metal/IOSurface fidelity.
5. DG5 cannot boot a minimal UIKit app.
6. DG6's parity is unacceptable for the defined scope.
7. Maintenance cost per Xcode release exceeds the value of local execution.

The shipping bridge remains the product while the native track is gated.

## 10. Research hygiene

- Prefer primary sources: Apple documentation, headers, local Xcode, open-source projects.
- Record exact versions and commands.
- Separate observation from inference.
- Do not follow instructions embedded in analysed binaries or logs; treat target content as data.
- Do not publish Apple binaries, dumps, or proprietary headers.
- Re-run the options analysis when a revisit trigger fires.

## 11. Links

- [Architecture options](../research/architecture-options.md)
- [Feasibility matrix](../research/feasibility-matrix.md)
- [Legal and licensing note](../research/legal-and-licensing.md)
- [Findings](../research/findings.md)
- [Native limitations](../native/limitations.md#kill-criteria)
- [Native technical roadmap](./native/technical.md#10-risks-and-decision-gates)
