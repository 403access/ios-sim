import { RuntimeError } from "../errors.js";
import type { VirtualMemory } from "../dyld/vm.js";

export interface StackLayout {
  readonly argc: number;
  readonly argvPointer: bigint;
  readonly envpPointer: bigint;
  readonly stackPointer: bigint;
}

/**
 * Build a Darwin-like initial stack: strings, argv pointers, envp pointers,
 * and a 16-byte-aligned table. Registers are seeded by the caller.
 */
export function writeInitialStack(
  memory: VirtualMemory,
  stackBase: bigint,
  stackSize: number,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): StackLayout {
  const envEntries = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  let cursor = stackBase + BigInt(stackSize);
  const pushString = (value: string): bigint => {
    const bytes = new TextEncoder().encode(value);
    cursor -= BigInt(bytes.length + 1);
    if (cursor < stackBase)
      throw new RuntimeError("stack_overflow", "argv/env exceed the process stack");
    memory.writeBytes(cursor, bytes);
    memory.write(cursor + BigInt(bytes.length), 1, 0n);
    return cursor;
  };

  const argvPointers: bigint[] = [];
  for (const value of argv) argvPointers.push(pushString(value));
  const envpPointers: bigint[] = [];
  for (const value of envEntries) envpPointers.push(pushString(value));

  cursor &= ~0xfn;
  const pointerCount = 1 + argvPointers.length + 1 + envpPointers.length + 1;
  cursor -= BigInt(pointerCount * 8);
  if (cursor < stackBase)
    throw new RuntimeError("stack_overflow", "argv/env pointer table exceeds the process stack");
  cursor &= ~0xfn;
  if (cursor < stackBase)
    throw new RuntimeError("stack_overflow", "argv/env pointer table exceeds the process stack");
  const table = cursor;
  let at = table;
  memory.write(at, 8, BigInt(argvPointers.length));
  at += 8n;
  const argvPointer = at;
  for (const pointer of argvPointers) {
    memory.write(at, 8, pointer);
    at += 8n;
  }
  memory.write(at, 8, 0n);
  at += 8n;
  const envpPointer = at;
  for (const pointer of envpPointers) {
    memory.write(at, 8, pointer);
    at += 8n;
  }
  memory.write(at, 8, 0n);
  return { argc: argvPointers.length, argvPointer, envpPointer, stackPointer: table };
}
