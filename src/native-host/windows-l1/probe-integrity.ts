/** WP-23c research labels. Not a policy installer; use disposable fixtures only. */
import { CrotError } from "../../core/errors.js";
import { validateWindowsPath } from "../validation.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";

const HANDLE = "CROT_L1_LABEL_HANDLE";
const DWORD = "CROT_L1_LABEL_DWORD";
const declared = new WeakSet<object>();
const success = (r: unknown) => r === true || (typeof r === "number" && r !== 0);
export type ProbeLabel = "low-write" | "medium-write" | "medium-no-read";
export function bindProbeIntegrity(ffi: TokenFfi, libraries: TokenLibraries) {
  if (!declared.has(ffi)) {
    ffi.struct(HANDLE, { value: "void *" });
    ffi.struct(DWORD, { value: "uint32_t" });
    declared.add(ffi);
  }
  const a = ffi.load(libraries.advapi32);
  const k = ffi.load(libraries.kernel32);
  const convert = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ ${HANDLE} *out, void *length)`,
  );
  const sacl = a.func(
    `int __stdcall GetSecurityDescriptorSacl(void *sd, _Out_ ${DWORD} *present, _Out_ ${HANDLE} *acl, _Out_ ${DWORD} *defaulted)`,
  );
  const set = a.func(
    "uint32_t __stdcall SetNamedSecurityInfoW(str16 path, int kind, uint32_t info, void *owner, void *group, void *dacl, void *sacl)",
  );
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  return (file: string, label: ProbeLabel): void => {
    validateWindowsPath(file);
    if (label !== "low-write" && label !== "medium-write" && label !== "medium-no-read")
      throw new CrotError("INVALID_INPUT", "Windows label spike: invalid fixture label.");
    const sd: { value?: unknown } = {};
    const fail = () => new CrotError("OPERATION_FAILED", "Windows label spike: fixture mandatory label failed.");
    try {
      const text =
        label === "low-write"
          ? "S:(ML;OICI;NW;;;LW)"
          : label === "medium-write"
            ? "S:(ML;OICI;NW;;;ME)"
            : "S:(ML;OICI;NWNR;;;ME)";
      if (!success(convert(text, 1, sd, null)) || !sd.value) throw fail();
      const present: { value?: number } = {};
      const acl: { value?: unknown } = {};
      const defaulted: { value?: number } = {};
      if (!success(sacl(sd.value, present, acl, defaulted)) || present.value !== 1 || !acl.value) throw fail();
      // LABEL_SECURITY_INFORMATION, not arbitrary SACL/DACL/owner changes.
      if (set(file, 1, 0x10, null, null, null, acl.value) !== 0) throw fail();
    } finally {
      if (sd.value) free(sd.value);
    }
  };
}
export async function loadProbeIntegrity() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new CrotError("OPERATION_FAILED", "Windows label spike requires native 64-bit Windows.");
  const name: string = "koffi";
  const imported = await import(name);
  const ffi = (imported.default ?? imported) as TokenFfi;
  return bindProbeIntegrity(ffi, { advapi32: "advapi32.dll", kernel32: "kernel32.dll" });
}
