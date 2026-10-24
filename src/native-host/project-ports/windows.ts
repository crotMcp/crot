/** Read-only Windows TCP owner table and same-owner 64-bit process cwd observation.
 * Only PBI.PebBaseAddress -> PEB.ProcessParameters -> CurrentDirectory is read.
 * No environment, command line, injection, writable handle or guessed executable cwd.
 */
import path from "node:path";
import type { ProjectPort } from "../../core/platform/types.js";
import { nativeOk, type PortFfi } from "./ffi.js";
import type { NativePortApi } from "./observer.js";
const MAX_TABLE = 1024 * 1024;
const missing = (h: unknown) => h === null || h === undefined || h === 0 || h === 0n;
export function windowsTcpListeners(data: Buffer, family: 2 | 23): ProjectPort[] {
  if (data.length < 4) throw new Error("Truncated TCP table");
  const count = data.readUInt32LE(0),
    width = family === 2 ? 24 : 56;
  if (data.length > MAX_TABLE || count > Math.floor((data.length - 4) / width))
    throw new Error("Invalid TCP table length");
  const result: ProjectPort[] = [];
  for (let i = 0; i < count; i++) {
    const at = 4 + i * width,
      state = data.readUInt32LE(at + (family === 2 ? 0 : 48));
    if (state !== 2) continue;
    const pid = data.readUInt32LE(at + (family === 2 ? 20 : 52)),
      port = data.readUInt16BE(at + (family === 2 ? 8 : 20));
    if (!pid || pid > 0x7fffffff || !port) continue;
    let address: string;
    if (family === 2) address = [...data.subarray(at + 4, at + 8)].join(".");
    else {
      address = Array.from({ length: 8 }, (_, n) => data.readUInt16BE(at + n * 2).toString(16)).join(":");
      const scope = data.readUInt32LE(at + 16);
      if (scope) address += `%${scope}`;
    }
    result.push({ pid, address, port });
  }
  return result;
}
export function windowsCwdDescriptor(data: Buffer): { address: bigint; length: number } {
  if (data.length !== 16) throw new Error("Invalid CurrentDirectory descriptor");
  const length = data.readUInt16LE(0),
    maximum = data.readUInt16LE(2),
    address = data.readBigUInt64LE(8);
  if (!length || length % 2 || length > 32766 || maximum < length || address < 65536n || address > 0xffffffffffffn)
    throw new Error("Invalid CurrentDirectory address");
  return { address, length };
}
const HANDLE = "CROT_PORT_HANDLE",
  DWORD = "CROT_PORT_DWORD",
  SIZE = "CROT_PORT_SIZE",
  WORD = "CROT_PORT_WORD",
  TIME = "CROT_PORT_FILETIME";
const declared = new WeakSet<object>();
export function bindWindowsPorts(ffi: PortFfi): NativePortApi {
  if (!declared.has(ffi)) {
    ffi.struct(HANDLE, { value: "void *" });
    ffi.struct(DWORD, { value: "uint32_t" });
    ffi.struct(SIZE, { value: "uint64_t" });
    ffi.struct(WORD, { value: "uint16_t" });
    ffi.struct(TIME, { value: "uint64_t" });
    declared.add(ffi);
  }
  const k = ffi.load("kernel32.dll");
  const systemDir = k.func("uint32_t __stdcall GetSystemDirectoryW(void *buffer, uint32_t size)");
  const directory = Buffer.alloc(65536),
    chars = Number(systemDir(directory, directory.length / 2));
  if (!Number.isInteger(chars) || chars < 3 || chars >= directory.length / 2)
    throw new Error("System directory unavailable");
  const system = directory.subarray(0, chars * 2).toString("utf16le");
  if (!/^[A-Za-z]:\\/.test(system) || system.includes("\0")) throw new Error("Invalid system library directory");
  const a = ffi.load(path.win32.join(system, "advapi32.dll")),
    n = ffi.load(path.win32.join(system, "ntdll.dll")),
    tcp = ffi.load(path.win32.join(system, "iphlpapi.dll"));
  const table = tcp.func(
    `uint32_t __stdcall GetExtendedTcpTable(void *data, _Inout_ ${DWORD} *size, int order, uint32_t family, int tableClass, uint32_t reserved)`,
  );
  const open = k.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    close = k.func("int __stdcall CloseHandle(void *handle)");
  const current = k.func("void * __stdcall GetCurrentProcess(void)");
  const token = a.func(`int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ ${HANDLE} *token)`);
  const info = a.func(
    `int __stdcall GetTokenInformation(void *token, int kind, void *data, uint32_t size, _Out_ ${DWORD} *returned)`,
  );
  const equal = a.func("int __stdcall EqualSid(void *left, void *right)");
  const wow = k.func(
    `int __stdcall IsWow64Process2(void *process, _Out_ ${WORD} *machine, _Out_ ${WORD} *nativeMachine)`,
  );
  const times = k.func(
    `int __stdcall GetProcessTimes(void *process, _Out_ ${TIME} *created, _Out_ ${TIME} *ended, _Out_ ${TIME} *kernel, _Out_ ${TIME} *user)`,
  );
  const exit = k.func(`int __stdcall GetExitCodeProcess(void *process, _Out_ ${DWORD} *code)`);
  const query = n.func(
    `int32_t __stdcall NtQueryInformationProcess(void *process, uint32_t kind, void *data, uint32_t size, _Out_ ${DWORD} *returned)`,
  );
  const read = k.func(
    `int __stdcall ReadProcessMemory(void *process, void *address, void *data, uint64_t size, _Out_ ${SIZE} *returned)`,
  );
  const release = (h: unknown) => {
    if (!nativeOk(close(h))) throw new Error("Process observation handle cleanup failed");
  };
  const sid = (process: unknown) => {
    const handle: { value?: unknown } = {};
    if (!nativeOk(token(process, 8, handle)) || missing(handle.value)) throw new Error("Process owner unavailable");
    try {
      const data = Buffer.alloc(4096),
        size: { value?: number } = {};
      if (
        !nativeOk(info(handle.value, 1, data, data.length, size)) ||
        !size.value ||
        size.value < 16 ||
        size.value > data.length
      )
        throw new Error("Process owner query failed");
      const pointer = ffi.decode(data, "void *");
      if (missing(pointer)) throw new Error("Process owner SID absent");
      const offset = Number(ffi.address(pointer) - ffi.address(data));
      if (
        !Number.isSafeInteger(offset) ||
        offset < 16 ||
        offset + 8 > size.value ||
        data[offset] !== 1 ||
        data[offset + 1]! > 15 ||
        offset + 8 + 4 * data[offset + 1]! > size.value
      )
        throw new Error("Process owner SID bounds invalid");
      return { data, pointer };
    } finally {
      release(handle.value);
    }
  };
  return {
    listeners: async (signal) => {
      const result: ProjectPort[] = [];
      for (const family of [2, 23] as const) {
        if (signal.aborted) throw new Error("Observation cancelled");
        const size = { value: 0 };
        const code = Number(table(null, size, 0, family, 3, 0));
        if (code === 0 && size.value === 0) continue;
        if (code !== 122 || !Number.isInteger(size.value) || size.value < 4 || size.value > MAX_TABLE)
          throw new Error("TCP table sizing failed");
        const data = Buffer.alloc(size.value);
        if (Number(table(data, size, 0, family, 3, 0)) !== 0 || size.value < 4 || size.value > data.length)
          throw new Error("TCP table changed or unavailable");
        result.push(...windowsTcpListeners(data.subarray(0, size.value), family));
      }
      return result;
    },
    process: async (pid, signal) => {
      if (signal.aborted) throw new Error("Observation cancelled");
      // QUERY_INFORMATION | VM_READ only. No injection, write, terminate, duplicate or debug privilege.
      const handle = open(0x0410, 0, pid);
      if (missing(handle)) throw new Error("Process metadata access unavailable");
      try {
        const owner = sid(current()),
          other = sid(handle);
        if (!nativeOk(equal(owner.pointer, other.pointer))) return null;
        // Retain both backing buffers while EqualSid uses pointers into them.
        if (!owner.data.length || !other.data.length) throw new Error("Owner storage unavailable");
        const machine: { value?: number } = {},
          native: { value?: number } = {};
        if (
          !nativeOk(wow(handle, machine, native)) ||
          machine.value !== 0 ||
          ![0x8664, 0xaa64].includes(native.value ?? 0)
        )
          throw new Error("Unsupported process pointer ABI");
        const created: { value?: bigint | number } = {},
          code: { value?: number } = {};
        if (
          !nativeOk(times(handle, created, {}, {}, {})) ||
          !created.value ||
          !nativeOk(exit(handle, code)) ||
          code.value !== 259
        )
          return null;
        const basic = Buffer.alloc(48),
          returned: { value?: number } = {};
        if (
          Number(query(handle, 0, basic, basic.length, returned)) !== 0 ||
          returned.value !== basic.length ||
          basic.readBigUInt64LE(32) !== BigInt(pid)
        )
          throw new Error("Process basic ABI unavailable");
        const memory = (address: bigint, length: number) => {
          if (address < 65536n || address > 0xffffffffffffn || length < 1 || length > 32766)
            throw new Error("Process field bounds exceeded");
          const data = Buffer.alloc(length),
            size: { value?: bigint | number } = {};
          if (!nativeOk(read(handle, address, data, length, size)) || Number(size.value) !== length)
            throw new Error("Process cwd field unavailable");
          return data;
        };
        const peb = basic.readBigUInt64LE(8),
          parameters = memory(peb + 0x20n, 8).readBigUInt64LE(0);
        const descriptor = windowsCwdDescriptor(memory(parameters + 0x38n, 16));
        const cwd = memory(descriptor.address, descriptor.length).toString("utf16le");
        if (!path.win32.isAbsolute(cwd) || /[\0\r\n]/.test(cwd) || !nativeOk(exit(handle, code)) || code.value !== 259)
          throw new Error("Process cwd unavailable");
        return { identity: String(created.value), cwd };
      } finally {
        release(handle);
      }
    },
  };
}
