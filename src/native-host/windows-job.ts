/**
 * Windows Job Objects through the koffi FFI module (optional dependency).
 *
 * Each job is created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (closing the
 * last handle terminates every process in the job, including when CROT itself
 * dies) and without BREAKAWAY_OK, so descendants cannot leave it. Only the
 * minimum set of kernel32 functions is bound; no other native code is loaded.
 */
import { CrotError } from "../core/errors.js";
import { validatePid } from "./validation.js";

/** Process counters of a job (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION). */
export interface JobAccounting {
  /** Processes currently in the job. */
  readonly active: number;
  /** Processes ever assigned to the job, including descendants. */
  readonly total: number;
}

export interface JobObject {
  readonly closed: boolean;
  /** Add a running process. False when the process cannot be opened or assigned. */
  assign(pid: number): boolean;
  /** Number of processes in the job, or null when it cannot be queried. */
  activeProcessCount(): number | null;
  /** Process counters, or null when they cannot be queried or are implausible. */
  accounting(): JobAccounting | null;
  /** Terminate every process in the job. */
  terminate(exitCode: number): boolean;
  /** Release the handle (kill-on-close terminates remaining members). Idempotent. */
  close(): void;
}

export interface JobObjectApi {
  createKillOnCloseJob(): JobObject;
}

/** Test seam: loads the FFI module. */
export type FfiLoader = () => Promise<unknown>;

type NativeFunction = (...args: unknown[]) => unknown;
interface FfiLibrary {
  func(signature: string): NativeFunction;
}
interface FfiModule {
  load(name: string): FfiLibrary;
  struct(name: string, members: Record<string, string>): unknown;
}

interface Kernel32 {
  readonly CreateJobObjectW: NativeFunction;
  readonly SetInformationJobObject: NativeFunction;
  readonly QueryAccounting: NativeFunction;
  readonly OpenProcess: NativeFunction;
  readonly AssignProcessToJobObject: NativeFunction;
  readonly TerminateJobObject: NativeFunction;
  readonly CloseHandle: NativeFunction;
}

// Not a literal import: the module is optional and resolved only at runtime.
const FFI_MODULE: string = "koffi";
const defaultLoader: FfiLoader = () => import(FFI_MODULE);

const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_LIMIT_FLAGS = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
const JobObjectBasicAccountingInformation = 1;
const JobObjectExtendedLimitInformation = 9;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on 64-bit Windows; LimitFlags at offset 16. Input only. */
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
/** sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION). */
const BASIC_ACCOUNTING_SIZE = 48;
const ACCOUNTING_STRUCT = "CROT_JOBOBJECT_BASIC_ACCOUNTING_INFORMATION";
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const MAX_COUNTER = 0xffff_ffff;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 200);
const isNullHandle = (h: unknown) => h === null || h === undefined || h === 0 || h === 0n;
const succeeded = (r: unknown) => r !== 0 && r !== 0n && r !== false && r !== null && r !== undefined;

/** A DWORD counter read from native output; anything else is rejected. */
function counter(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_COUNTER ? n : null;
}

class KernelJob implements JobObject {
  private isClosed = false;

  constructor(
    private readonly k32: Kernel32,
    private readonly handle: unknown,
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  assign(pid: number): boolean {
    validatePid(pid);
    if (this.isClosed) throw new CrotError("OPERATION_FAILED", "The Job Object is closed.");
    const proc = this.k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (isNullHandle(proc)) return false;
    try {
      return succeeded(this.k32.AssignProcessToJobObject(this.handle, proc));
    } finally {
      this.k32.CloseHandle(proc);
    }
  }

  accounting(): JobAccounting | null {
    if (this.isClosed) return null;
    // Output struct: koffi fills this object after the call (a Buffer passed as void* is not written back).
    const out: Record<string, unknown> = {};
    if (!succeeded(this.k32.QueryAccounting(this.handle, JobObjectBasicAccountingInformation, out, BASIC_ACCOUNTING_SIZE, null))) return null;
    const active = counter(out.ActiveProcesses);
    const total = counter(out.TotalProcesses);
    if (active === null || total === null || active > total) return null;
    return { active, total };
  }

  activeProcessCount(): number | null {
    return this.accounting()?.active ?? null;
  }

  terminate(exitCode: number): boolean {
    if (this.isClosed) return false;
    return succeeded(this.k32.TerminateJobObject(this.handle, exitCode >>> 0));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.k32.CloseHandle(this.handle);
  }
}

function createJob(k32: Kernel32): JobObject {
  const handle = k32.CreateJobObjectW(null, null);
  if (isNullHandle(handle)) throw new CrotError("OPERATION_FAILED", "CreateJobObjectW failed.");
  const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE);
  info.writeUInt32LE(JOB_LIMIT_FLAGS, LIMIT_FLAGS_OFFSET);
  if (!succeeded(k32.SetInformationJobObject(handle, JobObjectExtendedLimitInformation, info, info.length))) {
    k32.CloseHandle(handle);
    throw new CrotError("OPERATION_FAILED", "SetInformationJobObject (kill-on-close) failed.");
  }
  return new KernelJob(k32, handle);
}

/** Bindings are created once per FFI module (koffi type names are global). */
const bound = new WeakMap<object, Kernel32>();

function bind(ffi: FfiModule): Kernel32 {
  const cached = bound.get(ffi);
  if (cached) return cached;
  ffi.struct(ACCOUNTING_STRUCT, {
    TotalUserTime: "int64_t",
    TotalKernelTime: "int64_t",
    ThisPeriodTotalUserTime: "int64_t",
    ThisPeriodTotalKernelTime: "int64_t",
    TotalPageFaultCount: "uint32_t",
    TotalProcesses: "uint32_t",
    ActiveProcesses: "uint32_t",
    TotalTerminatedProcesses: "uint32_t",
  });
  const lib = ffi.load("kernel32.dll");
  const k32: Kernel32 = {
    CreateJobObjectW: lib.func("void * __stdcall CreateJobObjectW(void *attributes, void *name)"),
    SetInformationJobObject: lib.func("int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32_t length)"),
    QueryAccounting: lib.func(
      `int __stdcall QueryInformationJobObject(void *job, int infoClass, _Out_ ${ACCOUNTING_STRUCT} *info, uint32_t length, void *returnLength)`,
    ),
    OpenProcess: lib.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    AssignProcessToJobObject: lib.func("int __stdcall AssignProcessToJobObject(void *job, void *process)"),
    TerminateJobObject: lib.func("int __stdcall TerminateJobObject(void *job, uint32_t exitCode)"),
    CloseHandle: lib.func("int __stdcall CloseHandle(void *handle)"),
  };
  bound.set(ffi, k32);
  return k32;
}

/**
 * Bind the Job Object API and verify it with a self-test (create, configure,
 * query and close a job). Throws OPERATION_FAILED where it is unavailable:
 * not Windows, not 64-bit, koffi missing or unusable.
 */
export async function loadJobObjectApi(load: FfiLoader = defaultLoader): Promise<JobObjectApi> {
  if (process.platform !== "win32") throw new CrotError("OPERATION_FAILED", "Job Objects are only available on Windows.");
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new CrotError("OPERATION_FAILED", `Job Object support requires 64-bit Windows (arch ${process.arch}).`);
  }
  let loaded: unknown;
  try {
    loaded = await load();
  } catch (error) {
    throw new CrotError("OPERATION_FAILED", `the koffi FFI module is not available: ${describe(error)}`);
  }
  const candidate = ((loaded as { default?: unknown } | null | undefined)?.default ?? loaded) as { load?: unknown; struct?: unknown } | null | undefined;
  if (!candidate || typeof candidate.load !== "function" || typeof candidate.struct !== "function") {
    throw new CrotError("OPERATION_FAILED", "the koffi FFI module has an unexpected shape.");
  }
  const ffi = candidate as unknown as FfiModule;
  try {
    const k32 = bind(ffi);
    const api: JobObjectApi = { createKillOnCloseJob: () => createJob(k32) };
    const probe = api.createKillOnCloseJob();
    try {
      const counters = probe.accounting();
      if (!counters || counters.active !== 0 || counters.total !== 0) throw new Error("job accounting could not be read");
    } finally {
      probe.close();
    }
    return api;
  } catch (error) {
    throw new CrotError("OPERATION_FAILED", `Job Objects could not be initialized: ${describe(error)}`);
  }
}
