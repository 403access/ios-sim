declare module "bun:ffi" {
  export type FFIType =
    | "u8"
    | "i8"
    | "u16"
    | "i16"
    | "u32"
    | "i32"
    | "u64"
    | "i64"
    | "f32"
    | "f64"
    | "ptr"
    | "cstring"
    | "void"
    | "bool";

  export interface FFIDefinition {
    readonly args: readonly FFIType[];
    readonly returns: FFIType;
  }

  export interface FFILibrary {
    readonly symbols: Record<string, (...args: unknown[]) => unknown>;
    close(): void;
  }

  export function dlopen(path: string, definitions: Record<string, FFIDefinition>): FFILibrary;
  export function ptr(value: ArrayBufferView): unknown;
}
