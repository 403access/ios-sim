/**
 * Darwin arm64 syscall and Mach trap numbers used by the runtime.
 *
 * BSD numbers come from `<sys/syscall.h>` in the macOS SDK. Mach traps are the
 * negative values placed in `x16` by libsyscall stubs (for example
 * `_mach_msg_trap` loads `-31`). Only implemented entries are listed; the
 * kernel reports everything else as `ENOSYS`.
 */

export const SYS_EXIT = 1;
export const SYS_READ = 3;
export const SYS_READLINK = 58;
export const SYS_WRITE = 4;
export const SYS_OPEN = 5;
export const SYS_CHMOD = 15;
export const SYS_FSYNC = 95;
export const SYS_FCHMOD = 124;
export const SYS_TRUNCATE = 200;
export const SYS_FTRUNCATE = 201;
export const SYS_CHDIR = 12;
export const SYS_FCHDIR = 13;
export const SYS_CLOSE = 6;
export const SYS_UNLINK = 10;
export const SYS_GETPID = 20;
export const SYS_GETUID = 24;
export const SYS_GETEUID = 25;
export const SYS_ACCESS = 33;
export const SYS_GETPPID = 39;
export const SYS_DUP = 41;
export const SYS_GETEGID = 43;
export const SYS_GETGID = 47;
export const SYS_MUNMAP = 73;
export const SYS_MPROTECT = 74;
export const SYS_DUP2 = 90;
export const SYS_FCNTL = 92;
export const SYS_GETTIMEOFDAY = 116;
export const SYS_READV = 120;
export const SYS_WRITEV = 121;
export const SYS_RENAME = 128;
export const SYS_MKDIR = 136;
export const SYS_RMDIR = 137;
export const SYS_FSTAT = 189;
export const SYS_GETDIRENTRIES = 196;
export const SYS_GETDIRENTRIES64 = 344;
export const SYS_STAT = 188;
export const SYS_LSTAT = 190;
export const SYS_MMAP = 197;
export const SYS_LSEEK = 199;
export const SYS_SYSCTL = 202;
export const SYS_KQUEUE = 362;
export const SYS_KEVENT = 363;
export const SYS_ISSETUGID = 327;
export const SYS_GETENTROPY = 500;

export const SYS_MACH_REPLY_PORT = -26;
export const SYS_THREAD_SELF_TRAP = -27;
export const SYS_TASK_SELF_TRAP = -28;
export const SYS_HOST_SELF_TRAP = -29;
export const SYS_MACH_MSG_TRAP = -31;
export const SYS_MACH_MSG_OVERWRITE_TRAP = -32;

export const SYS_NAMES: Readonly<Record<number, string>> = {
  [SYS_EXIT]: "exit",
  [SYS_READ]: "read",
  [SYS_WRITE]: "write",
  [SYS_OPEN]: "open",
  [SYS_CLOSE]: "close",
  [SYS_UNLINK]: "unlink",
  [SYS_GETPID]: "getpid",
  [SYS_GETUID]: "getuid",
  [SYS_GETEUID]: "geteuid",
  [SYS_ACCESS]: "access",
  [SYS_GETPPID]: "getppid",
  [SYS_DUP]: "dup",
  [SYS_GETEGID]: "getegid",
  [SYS_GETGID]: "getgid",
  [SYS_MUNMAP]: "munmap",
  [SYS_MPROTECT]: "mprotect",
  [SYS_DUP2]: "dup2",
  [SYS_FCNTL]: "fcntl",
  [SYS_GETTIMEOFDAY]: "gettimeofday",
  [SYS_READV]: "readv",
  [SYS_WRITEV]: "writev",
  [SYS_MKDIR]: "mkdir",
  [SYS_FSTAT]: "fstat",
  [SYS_MMAP]: "mmap",
  [SYS_LSEEK]: "lseek",
  [SYS_SYSCTL]: "sysctl",
  [SYS_ISSETUGID]: "issetugid",
  [SYS_GETENTROPY]: "getentropy",
  [SYS_MACH_REPLY_PORT]: "mach_reply_port",
  [SYS_THREAD_SELF_TRAP]: "thread_self_trap",
  [SYS_TASK_SELF_TRAP]: "task_self_trap",
  [SYS_HOST_SELF_TRAP]: "host_self_trap",
  [SYS_MACH_MSG_TRAP]: "mach_msg_trap",
  [SYS_MACH_MSG_OVERWRITE_TRAP]: "mach_msg_overwrite_trap",
};

export const ERRNO_MAP: Readonly<Record<string, number>> = {
  EPERM: 1,
  ENOENT: 2,
  EACCES: 13,
  EBADF: 9,
  ENOMEM: 12,
  EFAULT: 14,
  EEXIST: 17,
  ENODEV: 19,
  EINVAL: 22,
  ENOTDIR: 20,
  EISDIR: 21,
  ENOSPC: 28,
  EPIPE: 32,
  ENOSYS: 78,
};

/** Darwin open(2) flags, not Linux's values. */
export const DARWIN_O_RDONLY = 0x0;
export const DARWIN_O_WRONLY = 0x1;
export const DARWIN_O_RDWR = 0x2;
export const DARWIN_O_APPEND = 0x8;
export const DARWIN_O_CREAT = 0x200;
export const DARWIN_O_TRUNC = 0x400;
export const DARWIN_O_EXCL = 0x800;

/** Darwin mmap(2) flags. */
export const DARWIN_MAP_PRIVATE = 0x2;
export const DARWIN_MAP_FIXED = 0x10;
export const DARWIN_MAP_ANON = 0x1000;
export const DARWIN_MAP_JIT = 0x8000;

export const DARWIN_PROT_READ = 0x1;
export const DARWIN_PROT_WRITE = 0x2;
export const DARWIN_PROT_EXEC = 0x4;

export const DARWIN_SEEK_SET = 0;
export const DARWIN_SEEK_CUR = 1;
export const DARWIN_SEEK_END = 2;

/** Option A guest-libc shims; not Apple syscall numbers. */
export const SYS_LIBC_MALLOC = 0x200;
export const SYS_LIBC_FREE = 0x201;
export const SYS_LIBC_MEMCPY = 0x202;
export const SYS_LIBC_STRLEN = 0x203;
export const SYS_LIBC_MEMSET = 0x204;
export const SYS_LIBC_REALLOC = 0x205;
export const SYS_LIBC_CALLOC = 0x206;
