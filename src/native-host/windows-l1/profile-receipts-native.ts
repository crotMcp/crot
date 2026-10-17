/** Absolute system API bindings for the durable profile owner; no profile adoption. */
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import { validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
import type { ProfileReceiptNative } from "./profile-receipts.js";
interface Ffi extends TokenFfi {
  decode(pointer: unknown, type: string, length?: number): unknown;
}
const declared = new WeakSet<object>();
const fail = (stage: string, code?: number) =>
  new CrotError("CONFINEMENT_FAILED", `Windows durable profile: ${stage} failed.`, {
    stage,
    ...(code === undefined ? {} : { nativeCode: code }),
  });
const present = (v: unknown) => v !== null && v !== undefined && v !== 0 && v !== 0n;
export function bindProfileReceiptNative(ffi: Ffi, systemRoot: string): ProfileReceiptNative {
  const root = validateWindowsPath(systemRoot);
  if (!/^[A-Za-z]:\\/.test(root) || ffi.sizeof("void *") !== 8) throw fail("system/ABI admission");
  const H = "CROT_RECEIPT_SID_OUTPUT";
  if (!declared.has(ffi)) {
    ffi.struct(H, { value: "void *" });
    declared.add(ffi);
  }
  const u = ffi.load(path.win32.join(root, "System32", "userenv.dll")),
    a = ffi.load(path.win32.join(root, "System32", "advapi32.dll")),
    k = ffi.load(path.win32.join(root, "System32", "kernel32.dll"));
  const derive = u.func(`int32_t __stdcall DeriveAppContainerSidFromAppContainerName(str16 name,_Out_ ${H} *sid)`);
  const remove = u.func("int32_t __stdcall DeleteAppContainerProfile(str16 name)");
  const valid = a.func("int __stdcall IsValidSid(void *sid)");
  const text = a.func(`int __stdcall ConvertSidToStringSidW(void *sid,_Out_ ${H} *text)`);
  const freeSid = a.func("void * __stdcall FreeSid(void *sid)"),
    freeText = k.func("void * __stdcall LocalFree(void *value)");
  const pending = new Map<unknown, (v: unknown) => unknown>();
  const release = (v: unknown, free: (v: unknown) => unknown) => {
    if (!present(v)) return;
    pending.set(v, free);
    if (present(free(v))) throw fail("allocation release");
    pending.delete(v);
  };
  const retry = () => {
    for (const [v, free] of pending) release(v, free);
  };
  const name = (n: string) => {
    if (!/^crot\.l1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(n))
      throw fail("owned name");
  };
  return {
    derive: (n) => {
      retry();
      name(n);
      const sid: { value?: unknown } = {},
        out: { value?: unknown } = {};
      let value: string | undefined, failure: unknown;
      try {
        const status = Number(derive(n, sid));
        if (status !== 0 || !present(sid.value) || !valid(sid.value)) throw fail("SID derivation", status);
        if (!text(sid.value, out) || !present(out.value)) throw fail("SID text");
        const decoded = ffi.decode(out.value, "char16_t", -1);
        if (typeof decoded !== "string" || !/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(decoded))
          throw fail("derived SID shape");
        value = decoded;
      } catch (cause) {
        failure = cause;
      }
      for (const [v, free] of [
        [out.value, freeText],
        [sid.value, freeSid],
      ] as const)
        try {
          release(v, free);
        } catch (cause) {
          failure ??= cause;
        }
      if (failure) throw failure;
      return value!;
    },
    remove: (n) => {
      retry();
      name(n);
      const status = Number(remove(n));
      // S_OK includes the system API's verified idempotent deletion result.
      // No generic ACCESS_DENIED/NOT_FOUND error is relabelled as success.
      if (status !== 0) throw fail("profile removal", status);
    },
  };
}
export async function loadProfileReceiptNative() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw fail("native Windows admission");
  const m = await import("koffi");
  return bindProfileReceiptNative(m.default ?? m, process.env.SystemRoot ?? "C:\\Windows");
}
