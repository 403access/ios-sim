/**
 * Bun FFI binding for DarwinHost.
 *
 * The native library is a narrow C ABI loaded with `dlopen`. There is no
 * second protocol and no JSON hop: a send/receive call goes straight into the
 * C host, including blocking receive and timeouts.
 *
 * This module is Bun-only by design. Pure TypeScript consumers can import the
 * constants/types without loading the library.
 */

import { dlopen, ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DH_ABI_VERSION = 1;
export const DH_TIMEOUT_NONE = 0;
export const DH_TIMEOUT_FOREVER = 0xffff_ffff;
export const DH_MAX_MESSAGE_WORDS = 1024;
export const DH_MAX_QUEUE_DEPTH = 256;

export const DH_RIGHT_SEND = 1;
export const DH_RIGHT_RECEIVE = 2;
export const DH_RIGHT_SEND_ONCE = 4;
export const DH_RIGHT_PORT_SET = 8;
export const DH_NOTIFY_DEAD = 0x0ead0001;

export const DH_THREAD_RUNNABLE = 1;
export const DH_THREAD_RUNNING = 2;
export const DH_THREAD_BLOCKED = 3;
export const DH_THREAD_TERMINATED = 4;

export enum DHStatus {
  OK = 0,
  InvalidArgument = 1,
  InvalidTask = 2,
  InvalidName = 3,
  InvalidRight = 4,
  QueueFull = 5,
  MessageTooLarge = 6,
  Timeout = 7,
  Interrupted = 8,
  NoSpace = 9,
  DuplicateService = 10,
  NotFound = 11,
  State = 12,
}

export const DH_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "dh_ok",
  1: "dh_invalid_argument",
  2: "dh_invalid_task",
  3: "dh_invalid_name",
  4: "dh_invalid_right",
  5: "dh_queue_full",
  6: "dh_message_too_large",
  7: "dh_timeout",
  8: "dh_interrupted",
  9: "dh_no_space",
  10: "dh_duplicate_service",
  11: "dh_not_found",
  12: "dh_state",
};

export class DarwinHostError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, operation: string) {
    const code = DH_STATUS_NAMES[status] ?? `dh_unknown_${status}`;
    super(`${operation} failed: ${code} (${status})`);
    this.name = "DarwinHostError";
    this.status = status;
    this.code = code;
  }
}

export interface ReceivedMessage {
  readonly status: number;
  readonly body: Uint32Array;
  readonly messageId: number;
  readonly remoteName: number;
  readonly replyName: number;
}

export interface KernelStats {
  readonly tasks: number;
  readonly ports: number;
  readonly messages: number;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function nativeHostLibraryPath(): string {
  if (process.env.DARWIN_HOST_LIB) return resolve(process.env.DARWIN_HOST_LIB);
  const name =
    process.platform === "darwin"
      ? "libdarwin_host.dylib"
      : process.platform === "linux"
        ? "libdarwin_host.so"
        : null;
  if (name === null) throw new DarwinHostError(DHStatus.State, "unsupported platform");
  return resolve(PACKAGE_ROOT, "build", name);
}

const SYMBOLS = {
  dh_abi_version: { args: [], returns: "u32" },
  dh_kernel_reset: { args: [], returns: "i32" },
  dh_task_create: { args: ["u32", "ptr"], returns: "i32" },
  dh_task_destroy: { args: ["u32"], returns: "i32" },
  dh_task_interrupt: { args: ["u32"], returns: "i32" },
  dh_thread_create: { args: ["u32", "ptr", "ptr"], returns: "i32" },
  dh_thread_terminate: { args: ["u32", "u32"], returns: "i32" },
  dh_thread_join: { args: ["u32", "u32", "u32"], returns: "i32" },
  dh_thread_state: { args: ["u32", "u32", "ptr"], returns: "i32" },
  dh_port_create_receive: { args: ["u32", "cstring", "ptr"], returns: "i32" },
  dh_reply_port: { args: ["u32", "ptr"], returns: "i32" },
  dh_port_make_send: { args: ["u32", "u32", "ptr"], returns: "i32" },
  dh_name_port_id: { args: ["u32", "u32", "ptr"], returns: "i32" },
  dh_name_deallocate: { args: ["u32", "u32"], returns: "i32" },
  dh_port_set_create: { args: ["u32", "ptr", "u32", "ptr"], returns: "i32" },
  dh_port_set_add: { args: ["u32", "u32", "u32"], returns: "i32" },
  dh_port_set_remove: { args: ["u32", "u32", "u32"], returns: "i32" },
  dh_port_register_dead_name: { args: ["u32", "u32", "u32"], returns: "i32" },
  dh_service_register: { args: ["u32", "cstring", "u32"], returns: "i32" },
  dh_service_lookup: { args: ["u32", "cstring", "ptr"], returns: "i32" },
  dh_send: { args: ["u32", "u32", "u32", "i32", "ptr", "u32"], returns: "i32" },
  dh_receive: {
    args: ["u32", "u32", "ptr", "u32", "ptr", "ptr", "ptr", "ptr", "u32"],
    returns: "i32",
  },
  dh_kernel_stats: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  dh_selftest_blocking: { args: [], returns: "i32" },
  dh_selftest_interrupt: { args: [], returns: "i32" },
  dh_selftest_threads: { args: [], returns: "i32" },
} as const;

type NativeLibrary = ReturnType<typeof dlopen>;

export class NativeHost {
  private readonly library: NativeLibrary;
  private readonly symbols: Record<string, (...args: unknown[]) => number>;

  constructor(path = nativeHostLibraryPath()) {
    if (!existsSync(path)) {
      throw new DarwinHostError(DHStatus.State, `native host library missing at ${path}`);
    }
    this.library = dlopen(path, SYMBOLS);
    this.symbols = this.library.symbols as Record<string, (...args: unknown[]) => number>;
    const version = this.abiVersion();
    if (version !== DH_ABI_VERSION) {
      this.library.close();
      throw new DarwinHostError(
        DHStatus.State,
        `ABI mismatch: library ${version}, binding ${DH_ABI_VERSION}`,
      );
    }
  }

  close(): void {
    this.library.close();
  }

  abiVersion(): number {
    return this.symbols.dh_abi_version!();
  }

  reset(): void {
    this.check("reset", this.symbols.dh_kernel_reset!());
  }

  createTask(pid: number): number {
    const out = new Uint32Array(1);
    this.check("task_create", this.symbols.dh_task_create!(pid, ptr(out)));
    return out[0]!;
  }

  destroyTask(task: number): void {
    this.check("task_destroy", this.symbols.dh_task_destroy!(task));
  }

  interruptTask(task: number): void {
    this.check("task_interrupt", this.symbols.dh_task_interrupt!(task));
  }

  createThread(task: number): { thread: number; portName: number } {
    const thread = new Uint32Array(1);
    const portName = new Uint32Array(1);
    this.check("thread_create", this.symbols.dh_thread_create!(task, ptr(thread), ptr(portName)));
    return { thread: thread[0]!, portName: portName[0]! };
  }

  terminateThread(task: number, thread: number): void {
    this.check("thread_terminate", this.symbols.dh_thread_terminate!(task, thread));
  }

  joinThread(task: number, thread: number, timeoutMs = DH_TIMEOUT_FOREVER): number {
    return this.symbols.dh_thread_join!(task, thread, timeoutMs);
  }

  threadState(task: number, thread: number): number {
    const state = new Uint32Array(1);
    this.check("thread_state", this.symbols.dh_thread_state!(task, thread, ptr(state)));
    return state[0]!;
  }

  createReceivePort(task: number, label: string): number {
    const out = new Uint32Array(1);
    this.check("port_create_receive", this.symbols.dh_port_create_receive!(task, label, ptr(out)));
    return out[0]!;
  }

  replyPort(task: number): number {
    const out = new Uint32Array(1);
    this.check("reply_port", this.symbols.dh_reply_port!(task, ptr(out)));
    return out[0]!;
  }

  makeSend(task: number, portId: number): number {
    const out = new Uint32Array(1);
    this.check("port_make_send", this.symbols.dh_port_make_send!(task, portId, ptr(out)));
    return out[0]!;
  }

  namePortId(task: number, name: number): number {
    const out = new Uint32Array(1);
    this.check("name_port_id", this.symbols.dh_name_port_id!(task, name, ptr(out)));
    return out[0]!;
  }

  deallocateName(task: number, name: number): void {
    this.check("name_deallocate", this.symbols.dh_name_deallocate!(task, name));
  }

  createPortSet(task: number, ports: readonly number[]): number {
    const out = new Uint32Array(1);
    this.check(
      "port_set_create",
      this.symbols.dh_port_set_create!(task, ptr(Uint32Array.from(ports)), ports.length, ptr(out)),
    );
    return out[0]!;
  }

  addPortToSet(task: number, setName: number, portName: number): void {
    this.check("port_set_add", this.symbols.dh_port_set_add!(task, setName, portName));
  }

  removePortFromSet(task: number, setName: number, portName: number): void {
    this.check("port_set_remove", this.symbols.dh_port_set_remove!(task, setName, portName));
  }

  registerDeadName(task: number, portName: number, notifyName: number): void {
    this.check(
      "port_register_dead_name",
      this.symbols.dh_port_register_dead_name!(task, portName, notifyName),
    );
  }

  registerService(task: number, service: string, name: number): void {
    this.check("service_register", this.symbols.dh_service_register!(task, service, name));
  }

  lookupService(task: number, service: string): number {
    const out = new Uint32Array(1);
    this.check("service_lookup", this.symbols.dh_service_lookup!(task, service, ptr(out)));
    return out[0]!;
  }

  send(task: number, remote: number, local: number, messageId: number, body: Uint32Array): number {
    return this.symbols.dh_send!(task, remote, local, messageId, ptr(body), body.length);
  }

  sendOrThrow(
    task: number,
    remote: number,
    local: number,
    messageId: number,
    body: Uint32Array,
  ): void {
    this.check("send", this.send(task, remote, local, messageId, body));
  }

  receive(
    task: number,
    name: number,
    capacity = DH_MAX_MESSAGE_WORDS,
    timeoutMs = DH_TIMEOUT_NONE,
  ): ReceivedMessage {
    const words = new Uint32Array(capacity);
    const count = new Uint32Array(1);
    const remote = new Uint32Array(1);
    const local = new Uint32Array(1);
    const messageId = new Int32Array(1);
    const status = this.symbols.dh_receive!(
      task,
      name,
      ptr(words),
      capacity,
      ptr(count),
      ptr(remote),
      ptr(local),
      ptr(messageId),
      timeoutMs,
    );
    return {
      status,
      body: words.slice(0, count[0]!),
      messageId: messageId[0]!,
      remoteName: remote[0]!,
      replyName: local[0]!,
    };
  }

  stats(): KernelStats {
    const tasks = new Uint32Array(1);
    const ports = new Uint32Array(1);
    const messages = new Uint32Array(1);
    this.check(
      "kernel_stats",
      this.symbols.dh_kernel_stats!(ptr(tasks), ptr(ports), ptr(messages)),
    );
    return { tasks: tasks[0]!, ports: ports[0]!, messages: messages[0]! };
  }

  selftestBlocking(): void {
    this.check("selftest_blocking", this.symbols.dh_selftest_blocking!());
  }

  selftestInterrupt(): void {
    this.check("selftest_interrupt", this.symbols.dh_selftest_interrupt!());
  }

  selftestThreads(): void {
    this.check("selftest_threads", this.symbols.dh_selftest_threads!());
  }

  private check(operation: string, status: number): void {
    if (status !== DHStatus.OK) throw new DarwinHostError(status, operation);
  }
}
