/* Own-token/own-child diagnostics only. No host secret/process inspection. */
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import process from "node:process";
const cache = new Map();
export function api(koffiPath) {
  if (cache.has(koffiPath)) return cache.get(koffiPath);
  const ffi = createRequire(import.meta.url)(koffiPath);
  const k = ffi.load("kernel32.dll");
  const a = ffi.load("advapi32.dll");
  ffi.struct("CROT_6A_HANDLE", { value: "void *" });
  ffi.struct("CROT_6A_DWORD", { value: "uint32_t" });
  ffi.struct("CROT_6A_PROCESS", { process: "void *", thread: "void *", pid: "uint32_t", tid: "uint32_t" });
  const result = {
    ffi,
    error: k.func("uint32_t __stdcall GetLastError(void)"),
    current: k.func("void * __stdcall GetCurrentProcess(void)"),
    standard: k.func("void * __stdcall GetStdHandle(uint32_t which)"),
    type: k.func("uint32_t __stdcall GetFileType(void *handle)"),
    handleInfo: k.func("int __stdcall GetHandleInformation(void *handle, _Out_ CROT_6A_DWORD *flags)"),
    token: a.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ CROT_6A_HANDLE *token)"),
    tokenInfo: a.func(
      "int __stdcall GetTokenInformation(void *token, uint32_t kind, void *buffer, uint32_t size, _Out_ CROT_6A_DWORD *needed)",
    ),
    sidText: a.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ CROT_6A_HANDLE *text)"),
    free: k.func("void * __stdcall LocalFree(void *memory)"),
    close: k.func("int __stdcall CloseHandle(void *handle)"),
    version: ffi.load("ntdll.dll").func("int32_t __stdcall RtlGetVersion(void *version)"),
    create: k.func(
      "int __stdcall CreateProcessW(str16 application, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, str16 cwd, void *startup, _Out_ CROT_6A_PROCESS *out)",
    ),
    inJob: k.func("int __stdcall IsProcessInJob(void *process, void *job, _Out_ CROT_6A_DWORD *result)"),
    resume: k.func("uint32_t __stdcall ResumeThread(void *thread)"),
    wait: k.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)"),
    terminate: k.func("int __stdcall TerminateProcess(void *process, uint32_t code)"),
    exit: k.func("int __stdcall GetExitCodeProcess(void *process, _Out_ CROT_6A_DWORD *code)"),
  };
  cache.set(koffiPath, result);
  return result;
}
const valid = (h) => h !== null && h !== undefined && BigInt(h) !== 0n && BigInt(h) !== 0xffffffffffffffffn;
export function sandboxApiAvailability(koffiPath) {
  const n = api(koffiPath);
  const kernel = n.ffi.load("kernel32.dll");
  const load = kernel.func("void * __stdcall LoadLibraryExW(str16 file, void *reserved, uint32_t flags)");
  const symbol = kernel.func("void * __stdcall GetProcAddress(void *module, str name)");
  const release = kernel.func("int __stdcall FreeLibrary(void *module)");
  const module = load("processmodel.dll", null, 0x800); // System32 only.
  if (!valid(module)) return { dll: false, error: n.error(), invoked: false };
  try {
    return {
      dll: true,
      create: valid(symbol(module, "Experimental_CreateProcessInSandbox")),
      asUser: valid(symbol(module, "Experimental_CreateProcessAsUserInSandbox")),
      invoked: false,
    };
  } finally {
    release(module);
  }
}
export function snapshot(koffiPath) {
  const n = api(koffiPath);
  const version = Buffer.alloc(284);
  version.writeUInt32LE(284);
  if (n.version(version) !== 0) throw new Error("RtlGetVersion failed");
  const token = {};
  if (!n.token(n.current(), 8, token)) throw new Error("own token query failed");
  let integrity;
  let elevated;
  try {
    const label = Buffer.alloc(256);
    if (!n.tokenInfo(token.value, 25, label, label.length, {})) throw new Error("own integrity query failed");
    const text = {};
    if (!n.sidText(n.ffi.decode(label, "void *"), text)) throw new Error("own integrity SID failed");
    try {
      integrity = n.ffi.decode(text.value, "str16");
    } finally {
      n.free(text.value);
    }
    const elevation = Buffer.alloc(4);
    if (!n.tokenInfo(token.value, 20, elevation, elevation.length, {})) throw new Error("own elevation query failed");
    elevated = elevation.readUInt32LE(0) !== 0;
  } finally {
    n.close(token.value);
  }
  return {
    node: process.version,
    uv: process.versions.uv,
    arch: process.arch,
    os: {
      major: version.readUInt32LE(4),
      minor: version.readUInt32LE(8),
      build: version.readUInt32LE(12),
      productType: version.readUInt8(282),
    },
    integrity,
    elevated,
    standard: [0xfffffff6, 0xfffffff5, 0xfffffff4].map((which) => {
      const h = n.standard(which);
      if (!valid(h)) return { valid: false };
      const flags = {};
      const ok = n.handleInfo(h, flags);
      return { valid: !!ok, error: ok ? 0 : n.error(), type: n.type(h), inheritable: !!(flags.value & 1) };
    }),
  };
}
const quote = (s) => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
/** Fixed test executable/fixture only; no broker or Medium execution path. */
export function nativeChild(koffiPath, fixture, cwd, suspended) {
  const n = api(koffiPath);
  const startup = Buffer.alloc(104);
  startup.writeUInt32LE(104);
  const out = {};
  const command = Buffer.from([process.execPath, fixture, "child"].map(quote).join(" ") + "\0", "utf16le");
  const created = n.create(
    process.execPath,
    command,
    null,
    null,
    0,
    0x08000000 | (suspended ? 4 : 0),
    null,
    cwd,
    startup,
    out,
  );
  const result = { attempted: true, created: !!created, error: created ? 0 : n.error() };
  if (!created) return result;
  try {
    const membership = {};
    result.inAnyJobQuery = !!n.inJob(out.process, null, membership);
    result.inAnyJob = membership.value === 1;
    if (suspended) {
      result.resume = n.resume(out.thread);
      result.resumeError = result.resume === 1 ? 0 : n.error();
    }
    result.wait = n.wait(out.process, 8000);
    if (result.wait === 258) {
      result.terminate = !!n.terminate(out.process, 1);
      result.terminationWait = n.wait(out.process, 5000);
    }
    const code = {};
    result.exitQuery = !!n.exit(out.process, code);
    result.exitCode = code.value;
  } finally {
    n.close(out.thread);
    n.close(out.process);
  }
  return result;
}
