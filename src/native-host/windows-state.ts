/** AD-26: exact CROT-owned private state, never a workspace policy installer. */
import { mkdir, lstat } from "node:fs/promises";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import {
  fromWin32NamespacedPath,
  isSameOrAncestorWindowsPath,
  validateSid,
  validateWindowsPath,
} from "./validation.js";
import type { TokenFfi, TokenLibraries } from "./windows-l1/restricted-token.js";
interface StateFfi extends TokenFfi {
  readonly decode: { string16(pointer: unknown, length: number): string };
}
const U = "CROT_STATE_UNICODE",
  O = "CROT_STATE_OBJECT",
  H = "CROT_STATE_HANDLE",
  N = "CROT_STATE_SIZE";
const declared = new WeakSet<object>();
const bindings = new WeakMap<object, Map<string, ReturnType<typeof bind>>>();
const valid = (h: unknown) =>
  h !== undefined && h !== null && h !== 0 && h !== 0n && h !== -1n && h !== 0xffffffffffffffffn;
const ok = (n: unknown) => n === true || (typeof n === "number" && n !== 0);
const fail = (stage: string) => new CrotError("OPERATION_FAILED", `Windows private state: ${stage} failed.`, { stage });
function bind(ffi: StateFfi, libraries: TokenLibraries) {
  if (!declared.has(ffi)) {
    ffi.struct(U, { Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
    ffi.struct(O, {
      Length: "uint32_t",
      RootDirectory: "void *",
      ObjectName: "void *",
      Attributes: "uint32_t",
      SecurityDescriptor: "void *",
      SecurityQualityOfService: "void *",
    });
    ffi.struct(H, { value: "void *" });
    ffi.struct(N, { value: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(U) !== 16 || ffi.sizeof(O) !== 48 || ffi.sizeof("void *") !== 8) throw fail("64-bit ABI");
  const k = ffi.load(libraries.kernel32),
    a = ffi.load(libraries.advapi32),
    nt = ffi.load(libraries.ntdll ?? "ntdll.dll");
  const file = k.func(
    "void * __stdcall CreateFileW(str16 path,uint32_t access,uint32_t share,void *security,uint32_t disposition,uint32_t flags,void *templateFile)",
  );
  const open = nt.func(
    `int32_t __stdcall NtCreateFile(_Out_ ${H} *out,uint32_t access,void *attributes,void *status,void *allocation,uint32_t fileAttributes,uint32_t share,uint32_t disposition,uint32_t options,void *ea,uint32_t eaSize)`,
  );
  const info = k.func("int __stdcall GetFileInformationByHandle(void *handle,_Out_ uint8_t *info)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const sd = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text,uint32_t revision,_Out_ ${H} *out,void *size)`,
  );
  const stringify = a.func(
    `int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor,uint32_t revision,uint32_t flags,_Out_ ${H} *text,_Out_ ${N} *length)`,
  );
  const sacl = a.func(
    `int __stdcall GetSecurityDescriptorSacl(void *descriptor,_Out_ ${N} *present,_Out_ ${H} *acl,_Out_ ${N} *defaulted)`,
  );
  const set = a.func("int __stdcall SetKernelObjectSecurity(void *object,uint32_t flags,void *descriptor)");
  const get = a.func(
    `uint32_t __stdcall GetSecurityInfo(void *object,int kind,uint32_t flags,void *owner,void *group,void *dacl,void *sacl,_Out_ ${H} *descriptor)`,
  );
  type Allocation = { value?: unknown; kind: "handle" | "memory" };
  const pending = new Set<Allocation>();
  const release = (out: Allocation) => {
    if (!valid(out.value)) return;
    if (out.kind === "handle" ? !ok(close(out.value)) : valid(free(out.value))) {
      pending.add(out);
      throw fail("native release");
    }
    pending.delete(out);
    out.value = undefined;
  };
  const retry = () => {
    let error: unknown;
    for (const out of pending)
      try {
        release(out);
      } catch (cause) {
        error ??= cause;
      }
    if (error) throw error;
  };
  return (
    target: string,
    owner: string,
    directory: boolean,
    mutate: boolean,
    sandboxSids: readonly string[] = [],
  ): boolean => {
    validateSid(owner);
    if (sandboxSids.length > 64 || new Set(sandboxSids).size !== sandboxSids.length) throw fail("sandbox SID set");
    for (const sid of sandboxSids) {
      validateSid(sid);
      if (!/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(sid)) throw fail("AppContainer SID");
    }
    validateWindowsPath(target);
    retry();
    if (!/^[A-Za-z]:\\/.test(target) || /[\u0000-\u001f/*?"<>|]/.test(target) || target.slice(2).includes(":"))
      throw fail("local state path");
    const parts = target.slice(3).split("\\");
    if (!parts.length || parts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p)))
      throw fail("state path components");
    const owned: Allocation[] = [];
    let error: unknown,
      result = false;
    const allocation = (kind: Allocation["kind"]) => {
      const out: Allocation = { kind };
      owned.push(out);
      return out;
    };
    const inspect = (handle: unknown, isDir: boolean) => {
      const b = Buffer.alloc(52);
      if (
        !ok(info(handle, b)) ||
        (b.readUInt32LE(0) & 0x400) !== 0 ||
        Boolean(b.readUInt32LE(0) & 0x10) !== isDir ||
        (!isDir && b.readUInt32LE(40) !== 1)
      )
        throw fail("state object type or links");
      if (isDir) {
        const security = allocation("memory");
        if (get(handle, 1, 0x10, null, null, null, null, security) !== 0 || !valid(security.value))
          throw fail("parent label query");
        const present: { value?: number } = {},
          acl: { value?: unknown } = {},
          defaulted: { value?: number } = {};
        if (!ok(sacl(security.value, present, acl, defaulted)) || ![0, 1].includes(present.value!))
          throw fail("parent SACL presence");
        // An absent/null SACL has the NTFS implicit Medium/NW policy. A failed
        // conversion is never absence. LABEL is the query selector; SACL is
        // the serialization selector for the returned label-only descriptor.
        if (present.value === 0 || !valid(acl.value)) return;
        const label = canonical(security.value, 0x08);
        for (const match of label.matchAll(/\(ML;[^;]*;([^;]*);;;([^;)]+)\)/g)) {
          const rights = match[1]!,
            sid = match[2]!;
          const rid =
            sid === "UN"
              ? 0
              : sid === "LW"
                ? 4096
                : sid === "ME"
                  ? 8192
                  : sid === "HI"
                    ? 12288
                    : sid === "SI"
                      ? 16384
                      : sid === "PP"
                        ? 20480
                        : /^S-1-16-\d+$/.test(sid)
                          ? Number(sid.slice(7))
                          : -1;
          const noWriteUp =
            rights.includes("NW") || (/^0X[0-9A-F]+$/.test(rights) && (Number.parseInt(rights.slice(2), 16) & 1) !== 0);
          if (rid < 8192 || !noWriteUp) throw fail("unsafe private state parent");
        }
      }
    };
    const canonical = (descriptor: unknown, sections = 0x0c) => {
      const text = allocation("memory"),
        size: { value?: number } = {};
      if (
        !ok(stringify(descriptor, 1, sections, text, size)) ||
        !valid(text.value) ||
        !Number.isSafeInteger(size.value) ||
        size.value! < 1 ||
        size.value! > 65536
      )
        throw fail("descriptor encoding");
      return ffi.decode.string16(text.value, size.value! - 1).toUpperCase();
    };
    try {
      const root = allocation("handle");
      root.value = file(target.slice(0, 3), 0x1200a0, 3, null, 3, 0x02200000, null);
      if (!valid(root.value)) throw fail("drive pin");
      inspect(root.value, true);
      let parent = root.value;
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1,
          isDir = !isLast || directory,
          text = Buffer.from(parts[i] + "\0", "utf16le"),
          unicode = Buffer.alloc(16),
          attributes = Buffer.alloc(48);
        ffi.encode(unicode, U, { Length: text.length - 2, MaximumLength: text.length, Buffer: text });
        ffi.encode(attributes, O, {
          Length: 48,
          RootDirectory: parent,
          ObjectName: unicode,
          Attributes: 0x1040,
          SecurityDescriptor: null,
          SecurityQualityOfService: null,
        });
        const out = allocation("handle"),
          status = Number(
            open(
              out,
              isLast ? (mutate ? 0x1e0080 : 0x120080) : 0x1200a0,
              attributes,
              Buffer.alloc(16),
              null,
              0,
              3,
              1,
              0x200020 | (isDir ? 1 : 0x40),
              null,
              0,
            ),
          );
        if (status < 0 || !valid(out.value)) throw fail("handle-relative state pin");
        inspect(out.value, isDir);
        parent = out.value;
      }
      const expected = allocation("memory"),
        inherit = directory ? "OICI" : "";
      if (
        !ok(
          sd(
            `D:P${sandboxSids.map((sid) => `(D;${inherit};FA;;;${sid})`).join("")}(A;${inherit};FA;;;${owner})S:(ML;${inherit};NWNR;;;ME)`,
            1,
            expected,
            null,
          ),
        ) ||
        !valid(expected.value)
      )
        throw fail("private descriptor");
      if (mutate && !ok(set(parent, 0x80000014, expected.value))) throw fail("private descriptor install");
      const actual = allocation("memory");
      if (get(parent, 1, 0x14, null, null, null, null, actual) !== 0 || !valid(actual.value))
        throw fail("kernel descriptor read-back");
      result = canonical(actual.value) === canonical(expected.value);
      if (mutate && !result) throw fail("kernel descriptor mismatch");
    } catch (cause) {
      error = cause;
    } finally {
      for (const out of owned.reverse())
        try {
          release(out);
        } catch (cause) {
          error ??= cause;
        }
    }
    if (error) throw error;
    return result;
  };
}
export function bindWindowsPrivateState(ffi: StateFfi, libraries: TokenLibraries) {
  const key = `${libraries.advapi32}\0${libraries.kernel32}\0${libraries.ntdll ?? "ntdll.dll"}`;
  let map = bindings.get(ffi);
  if (!map) {
    map = new Map();
    bindings.set(ffi, map);
  }
  let api = map.get(key);
  if (!api) {
    api = bind(ffi, libraries);
    map.set(key, api);
  }
  return api;
}
export async function loadWindowsPrivateState(
  owner: string,
  sandboxSids: readonly string[] = [],
): Promise<PrivateFileProtection> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw fail("native platform");
  const name: string = "koffi",
    module = await import(name),
    protect = bindWindowsPrivateState(module.default ?? module, { kernel32: "kernel32.dll", advapi32: "advapi32.dll" });
  return {
    mechanism: "windows-acl",
    enforced: true,
    fileMode: undefined,
    ensureDirectory: async (dir) => {
      const target = validateWindowsPath(dir),
        created = await mkdir(target, { recursive: true });
      if (created !== undefined) {
        const first = fromWin32NamespacedPath(created);
        if (!isSameOrAncestorWindowsPath(first, target)) throw fail("created directory scope");
        protect(first, owner, true, true, sandboxSids);
        let createdPath = first;
        for (const part of target.slice(first.length).replace(/^\\/, "").split("\\").filter(Boolean)) {
          createdPath += "\\" + part;
          protect(createdPath, owner, true, true, sandboxSids);
        }
      }
    },
    protectFile: async (file) => {
      protect(file, owner, false, true, sandboxSids);
    },
    inspect: async (file) => {
      const item = await lstat(file).catch((e) => {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      });
      if (!item)
        return {
          mechanism: "windows-acl",
          ownerOnly: true,
          detail: "will be created owner-only, Medium no-read-up before content",
        };
      const checked = protect(file, owner, item.isDirectory(), false, sandboxSids);
      return {
        mechanism: "windows-acl",
        ownerOnly: checked,
        detail: checked
          ? "owner-only DACL and Medium no-read-up label verified"
          : "private state descriptor does not match required policy",
      };
    },
  };
}
