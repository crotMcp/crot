/** Private, per-launch DOS-device map. Never changes the host map or shared pipe ACLs. */
import { randomUUID } from "node:crypto";
import { CrotError } from "../../core/errors.js";
import { validateSid } from "../validation.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";
export interface PrivatePipeMap {
  /** Trusted suspended process handle only; not a pid or an RPC parameter. */
  apply(process: unknown): void;
  /** Caller must first drain its complete Job. Idempotent, failed closes retryable. */
  close(): void;
}
const declared = new WeakSet<object>();
const quarantined = new Set<object>();
const OUT = "CROT_PIPE_MAP_OUT",
  US = "CROT_PIPE_MAP_UNICODE",
  OA = "CROT_PIPE_MAP_ATTRIBUTES";
const missing = (v: unknown) => v === undefined || v === null || v === 0 || v === 0n;
const fail = (stage: string, code?: unknown) =>
  new CrotError("CONFINEMENT_FAILED", `Private pipe map ${stage} failed.`, {
    stage,
    ...(typeof code === "number" ? { nativeCode: code >>> 0 } : {}),
  });
/** Native 64-bit binding; no privilege enabling, global object creation or runtime patching. */
export function bindPrivatePipeMaps(ffi: TokenFfi, libs: TokenLibraries & { ntdll: string }) {
  if (!declared.has(ffi)) {
    ffi.struct(OUT, { value: "void *" });
    ffi.struct(US, { Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
    ffi.struct(OA, {
      Length: "uint32_t",
      RootDirectory: "void *",
      ObjectName: "void *",
      Attributes: "uint32_t",
      SecurityDescriptor: "void *",
      SecurityQualityOfService: "void *",
    });
    declared.add(ffi);
  }
  if (ffi.sizeof(US) !== 16 || ffi.sizeof(OA) !== 48 || ffi.sizeof(OUT) !== 8) throw fail("64-bit ABI");
  const nt = ffi.load(libs.ntdll),
    k = ffi.load(libs.kernel32),
    a = ffi.load(libs.advapi32);
  const open = nt.func(`int32_t __stdcall NtOpenDirectoryObject(_Out_ ${OUT} *out, uint32_t access, void *attributes)`);
  const directory = nt.func(
    `int32_t __stdcall NtCreateDirectoryObjectEx(_Out_ ${OUT} *out, uint32_t access, void *attributes, void *shadow, uint32_t flags)`,
  );
  const link = nt.func(
    `int32_t __stdcall NtCreateSymbolicLinkObject(_Out_ ${OUT} *out, uint32_t access, void *attributes, void *target)`,
  );
  const set = nt.func(
    "int32_t __stdcall NtSetInformationProcess(void *process, int kind, void *information, uint32_t length)",
  );
  const sd = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ ${OUT} *out, void *size)`,
  );
  const free = k.func("void * __stdcall LocalFree(void *allocation)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const exact = (value: unknown, stage: string) => {
    if (value !== 0) throw fail(stage, value);
  };
  const unicode = (text: string) => {
    if (text.includes("\0") || text.length > 32766) throw fail("name admission");
    const chars = Buffer.from(text + "\0", "utf16le"),
      value = Buffer.alloc(16);
    ffi.encode(value, US, { Length: chars.length - 2, MaximumLength: chars.length, Buffer: chars });
    return { chars, value };
  };
  const attributes = (name: ReturnType<typeof unicode> | undefined, root: unknown, descriptor: unknown) => {
    const buffer = Buffer.alloc(48);
    ffi.encode(buffer, OA, {
      Length: 48,
      RootDirectory: root ?? null,
      ObjectName: name?.value ?? null,
      Attributes: 0x40,
      SecurityDescriptor: descriptor ?? null,
      SecurityQualityOfService: null,
    });
    return buffer;
  };
  return {
    create: (ownerSid: string, packageSid: string): PrivatePipeMap => {
      validateSid(ownerSid);
      validateSid(packageSid);
      if (!/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(packageSid)) throw fail("package admission");
      if (quarantined.size) throw fail("previous incomplete cleanup");
      const shadow: { value?: unknown } = {},
        map: { value?: unknown } = {},
        alias: { value?: unknown } = {};
      const descriptors: Array<{ value?: unknown }> = [];
      let applied = false,
        closed = false;
      const owned = { shadow, map, alias, descriptors };
      const release = () => {
        let fault: unknown;
        for (const h of [alias, map, shadow])
          if (!missing(h.value)) {
            try {
              if (!close(h.value)) throw fail("object release", last());
              h.value = undefined;
            } catch (e) {
              fault ??= e;
            }
          }
        for (const d of descriptors)
          if (!missing(d.value)) {
            try {
              if (!missing(free(d.value))) throw fail("descriptor release", last());
              d.value = undefined;
            } catch (e) {
              fault ??= e;
            }
          }
        if (fault) {
          quarantined.add(owned);
          throw fault;
        }
        quarantined.delete(owned);
        closed = true;
      };
      const security = (rights: string) => {
        const out: { value?: unknown } = {};
        descriptors.push(out);
        if (!sd(`D:P(A;;GA;;;${ownerSid})(A;;${rights};;;${packageSid})`, 1, out, null) || missing(out.value))
          throw fail("private descriptor", last());
        return out.value;
      };
      try {
        // Shadow the CALLER'S existing per-logon DOS directory. No mutation:
        // inherited drive letters/UNC/host tools keep their existing resolution.
        const base = unicode("\\??");
        exact(open(shadow, 0xb, attributes(base, null, null)), "shadow open");
        if (missing(shadow.value)) throw fail("shadow output");
        // Fresh, ephemeral private directory under this logon DOS directory.
        // Named-directory qualification is separate from process-map assignment.
        // Exact STATUS_SUCCESS only: never adopt a collided object.
        const mapName = unicode(`CrotPipeMap-${randomUUID()}`);
        exact(
          directory(map, 0xf000f, attributes(mapName, shadow.value, security("0x00020003")), shadow.value, 0),
          "directory create",
        );
        if (missing(map.value)) throw fail("directory output");
        const name = unicode("PIPE"),
          target = unicode(`\\Device\\NamedPipe\\LOCAL\\crot-${randomUUID()}`);
        exact(link(alias, 0xf0001, attributes(name, map.value, security("0x00020001")), target.value), "alias create");
        if (missing(alias.value)) throw fail("alias output");
        return {
          apply: (process) => {
            if (closed || applied || missing(process)) throw fail("suspended process admission");
            // The setter accepts sizeof(Set), a single HANDLE (8), NOT the
            // 40-byte Query union. Windows rejects 40 with INFO_LENGTH_MISMATCH.
            const value = Buffer.alloc(8);
            ffi.encode(value, "void *", map.value);
            exact(set(process, 23, value, value.length), "suspended process assignment");
            applied = true;
          },
          close: release,
        };
      } catch (cause) {
        try {
          release();
        } catch (cleanup) {
          throw new CrotError("CONFINEMENT_FAILED", "Private pipe map setup and cleanup failed.", undefined, {
            cause: cleanup,
          });
        }
        throw cause;
      }
    },
  };
}
