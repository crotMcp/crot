/**
 * Per-Core ownership of a fresh Windows AppContainer profile (AD-29).
 * This is a production building block, NOT a confinement availability predicate.
 * No adoption of pre-existing profiles, global ACL edits or implicit elevation.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import { validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";

export interface AppContainerProfilePin {
  /** Trusted SID for PrivateFileProtection/launch setup, never RPC input. */
  readonly sid: string;
  release(): void;
}
export interface AppContainerProfile {
  readonly name: string;
  readonly sid: string;
  /** False until both the owned profile and SID allocation have been released. */
  readonly closed: boolean;
  /** Hold until every actor in the owned Job has drained, not merely parent exit. */
  pin(): AppContainerProfilePin;
  /** Refuses while pinned; a failed close disables further use and can be retried. */
  close(): void;
}
/** Internal binding seam. An allocation is opaque and never a process/RPC parameter. */
export interface AppContainerProfileNative {
  create(name: string, output: { value?: unknown }): number;
  sidText(sid: unknown): string;
  remove(name: string): number;
  freeSid(sid: unknown): void;
}
export interface AppContainerProfiles {
  create(): AppContainerProfile;
  /** Retry only exact failed-setup resources retained by this owner. */
  recover(): void;
}
const ownedProfiles = new WeakSet<object>();
/** Trusted fresh S_OK owner, never a structural/RPC object claiming a SID. */
export function assertOwnedAppContainerProfile(profile: AppContainerProfile): void {
  if (!ownedProfiles.has(profile) || profile.closed) throw failure("unowned profile use");
}
const missing = (v: unknown) => v === undefined || v === null || v === 0 || v === 0n;
const failure = (stage: string, code?: number) =>
  new CrotError("CONFINEMENT_FAILED", `Windows AppContainer ${stage} failed.`, {
    stage,
    ...(code === undefined ? {} : { nativeCode: code >>> 0 }),
  });
const validPackageSid = (sid: string) => {
  if (!/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(sid)) return false;
  return sid
    .split("-")
    .slice(4)
    .every((v) => Number(v) <= 0xffffffff && String(Number(v)) === v);
};

/** The nonce source is a trusted test seam; callers cannot select a profile name. */
export function createAppContainerProfiles(
  native: AppContainerProfileNative,
  nonce: () => string = randomUUID,
): AppContainerProfiles {
  type Owned = { name: string; allocation?: unknown; created: boolean };
  const pending = new Set<Owned>();
  const release = (owned: Owned) => {
    if (owned.created) {
      const status = native.remove(owned.name);
      if (status !== 0) throw failure("profile removal", status);
      owned.created = false;
    }
    if (!missing(owned.allocation)) {
      native.freeSid(owned.allocation);
      owned.allocation = undefined;
    }
    pending.delete(owned);
  };
  const recover = () => {
    for (const owned of pending) release(owned);
  };
  return {
    recover,
    create: () => {
      recover();
      const id = nonce();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
        throw failure("fresh identity");
      const owned: Owned = { name: `crot.l1.${id}`, created: false };
      const output: { value?: unknown } = {};
      try {
        const status = native.create(owned.name, output);
        owned.allocation = output.value;
        // S_OK is the only ownership transfer. ERROR_ALREADY_EXISTS (including
        // a non-null output) never permits deleting/adopting a foreign profile.
        if (status !== 0) throw failure("profile creation", status);
        owned.created = true;
        if (missing(owned.allocation)) throw failure("profile SID allocation");
        const sid = native.sidText(owned.allocation);
        if (!validPackageSid(sid)) throw failure("profile SID validation");
        let closing = false,
          closed = false,
          users = 0;
        const profile: AppContainerProfile = {
          name: owned.name,
          sid,
          get closed() {
            return closed;
          },
          pin: () => {
            if (closing) throw failure("closed profile use");
            users++;
            let released = false;
            return {
              sid,
              release: () => {
                if (released) return;
                released = true;
                users--;
              },
            };
          },
          close: () => {
            if (closed) return;
            closing = true;
            if (users !== 0) throw failure("profile still owns actors");
            release(owned);
            closed = true;
            ownedProfiles.delete(profile);
          },
        };
        ownedProfiles.add(profile);
        return Object.freeze(profile);
      } catch (cause) {
        // A binding may populate its output before throwing. Retain ownership
        // of that allocation too, but never infer profile ownership from it.
        owned.allocation ??= output.value;
        try {
          release(owned);
        } catch {
          pending.add(owned);
        }
        throw cause instanceof CrotError ? cause : failure("profile setup");
      }
    },
  };
}

interface ProfileFfi extends TokenFfi {
  decode(pointer: unknown, type: string, length?: number): unknown;
}
interface ProfileLibraries {
  readonly userenv: string;
  readonly advapi32: string;
  readonly kernel32: string;
}
const OUTPUT = "CROT_APPC_PROFILE_OUTPUT";
const declared = new WeakSet<object>();
const bound = new WeakMap<object, Map<string, AppContainerProfiles>>();
const ok = (v: unknown) => v === true || (typeof v === "number" && v !== 0);

/** System-library adapter; platform admission belongs to loadAppContainerProfiles. */
export function bindAppContainerProfiles(ffi: ProfileFfi, libraries: ProfileLibraries): AppContainerProfiles {
  const key = `${libraries.userenv}\0${libraries.advapi32}\0${libraries.kernel32}`;
  let cache = bound.get(ffi);
  if (!cache) {
    cache = new Map();
    bound.set(ffi, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;
  if (!declared.has(ffi)) {
    ffi.struct(OUTPUT, { value: "void *" });
    declared.add(ffi);
  }
  const userenv = ffi.load(libraries.userenv),
    advapi = ffi.load(libraries.advapi32),
    kernel = ffi.load(libraries.kernel32);
  const create = userenv.func(
    `int32_t __stdcall CreateAppContainerProfile(str16 name, str16 display, str16 description, void *capabilities, uint32_t count, _Out_ ${OUTPUT} *sid)`,
  );
  const remove = userenv.func("int32_t __stdcall DeleteAppContainerProfile(str16 name)");
  const valid = advapi.func("int __stdcall IsValidSid(void *sid)");
  const text = advapi.func(`int __stdcall ConvertSidToStringSidW(void *sid, _Out_ ${OUTPUT} *out)`);
  const free = advapi.func("void * __stdcall FreeSid(void *sid)");
  const localFree = kernel.func("void * __stdcall LocalFree(void *allocation)");
  // Failed LocalFree outputs stay owned; a later setup cannot silently abandon them.
  const pendingText = new Set<unknown>();
  const freeText = (allocation: unknown) => {
    if (!missing(localFree(allocation))) throw failure("SID text release");
    pendingText.delete(allocation);
  };
  const profiles = createAppContainerProfiles({
    create: (name, output) => {
      for (const allocation of pendingText) freeText(allocation);
      return Number(create(name, "CROT L1", "Per-Core command isolation", null, 0, output));
    },
    remove: (name) => Number(remove(name)),
    freeSid: (sid) => {
      if (!missing(free(sid))) throw failure("SID release");
    },
    sidText: (sid) => {
      if (!ok(valid(sid))) throw failure("native SID validation");
      const output: { value?: unknown } = {};
      try {
        if (!ok(text(sid, output)) || missing(output.value)) throw failure("SID conversion");
        const value = ffi.decode(output.value, "char16_t", -1);
        if (typeof value !== "string") throw failure("SID conversion output");
        return value;
      } finally {
        if (!missing(output.value)) {
          pendingText.add(output.value);
          freeText(output.value);
        }
      }
    },
  });
  cache.set(key, profiles);
  return profiles;
}

export async function loadAppContainerProfiles(): Promise<AppContainerProfiles> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Windows AppContainer requires native 64-bit Windows.");
  // Absolute OS DLL paths; never consult PATH or a workspace for native code.
  const systemRoot = validateWindowsPath(process.env.SystemRoot ?? "C:\\Windows");
  if (!/^[A-Za-z]:\\/.test(systemRoot))
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Windows system directory is not a local drive path.");
  try {
    const loaded: unknown = await import("koffi");
    const ffi = ((loaded as { default?: unknown }).default ?? loaded) as ProfileFfi;
    const dll = (name: string) => path.win32.join(systemRoot, "System32", name);
    return bindAppContainerProfiles(ffi, {
      userenv: dll("userenv.dll"),
      advapi32: dll("advapi32.dll"),
      kernel32: dll("kernel32.dll"),
    });
  } catch {
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Windows AppContainer profile APIs are unavailable.");
  }
}
