/**
 * WP-23c spike: native restricted-token creation and DACL access checks.
 * Not a CommandConfinement backend. Research probes may launch restricted children;
 * this module must not be used to report L1 available. AccessCheck proves
 * only the supplied security descriptor's discretionary access decision,
 * not MIC, IPC, traversal, TOCTOU or descendant confinement.
 */
import { CrotError } from "../../core/errors.js";
import { validateSid, validateWindowsPath } from "../validation.js";
import type { JobObject } from "../windows-job.js";
import { bindProbeLauncher, type ProbeSpec, type ProbeProcess } from "./probe-process.js";

type NativeFunction = (...args: unknown[]) => unknown;
export interface TokenFfi {
  load(name: string): { func(signature: string): NativeFunction };
  struct(name: string, members: Record<string, string>): unknown;
  sizeof(name: string): number;
  encode(buffer: Buffer, type: string, value: unknown): void;
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
  readonly restrictingSid: string;
  /** Research only: owner SID must come from the trusted host identity. */
  prepareProbeObjects(ownerSid: string): void;
  /** Lower only the new primary probe token; DACL AccessCheck remains MIC-blind. */
  lowerProbeIntegrity(): void;
  /** Check the current file DACL using a restricted impersonation token. */
  fileDaclAccess(file: string): DaclAccess;
  /** Research only: takes an empty Job and resumes only after assignment. */
  launchProbe(spec: ProbeSpec, job: JobObject): ProbeProcess;
  /** Release both primary and impersonation handles. Idempotent. */
  close(): void;
}
export interface RestrictedTokenApi {
  /** The restricting SID is a spike input, not a remotely supplied policy. */
  /** Optional common probe SID supports loader resources; it is NOT read-only. */
  /** Logon SID is trusted research input for BaseNamedObjects, not an IPC boundary. */
  create(
    restrictingSid: string,
    commonProbeSid?: boolean,
    probeLogonSid?: string,
    /** mic-only strips privileges but has no additional restricting-SID filter. */
    restrictionMode?: "all-access" | "write-only" | "mic-only",
  ): RestrictedToken;
}

const HANDLE = "CROT_L1_TOKEN_HANDLE";
const DWORD = "CROT_L1_TOKEN_DWORD";
const SID_ATTRIBUTES = "CROT_L1_SID_ATTRIBUTES";
const MAPPING = "CROT_L1_GENERIC_MAPPING";
const DISABLE_MAX_PRIVILEGE = 0x1;
const WRITE_RESTRICTED = 0x8;
const TOKEN_ASSIGN_PRIMARY = 0x1;
const TOKEN_ADJUST_DEFAULT = 0x80;
const WRITE_DAC = 0x40000;
const DEFAULT_DACL = "CROT_L1_TOKEN_DEFAULT_DACL";
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
    ffi.struct(DEFAULT_DACL, { DefaultDacl: "void *" });
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
  const fromSddl = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 sddl, uint32_t revision, _Out_ ${HANDLE} *out, void *length)`,
  );
  const getDacl = a.func(
    `int __stdcall GetSecurityDescriptorDacl(void *sd, _Out_ ${DWORD} *present, _Out_ ${HANDLE} *acl, _Out_ ${DWORD} *defaulted)`,
  );
  const setToken = a.func(
    `int __stdcall SetTokenInformation(void *token, int kind, ${DEFAULT_DACL} *info, uint32_t length)`,
  );
  const setLabel = a.func("int __stdcall SetTokenInformation(void *token, int kind, void *info, uint32_t length)");
  const setObjectDacl = a.func("int __stdcall SetKernelObjectSecurity(void *object, uint32_t info, void *sd)");
  const launchProbe = bindProbeLauncher(ffi, libraries);
  const failure = (api: string, error: unknown = lastError()) => {
    // No file paths, SID values, payloads or native diagnostics in errors.
    const code = typeof error === "number" && Number.isInteger(error) ? error : "unknown";
    return new CrotError("OPERATION_FAILED", `Windows token spike: ${api} failed (code ${code}).`);
  };
  type Allocation = { value?: unknown };
  // A failed native release is still owned. Keep exact pointers/handles, never
  // reopen by identity; block further allocation until cleanup can be retried.
  const pendingCleanup = new Map<Allocation, "handle" | "memory">();
  const release = (out: Allocation, kind: "handle" | "memory") => {
    if (nullHandle(out.value)) {
      pendingCleanup.delete(out);
      return;
    }
    try {
      if (kind === "handle" ? !success(closeHandle(out.value)) : !nullHandle(localFree(out.value)))
        throw failure(kind === "handle" ? "CloseHandle" : "LocalFree");
      out.value = undefined;
      pendingCleanup.delete(out);
    } catch (error) {
      pendingCleanup.set(out, kind);
      throw error;
    }
  };
  const retryCleanup = () => {
    let error: unknown;
    for (const [out, kind] of pendingCleanup) {
      try {
        release(out, kind);
      } catch (cause) {
        error ??= cause;
      }
    }
    if (error) throw error;
  };
  const api: RestrictedTokenApi = {
    create: (restrictingSid, commonProbeSid = false, probeLogonSid, restrictionMode = "all-access") => {
      if (!["all-access", "write-only", "mic-only"].includes(restrictionMode))
        throw new CrotError("INVALID_INPUT", "Windows token spike: invalid restriction mode.");
      if (restrictionMode === "mic-only" && (commonProbeSid || probeLogonSid !== undefined))
        throw new CrotError("INVALID_INPUT", "Windows token spike: MIC-only probe cannot request extra SID filtering.");
      validateSid(restrictingSid);
      retryCleanup();
      const source: { value?: unknown } = {};
      const sid: { value?: unknown } = {};
      const common: { value?: unknown }[] = [];
      const logon: { value?: unknown } = {};
      if (probeLogonSid !== undefined && (!commonProbeSid || !/^S-1-5-5-\d+-\d+$/.test(probeLogonSid)))
        throw new CrotError("INVALID_INPUT", "Windows token spike: invalid probe logon SID.");
      const primary: { value?: unknown } = {};
      const impersonation: { value?: unknown } = {};
      let setupError: unknown;
      try {
        if (
          !success(
            openToken(
              currentProcess(),
              TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | WRITE_DAC,
              source,
            ),
          ) ||
          nullHandle(source.value)
        )
          throw failure("OpenProcessToken");
        if (!success(convertSid(restrictingSid, sid)) || nullHandle(sid.value)) throw failure("ConvertStringSidToSidW");
        if (commonProbeSid) {
          if (!/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(restrictingSid))
            throw new CrotError(
              "INVALID_INPUT",
              "Windows token spike: common probe SIDs require a unique restricting SID.",
            );
          // Research baseline mirrors the common-resource SIDs in Chromium's
          // USER_LIMITED token, not its complete sandbox or production policy.
          for (const value of ["S-1-5-32-545", "S-1-1-0", "S-1-5-12"]) {
            const out: { value?: unknown } = {};
            common.push(out);
            if (!success(convertSid(value, out)) || nullHandle(out.value)) throw failure("common probe SID");
          }
        }
        if (probeLogonSid !== undefined && (!success(convertSid(probeLogonSid, logon)) || nullHandle(logon.value)))
          throw failure("probe logon SID");
        if (
          !success(
            restrict(
              source.value,
              DISABLE_MAX_PRIVILEGE | (restrictionMode === "write-only" ? WRITE_RESTRICTED : 0),
              0,
              null,
              0,
              null,
              restrictionMode === "mic-only" ? 0 : 1 + common.length + (probeLogonSid !== undefined ? 1 : 0),
              restrictionMode === "mic-only"
                ? null
                : [
                    { Sid: sid.value, Attributes: 0 },
                    ...common.map((out) => ({ Sid: out.value, Attributes: 0 })),
                    ...(probeLogonSid !== undefined ? [{ Sid: logon.value, Attributes: 0 }] : []),
                  ],
              primary,
            ),
          ) ||
          nullHandle(primary.value)
        )
          throw failure("CreateRestrictedToken");
        // IsTokenRestricted reports restricting SIDs, not privilege removal or
        // a complete sandbox. MIC-only deliberately adds no such SIDs. This
        // research mode is never an L1 availability proof.
        const restricted = isRestricted(primary.value);
        if (restrictionMode !== "mic-only" && !success(restricted)) throw failure("IsTokenRestricted", 0);
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
        setupError = error;
      }
      for (const [out, kind] of [
        [logon, "memory"],
        ...common.map((out) => [out, "memory"] as const),
        [sid, "memory"],
        [source, "handle"],
      ] as readonly (readonly [Allocation, "handle" | "memory"])[]) {
        try {
          release(out, kind);
        } catch (error) {
          setupError ??= error;
        }
      }
      if (setupError) {
        for (const out of [impersonation, primary]) {
          try {
            release(out, "handle");
          } catch {
            /* exact owner retained in pendingCleanup */
          }
        }
        throw setupError;
      }
      let closing = false;
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
          return closing && nullHandle(primary.value) && nullHandle(impersonation.value);
        },
        restrictingSid,
        prepareProbeObjects: (ownerSid) => {
          if (closing) throw new CrotError("OPERATION_FAILED", "Windows token spike: token is closed.");
          retryCleanup();
          validateSid(ownerSid);
          // A normal group such as Builtin Users would grant other users access
          // to new child objects. Probes must use a separately generated SID.
          if (!/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(restrictingSid) || ownerSid === restrictingSid)
            throw new CrotError(
              "INVALID_INPUT",
              "Windows token spike: probe requires a separate unique restricting SID.",
            );
          const sd: { value?: unknown } = {};
          try {
            const sddl = `D:(A;;GA;;;${ownerSid})(A;;GA;;;${restrictingSid})(A;;GA;;;SY)`;
            if (!success(fromSddl(sddl, 1, sd, null)) || nullHandle(sd.value))
              throw failure("probe default descriptor");
            const present: { value?: number } = {};
            const acl: { value?: unknown } = {};
            const defaulted: { value?: number } = {};
            if (!success(getDacl(sd.value, present, acl, defaulted)) || present.value !== 1 || nullHandle(acl.value))
              throw failure("probe default DACL");
            // Changes only the newly created restricted token, never the service
            // token or existing files. Child kernel objects can now open each
            // other without granting a real user/group unrelated access.
            if (!success(setToken(primary.value, 6, { DefaultDacl: acl.value }, ffi.sizeof(DEFAULT_DACL))))
              throw failure("SetTokenInformation default DACL");
            // The restricted child must also be able to query its own token.
            // This updates only that newly created token object's DACL.
            if (!success(setObjectDacl(primary.value, 4, sd.value))) throw failure("probe token object DACL");
          } finally {
            release(sd, "memory");
          }
        },
        lowerProbeIntegrity: () => {
          if (closing) throw new CrotError("OPERATION_FAILED", "Windows token spike: token is closed.");
          retryCleanup();
          const low: { value?: unknown } = {};
          try {
            if (!success(convertSid("S-1-16-4096", low)) || nullHandle(low.value)) throw failure("low integrity SID");
            // TOKEN_MANDATORY_LABEL is SID_AND_ATTRIBUTES. Reserve enough native
            // input buffer for the struct plus SECURITY_MAX_SID_SIZE (68), so
            // cbTokenInformation never describes memory beyond our allocation.
            const buffer = Buffer.alloc(ffi.sizeof(SID_ATTRIBUTES) + 68);
            ffi.encode(buffer, SID_ATTRIBUTES, { Sid: low.value, Attributes: 0x20 });
            if (!success(setLabel(primary.value, 25, buffer, buffer.length))) throw failure("low integrity label");
          } finally {
            release(low, "memory");
          }
        },
        fileDaclAccess: (file) => {
          if (closing) throw new CrotError("OPERATION_FAILED", "Windows token spike: token is closed.");
          retryCleanup();
          validateWindowsPath(file);
          const sd: { value?: unknown } = {};
          try {
            const result = descriptor(file, FILE_OBJECT, OWNER_GROUP_DACL, null, null, null, null, sd);
            if (result !== 0 || nullHandle(sd.value)) throw failure("GetNamedSecurityInfoW", result);
            return { readData: check(sd.value, 0x1), writeData: check(sd.value, 0x2) };
          } finally {
            release(sd, "memory");
          }
        },
        launchProbe: (spec, job) => {
          if (closing) {
            const empty = job.accounting();
            if (!job.closed && empty?.active === 0 && empty.total === 0) job.close();
            throw new CrotError("OPERATION_FAILED", "Windows token spike: token is closed.");
          }
          try {
            retryCleanup();
          } catch (error) {
            // No process was created; this caller transferred only a fresh Job.
            const empty = job.accounting();
            if (!job.closed && empty?.active === 0 && empty.total === 0) job.close();
            throw error;
          }
          return launchProbe(primary.value, spec, job);
        },
        close: () => {
          // Disable every use before the first native close; a partially closed
          // token is not usable and is not falsely reported fully released.
          closing = true;
          let error: unknown;
          for (const out of [impersonation, primary]) {
            try {
              release(out, "handle");
            } catch (cause) {
              error ??= cause;
            }
          }
          if (error) throw error;
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
  if (
    !ffi ||
    typeof ffi.load !== "function" ||
    typeof ffi.struct !== "function" ||
    typeof ffi.sizeof !== "function" ||
    typeof ffi.encode !== "function"
  )
    throw new CrotError("OPERATION_FAILED", "Windows token spike: koffi module is unavailable.");
  return bindRestrictedTokens(ffi as TokenFfi);
}
