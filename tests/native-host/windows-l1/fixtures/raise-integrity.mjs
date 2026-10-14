/* Native Windows adversarial fixture. No service handles or real secrets. */
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
export default function probeRaiseIntegrity(koffiPath) {
  const ffi = createRequire(import.meta.url)(koffiPath);
  const a = ffi.load("advapi32.dll");
  const k = ffi.load("kernel32.dll");
  const H = "CROT_BYPASS_HANDLE";
  const L = "CROT_BYPASS_LABEL";
  ffi.struct(H, { value: "void *" });
  ffi.struct(L, { Sid: "void *", Attributes: "uint32_t" });
  const current = k.func("void * __stdcall GetCurrentProcess(void)");
  const open = a.func(`int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ ${H} *out)`);
  const sid = a.func(`int __stdcall ConvertStringSidToSidW(str16 text, _Out_ ${H} *out)`);
  const set = a.func("int __stdcall SetTokenInformation(void *token, int kind, void *info, uint32_t length)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const error = k.func("uint32_t __stdcall GetLastError(void)");
  const token = {},
    low = {},
    medium = {};
  const r = {};
  try {
    r.open = open(current(), 0x88, token); // QUERY | ADJUST_DEFAULT
    if (!r.open) {
      r.openError = error();
      return r;
    }
    r.lowSid = sid("S-1-16-4096", low);
    r.mediumSid = sid("S-1-16-8192", medium);
    if (!r.lowSid || !r.mediumSid) return r;
    const change = (p) => {
      const buffer = Buffer.alloc(ffi.sizeof(L) + 68);
      ffi.encode(buffer, L, { Sid: p, Attributes: 0x20 });
      return set(token.value, 25, buffer, buffer.length);
    };
    // Positive API/rights/ABI control: same Low label must be set successfully.
    r.sameLow = change(low.value);
    if (!r.sameLow) {
      r.lowError = error();
      return r;
    }
    r.raise = change(medium.value);
    r.raiseError = r.raise ? 0 : error();
    return r;
  } finally {
    if (medium.value) free(medium.value);
    if (low.value) free(low.value);
    if (token.value) close(token.value);
  }
}
