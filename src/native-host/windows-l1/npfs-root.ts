/** Curator-authorized A.1 qualification ONLY. Not registered as production confinement.
 * Grants a fresh package SID precisely 0x100084 on the NPFS root, never a pipe.
 * The caller must drain its Job before closing; concurrent DACL edits fail closed.
 */
import { CrotError } from "../../core/errors.js";
import { validateSid } from "../validation.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";
export const NPFS_CREATE_MASK = 0x100084;
const H = "CROT_NPFS_HANDLE",
  N = "CROT_NPFS_SIZE";
const declared = new WeakSet<object>();
const retained = new Set<object>();
const valid = (v: unknown) =>
  v !== undefined && v !== null && v !== 0 && v !== 0n && v !== -1n && v !== 0xffffffffffffffffn;
const fail = (stage: string, nativeCode?: unknown) =>
  new CrotError("CONFINEMENT_FAILED", `NPFS root qualification ${stage} failed.`, { stage, nativeCode });
interface NpfsFfi extends TokenFfi {
  decode(pointer: unknown, type: string, length: number): unknown;
}
export function npfsGrantDescriptor(before: string, sid: string): string {
  validateSid(sid);
  if (!/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(sid) || before.includes(sid)) throw fail("fresh package SID admission");
  // Reject null/empty/conditional or unexpected descriptors rather than guessing.
  if (!/^D:[PAI]*(?:\([^()]+\))+$/.test(before)) throw fail("DACL representation");
  const inherited = [...before.matchAll(/\([^()]+\)/g)].find((m) => m[0].split(";")[1]?.includes("ID"));
  const at = inherited?.index ?? before.length;
  return before.slice(0, at) + `(A;;0x100084;;;${sid})` + before.slice(at);
}
export function bindNpfsRootQualification(ffi: NpfsFfi, libs: TokenLibraries) {
  if (!declared.has(ffi)) {
    ffi.struct(H, { value: "void *" });
    ffi.struct(N, { value: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof("void *") !== 8) throw fail("64-bit ABI");
  const k = ffi.load(libs.kernel32),
    a = ffi.load(libs.advapi32);
  const open = k.func(
    "void * __stdcall CreateFileW(str16 path,uint32_t access,uint32_t share,void *security,uint32_t disposition,uint32_t flags,void *templateFile)",
  );
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const get = a.func(
    `int __stdcall GetKernelObjectSecurity(void *handle,uint32_t flags,void *descriptor,uint32_t size,_Out_ ${N} *needed)`,
  );
  const set = a.func("int __stdcall SetKernelObjectSecurity(void *handle,uint32_t flags,void *descriptor)");
  const text = a.func(
    `int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor,uint32_t revision,uint32_t flags,_Out_ ${H} *out,_Out_ ${N} *length)`,
  );
  const sd = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text,uint32_t revision,_Out_ ${H} *out,void *size)`,
  );
  const snapshot = (handle: unknown) => {
    const needed: { value?: number } = {};
    if (get(handle, 4, null, 0, needed) || Number(last()) !== 122 || !needed.value || needed.value > 1048576)
      throw fail("DACL sizing", last());
    const result = Buffer.alloc(needed.value);
    if (!get(handle, 4, result, result.length, needed) || !needed.value || needed.value > result.length)
      throw fail("DACL read", last());
    return result.subarray(0, needed.value);
  };
  return (sid: string) => {
    // Validate before opening any shared object.
    npfsGrantDescriptor("D:(A;;GA;;;SY)", sid);
    if (retained.size) throw fail("previous incomplete cleanup");
    const state: {
      handle?: unknown;
      descriptor?: unknown;
      text?: unknown;
      before?: Buffer;
      installed?: Buffer;
      dirty: boolean;
    } = { dirty: false };
    retained.add(state);
    const apply = (buffer: unknown, control: Buffer) => {
      const flags = 4 | (control.readUInt16LE(2) & 0x1000 ? 0x80000000 : 0x20000000);
      if (!set(state.handle, flags >>> 0, buffer)) throw fail("DACL write", last());
    };
    const release = () => {
      if (state.dirty) {
        if (!state.before || !state.installed || !snapshot(state.handle).equals(state.installed))
          throw fail("concurrent DACL change; snapshot not overwritten");
        apply(state.before, state.before);
        if (!snapshot(state.handle).equals(state.before)) throw fail("exact DACL restoration");
        state.dirty = false;
      }
      for (const key of ["descriptor", "text"] as const)
        if (valid(state[key])) {
          if (valid(free(state[key]))) throw fail("descriptor release", last());
          state[key] = undefined;
        }
      if (valid(state.handle)) {
        if (!close(state.handle)) throw fail("root handle release", last());
        state.handle = undefined;
      }
      retained.delete(state);
    };
    try {
      state.handle = open("\\\\.\\pipe\\", 0x60000, 7, null, 3, 0, null);
      if (!valid(state.handle)) {
        state.handle = undefined;
        throw fail("root open", last());
      }
      state.before = snapshot(state.handle);
      const out: { value?: unknown } = {},
        length: { value?: number } = {};
      const converted = text(state.before, 1, 4, out, length);
      state.text = out.value;
      if (!converted || !valid(state.text) || !length.value || length.value > 524288)
        throw fail("DACL serialization", last());
      const before = ffi.decode(state.text, "char16_t", length.value - 1);
      if (typeof before !== "string") throw fail("DACL output");
      const next = npfsGrantDescriptor(before, sid),
        output: { value?: unknown } = {};
      const built = sd(next, 1, output, null);
      state.descriptor = output.value;
      if (!built || !valid(state.descriptor)) throw fail("grant descriptor", last());
      // Refuse to overwrite an edit made while constructing our descriptor.
      if (!snapshot(state.handle).equals(state.before)) throw fail("concurrent setup DACL change");
      apply(state.descriptor, state.before);
      state.dirty = true;
      state.installed = snapshot(state.handle);
      return { mask: NPFS_CREATE_MASK, close: release };
    } catch (cause) {
      try {
        release();
      } catch (cleanup) {
        throw new CrotError(
          "CONFINEMENT_FAILED",
          "NPFS qualification setup and cleanup failed.",
          { setup: String(cause) },
          { cause: cleanup },
        );
      }
      throw cause;
    }
  };
}
