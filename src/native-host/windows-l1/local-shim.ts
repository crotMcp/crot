/** Trusted packaged DLL, compatibility only; no policy, NPFS grants or fallback. */
import { CrotError } from "../../core/errors.js";
import { validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
export interface LocalPipeShim {
  prepareSuspended(process: unknown): void;
  close(): void;
}
export function bindLocalPipeShim(ffi: TokenFfi, library: string): LocalPipeShim {
  const file = validateWindowsPath(library);
  if (!/^[A-Za-z]:\\/.test(file) || !file.toLowerCase().endsWith("\\crot-local-shim.dll"))
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Invalid packaged LOCAL shim path.");
  const native = ffi.load(file),
    version = native.func("uint32_t __stdcall CrotLocalShimVersion(void)");
  if (version() !== 1) throw new CrotError("CONFINEMENT_UNAVAILABLE", "Unsupported LOCAL shim ABI.");
  const unload = (native as { unload?: () => void }).unload;
  if (typeof unload !== "function")
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "LOCAL shim native loader cannot release its module.");
  let closed = false;
  const inject = native.func("uint32_t __stdcall CrotInjectLocalShim(void *process)");
  return {
    prepareSuspended: (process) => {
      if (closed) throw new CrotError("CONFINEMENT_FAILED", "LOCAL shim is closed.");
      if (process === undefined || process === null || process === 0 || process === 0n)
        throw new CrotError("CONFINEMENT_FAILED", "LOCAL shim requires an owned suspended process.");
      const code = Number(inject(process));
      if (code !== 0)
        throw new CrotError("CONFINEMENT_FAILED", "LOCAL shim injection failed before ResumeThread.", {
          nativeCode: code,
        });
    },
    close: () => {
      if (!closed) {
        unload.call(native);
        closed = true;
      }
    },
  };
}
