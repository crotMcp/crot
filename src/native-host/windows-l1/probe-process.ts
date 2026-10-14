/**
 * WP-23c research launch path. Uses a restricted primary token and an empty
 * kill-on-close Job before ResumeThread. Not a production ProcessLauncher:
 * no stdio bridge, IPC/MIC/network policy or L1 availability declaration.
 */
import { CrotError } from "../../core/errors.js";
import type { JobObject } from "../windows-job.js";
import { validatePid, validateWindowsPath } from "../validation.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";

export interface ProbeSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Explicit environment. Never inherits the CROT service environment. */
  readonly env: Readonly<Record<string, string>>;
}
export interface ProbeProcess {
  readonly pid: number;
  readonly closed: boolean;
  /** Non-blocking poll; null while running, otherwise the DWORD exit code. */
  exitCode(): number | null;
  /** Ends the complete job and releases native process/job handles. */
  close(): void;
}

const STARTUP = "CROT_L1_STARTUPINFO";
const INFORMATION = "CROT_L1_PROCESS_INFORMATION";
const DWORD = "CROT_L1_PROCESS_DWORD";
const FLAGS = 0x4 | 0x400 | 0x08000000; // SUSPENDED | UNICODE_ENVIRONMENT | NO_WINDOW
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))
      throw invalid("environment");
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
  const failure = (stage: string) =>
    new CrotError("OPERATION_FAILED", `Windows process probe: ${stage} failed (code ${lastError()}).`);

  /** Takes ownership only after verifying a fresh empty Job; closes owned Jobs on failure. */
  return (token: unknown, spec: ProbeSpec, job: JobObject): ProbeProcess => {
    const info: { hProcess?: unknown; hThread?: unknown; dwProcessId?: number; dwThreadId?: number } = {};
    let launched = false;
    let assigned = false;
    let ownsJob = false;
    const killDirect = () => {
      if (!nullHandle(info.hProcess) && wait(info.hProcess, 0) !== WAIT_OBJECT) {
        if (!success(terminate(info.hProcess, 1)) && wait(info.hProcess, 0) !== WAIT_OBJECT)
          throw failure("TerminateProcess");
        if (wait(info.hProcess, 5000) !== WAIT_OBJECT) throw failure("termination wait");
      }
    };
    const releaseHandles = () => {
      const thread = info.hThread;
      const process = info.hProcess;
      info.hThread = undefined;
      info.hProcess = undefined;
      const threadOK = nullHandle(thread) || success(release(thread));
      const processOK = nullHandle(process) || success(release(process));
      if (!threadOK || !processOK) throw failure("CloseHandle");
    };
    try {
      const empty = job.accounting();
      if (job.closed || !empty || empty.active !== 0 || empty.total !== 0) throw failure("empty Job verification");
      // A nonempty/unverifiable Job may belong to another workload. Never close it.
      ownsJob = true;
      const executable = validateWindowsPath(spec.executable);
      if (!/\.exe$/i.test(executable)) throw invalid("executable type");
      const cwd = validateWindowsPath(spec.cwd);
      const command = [executable, ...spec.args].map(quoteProbeArgument).join(" ");
      if (command.length >= 32767) throw invalid("command length");
      const env = probeEnvironment(spec.env);
      if (
        !success(
          create(
            token,
            executable,
            Buffer.from(`${command}\0`, "utf16le"),
            null,
            null,
            0,
            FLAGS,
            env,
            cwd,
            { cb: 104 },
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
      if (resume(info.hThread) !== 1) throw failure("ResumeThread");
      if (!success(release(info.hThread))) throw failure("thread CloseHandle");
      info.hThread = undefined;
      let closed = false;
      return {
        pid,
        get closed() {
          return closed;
        },
        exitCode: () => {
          if (closed) throw new CrotError("OPERATION_FAILED", "Windows process probe is closed.");
          const state = wait(info.hProcess, 0);
          if (state === WAIT_TIMEOUT) return null;
          if (state !== WAIT_OBJECT) throw failure("exit wait");
          const code: { value?: number } = {};
          if (!success(getExit(info.hProcess, code)) || typeof code.value !== "number") throw failure("exit code");
          return code.value;
        },
        close: () => {
          if (closed) return;
          closed = true;
          try {
            // Even an exited parent may leave live descendants in its Job.
            const killed = job.terminate(1);
            killDirect();
            if (!killed && (job.accounting()?.active ?? 1) !== 0) throw failure("Job termination");
          } finally {
            try {
              job.close();
            } finally {
              releaseHandles();
            }
          }
        },
      };
    } catch (error) {
      try {
        if (assigned) job.terminate(1);
        if (launched || !nullHandle(info.hProcess)) killDirect();
      } finally {
        try {
          if (ownsJob) job.close();
        } finally {
          releaseHandles();
        }
      }
      throw error;
    }
  };
}
