/**
 * Machine-readable provenance ledger (LEG-001).
 *
 * Every claim the native track makes should point at a file, test, or command
 * that can be re-run. This ledger is intentionally conservative: it records
 * partial implementations and blockers, not aspirations.
 *
 * `scripts/check-provenance.ts` validates that evidence paths exist and that
 * required claims are present.
 */

export type ProvenanceStatus = "implemented" | "partial" | "blocked";

export interface ProvenanceEntry {
  readonly id: string;
  readonly claim: string;
  readonly status: ProvenanceStatus;
  readonly evidence: readonly string[];
  readonly command: string;
  readonly limitation?: string;
}

export const PROVENANCE: readonly ProvenanceEntry[] = [
  {
    id: "A0-MACHO",
    claim: "Parses 64-bit thin and fat arm64 Mach-O, load commands, symbols, and export tries.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/macho/parse.ts",
      "packages/darwin-compat/src/macho/parse.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/macho/parse.test.ts",
  },
  {
    id: "A0-FIXUPS",
    claim: "Applies chained fixups for PTR_64, PTR_64_OFFSET, and arm64e formats.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/macho/fixups.ts",
      "packages/darwin-compat/src/macho/fixups.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/macho/fixups.test.ts",
  },
  {
    id: "LDR-001",
    claim: "Decodes and applies legacy LC_DYLD_INFO rebase/bind opcode streams.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/macho/legacy-fixups.ts",
      "packages/darwin-compat/src/dyld/loader.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/dyld/loader.test.ts",
  },
  {
    id: "LDR-002",
    claim: "Records lazy binds for first-use binding and resolves weak binds flat, missing → null.",
    status: "partial",
    evidence: [
      "packages/darwin-compat/src/dyld/loader.ts",
      "packages/darwin-compat/src/dyld/loader.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/dyld/loader.test.ts",
    limitation: "No executable lazy-stub trampolines or general weak-definition coalescing.",
  },
  {
    id: "LDR-003",
    claim: "Runs __mod_init_func/__mod_term_func and LC_ROUTINES_64 around main.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/dyld/loader.ts",
      "packages/darwin-compat/src/runtime/process.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/dyld/loader.test.ts",
  },
  {
    id: "LDR-004",
    claim: "Provides reference-counted dlopen/dlsym/dlclose handles and unloads on last close.",
    status: "partial",
    evidence: [
      "packages/darwin-compat/src/dyld/dlopen.ts",
      "packages/darwin-compat/src/dyld/loader.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/dyld/loader.test.ts",
    limitation: "Guest dlopen syscalls, RTLD_GLOBAL, and interposition policy are not wired.",
  },
  {
    id: "LDR-005",
    claim: "Enforces dependency ordinals, flat load-order collisions, and __interpose pairs.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/dyld/loader.ts",
      "packages/darwin-compat/src/dyld/loader.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/dyld/loader.test.ts",
  },
  {
    id: "LDR-010",
    claim: "Parses embedded signatures, CodeDirectory fields, and XML entitlements.",
    status: "partial",
    evidence: [
      "packages/darwin-compat/src/macho/code-signature.ts",
      "packages/darwin-compat/src/macho/code-signature.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/macho/code-signature.test.ts",
    limitation: "Hashes, certificates, CMS, and entitlement policy are not verified.",
  },
  {
    id: "LDR-012",
    claim: "Reads bundle Info.plist, LC_FILESET_ENTRY, N_OSO dSYM objects, and UUID mismatches.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/macho/bundle.ts",
      "packages/darwin-compat/src/macho/bundle.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/macho/bundle.test.ts",
  },
  {
    id: "LDR-013",
    claim: "Produces structured loader diagnostics with a next action.",
    status: "implemented",
    evidence: ["packages/darwin-compat/src/dyld/diagnostics.ts", "apps/native/src/cli.ts"],
    command: "bunx vitest run packages/darwin-compat/src/dyld/diagnostics.test.ts",
  },
  {
    id: "THR-008",
    claim: "Provides guest timers, named readiness sources, and scheduler wakeups without polling.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/runtime/event-loop.ts",
      "packages/darwin-compat/src/runtime/event-loop.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/runtime/event-loop.test.ts",
  },
  {
    id: "THR-009",
    claim: "Implements realtime/monotonic clocks, Mach timebase conversion, and timer sleep.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/runtime/clock.ts",
      "packages/darwin-compat/src/runtime/clock.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/runtime/clock.test.ts",
  },
  {
    id: "THR-012",
    claim: "Stress-tests 64 guest threads and 64 fork/exit/reap processes.",
    status: "implemented",
    evidence: ["packages/darwin-compat/src/runtime/stress.test.ts"],
    command: "bunx vitest run packages/darwin-compat/src/runtime/stress.test.ts",
  },
  {
    id: "THR-010",
    claim: "Applies priority-ordered jetsam kills under critical memory pressure.",
    status: "partial",
    evidence: [
      "packages/darwin-compat/src/runtime/jetsam.ts",
      "packages/darwin-compat/src/runtime/jetsam.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/runtime/jetsam.test.ts",
    limitation: "Policy only; host memory accounting and guest pressure delivery are not wired.",
  },
  {
    id: "KRN-001",
    claim: "Uses a C11 shared library through Bun FFI for the native kernel boundary.",
    status: "implemented",
    evidence: [
      "docs-site/docs/adr/native-kernel-boundary.md",
      "packages/darwin-host/include/darwin_host.h",
      "packages/darwin-host/src/host.c",
    ],
    command: "bun run test:kernel",
  },
  {
    id: "KRN-012",
    claim: "Passes a 16-thread, one-million-message native port stress with zero queued messages.",
    status: "implemented",
    evidence: ["packages/darwin-host/tests/stress_host.c"],
    command: "make -C packages/darwin-host stress",
  },
  {
    id: "QA-001",
    claim: "Runs deterministic outcome-guided fuzzing over Mach-O, plist, and XPC at 1M mutations.",
    status: "implemented",
    evidence: ["packages/darwin-compat/src/testing/fuzz.ts", "scripts/fuzz-darwin.ts"],
    command: "bun run fuzz:1m",
  },
  {
    id: "QA-003",
    claim: "Generates a 23-case Mach-O corpus covering 15 load commands and five pointer formats.",
    status: "implemented",
    evidence: ["packages/darwin-compat/src/testing/corpus.ts", "scripts/build-corpus.ts"],
    command: "bun run corpus",
  },
  {
    id: "QA-004",
    claim: "Records machine metadata and enforces budgets for seven performance cases.",
    status: "implemented",
    evidence: ["packages/darwin-compat/src/testing/benchmark.ts", "scripts/bench.ts"],
    command: "bun run bench",
  },
  {
    id: "QA-006",
    claim: "Soaks Mach, loader, and process resources and fails on counter growth.",
    status: "implemented",
    evidence: ["packages/darwin-compat/src/testing/soak.ts", "scripts/soak.ts"],
    command: "bun run soak --seconds 30",
    limitation: "A 24-hour run uses the same code but is not part of the default test suite.",
  },
  {
    id: "OBS-001",
    claim: "Defines versioned JSON/NDJSON runtime events with redaction.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/observability/events.ts",
      "packages/darwin-compat/src/observability/events.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/observability/events.test.ts",
  },
  {
    id: "OBS-004",
    claim: "Exports runtime events as Chrome Trace Event JSON.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/observability/trace.ts",
      "packages/darwin-compat/src/observability/trace.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/observability/trace.test.ts",
  },
  {
    id: "OBS-006",
    claim: "Attaches a JSON-safe fault snapshot with PC, encoding, registers, maps, and images.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/observability/fault.ts",
      "packages/darwin-compat/src/observability/fault.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/observability/fault.test.ts",
  },
  {
    id: "DX-003",
    claim: "Publishes a versioned capability report with per-feature yes/partial/no states.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/capabilities.ts",
      "packages/darwin-compat/schema/capability-report.schema.json",
      "packages/darwin-compat/src/capabilities.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/capabilities.test.ts",
  },
  {
    id: "DX-001",
    claim: "Disassembles the integer/syscall AArch64 subset and prints unknown words.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/arm64/disassemble.ts",
      "packages/darwin-compat/src/arm64/disassemble.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/arm64/disassemble.test.ts",
  },
  {
    id: "DX-005",
    claim: "Provides a one-command quickstart for the generated demo and optional clang fixture.",
    status: "implemented",
    evidence: ["scripts/quickstart.sh", "docs-site/docs/native/quickstart.md"],
    command: "bun run quickstart",
  },
  {
    id: "UI-000",
    claim: "Shows a clean-room UIKit-compatible blank window in native X11.",
    status: "partial",
    evidence: ["packages/uikit-native", "docs-site/docs/native/uikit-window.md"],
    command: "bun run test:uikit",
    limitation: "This is a clean-room API subset and software renderer, not Apple UIKit.",
  },
  {
    id: "THR-011",
    claim: "Tracks session identity, roles, owned ports/services, and idempotent teardown.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/runtime/session.ts",
      "packages/darwin-compat/src/runtime/session.test.ts",
    ],
    command: "bunx vitest run packages/darwin-compat/src/runtime/session.test.ts",
  },
  {
    id: "DX-004",
    claim: "Builds a SHA-256 reproduction bundle with doctor, versions, corpus, and bench data.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/testing/repro.ts",
      "packages/darwin-compat/src/testing/repro.test.ts",
      "scripts/repro-bundle.ts",
    ],
    command: "bun run repro:bundle",
  },
  {
    id: "REL-006",
    claim: "Audits manifests, lockfile, ignore rules, and frozen install for supply-chain policy.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/provenance/supply-chain.ts",
      "packages/darwin-compat/src/provenance/supply-chain.test.ts",
      "scripts/check-supply-chain.ts",
    ],
    command: "bun run supply-chain",
  },
  {
    id: "REL-004",
    claim: "Enforces patch-only semver drift and exact host ABI/schema versions.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/version.ts",
      "packages/darwin-compat/src/version.test.ts",
      "scripts/check-versions.ts",
    ],
    command: "bun run versions",
  },
  {
    id: "DX-006",
    claim: "Validates the backlog for duplicate, stale, or unqueued task statuses.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/provenance/roadmap.ts",
      "packages/darwin-compat/src/provenance/roadmap.test.ts",
      "scripts/check-roadmap.ts",
    ],
    command: "bun run roadmap:check",
  },
  {
    id: "LEG-004",
    claim: "Audits documentation/source for false simulator, iOS, or Apple UIKit claims.",
    status: "implemented",
    evidence: [
      "packages/darwin-compat/src/provenance/claims.ts",
      "packages/darwin-compat/src/provenance/claims.test.ts",
      "scripts/check-claims.ts",
    ],
    command: "bun run claims",
  },
  {
    id: "BLOCKED-UIKIT",
    claim: "Apple UIKit, Metal, CoreSimulator, launchd_sim, and SpringBoard are not runnable here.",
    status: "blocked",
    evidence: ["docs-site/docs/native/limitations.md", "docs-site/docs/native/roadmap.md"],
    command: "bun run docs:build",
    limitation:
      "Requires licensed Apple runtime/frameworks, multi-year platform work, and legal review; no Apple binaries are committed.",
  },
];

export const REQUIRED_PROVENANCE_IDS = [
  "A0-MACHO",
  "LDR-001",
  "LDR-010",
  "THR-012",
  "KRN-001",
  "QA-001",
  "OBS-001",
  "DX-001",
  "BLOCKED-UIKIT",
] as const;

export interface ProvenanceProblem {
  readonly id: string;
  readonly message: string;
}

export function validateProvenance(
  entries: readonly ProvenanceEntry[] = PROVENANCE,
  required: readonly string[] = REQUIRED_PROVENANCE_IDS,
): ProvenanceProblem[] {
  const problems: ProvenanceProblem[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push({ id: entry.id, message: "duplicate id" });
    ids.add(entry.id);
    if (entry.claim.trim().length === 0) problems.push({ id: entry.id, message: "empty claim" });
    if (entry.evidence.length === 0) problems.push({ id: entry.id, message: "no evidence" });
    if (entry.command.trim().length === 0) problems.push({ id: entry.id, message: "no command" });
    if (entry.status === "blocked" && !entry.limitation) {
      problems.push({ id: entry.id, message: "blocked entry needs a limitation/blocker" });
    }
  }
  for (const id of required) {
    if (!ids.has(id)) problems.push({ id, message: "required claim is missing" });
  }
  return problems;
}
