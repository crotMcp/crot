/**
 * Owned low-level restricted launch used by the native ProcessLauncher.
 * Verifies an empty kill-on-close Job before ResumeThread and accepts only
 * owned stdio. This primitive alone declares no L1 or filesystem availability.
 */
import { bnoIsolationAttribute, bindBnoIsolationVerifier, type BnoIsolation } from "./bno-isolation.js";
import { CrotError } from "../../core/errors.js";
import type { JobObject } from "../windows-job.js";
import { validatePid, validateWindowsPath } from "../validation.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";
import { isNativeByteStdio, releaseStdioChildEnds, type NativeByteStdio } from "./byte-stdio.js";
import { validateOwnedDesktopName } from "./user-objects.js";
import { bindPipeProcessCreation, bindNulProcessCreation } from "./restricted-stdio.js";

export interface ProbeSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Trusted CommandSpec cmd.exe wrapper arguments are already escaped. */
  readonly windowsVerbatimArguments?: boolean;
  /** Explicit environment. Never inherits the CROT service environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Explicitly owned standard streams; never inherit arbitrary host handles. */
  readonly stdio?: "nul" | NativeByteStdio;
  /** AD-24 trusted, newly owned noninteractive station/desktop, never caller input. */
  readonly desktop?: string;
  /** AD-25 host-generated branded namespace, never untrusted process input. */
  readonly bnoIsolation?: BnoIsolation;
  /** AD-24 new hidden console, only inside the owned noninteractive desktop. */
  readonly console?: "owned-hidden";
  /** Owned research diagnostics only; never forwarded from Core/CommandSpec. */
  readonly diagnostics?: {
    readonly debugOnlyThisProcess: boolean;
    readonly beforeResume: (pid: number, debuggerAttached: () => boolean) => void;
  };
}
export interface ProbeProcess {
  readonly pid: number;
  readonly closed: boolean;
  /** Captured before releasing the native handle, including forced close. */
  readonly finalExitCode: number | null;
  /** Non-blocking poll; null while running, otherwise the DWORD exit code. */
  exitCode(): number | null;
  /** Ends the complete job and releases native process/job handles. */
  close(): void;
}

const STARTUP = "CROT_L1_STARTUPINFO";
const INFORMATION = "CROT_L1_PROCESS_INFORMATION";
const DWORD = "CROT_L1_PROCESS_DWORD";
const FLAGS = 0x4 | 0x400; // SUSPENDED | UNICODE_ENVIRONMENT; console is selected explicitly below
const WAIT_OBJECT = 0;
const WAIT_TIMEOUT = 258;
const nullHandle = (h: unknown) => h === null || h === undefined || h === 0 || h === 0n;
const success = (r: unknown) => r === true || (typeof r === "number" && r !== 0) || (typeof r === "bigint" && r !== 0n);
const invalid = (what: string) => new CrotError("INVALID_INPUT", `Windows process probe: invalid ${what}.`);
const declared = new WeakSet<object>();

/** CRT/CommandLineToArgv-style quoting for a direct exe, not cmd.exe syntax. */
export function quoteProbeArgument(arg: string): string {
  if (typeof arg !== "string" || arg.includes("\0")) throw invalid("argument");
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
export function probeEnvironment(env: Readonly<Record<string, string>>): Buffer {
  const seen = new Set<string>();
  const entries = Object.entries(env).sort(([a], [b]) =>
    a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0,
  );
  for (const [key, value] of entries) {
    if (!/^[^=\0]+$/.test(key) || typeof value !== "string" || value.includes("\0")) throw invalid("environment");
    const folded = key.toUpperCase();
    if (seen.has(folded)) throw invalid("duplicate environment name");
    seen.add(folded);
  }
  const text = `${entries.map(([k, v]) => `${k}=${v}`).join("\0")}\0\0`;
  if (text.length > 32767) throw invalid("environment size");
  return Buffer.from(text, "utf16le");
}

export function bindProbeLauncher(ffi: TokenFfi, libraries: TokenLibraries) {
  if (!declared.has(ffi)) {
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
    ffi.struct(INFORMATION, { hProcess: "void *", hThread: "void *", dwProcessId: "uint32_t", dwThreadId: "uint32_t" });
    ffi.struct(DWORD, { value: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(STARTUP) !== 104 || ffi.sizeof(INFORMATION) !== 24)
    throw new CrotError("OPERATION_FAILED", "Windows process probe requires the 64-bit native structure ABI.");
  const a = ffi.load(libraries.advapi32);
  const k = ffi.load(libraries.kernel32);
  const create = a.func(
    `int __stdcall CreateProcessAsUserW(void *token, str16 application, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32_t flags, void *environment, str16 cwd, ${STARTUP} *startup, _Out_ ${INFORMATION} *out)`,
  );
  const resume = k.func("uint32_t __stdcall ResumeThread(void *thread)");
  const terminate = k.func("int __stdcall TerminateProcess(void *process, uint32_t code)");
  const wait = k.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)");
  const getExit = k.func(`int __stdcall GetExitCodeProcess(void *process, _Out_ ${DWORD} *code)`);
  const release = k.func("int __stdcall CloseHandle(void *handle)");
  const lastError = k.func("uint32_t __stdcall GetLastError(void)");
  const checkDebugger = k.func(`int __stdcall CheckRemoteDebuggerPresent(void *process, _Out_ ${DWORD} *present)`);
  const failure = (stage: string) =>
    new CrotError("OPERATION_FAILED", `Windows process probe: ${stage} failed (code ${lastError()}).`);

  // Preserve exact ownership if a failed launch cannot be cleaned up. There is
  // no successful recovery claim or subsequent launch through this binding.
  const failedLaunchCleanup = new Set<object>();
  /** Takes ownership only after verifying a fresh empty Job; closes owned Jobs on failure. */
  return (token: unknown, spec: ProbeSpec, job: JobObject): ProbeProcess => {
    const info: { hProcess?: unknown; hThread?: unknown; dwProcessId?: number; dwThreadId?: number } = {};
    let launched = false;
    let assigned = false;
    let ownsJob = false;
    let ownedStdio: NativeByteStdio | undefined;
    const killDirect = () => {
      if (!nullHandle(info.hProcess) && wait(info.hProcess, 0) !== WAIT_OBJECT) {
        // TerminateJobObject is asynchronous. TerminateProcess can report
        // ACCESS_DENIED for an already-terminating process whose handle is not
        // signalled yet. Require actual bounded completion, never call that
        // error a successful kill without waiting.
        if (!success(terminate(info.hProcess, 1)) && wait(info.hProcess, 5000) !== WAIT_OBJECT)
          throw failure("TerminateProcess");
        if (wait(info.hProcess, 5000) !== WAIT_OBJECT) throw failure("termination wait");
      }
    };
    const releaseHandles = () => {
      let error: unknown;
      for (const key of ["hThread", "hProcess"] as const) {
        const handle = info[key];
        if (nullHandle(handle)) continue;
        try {
          if (!success(release(handle))) throw failure("CloseHandle");
          info[key] = undefined;
        } catch (cause) {
          error ??= cause;
        }
      }
      if (error) throw error;
    };
    try {
      if (failedLaunchCleanup.size)
        throw new CrotError("OPERATION_FAILED", "Windows process probe has incomplete failed-launch cleanup.");
      const empty = job.accounting();
      if (job.closed || !empty || empty.active !== 0 || empty.total !== 0) throw failure("empty Job verification");
      // A nonempty/unverifiable Job may belong to another workload. Never close it.
      ownsJob = true;
      if (isNativeByteStdio(spec.stdio)) ownedStdio = spec.stdio;
      else if (spec.stdio !== undefined && spec.stdio !== "nul") throw invalid("stdio");
      const executable = validateWindowsPath(spec.executable);
      if (!/\.exe$/i.test(executable)) throw invalid("executable type");
      const cwd = validateWindowsPath(spec.cwd);
      // Validate even verbatim arguments; only the trusted shell provider decides
      // whether cmd.exe needs its pre-escaped command line preserved.
      spec.args.forEach(quoteProbeArgument);
      const command = [
        quoteProbeArgument(executable),
        ...spec.args.map((arg) => (spec.windowsVerbatimArguments ? arg : quoteProbeArgument(arg))),
      ].join(" ");
      if (command.length >= 32767) throw invalid("command length");
      const env = probeEnvironment(spec.env);
      const desktop =
        spec.desktop === undefined ? undefined : Buffer.from(`${validateOwnedDesktopName(spec.desktop)}\0`, "utf16le");
      if (
        spec.diagnostics &&
        (typeof spec.diagnostics.debugOnlyThisProcess !== "boolean" ||
          typeof spec.diagnostics.beforeResume !== "function")
      )
        throw invalid("owned diagnostics");
      if (spec.console !== undefined && (spec.console !== "owned-hidden" || !desktop)) throw invalid("owned console");
      const consoleFlags = spec.console === "owned-hidden" ? 0x10 : 0x08000000;
      const flags = FLAGS | consoleFlags | (spec.diagnostics?.debugOnlyThisProcess ? 0x2 : 0);
      const bno = spec.bnoIsolation;
      const bnoVerifier = bno ? bindBnoIsolationVerifier(ffi, libraries) : undefined;
      if (bno) {
        bnoIsolationAttribute(bno);
        if (!ownedStdio && spec.stdio !== "nul") throw invalid("BNO requires owned extended startup");
        bnoVerifier!.retry();
      }
      if (ownedStdio) {
        bindPipeProcessCreation(ffi, libraries)(
          token,
          executable,
          Buffer.from(`${command}\0`, "utf16le"),
          flags,
          env,
          cwd,
          info,
          ownedStdio,
          desktop,
          bno,
        );
      } else if (spec.stdio === "nul") {
        bindNulProcessCreation(ffi, libraries)(
          token,
          executable,
          Buffer.from(`${command}\0`, "utf16le"),
          flags,
          env,
          cwd,
          info,
          desktop,
          bno,
        );
      } else if (
        !success(
          create(
            token,
            executable,
            Buffer.from(`${command}\0`, "utf16le"),
            null,
            null,
            0,
            flags,
            env,
            cwd,
            {
              cb: 104,
              ...(desktop ? { lpDesktop: desktop } : {}),
              ...(spec.console ? { dwFlags: 1, wShowWindow: 0 } : {}),
            },
            info,
          ),
        )
      )
        throw failure("CreateProcessAsUserW");
      launched = true;
      if (nullHandle(info.hProcess) || nullHandle(info.hThread)) throw failure("process handles");
      let pid: number;
      try {
        pid = validatePid(info.dwProcessId);
      } catch {
        throw failure("native process id");
      }
      if (!job.assign(pid)) throw failure("Job assignment");
      assigned = true;
      const contained = job.accounting();
      if (!contained || contained.active < 1 || contained.total < 1) throw failure("Job accounting");
      if (ownedStdio) releaseStdioChildEnds(ownedStdio);
      if (bno) bnoVerifier!.verify(info.hProcess, bno);
      if (spec.diagnostics) {
        let observing = true;
        try {
          // A boolean witness over THIS held native handle, only before resume.
          // No handle, arbitrary PID opener or reusable authority leaves here.
          spec.diagnostics.beforeResume(pid, () => {
            if (!observing || nullHandle(info.hProcess)) throw invalid("owned debugger observation lifetime");
            const present: { value?: number } = {};
            if (!success(checkDebugger(info.hProcess, present)) || ![0, 1].includes(present.value!))
              throw failure("owned debugger observation");
            return present.value === 1;
          });
        } finally {
          observing = false;
        }
        if (!spec.diagnostics.debugOnlyThisProcess) {
          // An external debugger reports attached before its initial attach
          // suspension has necessarily been released. Wait for it to finish;
          // never consume its suspension with an additional ResumeThread.
          // This is diagnostic-only and observes THIS held child thread, not a
          // PID opener, actor-provided handle or production readiness shortcut.
          const queryThread = ffi
            .load(libraries.ntdll ?? "ntdll.dll")
            .func(
              `int32_t __stdcall NtQueryInformationThread(void *thread, uint32_t kind, _Out_ ${DWORD} *count, uint32_t size, _Out_ ${DWORD} *returned)`,
            );
          const deadline = Date.now() + 10000;
          const sleeper = new Int32Array(new SharedArrayBuffer(4));
          for (;;) {
            const count: { value?: number } = {},
              returned: { value?: number } = {};
            const nativeStatus = Number(queryThread(info.hThread, 35, count, 4, returned));
            if (
              nativeStatus !== 0 ||
              returned.value !== 4 ||
              !Number.isSafeInteger(count.value) ||
              count.value! < 1 ||
              count.value! > 0x7fffffff
            )
              throw new CrotError(
                "OPERATION_FAILED",
                "Windows process probe: owned diagnostic suspend observation failed.",
                {
                  stage: "owned diagnostic suspend observation",
                  nativeStatus,
                },
              );
            if (count.value === 1) break;
            if (Date.now() >= deadline)
              throw new CrotError(
                "OPERATION_FAILED",
                "Windows process probe: owned diagnostic attach suspension deadline failed.",
                {
                  stage: "owned diagnostic attach suspension deadline",
                  previousSuspendCount: count.value,
                },
              );
            Atomics.wait(sleeper, 0, 0, 10);
          }
        }
      }
      const previousSuspendCount = resume(info.hThread);
      if (previousSuspendCount !== 1) {
        // GetLastError is defined only for the failure sentinel. For 0 or >1,
        // record the actual count, not an unrelated/stale last-error value.
        const nativeCode = previousSuspendCount === 0xffffffff ? Number(lastError()) : undefined;
        throw new CrotError(
          "OPERATION_FAILED",
          `Windows process probe: ResumeThread failed (previous suspend count ${String(previousSuspendCount)}${nativeCode === undefined ? "" : `, code ${nativeCode}`}).`,
          { stage: "ResumeThread", previousSuspendCount, ...(nativeCode === undefined ? {} : { nativeCode }) },
        );
      }
      if (!success(release(info.hThread))) throw failure("thread CloseHandle");
      info.hThread = undefined;
      let closed = false;
      let resourcesReleased = false;
      let finalExitCode: number | null = null;
      const readExit = () => {
        const state = wait(info.hProcess, 0);
        if (state === WAIT_TIMEOUT) return null;
        if (state !== WAIT_OBJECT) throw failure("exit wait");
        const code: { value?: number } = {};
        if (!success(getExit(info.hProcess, code)) || typeof code.value !== "number") throw failure("exit code");
        finalExitCode = code.value;
        return code.value;
      };
      return {
        pid,
        get closed() {
          return closed;
        },
        get finalExitCode() {
          return finalExitCode;
        },
        exitCode: () => {
          if (closed) throw new CrotError("OPERATION_FAILED", "Windows process probe is closed.");
          return readExit();
        },
        close: () => {
          if (resourcesReleased) return;
          closed = true;
          let error: unknown;
          const attempt = (action: () => void) => {
            try {
              action();
            } catch (cause) {
              error ??= cause;
            }
          };
          attempt(() => {
            // An exited direct parent may still own live descendants.
            const killed = job.closed || job.terminate(1);
            if (!nullHandle(info.hProcess)) {
              killDirect();
              readExit();
            }
            if (!killed && (job.accounting()?.active ?? 1) !== 0) throw failure("Job termination");
          });
          attempt(() => job.close());
          attempt(releaseHandles);
          attempt(() => ownedStdio?.closeSync());
          if (error) throw error;
          resourcesReleased = true;
        },
      };
    } catch (error) {
      let cleanupFailed = false;
      const attempt = (action: () => void) => {
        try {
          action();
        } catch {
          cleanupFailed = true;
        }
      };
      if (assigned)
        attempt(() => {
          job.terminate(1);
        });
      if (launched || !nullHandle(info.hProcess)) attempt(killDirect);
      if (ownsJob) attempt(() => job.close());
      attempt(releaseHandles);
      attempt(() => ownedStdio?.closeSync());
      if (cleanupFailed) failedLaunchCleanup.add({ info, job, ownedStdio });
      throw error;
    }
  };
}
