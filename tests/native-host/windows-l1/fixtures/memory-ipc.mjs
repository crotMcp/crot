/* WP-23c disposable canaries only. Never read a real user's target process. */
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
const cache = new WeakMap();
export function bindings(koffiPath) {
  const ffi = createRequire(import.meta.url)(koffiPath);
  if (cache.has(ffi)) return cache.get(ffi);
  const k = ffi.load("kernel32.dll");
  const a = ffi.load("advapi32.dll");
  const H = "CROT_CANARY_HANDLE",
    D = "CROT_CANARY_DWORD",
    S = "CROT_CANARY_SIZE",
    A = "CROT_CANARY_ATTRIBUTES";
  ffi.struct(H, { value: "uintptr_t" });
  ffi.struct("CROT_CANARY_DESCRIPTOR", { value: "void *" });
  ffi.struct(D, { value: "uint32_t" });
  ffi.struct(S, { value: "uintptr_t" });
  ffi.struct(A, { nLength: "uint32_t", lpSecurityDescriptor: "void *", bInheritHandle: "int" });
  const api = {
    ffi,
    open: k.func("uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    current: k.func("uintptr_t __stdcall GetCurrentProcess(void)"),
    memory: k.func(
      `int __stdcall ReadProcessMemory(uintptr_t process, uintptr_t address, _Out_ uint8_t *buffer, uintptr_t size, _Out_ ${S} *read)`,
    ),
    duplicate: k.func(
      `int __stdcall DuplicateHandle(uintptr_t source, uintptr_t handle, uintptr_t target, _Out_ ${H} *out, uint32_t access, int inherit, uint32_t options)`,
    ),
    file: k.func(
      "uintptr_t __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *attributes, uint32_t creation, uint32_t flags, uintptr_t templateHandle)",
    ),
    read: k.func(
      `int __stdcall ReadFile(uintptr_t handle, _Out_ uint8_t *buffer, uint32_t length, _Out_ ${D} *read, void *overlapped)`,
    ),
    seek: k.func("int __stdcall SetFilePointerEx(uintptr_t file, int64_t offset, void *position, uint32_t method)"),
    close: k.func("int __stdcall CloseHandle(uintptr_t handle)"),
    error: k.func("uint32_t __stdcall GetLastError(void)"),
    descriptor: a.func(
      "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ CROT_CANARY_DESCRIPTOR *out, void *length)",
    ),
    free: k.func("void * __stdcall LocalFree(void *memory)"),
    pipe: k.func(
      `uintptr_t __stdcall CreateNamedPipeW(str16 name, uint32_t access, uint32_t mode, uint32_t instances, uint32_t outputSize, uint32_t inputSize, uint32_t timeout, ${A} *attributes)`,
    ),
    connect: k.func("int __stdcall ConnectNamedPipe(uintptr_t pipe, void *overlapped)"),
    write: k.func(
      `int __stdcall WriteFile(uintptr_t pipe, uint8_t *buffer, uint32_t length, _Out_ ${D} *written, void *overlapped)`,
    ),
  };
  cache.set(ffi, api);
  return api;
}
const valid = (h) => h !== null && h !== undefined && BigInt(h) !== 0n && BigInt(h) !== 0xffffffffffffffffn;
export function probeProcess(koffiPath, target, expectedHex) {
  const api = bindings(koffiPath),
    size = expectedHex.length / 2;
  const r = { memory: {}, duplicate: {} };
  const proc = api.open(0x10, 0, target.pid); // PROCESS_VM_READ, not all-access
  r.memory.opened = valid(proc);
  r.memory.error = r.memory.opened ? 0 : api.error();
  if (r.memory.opened) {
    try {
      const buffer = Buffer.alloc(size),
        count = {};
      r.memory.read = api.memory(proc, BigInt(target.address), buffer, size, count);
      r.memory.error = r.memory.read ? 0 : api.error();
      r.memory.bytes = Number(count.value ?? 0);
      r.memory.matched = !!r.memory.read && r.memory.bytes === size && buffer.toString("hex") === expectedHex;
    } finally {
      api.close(proc);
    }
  }
  const source = api.open(0x40, 0, target.pid); // PROCESS_DUP_HANDLE
  r.duplicate.opened = valid(source);
  r.duplicate.error = r.duplicate.opened ? 0 : api.error();
  if (r.duplicate.opened) {
    const out = {};
    try {
      r.duplicate.copied = api.duplicate(source, BigInt(target.handle), api.current(), out, 0, 0, 2); // SAME_ACCESS, never CLOSE_SOURCE
      r.duplicate.error = r.duplicate.copied ? 0 : api.error();
      if (r.duplicate.copied) {
        // Duplicates share a file offset: reset it, so EOF cannot fake denial.
        r.duplicate.seek = api.seek(out.value, 0, null, 0);
        if (!r.duplicate.seek) {
          r.duplicate.error = api.error();
          return r;
        }
        const buffer = Buffer.alloc(size),
          count = {};
        r.duplicate.read = api.read(out.value, buffer, size, count, null);
        r.duplicate.error = r.duplicate.read ? 0 : api.error();
        r.duplicate.bytes = Number(count.value ?? 0);
        r.duplicate.matched =
          !!r.duplicate.read && r.duplicate.bytes === size && buffer.toString("hex") === expectedHex;
      }
    } finally {
      if (out.value) api.close(out.value);
      api.close(source);
    }
  }
  return r;
}
export function readCanaryPipe(koffiPath, name, expectedHex) {
  const api = bindings(koffiPath),
    h = api.file(name, 0x80000000, 0, null, 3, 0, 0); // READ-only can reveal data even when duplex connect is refused
  if (!valid(h)) return { opened: false, error: api.error(), matched: false };
  try {
    const buffer = Buffer.alloc(expectedHex.length / 2),
      count = {};
    const read = api.read(h, buffer, buffer.length, count, null);
    return {
      opened: true,
      read,
      error: read ? 0 : api.error(),
      bytes: Number(count.value ?? 0),
      matched: !!read && Number(count.value) === buffer.length && buffer.toString("hex") === expectedHex,
    };
  } finally {
    api.close(h);
  }
}
export function canaryPipe(koffiPath, name, ownerSid, label, bytes) {
  const api = bindings(koffiPath),
    sd = {};
  const sddl = `D:P(A;;GA;;;${ownerSid})S:(ML;;${label === "medium-nr" ? "NWNR" : "NW"};;;${label === "low" ? "LW" : "ME"})`;
  if (!api.descriptor(sddl, 1, sd, null) || !sd.value) throw new Error("canary pipe descriptor failed");
  let h;
  try {
    h = api.pipe(name, 2, 8, 1, 4096, 4096, 1000, {
      nLength: api.ffi.sizeof("CROT_CANARY_ATTRIBUTES"),
      lpSecurityDescriptor: sd.value,
      bInheritHandle: 0,
    });
  } finally {
    api.free(sd.value);
  }
  if (!valid(h)) throw new Error(`canary pipe creation failed ${api.error()}`);
  // Koffi's async call waits off the Node event loop. Only synthetic bytes are
  // sent; blocked connections die with the owned disposable victim process.
  api.connect.async(h, null, (err) => {
    if (err) return;
    const count = {};
    api.write(h, bytes, bytes.length, count, null);
  });
  return h;
}
