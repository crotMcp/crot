/**
 * WP-23c spike: native restricted-token creation and DACL access checks.
 * Not a CommandConfinement backend. No process is launched/impersonated and
 * this module must not be used to report L1 available. AccessCheck proves
 * only the supplied security descriptor's discretionary access decision,
 * not MIC, IPC, traversal, TOCTOU or descendant confinement.
 */
import { CrotError } from "../../core/errors.js";
import { validateSid, validateWindowsPath } from "../validation.js";

type NativeFunction = (...args: unknown[]) => unknown;
export interface TokenFfi {
  load(name: string): { func(signature: string): NativeFunction };
  struct(name: string, members: Record<string, string>): unknown;
}
export interface TokenLibraries {
  readonly advapi32: string;
  readonly kernel32: string;
}
export interface DaclAccess {
  /** FILE_READ_DATA only; not all file-read operations. */
  readonly readData: boolean;
  /** FILE_WRITE_DATA only; not all file-write operations. */
  readonly writeData: boolean;
}
export interface RestrictedToken {
  readonly closed: boolean;
  /** Check the current file DACL using a restricted impersonation token. */
  fileDaclAccess(file: string): DaclAccess;
  /** Release both primary and impersonation handles. Idempotent. */
  close(): void;
}
export interface RestrictedTokenApi {
  /** The restricting SID is a spike input, not a remotely supplied policy. */
  create(restrictingSid: string): RestrictedToken;
}

const HANDLE = "CROT_L1_TOKEN_HANDLE";
const DWORD = "CROT_L1_TOKEN_DWORD";
const SID_ATTRIBUTES = "CROT_L1_SID_ATTRIBUTES";
const MAPPING = "CROT_L1_GENERIC_MAPPING";
const DISABLE_MAX_PRIVILEGE = 0x1;
const TOKEN_DUPLICATE = 0x2;
const TOKEN_IMPERSONATE = 0x4;
const TOKEN_QUERY = 0x8;
const SECURITY_IMPERSONATION = 2;
const TOKEN_IMPERSONATION = 2;
const FILE_OBJECT = 1;
const OWNER_GROUP_DACL = 0x7;
const PRIVILEGE_BYTES = 4096;
const nullHandle = (h: unknown) => h === undefined || h === null || h === 0 || h === 0n;
const success = (r: unknown) => r === true || (typeof r === "number" && r !== 0) || (typeof r === "bigint" && r !== 0n);
const declared = new WeakSet<object>();
const bound = new WeakMap<object, Map<string, RestrictedTokenApi>>();

export function bindRestrictedTokens(
  ffi: TokenFfi,
  libraries: TokenLibraries = { advapi32: "advapi32.dll", kernel32: "kernel32.dll" },
): RestrictedTokenApi {
  const key = `${libraries.advapi32}\0${libraries.kernel32}`;
  let perModule = bound.get(ffi);
  if (!perModule) {
    perModule = new Map();
    bound.set(ffi, perModule);
  }
  const cached = perModule.get(key);
  if (cached) return cached;
  if (!declared.has(ffi)) {
    ffi.struct(HANDLE, { value: "void *" });
    ffi.struct(DWORD, { value: "uint32_t" });
    ffi.struct(SID_ATTRIBUTES, { Sid: "void *", Attributes: "uint32_t" });
    ffi.struct(MAPPING, {
      GenericRead: "uint32_t",
      GenericWrite: "uint32_t",
      GenericExecute: "uint32_t",
      GenericAll: "uint32_t",
    });
    declared.add(ffi);
  }
  const a = ffi.load(libraries.advapi32);
  const k = ffi.load(libraries.kernel32);
  const currentProcess = k.func("void * __stdcall GetCurrentProcess(void)");
  const lastError = k.func("uint32_t __stdcall GetLastError(void)");
  const closeHandle = k.func("int __stdcall CloseHandle(void *handle)");
  const localFree = k.func("void * __stdcall LocalFree(void *memory)");
  const openToken = a.func(`int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ ${HANDLE} *out)`);
  const convertSid = a.func(`int __stdcall ConvertStringSidToSidW(str16 sid, _Out_ ${HANDLE} *out)`);
  const restrict = a.func(
    `int __stdcall CreateRestrictedToken(void *source, uint32_t flags, uint32_t disableCount, void *disable, uint32_t deleteCount, void *remove, uint32_t restrictCount, ${SID_ATTRIBUTES} *sids, _Out_ ${HANDLE} *out)`,
  );
  const isRestricted = a.func("int __stdcall IsTokenRestricted(void *token)");
  const duplicate = a.func(
    `int __stdcall DuplicateTokenEx(void *token, uint32_t access, void *attributes, int level, int type, _Out_ ${HANDLE} *out)`,
  );
  const descriptor = a.func(
    `uint32_t __stdcall GetNamedSecurityInfoW(str16 file, int objectType, uint32_t info, void *owner, void *group, void *dacl, void *sacl, _Out_ ${HANDLE} *out)`,
  );
  const accessCheck = a.func(
    `int __stdcall AccessCheck(void *sd, void *token, uint32_t access, ${MAPPING} *mapping, void *privileges, _Inout_ ${DWORD} *length, _Out_ ${DWORD} *granted, _Out_ ${DWORD} *allowed)`,
  );
  const failure = (api: string, error: unknown = lastError()) => {
    // No file paths, SID values, payloads or native diagnostics in errors.
    const code = typeof error === "number" && Number.isInteger(error) ? error : "unknown";
    return new CrotError("OPERATION_FAILED", `Windows token spike: ${api} failed (code ${code}).`);
  };
  const api: RestrictedTokenApi = {
    create: (restrictingSid) => {
      validateSid(restrictingSid);
      const source: { value?: unknown } = {};
      const sid: { value?: unknown } = {};
      const primary: { value?: unknown } = {};
      const impersonation: { value?: unknown } = {};
      try {
        if (!success(openToken(currentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, source)) || nullHandle(source.value))
          throw failure("OpenProcessToken");
        if (!success(convertSid(restrictingSid, sid)) || nullHandle(sid.value)) throw failure("ConvertStringSidToSidW");
        if (
          !success(
            restrict(
              source.value,
              DISABLE_MAX_PRIVILEGE,
              0,
              null,
              0,
              null,
              1,
              { Sid: sid.value, Attributes: 0 },
              primary,
            ),
          ) ||
          nullHandle(primary.value)
        )
          throw failure("CreateRestrictedToken");
        if (!success(isRestricted(primary.value))) throw failure("IsTokenRestricted", 0);
        if (
          !success(
            duplicate(
              primary.value,
              TOKEN_QUERY | TOKEN_IMPERSONATE,
              null,
              SECURITY_IMPERSONATION,
              TOKEN_IMPERSONATION,
              impersonation,
            ),
          ) ||
          nullHandle(impersonation.value)
        )
          throw failure("DuplicateTokenEx");
      } catch (error) {
        if (!nullHandle(impersonation.value)) closeHandle(impersonation.value);
        if (!nullHandle(primary.value)) closeHandle(primary.value);
        throw error;
      } finally {
        if (!nullHandle(sid.value)) localFree(sid.value);
        if (!nullHandle(source.value)) closeHandle(source.value);
      }
      let closed = false;
      const check = (sd: unknown, access: number): boolean => {
        const length = { value: PRIVILEGE_BYTES };
        const granted: { value?: number } = {};
        const allowed: { value?: number } = {};
        const mapping = {
          GenericRead: 0x120089,
          GenericWrite: 0x120116,
          GenericExecute: 0x1200a0,
          GenericAll: 0x1f01ff,
        };
        if (
          !success(
            accessCheck(
              sd,
              impersonation.value,
              access,
              mapping,
              Buffer.alloc(PRIVILEGE_BYTES),
              length,
              granted,
              allowed,
            ),
          )
        )
          throw failure("AccessCheck");
        if (allowed.value === 0) return false;
        if (allowed.value !== 1 || typeof granted.value !== "number" || (granted.value & access) !== access)
          throw failure("AccessCheck output", 0);
        return true;
      };
      return {
        get closed() {
          return closed;
        },
        fileDaclAccess: (file) => {
          if (closed) throw new CrotError("OPERATION_FAILED", "Windows token spike: token is closed.");
          validateWindowsPath(file);
          const sd: { value?: unknown } = {};
          try {
            const result = descriptor(file, FILE_OBJECT, OWNER_GROUP_DACL, null, null, null, null, sd);
            if (result !== 0 || nullHandle(sd.value)) throw failure("GetNamedSecurityInfoW", result);
            return { readData: check(sd.value, 0x1), writeData: check(sd.value, 0x2) };
          } finally {
            if (!nullHandle(sd.value)) localFree(sd.value);
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          const first = closeHandle(impersonation.value);
          const second = closeHandle(primary.value);
          if (!success(first) || !success(second)) throw failure("CloseHandle");
        },
      };
    },
  };
  perModule.set(key, api);
  return api;
}

const FFI_MODULE: string = "koffi";
/** Load native primitives only; never marks CommandConfinement available. */
export async function loadRestrictedTokens(): Promise<RestrictedTokenApi> {
  if (process.platform !== "win32" || (process.arch !== "x64" && process.arch !== "arm64"))
    throw new CrotError("OPERATION_FAILED", "Windows token spike requires native 64-bit Windows.");
  const module: unknown = await import(FFI_MODULE);
  const ffi = ((module as { default?: unknown } | null)?.default ?? module) as Partial<TokenFfi> | undefined;
  if (!ffi || typeof ffi.load !== "function" || typeof ffi.struct !== "function")
    throw new CrotError("OPERATION_FAILED", "Windows token spike: koffi module is unavailable.");
  return bindRestrictedTokens(ffi as TokenFfi);
}
