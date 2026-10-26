/**
 * Minimal sysctl MIB surface (guest compatibility).
 *
 * Supports the common CPU/memory/OS identity queries a C runtime or libc
 * startup code asks for. Unknown MIBs return ENOENT rather than inventing a
 * value.
 */

export const CTL_KERN = 1;
export const CTL_HW = 6;

export const KERN_OSTYPE = 1;
export const KERN_OSRELEASE = 2;
export const KERN_HOSTNAME = 10;
export const KERN_OSVERSION = 65;

export const HW_MACHINE = 1;
export const HW_NCPU = 3;
export const HW_PAGESIZE = 7;
export const HW_MEMSIZE = 24;

export function sysctlValue(mib: readonly number[]): Uint8Array | null {
  if (mib.length !== 2) return null;
  const [level, name] = mib;
  if (level === CTL_KERN) {
    if (name === KERN_OSTYPE) return cstring("Darwin");
    if (name === KERN_OSRELEASE) return cstring("24.0.0");
    if (name === KERN_OSVERSION) return cstring("Darwin Kernel Version 24.0.0");
    if (name === KERN_HOSTNAME) return cstring("ios-sim-native");
  }
  if (level === CTL_HW) {
    if (name === HW_MACHINE) return cstring("arm64");
    if (name === HW_NCPU) return i32(1);
    if (name === HW_PAGESIZE) return i32(0x4000);
    if (name === HW_MEMSIZE) return i64(512n * 1024n * 1024n);
  }
  return null;
}

function cstring(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

function i32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}
