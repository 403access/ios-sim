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
  renameSync,
  rmdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CompatError, SyscallError } from "../errors.js";
import type { Arm64Cpu, SyscallResult } from "../arm64/cpu.js";
import type { VirtualMemory } from "../dyld/vm.js";
import type { BlockingMachBridge } from "../runtime/blocking.js";
import type { GuestThread } from "../runtime/scheduler.js";
import { MallocHeap } from "../libc/memory.js";
import { Kqueue, KqueueError } from "./kqueue.js";
import { sysctlValue } from "./sysctl.js";
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
  DARWIN_O_RDONLY,
  DARWIN_O_RDWR,
  DARWIN_O_TRUNC,
  DARWIN_O_WRONLY,
  DARWIN_SEEK_CUR,
  DARWIN_SEEK_END,
  DARWIN_SEEK_SET,
  ERRNO_MAP,
  SYS_ACCESS,
  SYS_CHDIR,
  SYS_CLOSE,
  SYS_FCHDIR,
  SYS_DUP,
  SYS_DUP2,
  SYS_EXIT,
  SYS_FCNTL,
  SYS_FSTAT,
  SYS_LSTAT,
  SYS_STAT,
  SYS_GETEGID,
  SYS_GETDIRENTRIES,
  SYS_GETDIRENTRIES64,
  SYS_GETENTROPY,
  SYS_GETEUID,
  SYS_GETGID,
  SYS_GETPID,
  SYS_GETPPID,
  SYS_GETTIMEOFDAY,
  SYS_GETUID,
  SYS_KEVENT,
  SYS_KQUEUE,
  SYS_HOST_SELF_TRAP,
  SYS_ISSETUGID,
  SYS_LIBC_CALLOC,
  SYS_LIBC_FREE,
  SYS_LIBC_MALLOC,
  SYS_LIBC_MEMCPY,
  SYS_LIBC_MEMSET,
  SYS_LIBC_REALLOC,
  SYS_LIBC_STRLEN,
  SYS_LSEEK,
  SYS_MACH_MSG_OVERWRITE_TRAP,
  SYS_MACH_MSG_TRAP,
  SYS_MACH_REPLY_PORT,
  SYS_MKDIR,
  SYS_RENAME,
  SYS_RMDIR,
  SYS_MMAP,
  SYS_MPROTECT,
  SYS_MUNMAP,
  SYS_NAMES,
  SYS_OPEN,
  SYS_READ,
  SYS_READLINK,
  SYS_READV,
  SYS_SYSCTL,
  SYS_TASK_SELF_TRAP,
  SYS_THREAD_SELF_TRAP,
  SYS_UNLINK,
  SYS_WRITE,
  SYS_WRITEV,
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
  readonly kind: "stdin" | "stdout" | "stderr" | "file" | "dir" | "kqueue";
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
  private libcHeap: MallocHeap | null = null;
  private readonly kqueues = new Map<number, Kqueue>();
  private cwd = "/";
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
      case SYS_LIBC_MALLOC:
        return this.ok(Number(this.heap().malloc(Number(args[0]!))));
      case SYS_LIBC_FREE:
        this.heap().free(args[0]!);
        return this.ok(0);
      case SYS_LIBC_MEMCPY:
        this.heap().memcpy(args[0]!, args[1]!, Number(args[2]!));
        return this.ok(Number(args[0]!));
      case SYS_LIBC_STRLEN:
        return this.ok(this.heap().strlen(args[0]!));
      case SYS_LIBC_MEMSET:
        this.heap().memset(args[0]!, Number(args[1]!), Number(args[2]!));
        return this.ok(Number(args[0]!));
      case SYS_LIBC_REALLOC:
        return this.ok(Number(this.heap().realloc(args[0]!, Number(args[1]!))));
      case SYS_LIBC_CALLOC:
        return this.ok(Number(this.heap().calloc(Number(args[0]!), Number(args[1]!))));
      case SYS_WRITE:
        return this.write(Number(args[0]!), args[1]!, Number(args[2]!));
      case SYS_READ:
        return this.read(Number(args[0]!), args[1]!, Number(args[2]!));
      case SYS_READV:
        return this.readv(Number(args[0]!), args[1]!, Number(args[2]!));
      case SYS_WRITEV:
        return this.writev(Number(args[0]!), args[1]!, Number(args[2]!));
      case SYS_OPEN:
        return this.open(args[0]!, Number(args[1]!), Number(args[2]!));
      case SYS_KQUEUE:
        return this.createKqueue();
      case SYS_KEVENT:
        return this.kevent(
          Number(args[0]!),
          args[1]!,
          Number(args[2]!),
          args[3]!,
          Number(args[4]!),
          args[5]!,
        );
      case SYS_CLOSE:
        return this.close(Number(args[0]!));
      case SYS_CHDIR:
        return this.chdir(args[0]!);
      case SYS_FCHDIR:
        return this.fchdir(Number(args[0]!));
      case SYS_LSEEK:
        return this.seek(Number(args[0]!), BigInt.asIntN(64, args[1]!), Number(args[2]!));
      case SYS_FSTAT:
        return this.fstat(Number(args[0]!), args[1]!);
      case SYS_GETDIRENTRIES:
      case SYS_GETDIRENTRIES64:
        return this.getdirentries(Number(args[0]!), args[1]!, Number(args[2]!), args[3]!);
      case SYS_STAT:
        return this.statPath(args[0]!, args[1]!, true);
      case SYS_LSTAT:
        return this.statPath(args[0]!, args[1]!, false);
      case SYS_READLINK:
        return this.readlink(args[0]!, args[1]!, Number(args[2]!));
      case SYS_SYSCTL:
        return this.sysctl(args[0]!, Number(args[1]!), args[2]!, args[3]!);
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
        return this.access(args[0]!, Number(args[1]!));
      case SYS_MKDIR:
        return this.mkdir(args[0]!, Number(args[1]!));
      case SYS_UNLINK:
        return this.unlink(args[0]!);
      case SYS_DUP:
        return this.dup(Number(args[0]!));
      case SYS_DUP2:
        return this.dup2(Number(args[0]!), Number(args[1]!));
      case SYS_FCNTL:
        return this.fcntl(Number(args[0]!), Number(args[1]!), args[2]!);
      case SYS_RENAME:
        return this.rename(args[0]!, args[1]!);
      case SYS_RMDIR:
        return this.rmdir(args[0]!);
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

  private heap(): MallocHeap {
    if (!this.libcHeap) this.libcHeap = new MallocHeap(this.memory, 8 * 1024 * 1024);
    return this.libcHeap;
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

  private readv(fd: number, iov: bigint, count: number): SyscallResult {
    return this.vector(fd, iov, count, (address, length) => this.read(fd, address, length));
  }

  private writev(fd: number, iov: bigint, count: number): SyscallResult {
    return this.vector(fd, iov, count, (address, length) => this.write(fd, address, length));
  }

  private vector(
    _fd: number,
    iov: bigint,
    count: number,
    io: (address: bigint, length: number) => SyscallResult,
  ): SyscallResult {
    if (count < 0 || count > 1024) return this.errno(ERRNO_MAP.EINVAL!);
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const record = this.memory.readBytes(iov + BigInt(index * 16), 16);
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const address = view.getBigUint64(0, true);
      const length = Number(view.getBigUint64(8, true));
      const result = io(address, length);
      if (result.error) return result;
      total += Number(result.value);
    }
    return this.ok(total);
  }

  private read(fd: number, address: bigint, count: number): SyscallResult {
    if (count < 0 || count > MAX_IO) return this.errno(ERRNO_MAP.EINVAL!);
    const entry = this.fds.get(fd);
    if (!entry || entry.kind === "stdout" || entry.kind === "stderr")
      return this.errno(ERRNO_MAP.EBADF!);
    if (entry.kind === "dir") return this.errno(ERRNO_MAP.EISDIR!);
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
      let directory = false;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        // Missing paths can still be created below.
      }
      if (directory) {
        if (access !== DARWIN_O_RDONLY) return this.errno(ERRNO_MAP.EACCES!);
        const fd = this.nextFd();
        this.fds.set(fd, { kind: "dir", path, position: 0, append: false });
        return this.ok(fd);
      }
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
    if (entry?.kind === "kqueue") {
      this.fds.delete(fd);
      this.kqueues.delete(fd);
      return this.ok(0);
    }
    if (entry?.kind === "dir") {
      this.fds.delete(fd);
      return this.ok(0);
    }
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

  private access(pathAddress: bigint, mode: number): SyscallResult {
    const path = this.guestPath(pathAddress);
    const requested = mode & 0x7;
    const nodeMode =
      requested === 0
        ? fsConstants.F_OK
        : (requested & 0x4 ? fsConstants.R_OK : 0) |
          (requested & 0x2 ? fsConstants.W_OK : 0) |
          (requested & 0x1 ? fsConstants.X_OK : 0);
    try {
      accessSync(path, nodeMode);
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

  private fcntl(fd: number, command: number, argument: bigint): SyscallResult {
    const entry = this.fds.get(fd);
    if (!entry) return this.errno(ERRNO_MAP.EBADF!);
    if (command === 50) {
      const path = entry.path ? this.toGuestPath(entry.path) : "/";
      this.memory.writeBytes(argument, new TextEncoder().encode(`${path}\0`));
      return this.ok(0);
    }
    if (command === 0 || command === 67) {
      const next = this.nextFd();
      this.fds.set(next, entry);
      return this.ok(next);
    }
    return this.ok(0);
  }

  private rename(oldAddress: bigint, newAddress: bigint): SyscallResult {
    try {
      renameSync(this.guestPath(oldAddress), this.guestPath(newAddress));
      return this.ok(0);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private rmdir(pathAddress: bigint): SyscallResult {
    try {
      rmdirSync(this.guestPath(pathAddress));
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

  private sysctl(
    namePointer: bigint,
    nameLength: number,
    oldPointer: bigint,
    oldLengthPointer: bigint,
  ): SyscallResult {
    if (nameLength <= 0 || nameLength > 16 || namePointer === 0n) {
      return this.errno(ERRNO_MAP.EINVAL!);
    }
    const names: number[] = [];
    for (let index = 0; index < nameLength; index += 1) {
      names.push(Number(this.memory.read(namePointer + BigInt(index * 4), 4)) | 0);
    }
    const value = sysctlValue(names);
    if (!value) return this.errno(ERRNO_MAP.ENOENT!);
    if (oldPointer !== 0n && oldLengthPointer !== 0n) {
      const capacity = Number(this.memory.read(oldLengthPointer, 8));
      if (capacity < value.length) {
        this.memory.write(oldLengthPointer, 8, BigInt(value.length));
        return this.errno(ERRNO_MAP.ENOMEM!);
      }
      this.memory.writeBytes(oldPointer, value);
    }
    if (oldLengthPointer !== 0n) this.memory.write(oldLengthPointer, 8, BigInt(value.length));
    return this.ok(0);
  }

  private fstat(fd: number, address: bigint): SyscallResult {
    const entry = this.fds.get(fd);
    if (!entry) return this.errno(ERRNO_MAP.EBADF!);
    if (entry.kind === "file" && entry.path) {
      try {
        return this.writeStat(address, statSync(entry.path));
      } catch (error) {
        return this.errno(errnoFor(error));
      }
    }
    const bytes = new Uint8Array(144);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 0x2000 | 0o666, true);
    view.setUint16(6, 1, true);
    view.setInt32(112, 4096, true);
    this.memory.writeBytes(address, bytes);
    return this.ok(0);
  }

  private getdirentries(
    fd: number,
    buffer: bigint,
    byteCount: number,
    basePointer: bigint,
  ): SyscallResult {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== "dir" || !entry.path) return this.errno(ERRNO_MAP.EBADF!);
    if (byteCount < 0 || byteCount > MAX_IO) return this.errno(ERRNO_MAP.EINVAL!);
    let names: string[];
    try {
      names = readdirSync(entry.path).sort();
    } catch (error) {
      return this.errno(errnoFor(error));
    }
    let index = entry.position;
    let written = 0;
    while (index < names.length) {
      const name = names[index]!;
      const recordLength = Math.ceil((21 + name.length + 1) / 8) * 8;
      if (written + recordLength > byteCount) break;
      let ino = 0n;
      let type = 0;
      try {
        const stats = statSync(join(entry.path, name));
        ino = BigInt(stats.ino);
        type = stats.isDirectory() ? 4 : stats.isSymbolicLink?.() ? 10 : stats.isFile() ? 8 : 0;
      } catch {
        // Unreadable entries remain present with type 0.
      }
      index += 1;
      const record = new Uint8Array(recordLength);
      const view = new DataView(record.buffer);
      view.setBigUint64(0, ino, true);
      view.setBigUint64(8, BigInt(index), true);
      view.setUint16(16, recordLength, true);
      view.setUint16(18, name.length, true);
      record[20] = type;
      record.set(new TextEncoder().encode(`${name}\0`), 21);
      this.memory.writeBytes(buffer + BigInt(written), record);
      written += recordLength;
    }
    entry.position = index;
    if (basePointer !== 0n) this.memory.write(basePointer, 8, BigInt(index));
    return this.ok(written);
  }

  private chdir(pathPointer: bigint): SyscallResult {
    try {
      const guest = this.memory.readCString(pathPointer);
      const resolved = this.resolveGuestPath(guest);
      if (!statSync(resolved).isDirectory()) return this.errno(ERRNO_MAP.ENOTDIR!);
      this.cwd = this.toGuestPath(resolved);
      return this.ok(0);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private fchdir(fd: number): SyscallResult {
    const entry = this.fds.get(fd);
    if (!entry || entry.kind !== "dir" || !entry.path) return this.errno(ERRNO_MAP.EBADF!);
    this.cwd = this.toGuestPath(entry.path);
    return this.ok(0);
  }

  private toGuestPath(hostPath: string): string {
    const rel = relative(this.rootDir, hostPath);
    return rel.length === 0 ? "/" : `/${rel}`;
  }

  private statPath(pathPointer: bigint, address: bigint, follow: boolean): SyscallResult {
    try {
      const path = this.memory.readCString(pathPointer);
      const resolved = this.resolveGuestPath(path);
      return this.writeStat(address, follow ? statSync(resolved) : lstatSync(resolved));
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private readlink(pathPointer: bigint, buffer: bigint, size: number): SyscallResult {
    if (size < 0 || size > MAX_IO) return this.errno(ERRNO_MAP.EINVAL!);
    try {
      const path = this.memory.readCString(pathPointer);
      const target = readlinkSync(this.resolveGuestPath(path));
      const bytes = new TextEncoder().encode(target).subarray(0, size);
      this.memory.writeBytes(buffer, bytes);
      return this.ok(bytes.length);
    } catch (error) {
      return this.errno(errnoFor(error));
    }
  }

  private writeStat(address: bigint, stats: import("node:fs").Stats): SyscallResult {
    const bytes = new Uint8Array(144);
    const view = new DataView(bytes.buffer);
    const writeTimes = (offset: number, ms: number): void => {
      const seconds = Math.floor(ms / 1000);
      const nanos = Math.round((ms - seconds * 1000) * 1e6);
      view.setBigInt64(offset, BigInt(seconds), true);
      view.setBigInt64(offset + 8, BigInt(nanos), true);
    };
    view.setInt32(0, Number(stats.dev), true);
    view.setUint16(4, stats.mode, true);
    view.setUint16(6, stats.nlink, true);
    view.setBigUint64(8, BigInt(stats.ino), true);
    view.setUint32(16, stats.uid, true);
    view.setUint32(20, stats.gid, true);
    view.setInt32(24, Number(stats.rdev), true);
    writeTimes(32, stats.atimeMs);
    writeTimes(48, stats.mtimeMs);
    writeTimes(64, stats.ctimeMs);
    writeTimes(80, stats.birthtimeMs);
    view.setBigInt64(96, BigInt(stats.size), true);
    view.setBigInt64(104, BigInt(stats.blocks ?? Math.ceil(stats.size / 512)), true);
    view.setInt32(112, stats.blksize ?? 4096, true);
    this.memory.writeBytes(address, bytes);
    return this.ok(0);
  }

  private createKqueue(): SyscallResult {
    const fd = this.nextFd();
    this.fds.set(fd, { kind: "kqueue", position: 0, append: false });
    this.kqueues.set(fd, new Kqueue());
    return this.ok(fd);
  }

  private kevent(
    fd: number,
    changePointer: bigint,
    changeCount: number,
    eventPointer: bigint,
    eventCount: number,
    timeoutPointer: bigint,
  ): SyscallResult {
    const queue = this.kqueues.get(fd);
    if (!queue) return this.errno(ERRNO_MAP.EBADF!);
    if (changeCount < 0 || eventCount < 0) return this.errno(ERRNO_MAP.EINVAL!);
    try {
      for (let index = 0; index < changeCount; index += 1) {
        const event = readKevent(this.memory, changePointer + BigInt(index * 32));
        queue.add(event);
        this.markReady(queue, event.ident, event.filter);
      }
      if (eventCount === 0) return this.ok(0);
      const pause = timeoutPointer === 0n ? 0 : Number(this.memory.read(timeoutPointer, 8));
      const timeoutMs = Math.max(
        0,
        pause * 1000 + Number(this.memory.read(timeoutPointer + 8n, 8)) / 1e6,
      );
      let ready = queue.poll(this.now(), eventCount);
      if (ready.length === 0 && timeoutMs > 0) {
        // Semantic implementation: no scheduler here, so a timeout returns no events.
        ready = [];
      }
      ready.forEach((event, index) =>
        writeKevent(this.memory, eventPointer + BigInt(index * 32), event),
      );
      return this.ok(ready.length);
    } catch (error) {
      if (error instanceof KqueueError) return this.errno(ERRNO_MAP.EINVAL!);
      throw error;
    }
  }

  private pollKqueue(queue: Kqueue, max: number): import("./kqueue.js").KqueueEvent[] {
    const now = Date.now();
    return queue.poll(now, max);
  }

  private markReady(queue: Kqueue, ident: number, filter: number): void {
    if (filter === -1 && ident === 0 && this.stdin.offset < this.stdin.bytes.length)
      queue.signal(filter, ident);
    if (filter === -2 && (ident === 1 || ident === 2)) queue.signal(filter, ident);
  }

  private now(): number {
    return Date.now();
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
    return this.resolveGuestPath(this.memory.readCString(address));
  }

  private resolveGuestPath(guest: string): string {
    if (guest.includes("\u0000")) throw new SyscallError("bad_path", "path contains a null byte");
    if (guest.split("/").includes("..")) {
      throw new SyscallError("path_escape", `path ${guest} escapes the runtime root`);
    }
    const normalized = guest.startsWith("/") ? guest : join(this.cwd, guest);
    const relativePath = normalized.startsWith("/") ? normalized.slice(1) : normalized;
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

function readKevent(memory: VirtualMemory, address: bigint): import("./kqueue.js").KqueueEvent {
  const bytes = memory.readBytes(address, 32);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ident: Number(view.getBigUint64(0, true)),
    filter: view.getInt16(8, true),
    flags: view.getUint16(10, true),
    fflags: view.getUint32(12, true),
    data: view.getBigInt64(16, true),
    udata: view.getBigUint64(24, true),
  };
}

function writeKevent(
  memory: VirtualMemory,
  address: bigint,
  event: import("./kqueue.js").KqueueEvent,
): void {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(event.ident), true);
  view.setInt16(8, event.filter, true);
  view.setUint16(10, event.flags, true);
  view.setUint32(12, event.fflags, true);
  view.setBigInt64(16, event.data, true);
  view.setBigUint64(24, event.udata, true);
  memory.writeBytes(address, bytes);
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
