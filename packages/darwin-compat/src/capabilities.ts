/**
 * Capability doctor schema (DX-003).
 *
 * The report is a versioned, JSON-safe capability snapshot. It is deliberately
 * explicit about the substrate/simulator boundary: `apple.simulator` and
 * `apple.uikit` are false, and the blocked list names what that implies.
 *
 * The matching JSON Schema lives at
 * `packages/darwin-compat/schema/capability-report.schema.json`.
 */

export const CAPABILITY_SCHEMA_VERSION = 1;

export type FeatureState = "yes" | "partial" | "no";

export interface CapabilityEntry {
  readonly id: string;
  readonly state: FeatureState;
  readonly detail: string;
}

export interface CapabilityReport {
  readonly schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  readonly service: "ios-sim-native";
  readonly version: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly simulator: false;
  readonly features: readonly CapabilityEntry[];
  readonly blocked: readonly CapabilityEntry[];
  readonly notes: readonly string[];
}

export const CAPABILITIES: readonly CapabilityEntry[] = [
  {
    id: "macho.parse",
    state: "yes",
    detail: "thin/fat arm64, load commands, symbols, export tries",
  },
  { id: "macho.chained", state: "yes", detail: "PTR_64, PTR_64_OFFSET, arm64e formats" },
  { id: "dyld.legacy", state: "yes", detail: "LC_DYLD_INFO rebase/bind opcodes" },
  { id: "dyld.lazy", state: "partial", detail: "sites recorded; caller binds on first use" },
  { id: "dyld.weak", state: "partial", detail: "flat lookup; missing becomes null" },
  { id: "dyld.initTerm", state: "yes", detail: "__mod_init_func/__mod_term_func, LC_ROUTINES_64" },
  { id: "dyld.dlopenApi", state: "yes", detail: "refcounted open/symbol/close handles" },
  { id: "dyld.dlopenSyscalls", state: "no", detail: "guest dlopen traps are not wired" },
  { id: "dyld.signatureParse", state: "yes", detail: "superblob, CodeDirectory, entitlements" },
  { id: "dyld.signatureVerify", state: "no", detail: "hashes, certificates, CMS unverified" },
  { id: "dyld.sharedCache", state: "no", detail: "licensed cache parsing is Mac-gated" },
  { id: "threads.scheduler", state: "yes", detail: "round-robin guest scheduler with block/wake" },
  { id: "threads.timers", state: "yes", detail: "timer/source event loop, no busy wait" },
  {
    id: "threads.processTable",
    state: "yes",
    detail: "fork/exec/waitpid/groups, 64-process stress",
  },
  { id: "threads.signals", state: "yes", detail: "handler/mask/raise/kill, SIGCHLD" },
  { id: "kernel.c11ffi", state: "yes", detail: "C11 host via Bun FFI, quotas and stress" },
  { id: "xpc.codec", state: "yes", detail: "typed XPC-style codec and Mach connection" },
  { id: "observability.events", state: "yes", detail: "schema v1 JSON/NDJSON with redaction" },
  { id: "observability.trace", state: "yes", detail: "Chrome Trace Event export" },
  { id: "quality.fuzz", state: "yes", detail: "1M outcome-guided mutations per parser" },
  { id: "quality.corpus", state: "yes", detail: "23 generated Mach-O cases" },
  { id: "quality.bench", state: "yes", detail: "machine metadata + seven budgeted cases" },
  { id: "quality.soak", state: "yes", detail: "Mach/loader/process counters, leak gate" },
  { id: "uikit.nativeX11", state: "partial", detail: "clean-room UIKit-compatible blank window" },
  {
    id: "apple.uikit",
    state: "no",
    detail: "Apple UIKit is not runnable without licensed frameworks",
  },
  { id: "apple.simulator", state: "no", detail: "no CoreSimulator/launchd_sim/SpringBoard boot" },
];

export const BLOCKED_CAPABILITIES: readonly CapabilityEntry[] = [
  { id: "dyld.sharedCache", state: "no", detail: "needs a licensed Mac and shared-cache reader" },
  { id: "dyld.signatureVerify", state: "no", detail: "security work plus trusted anchor policy" },
  { id: "dyld.dlopenSyscalls", state: "no", detail: "guest syscall wiring is future work" },
  { id: "apple.uikit", state: "no", detail: "licensed Apple runtime and multi-year platform work" },
  {
    id: "apple.simulator",
    state: "no",
    detail: "CoreSimulator, launchd_sim, SpringBoard, APFS images",
  },
  {
    id: "graphics.metal",
    state: "no",
    detail: "Metal/IOSurface/CoreAnimation are not implemented",
  },
  {
    id: "runtime.foundation",
    state: "no",
    detail: "Objective-C/Swift runtimes are not implemented",
  },
];

export function capabilityReport(): CapabilityReport {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    service: "ios-sim-native",
    version: "0.1.0",
    runtime: "bun",
    runtimeVersion: (process.versions as Record<string, string | undefined>).bun ?? process.version,
    platform: process.platform,
    architecture: process.arch,
    simulator: false,
    features: CAPABILITIES,
    blocked: BLOCKED_CAPABILITIES,
    notes: [
      "This is a research substrate, not a simulator.",
      "Clean-room UIKitLite in native X11 is not Apple UIKit.",
      "The CLI never loads Apple binaries; use your own arm64 Mach-O or the demo.",
    ],
  };
}

export interface CapabilityProblem {
  readonly path: string;
  readonly message: string;
}

const STATES: ReadonlySet<string> = new Set(["yes", "partial", "no"]);

export function validateCapabilityReport(value: unknown): CapabilityProblem[] {
  const problems: CapabilityProblem[] = [];
  if (typeof value !== "object" || value === null) {
    return [{ path: "", message: "report must be an object" }];
  }
  const report = value as Partial<CapabilityReport>;
  if (report.schemaVersion !== CAPABILITY_SCHEMA_VERSION) {
    problems.push({ path: "schemaVersion", message: "must be 1" });
  }
  for (const key of [
    "service",
    "version",
    "runtime",
    "runtimeVersion",
    "platform",
    "architecture",
  ] as const) {
    if (typeof report[key] !== "string" || (report[key] as string).length === 0) {
      problems.push({ path: key, message: "must be a non-empty string" });
    }
  }
  if (report.simulator !== false) {
    problems.push({ path: "simulator", message: "must be false for the research track" });
  }
  for (const listName of ["features", "blocked"] as const) {
    const list = report[listName];
    if (!Array.isArray(list)) {
      problems.push({ path: listName, message: "must be an array" });
      continue;
    }
    const ids = new Set<string>();
    list.forEach((entry: unknown, index: number) => {
      if (typeof entry !== "object" || entry === null) {
        problems.push({ path: `${listName}[${index}]`, message: "must be an object" });
        return;
      }
      const item = entry as Partial<CapabilityEntry>;
      if (typeof item.id !== "string" || item.id.length === 0) {
        problems.push({ path: `${listName}[${index}].id`, message: "must be a non-empty string" });
      } else if (ids.has(item.id)) {
        problems.push({ path: `${listName}[${index}].id`, message: "duplicate id" });
      } else {
        ids.add(item.id);
      }
      if (typeof item.state !== "string" || !STATES.has(item.state)) {
        problems.push({ path: `${listName}[${index}].state`, message: "must be yes/partial/no" });
      }
      if (typeof item.detail !== "string" || item.detail.length === 0) {
        problems.push({ path: `${listName}[${index}].detail`, message: "must be non-empty" });
      }
    });
  }
  if (!Array.isArray(report.notes) || report.notes.length === 0) {
    problems.push({ path: "notes", message: "must be a non-empty array" });
  }
  const apple = report.features?.find?.((entry) => entry.id === "apple.simulator");
  if (!apple || apple.state !== "no") {
    problems.push({ path: "features.apple.simulator", message: "must be present and no" });
  }
  return problems;
}
