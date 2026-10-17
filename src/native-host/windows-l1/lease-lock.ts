/** Native exclusive store lock. No stale PID heuristics, inheritable handle or ACL edits. */
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import { validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
const valid = (v: unknown) =>
  v !== undefined && v !== null && v !== 0 && v !== 0n && v !== -1n && v !== -1 && v !== 0xffffffffffffffffn;
const okay = (v: unknown) => v === true || (typeof v === "number" && v !== 0);
const fail = (stage: string) => new CrotError("CONFINEMENT_FAILED", `Windows lease lock: ${stage} failed.`, { stage });
export function bindWindowsLeaseLock(ffi: TokenFfi, kernel32: string) {
  const k = ffi.load(kernel32);
  const create = k.func(
    "void * __stdcall CreateFileW(str16 path,uint32_t access,uint32_t share,void *security,uint32_t disposition,uint32_t flags,void *templateFile)",
  );
  const info = k.func("int __stdcall GetFileInformationByHandle(void *handle,_Out_ uint8_t *info)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const handleInfo = k.func("int __stdcall GetHandleInformation(void *handle,_Out_ uint32_t *flags)");
  // Retain failed setup CloseHandle ownership. A later lock cannot forget it.
  const pending = new Set<unknown>();
  const release = (handle: unknown) => {
    if (!okay(close(handle))) throw fail("handle release");
    pending.delete(handle);
  };
  return async (file: string): Promise<{ close(): void }> => {
    validateWindowsPath(file);
    if (!/^[A-Za-z]:\\/.test(file)) throw fail("local lock path");
    for (const h of pending) release(h);
    // OPEN_EXISTING, no sharing, no security attributes/inheritance; lock
    // access includes read/write DATA so Windows share-access accounting really
    // excludes a second owner. OPEN_REPARSE_POINT inspects the lock object instead of following it.
    const handle = create(file, 0xc0000000, 0, null, 3, 0x00200000, null);
    if (!valid(handle)) throw fail("exclusive open");
    try {
      const data = Buffer.alloc(52),
        flags = Buffer.alloc(4);
      if (!okay(info(handle, data)) || (data.readUInt32LE(0) & 0x410) !== 0 || data.readUInt32LE(40) !== 1)
        throw fail("lock object type");
      if (!okay(handleInfo(handle, flags)) || (flags.readUInt32LE(0) & 1) !== 0) throw fail("handle inheritance");
      let closed = false;
      return {
        close: () => {
          if (closed) return;
          release(handle);
          closed = true;
        },
      };
    } catch (error) {
      try {
        release(handle);
      } catch {
        pending.add(handle); /* failed setup keeps ownership */
      }
      throw error;
    }
  };
}
export async function loadWindowsLeaseLock() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Windows lease lock requires native 64-bit Windows.");
  const root = validateWindowsPath(process.env.SystemRoot ?? "C:\\Windows");
  if (!/^[A-Za-z]:\\/.test(root)) throw fail("system directory");
  const name: string = "koffi",
    loaded = await import(name);
  return bindWindowsLeaseLock(loaded.default ?? loaded, path.win32.join(root, "System32", "kernel32.dll"));
}
