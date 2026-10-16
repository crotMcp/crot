/**
 * Verified, suspended AppContainer launch for NativeProcessLauncher.
 * No filesystem grant, network-on promise or CommandConfinement availability.
 * Keeps the existing owned byte streams / Job / cancellation implementation.
 */
import path from "node:path";
import { bindPrivatePipeMaps, type PrivatePipeMap } from "./device-map.js";
import { CrotError } from "../../core/errors.js";
import type { JobObject } from "../windows-job.js";
import type { AppContainerProfile } from "./appcontainer-profile.js";
import { ownedStdioHandles } from "./byte-stdio.js";
import { bindProbeLauncher, type ProbeProcess, type ProbeSpec } from "./probe-process.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";
interface AppContainerFfi extends TokenFfi {
  decode(pointer: unknown, type: string): unknown;
}
export interface AppContainerProcessIdentity {
  readonly restrictingSid: string;
  launchProbe(spec: ProbeSpec, job: JobObject): ProbeProcess;
}
const OUTPUT = "CROT_APPC_PROCESS_OUTPUT";
const SIZE = "CROT_APPC_PROCESS_SIZE";
const DWORD = "CROT_APPC_PROCESS_DWORD";
const STARTUP = "CROT_APPC_PROCESS_STARTUP";
const EXTENDED = "CROT_APPC_PROCESS_EXTENDED";
const INFO = "CROT_APPC_PROCESS_INFORMATION";
const CAPABILITIES = "CROT_APPC_PROCESS_CAPABILITIES";
const SID_ATTRIBUTES = "CROT_APPC_PROCESS_SID_ATTRIBUTES";
const declared = new WeakSet<object>();
// Fatal native cleanup may not be "recovered" by GC, a new profile or a new
// identity wrapper. Retain exact owners for process lifetime; no availability
// claim is permitted after such a failure.
const failedAppContainerStarts = new Set<object>();
const missing = (v: unknown) =>
  v === undefined || v === null || v === 0 || v === 0n || v === -1n || v === 0xffffffffffffffffn;
const ok = (v: unknown) => v === true || (typeof v === "number" && v !== 0);
const failure = (stage: string, code?: unknown) =>
  new CrotError("CONFINEMENT_FAILED", `Windows AppContainer ${stage} failed.`, {
    stage,
    ...(typeof code === "number" ? { nativeCode: code >>> 0 } : {}),
  });

/** A real owned profile is pinned for the complete Job lifetime. */
export function bindAppContainerProcessIdentity(
  ffi: AppContainerFfi,
  libraries: TokenLibraries,
  profile: AppContainerProfile,
  ownerSid: string,
): AppContainerProcessIdentity {
  if (!declared.has(ffi)) {
    ffi.struct(OUTPUT, { value: "void *" });
    ffi.struct(SIZE, { value: "size_t" });
    ffi.struct(DWORD, { value: "uint32_t" });
    ffi.struct(STARTUP, {
      cb: "uint32_t",
      lpReserved: "void *",
      lpDesktop: "void *",
      lpTitle: "void *",
      dwX: "uint32_t",
      dwY: "uint32_t",
      dwXSize: "uint32_t",
      dwYSize: "uint32_t",
      dwXCountChars: "uint32_t",
      dwYCountChars: "uint32_t",
      dwFillAttribute: "uint32_t",
      dwFlags: "uint32_t",
      wShowWindow: "uint16_t",
      cbReserved2: "uint16_t",
      lpReserved2: "void *",
      hStdInput: "void *",
      hStdOutput: "void *",
      hStdError: "void *",
    });
    ffi.struct(EXTENDED, { startup: STARTUP, attributes: "void *" });
    ffi.struct(INFO, { hProcess: "void *", hThread: "void *", dwProcessId: "uint32_t", dwThreadId: "uint32_t" });
    ffi.struct(CAPABILITIES, {
      AppContainerSid: "void *",
      Capabilities: "void *",
      CapabilityCount: "uint32_t",
      Reserved: "uint32_t",
    });
    ffi.struct(SID_ATTRIBUTES, { Sid: "void *", Attributes: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(EXTENDED) !== 112 || ffi.sizeof(INFO) !== 24 || ffi.sizeof(CAPABILITIES) !== 24)
    throw failure("64-bit ABI admission");
  const k = ffi.load(libraries.kernel32),
    a = ffi.load(libraries.advapi32);
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const convert = a.func(`int __stdcall ConvertStringSidToSidW(str16 text, _Out_ ${OUTPUT} *out)`);
  const localFree = k.func("void * __stdcall LocalFree(void *allocation)");
  const inherit = k.func("int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)");
  const init = k.func(
    `int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ ${SIZE} *size)`,
  );
  const update = k.func(
    "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, size_t attribute, void *value, size_t size, void *previous, void *returned)",
  );
  const remove = k.func("void __stdcall DeleteProcThreadAttributeList(void *list)");
  const create = k.func(
    `int __stdcall CreateProcessW(str16 application, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32_t flags, void *environment, str16 cwd, ${EXTENDED} *startup, _Out_ ${INFO} *out)`,
  );
  const openToken = a.func(`int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ ${OUTPUT} *out)`);
  const tokenInfo = a.func(
    `int __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ ${DWORD} *returned)`,
  );
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const valid = a.func("int __stdcall IsValidSid(void *sid)");
  const equal = a.func("int __stdcall EqualSid(void *left, void *right)");
  const subCount = a.func("void * __stdcall GetSidSubAuthorityCount(void *sid)");
  const sub = a.func("void * __stdcall GetSidSubAuthority(void *sid, uint32_t index)");
  const maps = bindPrivatePipeMaps(ffi, {
    ...libraries,
    ntdll: libraries.ntdll ?? path.join(path.dirname(libraries.kernel32), "ntdll.dll"),
  });
  const retained = new Set<unknown>();
  const failedPins = new Set<ReturnType<typeof profile.pin>>();
  let blocked = false;
  const releaseMemory = (allocation: unknown) => {
    if (missing(allocation)) return;
    if (!missing(localFree(allocation))) {
      retained.add(allocation);
      blocked = true;
      throw failure("launch SID release", last());
    }
    retained.delete(allocation);
  };
  return {
    restrictingSid: profile.sid,
    launchProbe: (spec, job) => {
      if (blocked || retained.size || failedPins.size) throw failure("previous incomplete cleanup");
      const pin = profile.pin();
      const packageSid: { value?: unknown } = {};
      let child: ProbeProcess | undefined;
      let pipeMap: PrivatePipeMap | undefined;
      let abortedBeforeResume = false;
      const launchers = new Set<ReturnType<typeof bindProbeLauncher>>();
      try {
        if (!ok(convert(pin.sid, packageSid)) || missing(packageSid.value) || !ok(valid(packageSid.value)))
          throw failure("launch SID conversion", last());
        const launch = bindProbeLauncher(ffi, libraries, {
          create: (input) => {
            const handles = ownedStdioHandles(input.stdio);
            if (handles.length !== 3 || handles.some(missing)) throw failure("owned handle admission");
            const size: { value?: number | bigint } = { value: 0 };
            const sized = init(null, 2, 0, size),
              error = Number(last()),
              bytes = Number(size.value);
            if (ok(sized) || error !== 122 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536)
              throw failure("startup attribute sizing", error);
            const list = Buffer.alloc(bytes),
              caps = Buffer.alloc(24),
              allow = Buffer.alloc(24);
            ffi.encode(caps, CAPABILITIES, {
              AppContainerSid: packageSid.value,
              Capabilities: null,
              CapabilityCount: 0,
              Reserved: 0,
            });
            handles.forEach((h, i) => ffi.encode(allow.subarray(i * 8), "void *", h));
            let initialized = false,
              fault: unknown;
            const marked: unknown[] = [];
            try {
              if (!ok(init(list, 2, 0, size))) throw failure("startup attribute initialization", last());
              initialized = true;
              if (!ok(update(list, 0, 0x20009, caps, caps.length, null, null)))
                throw failure("security capabilities", last());
              if (!ok(update(list, 0, 0x20002, allow, allow.length, null, null)))
                throw failure("handle allowlist", last());
              for (const h of handles) {
                if (!ok(inherit(h, 1, 1))) throw failure("owned child inheritance", last());
                marked.push(h);
              }
              if (
                !ok(
                  create(
                    input.executable,
                    input.command,
                    null,
                    null,
                    1,
                    input.flags | 0x80000,
                    input.environment,
                    input.cwd,
                    {
                      startup: {
                        cb: 112,
                        dwFlags: 0x100,
                        hStdInput: handles[0],
                        hStdOutput: handles[1],
                        hStdError: handles[2],
                      },
                      attributes: list,
                    },
                    input.info,
                  ),
                )
              )
                throw failure("process creation", last());
            } catch (cause) {
              fault = cause;
            } finally {
              for (const h of marked) {
                try {
                  if (!ok(inherit(h, 1, 0))) {
                    fault ??= failure("clear child inheritance", last());
                    blocked = true;
                  }
                } catch (cause) {
                  fault ??= cause;
                  blocked = true;
                }
              }
              if (initialized) remove(list);
            }
            if (fault) throw fault;
          },
          abortedBeforeResume: () => {
            pipeMap?.close();
            abortedBeforeResume = true;
          },
          verify: (process) => {
            const token: { value?: unknown } = {};
            let verificationFault: unknown;
            try {
              if (!ok(openToken(process, 8, token)) || missing(token.value))
                throw failure("token readback open", last());
              const read = (kind: number) => {
                const required: { value?: number | bigint } = { value: 0 };
                const first = tokenInfo(token.value, kind, null, 0, required),
                  error = Number(last()),
                  bytes = Number(required.value);
                if (ok(first) || error !== 122 || !Number.isSafeInteger(bytes) || bytes < 4 || bytes > 65536)
                  throw failure("token readback sizing", error);
                const buffer = Buffer.alloc(bytes),
                  returned: { value?: number | bigint } = { value: 0 };
                if (
                  !ok(tokenInfo(token.value, kind, buffer, buffer.length, returned)) ||
                  Number(returned.value) > bytes ||
                  Number(returned.value) < 4
                )
                  throw failure("token readback", last());
                return buffer;
              };
              const isApp = read(29),
                packageInfo = read(31),
                capabilities = read(30),
                integrity = read(25);
              if (packageInfo.length < 8 || integrity.length < 16) throw failure("token readback ABI");
              const observedSid = ffi.decode(packageInfo, "void *");
              const label = ffi.decode(integrity, SID_ATTRIBUTES) as { Sid?: unknown };
              if (
                isApp.readUInt32LE(0) !== 1 ||
                missing(observedSid) ||
                !ok(valid(observedSid)) ||
                !ok(equal(observedSid, packageSid.value))
              )
                throw failure("AppContainer identity verification");
              if (capabilities.readUInt32LE(0) !== 0) throw failure("zero capabilities verification");
              if (!label || missing(label.Sid) || !ok(valid(label.Sid))) throw failure("integrity SID verification");
              const count = subCount(label.Sid);
              if (missing(count) || ffi.decode(count, "uint8_t") !== 1) throw failure("integrity authority count");
              const level = sub(label.Sid, 0);
              if (missing(level) || ffi.decode(level, "uint32_t") !== 4096) throw failure("Low integrity verification");
            } catch (cause) {
              verificationFault = cause;
            } finally {
              if (!missing(token.value)) {
                try {
                  if (!ok(close(token.value))) {
                    blocked = true;
                    retained.add(token.value);
                    verificationFault ??= failure("token readback close", last());
                  }
                } catch (cause) {
                  blocked = true;
                  retained.add(token.value);
                  verificationFault ??= cause;
                }
              }
            }
            if (verificationFault) throw verificationFault;
            pipeMap = maps.create(ownerSid, pin.sid);
            pipeMap.apply(process);
          },
        });
        launchers.add(launch);
        child = launch(null, spec, job);
        launchers.delete(launch);
        releaseMemory(packageSid.value);
        packageSid.value = undefined;
        const owned = child;
        let released = false;
        return {
          pid: owned.pid,
          get closed() {
            return owned.closed;
          },
          get finalExitCode() {
            return owned.finalExitCode;
          },
          exitCode: () => owned.exitCode(),
          close: () => {
            // ACL/profile teardown must wait for ALL actors, including detached
            // descendants, not just the direct process handle becoming signalled.
            if (!released && !job.closed) {
              if (!job.terminate(1)) throw failure("owned Job termination");
              const deadline = Date.now() + 5000;
              const sleep = new Int32Array(new SharedArrayBuffer(4));
              for (;;) {
                const state = job.accounting();
                if (!state) throw failure("owned Job drain observation");
                if (state.active === 0) break;
                if (Date.now() >= deadline) throw failure("owned Job drain deadline");
                Atomics.wait(sleep, 0, 0, 10);
              }
            } else if (!released) throw failure("owned Job closed before drain");
            owned.close();
            pipeMap?.close();
            if (!released) {
              pin.release();
              released = true;
            }
          },
        };
      } catch (cause) {
        let cleanupFailed = false;
        try {
          child?.close();
        } catch {
          cleanupFailed = true;
        }
        try {
          releaseMemory(packageSid.value);
        } catch {
          cleanupFailed = true;
        }
        if (abortedBeforeResume) launchers.clear();
        if (launchers.size) {
          // bindProbeLauncher retains any failed native cleanup in its closure.
          // Preserve that closure strongly, rather than losing ownership on throw.
          blocked = true;
          failedAppContainerStarts.add({ profile, pin, child, job, pipeMap, retained, failedPins, launchers, ffi });
        }
        if (!cleanupFailed && !blocked) pin.release();
        else {
          blocked = true;
          failedPins.add(pin);
          failedAppContainerStarts.add({ profile, pin, child, job, pipeMap, retained, failedPins, launchers, ffi });
        }
        throw cause;
      }
    },
  };
}
