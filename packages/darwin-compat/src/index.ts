/**
 * Option A native Darwin compatibility layer — research implementation.
 *
 * This package is intentionally layered. Each module can be imported and
 * tested in isolation:
 *
 * - macho:   Mach-O / chained fixups / exports trie parsing and fixture writing
 * - arm64:   A64 assembler helpers and user-mode integer interpreter
 * - mach:    ports, rights, messages, bootstrap service registry, MIG-lite
 * - xpc:     typed XPC-style codec and request/reply connection
 * - dyld:    sparse VM, image loading, fixups, export resolution
 * - syscall: Darwin syscall and Mach trap dispatch with a jailed file layer
 * - launchd: plist jobs, MachServices, bounded RunAtLoad/KeepAlive execution
 * - runtime: the process orchestrator tying every layer together
 */

export * from "./errors.js";
export * from "./binary.js";
export * from "./macho/index.js";
export * from "./arm64/index.js";
export * from "./mach/index.js";
export * from "./xpc/index.js";
export * from "./dyld/index.js";
export * from "./syscall/index.js";
export * from "./plist/index.js";
export * from "./launchd/index.js";
export * from "./runtime/index.js";
export * from "./observability/index.js";
export * from "./capabilities.js";
export * from "./provenance/ledger.js";
export * from "./inspect.js";
export * from "./demo.js";
