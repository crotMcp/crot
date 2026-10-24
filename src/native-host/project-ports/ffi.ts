import type { FfiLoader } from "../windows-job.js";
export interface PortFfi {
  load(name: string): { func(signature: string): (...args: unknown[]) => unknown };
  struct(name: string, members: Record<string, string>): unknown;
  sizeof(name: string): number;
  decode(pointer: unknown, type: string, length?: number): unknown;
  address(pointer: unknown): bigint;
}
export async function loadPortFfi(load?: FfiLoader): Promise<PortFfi> {
  const moduleName: string = "koffi";
  const loaded = (load ? await load() : await import(moduleName)) as { default?: unknown };
  const ffi = (loaded.default ?? loaded) as PortFfi;
  if (
    typeof ffi?.load !== "function" ||
    typeof ffi.struct !== "function" ||
    typeof ffi.decode !== "function" ||
    typeof ffi.address !== "function" ||
    ffi.sizeof("void *") !== 8
  )
    throw new Error("Native process observation requires the qualified 64-bit FFI ABI");
  return ffi;
}
export const nativeOk = (value: unknown) =>
  value === true || (typeof value === "number" && value !== 0) || (typeof value === "bigint" && value !== 0n);
