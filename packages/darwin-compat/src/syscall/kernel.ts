/**
 * BSD syscall + Mach trap dispatch for one emulated task.
 *
 * Files are confined to a caller-supplied root directory; the runtime never
 * resolves a guest path against the host filesystem directly. Unimplemented
 * syscalls fail loudly by default (`strict: true`) so a research run cannot
 * quietly believe it exercised a code path it did not.
 */

import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CompatError, SyscallError } from "../errors.js";
import type { Arm64Cpu, SyscallResult } from "../arm64/cpu.js";
import type { VirtualMemory } from "../dyld/vm.js";
import type { BlockingMachBridge } from "../runtime/blocking.js";
import type { GuestThread } from "../runtime/scheduler.js";
import {
  KERN_INVALID_ARGUMENT,
  KERN_MESSAGE_TOO_LARGE,
  KERN_RECEIVE_TIMED_OUT,
  KERN_SUCCESS,
  MACH_RCV_MSG,
  MACH_RCV_TIMEOUT,
  MACH_SEND_MSG,
  type MachKernel,
  type MachTask,
} from "../mach/kernel.js";
import { decodeMachMessage, encodeMachMessage } from "../mach/message.js";
import {
  DARWIN_MAP_ANON,
  DARWIN_MAP_FIXED,
  DARWIN_O_APPEND,
  DARWIN_O_CREAT,
  DARWIN_O_EXCL,
  DARWIN_O_RDWR,
  DARWIN_O_TRUNC,
  DARWIN_O_WRONLY,
  DARWIN_SEEK_CUR,
  DARWIN_SEEK_END,
  DARWIN_SEEK_SET,
  ERRNO_MAP,
  SYS_ACCESS,
  SYS_CLOSE,
  SYS_DUP,
  SYS_DUP2,
  SYS_EXIT,
  SYS_FCNTL,
  SYS_GETEGID,
  SYS_GETENTROPY,
  SYS_GETEUID,
  SYS_GETGID,
  SYS_GETPID,
  SYS_GETPPID,
  SYS_GETTIMEOFDAY,
  SYS_GETUID,
  SYS_HOST_SELF_TRAP,
  SYS_ISSETUGID,
  SYS_LSEEK,
  SYS_MACH_MSG_OVERWRITE_TRAP,
  SYS_MACH_MSG_TRAP,
  SYS_MACH_REPLY_PORT,
  SYS_MKDIR,
  SYS_MMAP,
  SYS_MPROTECT,
  SYS_MUNMAP,
  SYS_NAMES,
  SYS_OPEN,
  SYS_READ,
  SYS_TASK_SELF_TRAP,
  SYS_THREAD_SELF_TRAP,
  SYS_UNLINK,
  SYS_WRITE,
} from "./numbers.js";

export interface ByteSink {
  write(bytes: Uint8Array): number;
}

export class CaptureSink implements ByteSink {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  private readonly limit: number;
  truncated = false;

  constructor(limit = 4 * 1024 * 1024) {
    this.limit = limit;
  }

  write(bytes: Uint8Array): number {
    if (this.total >= this.limit) {
      this.truncated = true;
      return 0;
    }
    const room = this.limit - this.total;
    const chunk = bytes.length > room ? bytes.subarray(0, room) : bytes;
    this.chunks.push(chunk.slice());
    this.total += chunk.length;
    if (chunk.length !== bytes.length) this.truncated = true;
    return chunk.length;
  }

  bytes(): Uint8Array {
    const result = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  text(): string {
    return new TextDecoder().decode(this.bytes());
  }
}

interface StdinState {
  readonly bytes: Uint8Array;
  offset: number;
}

interface FdEntry {
  readonly kind: "stdin" | "stdout" | "stderr" | "file";
  readonly handle?: number;
  readonly path?: string;
  position: number;
  readonly append: boolean;
}

export interface SyscallTraceEvent {
  readonly pid: number;
  readonly number: number;
  readonly name: string;
  readonly args: readonly bigint[];
  readonly result: SyscallResult;
}

export interface SyscallKernelOptions {
  readonly memory: VirtualMemory;
  readonly mach: MachKernel;
  readonly task: MachTask;
  readonly rootDir: string;
  readonly stdout?: ByteSink;
  readonly stderr?: ByteSink;
  readonly stdin?: Uint8Array;
  readonly strict?: boolean;
  readonly trace?: (event: SyscallTraceEvent) => void;
  readonly blocking?: BlockingMachBridge;
}

const MAX_IO = 64 * 1024 * 1024;

export class DarwinSyscallKernel {
  readonly stdout: ByteSink;
  readonly stderr: ByteSink;
  readonly stdin: StdinState;
  readonly rootDir: string;
  readonly memory: VirtualMemory;
  readonly mach: MachKernel;
  readonly task: MachTask;
  readonly strict: boolean;
  readonly blocking: BlockingMachBridge | undefined;
  exitStatus: number | null = null;
  readonly unsupported = new Map<number, number>();
  private readonly trace: SyscallKernelOptions["trace"];
  private readonly fds = new Map<number, FdEntry>([
    [0, { kind: "stdin", position: 0, append: false }],
    [1, { kind: "stdout", position: 0, append: false }],
    [2, { kind: "stderr", position: 0, append: false }],
  ]);

  constructor(options: SyscallKernelOptions) {
    this.memory = options.memory;
    this.mach = options.mach;
    this.task = options.task;
    this.rootDir = resolve(options.rootDir);
    this.stdout = options.stdout ?? new CaptureSink();
    this.stderr = options.stderr ?? new CaptureSink();
    this.stdin = { bytes: options.stdin ?? new Uint8Array(), offset: 0 };
    this.strict = options.strict ?? true;
    this.blocking = options.blocking;
    this.trace = options.trace;
  }

  handle(number: number, cpu: Arm64Cpu, thread?: GuestThread): SyscallResult {
    const args: bigint[] = [];
    for (let index = 0; index < 7; index += 1) args.push(cpu.readRegister(index));
    let result: SyscallResult;
    try {
      result = this.dispatch(number, args, thread);
    } catch (error) {
      if (error instanceof CompatError && error.code === "memory_fault") throw error;
      if (this.strict) throw error;
      result = this.errno(errnoFor(error));
    }
    this.trace?.({
      pid: this.task.pid,
      number,
      name: SYS_NAMES[number] ?? `syscall_${number}`,
      args,
      result,
    });
    return result;
  }

  private dispatch(number: number, args: readonly bigint[], thread?: GuestThread): SyscallResult {
    switch (number) {
      case SYS_EXIT: {
        const status = Number(BigInt.asIntN(32, args[0] ?? 0n)) & 0xff;
        this.exitStatus = status;
        return { value: 0, halt: true };
      }
      case SYS_WRITE:
        return this.write(Number(args[0]!), args[1]!, Number(args[2]!));
      case SYS_READ:
        return this.read(Number(args[0]!), args[1]!, Number(args[2]!));
      case SYS_OPEN:
        return this.open(args[0]!, Number(args[1]!), Number(args[2]!));
      case SYS_CLOSE:
        return this.close(Number(args[0]!));
      case SYS_LSEEK:
        return this.seek(Number(args[0]!), BigInt.asIntN(64, args[1]!), Number(args[2]!));
      case SYS_MMAP:
        return this.mmap(
          args[0]!,
          Number(args[1]!),
          Number(args[2]!),
          Number(args[3]!),
          Number(BigInt.asIntN(32, args[4]!)),
          args[5]!,
        );
      case SYS_MUNMAP:
        return this.munmap(args[0]!, Number(args[1]!));
      case SYS_MPROTECT:
        return this.ok(0);
      case SYS_GETPID:
        return this.ok(this.task.pid);
      case SYS_GETPPID:
        return this.ok(1);
      case SYS_GETUID:
      case SYS_GETEUID:
        return this.ok(501);
      case SYS_GETGID:
      case SYS_GETEGID:
        return this.ok(20);
      case SYS_ISSETUGID:
        return this.ok(0);
      case SYS_GETTIMEOFDAY:
        return this.gettimeofday(args[0]!, args[1]!);
      case SYS_GETENTROPY:
        return this.getentropy(args[0]!, Number(args[1]!));
      case SYS_ACCESS:
        return this.access(args[0]!);
      case SYS_MKDIR:
        return this.mkdir(args[0]!, Number(args[1]!));
      case SYS_UNLINK:
        return this.unlink(args[0]!);
      case SYS_DUP:
        return this.dup(Number(args[0]!));
      case SYS_DUP2:
        return this.dup2(Number(args[0]!), Number(args[1]!));
      case SYS_FCNTL:
        return this.ok(0);
      case SYS_MACH_REPLY_PORT:
        return this.ok(this.mach.machReplyPort(this.task));
      case SYS_TASK_SELF_TRAP:
        return this.ok(this.mach.taskSelf(this.task));
      case SYS_THREAD_SELF_TRAP:
        return this.ok(this.mach.threadSelf(this.task));
      case SYS_HOST_SELF_TRAP:
        return this.ok(this.mach.hostSelf(this.task));
      case SYS_MACH_MSG_TRAP:
      case SYS_MACH_MSG_OVERWRITE_TRAP:
        return this.machMsg(args, thread);
      default: {
        this.unsupported.set(number, (this.unsupported.get(number) ?? 0) + 1);
        if (this.strict) {
          throw new SyscallError(
            "unsupported_syscall",
            `unsupported Darwin syscall ${number} (${SYS_NAMES[number] ?? "unknown"})`,
            { number, pid: this.task.pid },
          );
        }
        return this.errno(ERRNO_MAP.ENOSYS!);
      }
    }
  }

  private ok(value: number | bigint): SyscallResult {
    return { value };
  }

  private errno(code: number): SyscallResult {
    return { value: code, error: true };
  }

  private write(fd: number, address: bigint, count: number): SyscallResult {
    if (count < 0 || count > MAX_IO) return this.errno(ERRNO_MAP.EINVAL!);
    const entry = this.fds.get(fd);
    if (!entry || entry.kind === "stdin") return this.errno(ERRNO_MAP.EBADF!);
    const bytes = this.memory.readBytes(address, count);
    if (entry.kind === "stdout") return this.ok(this.stdout.write(bytes));
    if (entry.kind === "stderr") return this.ok(this.stderr.write(bytes));
    try {
      const written = entry.append
        ? writeSync(entry.handle!, bytes)
        : writeSync(entry.handle!, bytes, 0, bytes.length, entry.position);
      if (!entry.append) entry.position += written;
      return this.ok(written);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private read(fd: number, address: bigint, count: number): SyscallResult {
    if (count < 0 || count > MAX_IO) return this.errno(ERRNO_MAP.EINVAL!);
    const entry = this.fds.get(fd);
    if (!entry || entry.kind === "stdout" || entry.kind === "stderr")
      return this.errno(ERRNO_MAP.EBADF!);
    if (entry.kind === "stdin") {
      const available = this.stdin.bytes.length - this.stdin.offset;
      const length = Math.min(count, available);
      if (length > 0) {
        this.memory.writeBytes(
          address,
          this.stdin.bytes.subarray(this.stdin.offset, this.stdin.offset + length),
        );
        this.stdin.offset += length;
      }
      return this.ok(length);
    }
    try {
      const buffer = new Uint8Array(count);
      const length = readSync(entry.handle!, buffer, 0, count, entry.position);
      entry.position += length;
      this.memory.writeBytes(address, buffer.subarray(0, length));
      return this.ok(length);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private open(pathAddress: bigint, flags: number, mode: number): SyscallResult {
    const path = this.guestPath(pathAddress);
    try {
      const access = flags & 0x3;
      let nodeFlags =
        access === DARWIN_O_WRONLY
          ? fsConstants.O_WRONLY
          : access === DARWIN_O_RDWR
            ? fsConstants.O_RDWR
            : fsConstants.O_RDONLY;
      if (flags & DARWIN_O_CREAT) nodeFlags |= fsConstants.O_CREAT;
      if (flags & DARWIN_O_TRUNC) nodeFlags |= fsConstants.O_TRUNC;
      if (flags & DARWIN_O_APPEND) nodeFlags |= fsConstants.O_APPEND;
      if (flags & DARWIN_O_EXCL) nodeFlags |= fsConstants.O_EXCL;
      const handle = openSync(path, nodeFlags, mode & 0o777 || 0o644);
      const fd = this.nextFd();
      this.fds.set(fd, {
        kind: "file",
        handle,
        path,
        position: 0,
        append: (flags & DARWIN_O_APPEND) !== 0,
      });
      return this.ok(fd);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private close(fd: number): SyscallResult {
    if (fd <= 2) return this.errno(ERRNO_MAP.EBADF!);
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== "file") return this.errno(ERRNO_MAP.EBADF!);
    try {
      closeSync(entry.handle!);
      this.fds.delete(fd);
      return this.ok(0);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private seek(fd: number, offset: bigint, whence: number): SyscallResult {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== "file") return this.errno(ERRNO_MAP.EBADF!);
    const delta = Number(BigInt.asIntN(64, offset));
    if (whence === DARWIN_SEEK_SET) entry.position = delta;
    else if (whence === DARWIN_SEEK_CUR) entry.position += delta;
    else if (whence === DARWIN_SEEK_END) {
      try {
        entry.position = readFileSync(entry.path!).length + delta;
      } catch (error) {
        return this.errno(errnoFor(error));
      }
    } else {
      return this.errno(ERRNO_MAP.EINVAL!);
    }
    if (entry.position < 0) {
      entry.position = 0;
      return this.errno(ERRNO_MAP.EINVAL!);
    }
    return this.ok(entry.position);
  }

  private mmap(
    addressHint: bigint,
    length: number,
    _prot: number,
    flags: number,
    fd: number,
    offset: bigint,
  ): SyscallResult {
    if (length <= 0 || length > MAX_IO / 2) return this.errno(ERRNO_MAP.EINVAL!);
    const alignedLength = Math.ceil(length / this.memory.pageSize) * this.memory.pageSize;
    let address: bigint;
    try {
      if (flags & DARWIN_MAP_FIXED) {
        if (addressHint === 0n) return this.errno(ERRNO_MAP.EINVAL!);
        address = this.memory.mapFixed(addressHint, alignedLength, { tag: "mmap", protection: 3 });
      } else {
        address = this.memory.allocate(alignedLength, { tag: "mmap", protection: 3 });
      }
    } catch (error) {
      if (error instanceof CompatError && error.code === "memory_limit")
        return this.errno(ERRNO_MAP.ENOMEM!);
      throw error;
    }
    if (!(flags & DARWIN_MAP_ANON)) {
      const entry = this.fds.get(fd);
      if (!entry || entry.kind !== "file" || !entry.path) {
        this.memory.unmap(address, alignedLength);
        return this.errno(ERRNO_MAP.ENODEV!);
      }
      try {
        const contents = readFileSync(entry.path);
        const start = Number(BigInt.asIntN(64, offset));
        if (start < 0 || start > contents.length) {
          this.memory.unmap(address, alignedLength);
          return this.errno(ERRNO_MAP.EINVAL!);
        }
        const slice = contents.subarray(start, Math.min(contents.length, start + alignedLength));
        this.memory.writeBytes(address, slice);
      } catch (error) {
        this.memory.unmap(address, alignedLength);
        return this.errno(errnoFor(error));
      }
    }
    return this.ok(address);
  }

  private munmap(address: bigint, length: number): SyscallResult {
    if (length <= 0 || address < 0n) return this.errno(ERRNO_MAP.EINVAL!);
    const page = BigInt(this.memory.pageSize);
    const start = address & ~(page - 1n);
    const requestedEnd = address + BigInt(length);
    const end = (requestedEnd + page - 1n) & ~(page - 1n);
    try {
      this.memory.unmap(start, Number(end - start));
      return this.ok(0);
    } catch (error) {
      if (error instanceof CompatError && error.code === "unaligned_unmap")
        return this.errno(ERRNO_MAP.EINVAL!);
      return this.errno(ERRNO_MAP.EINVAL!);
    }
  }

  private gettimeofday(timeval: bigint, _timezone: bigint): SyscallResult {
    const now = Date.now();
    this.memory.write(timeval, 8, BigInt(Math.floor(now / 1000)));
    this.memory.write(timeval + 8n, 8, BigInt((now % 1000) * 1000));
    return this.ok(0);
  }

  private getentropy(buffer: bigint, length: number): SyscallResult {
    if (length < 0 || length > 256) return this.errno(ERRNO_MAP.EINVAL!);
    this.memory.writeBytes(buffer, randomBytes(length));
    return this.ok(0);
  }

  private access(pathAddress: bigint): SyscallResult {
    const path = this.guestPath(pathAddress);
    try {
      accessSync(path, fsConstants.R_OK);
      return this.ok(0);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private mkdir(pathAddress: bigint, mode: number): SyscallResult {
    const path = this.guestPath(pathAddress);
    try {
      mkdirSync(path, { mode: mode & 0o777 });
      return this.ok(0);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private unlink(pathAddress: bigint): SyscallResult {
    const path = this.guestPath(pathAddress);
    try {
      unlinkSync(path);
      return this.ok(0);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private dup(fd: number): SyscallResult {
    const entry = this.fds.get(fd);
    if (!entry) return this.errno(ERRNO_MAP.EBADF!);
    const next = this.nextFd();
    this.fds.set(next, entry);
    return this.ok(next);
  }

  private dup2(fd: number, target: number): SyscallResult {
    if (fd === target) return this.fds.has(fd) ? this.ok(target) : this.errno(ERRNO_MAP.EBADF!);
    const entry = this.fds.get(fd);
    if (!entry) return this.errno(ERRNO_MAP.EBADF!);
    const previous = this.fds.get(target);
    if (previous?.kind === "file") {
      try {
        closeSync(previous.handle!);
      } catch {
        // Best effort, matching close-on-replace semantics.
      }
    }
    this.fds.set(target, entry);
    return this.ok(target);
  }

  private machMsg(args: readonly bigint[], thread?: GuestThread): SyscallResult {
    const address = args[0]!;
    const option = Number(BigInt.asIntN(32, args[1]!));
    const sendSize = Number(BigInt.asIntN(32, args[2]!));
    const receiveSize = Number(BigInt.asIntN(32, args[3]!));
    const receiveName = Number(BigInt.asIntN(32, args[4]!));

    if (option & MACH_SEND_MSG) {
      if (sendSize < 24 || sendSize > 256 * 1024) return this.ok(KERN_INVALID_ARGUMENT);
      const bytes = this.memory.readBytes(address, sendSize);
      const message = decodeMachMessage(bytes);
      const result =
        this.blocking && thread
          ? this.blocking.send(
              this.task,
              message.header.remotePort,
              message.header.localPort,
              message.header.id,
              message.body,
            )
          : this.mach.send(this.task, message);
      if (result !== KERN_SUCCESS) return this.ok(result);
    }

    if (option & MACH_RCV_MSG) {
      if (this.blocking && thread) {
        const timeout = (option & MACH_RCV_TIMEOUT) === 0 ? 0xffff_ffff : Number(args[5]);
        const received = this.blocking.receive(thread, this.task, receiveName, timeout);
        if (received.blocked) return { value: KERN_RECEIVE_TIMED_OUT, blocked: true };
        if (received.status !== KERN_SUCCESS || !received.message) return this.ok(received.status);
        const bytes = encodeMachMessage(received.message.header, received.message.body);
        if (bytes.length > receiveSize) return this.ok(KERN_MESSAGE_TOO_LARGE);
        this.memory.writeBytes(address, bytes);
        return this.ok(KERN_SUCCESS);
      }
      const received = this.mach.receive(this.task, receiveName);
      if (received.result !== KERN_SUCCESS || !received.message) {
        return this.ok(received.result);
      }
      const bytes = encodeMachMessage(received.message.header, received.message.body);
      if (bytes.length > receiveSize) return this.ok(KERN_MESSAGE_TOO_LARGE);
      this.memory.writeBytes(address, bytes);
    }
    return this.ok(KERN_SUCCESS);
  }

  private nextFd(): number {
    let fd = 3;
    while (this.fds.has(fd)) fd += 1;
    return fd;
  }

  private guestPath(address: bigint): string {
    const guest = this.memory.readCString(address);
    if (guest.includes("\u0000")) throw new SyscallError("bad_path", "path contains a null byte");
    const relativePath = guest.startsWith("/") ? guest.slice(1) : guest;
    const candidate = resolve(this.rootDir, relativePath);
    const rel = relative(this.rootDir, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new SyscallError(
        "path_escape",
        `path ${guest} escapes the runtime root ${this.rootDir}`,
      );
    }
    return candidate;
  }
}

function errnoFor(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const map: Record<string, number> = {
    ENOENT: ERRNO_MAP.ENOENT!,
    EACCES: ERRNO_MAP.EACCES!,
    EPERM: ERRNO_MAP.EPERM!,
    EEXIST: ERRNO_MAP.EEXIST!,
    EISDIR: ERRNO_MAP.EISDIR!,
    ENOTDIR: ERRNO_MAP.ENOTDIR!,
    ENOSPC: ERRNO_MAP.ENOSPC!,
    EPIPE: ERRNO_MAP.EPIPE!,
    EBADF: ERRNO_MAP.EBADF!,
    EINVAL: ERRNO_MAP.EINVAL!,
  };
  return map[code] ?? ERRNO_MAP.EINVAL!;
}
