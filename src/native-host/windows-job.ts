/**
 * Windows Job Objects through the koffi FFI module (optional dependency).
 *
 * Each job is created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (closing the
 * last handle terminates every process in the job, including when CROT itself
 * dies) and without BREAKAWAY_OK, so descendants cannot leave it. Only the
 * minimum set of kernel32 functions is bound; no other native code is loaded.
 */
import { randomBytes } from "node:crypto";
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

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 200);
const isNullHandle = (h: unknown) => h === null || h === undefined || h === 0 || h === 0n;
const succeeded = (r: unknown) => r !== 0 && r !== 0n && r !== false && r !== null && r !== undefined;

/** A DWORD counter read from native output; anything else is rejected. */
function counter(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_COUNTER ? n : null;
}

class KernelJob implements JobObject {
  private isClosed = false;
  private readonly pendingProcessHandles = new Set<unknown>();

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
    this.pendingProcessHandles.add(proc);
    let assigned = false;
    let failure: unknown;
    try {
      assigned = succeeded(this.k32.AssignProcessToJobObject(this.handle, proc));
    } catch (error) {
      failure = error;
    }
    try {
      if (!succeeded(this.k32.CloseHandle(proc)))
        throw new CrotError("OPERATION_FAILED", "CloseHandle (process assignment) failed.");
      this.pendingProcessHandles.delete(proc);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    return assigned;
  }

  accounting(): JobAccounting | null {
    if (this.isClosed) return null;
    // Output struct: koffi fills this object after the call (a Buffer passed as void* is not written back).
    const out: Record<string, unknown> = {};
    if (
      !succeeded(
        this.k32.QueryAccounting(this.handle, JobObjectBasicAccountingInformation, out, BASIC_ACCOUNTING_SIZE, null),
      )
    )
      return null;
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
    let failure: unknown;
    if (!this.isClosed) {
      try {
        if (!succeeded(this.k32.CloseHandle(this.handle)))
          throw new CrotError("OPERATION_FAILED", "CloseHandle (Job Object) failed.");
        this.isClosed = true;
      } catch (error) {
        failure = error;
      }
    }
    // Failed closes retain their exact owned handles. Retry cleanup without
    // reopening by PID, and attempt all resources even after the first error.
    for (const handle of this.pendingProcessHandles) {
      try {
        if (!succeeded(this.k32.CloseHandle(handle)))
          throw new CrotError("OPERATION_FAILED", "CloseHandle (process assignment) failed.");
        this.pendingProcessHandles.delete(handle);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}

// A failed configuration still owns a kernel handle. Keep it reachable across
// API rebindings/self-test failures, retry that exact owner before allocating,
// and never grow an unbounded series of leaked failed creations.
const failedCreations = new WeakMap<Kernel32, Set<JobObject>>();
function createJob(k32: Kernel32, allocate: () => unknown = () => k32.CreateJobObjectW(null, null)): JobObject {
  let pending = failedCreations.get(k32);
  if (!pending) {
    pending = new Set();
    failedCreations.set(k32, pending);
  }
  let cleanupError: unknown;
  for (const job of pending) {
    try {
      job.close();
      pending.delete(job);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) throw cleanupError;
  const handle = allocate();
  if (isNullHandle(handle)) throw new CrotError("OPERATION_FAILED", "CreateJobObjectW failed.");
  const job = new KernelJob(k32, handle);
  try {
    const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE);
    info.writeUInt32LE(JOB_LIMIT_FLAGS, LIMIT_FLAGS_OFFSET);
    if (!succeeded(k32.SetInformationJobObject(handle, JobObjectExtendedLimitInformation, info, info.length)))
      throw new CrotError("OPERATION_FAILED", "SetInformationJobObject (kill-on-close) failed.");
    return job;
  } catch (error) {
    try {
      job.close();
    } catch {
      pending.add(job);
    }
    throw error;
  }
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
    SetInformationJobObject: lib.func(
      "int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32_t length)",
    ),
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

/** Native binding seam. Platform and self-test checks remain in loadJobObjectApi. */
export function bindJobObjectApi(ffi: FfiModule): JobObjectApi {
  const k32 = bind(ffi);
  return { createKillOnCloseJob: () => createJob(k32) };
}

/** AD-27 internal owner name; a name/SID alone never authenticates filesystem I/O. */
const viewJobNames = new WeakMap<JobObject, string>();
const failedNameCloses = new WeakMap<object, Set<unknown>>();
export function ownedViewJobName(job: JobObject): string {
  const name = viewJobNames.get(job);
  if (!name || job.closed) throw new CrotError("INVALID_INPUT", "Not an open owned projection Job.");
  return name;
}
/** Trusted projection setup only. Existing unnamed Job behavior/gates are unchanged. */
export function bindViewJobObjectApi(ffi: FfiModule): JobObjectApi {
  const k32 = bind(ffi),
    lib = ffi.load("kernel32.dll");
  const create = lib.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const last = lib.func("uint32_t __stdcall GetLastError(void)");
  const setLast = lib.func("void __stdcall SetLastError(uint32_t error)");
  let pending = failedNameCloses.get(ffi);
  if (!pending) {
    pending = new Set();
    failedNameCloses.set(ffi, pending);
  }
  return {
    createKillOnCloseJob: () => {
      for (const handle of pending) {
        if (!succeeded(k32.CloseHandle(handle)))
          throw new CrotError("OPERATION_FAILED", "Projection Job close incomplete.");
        pending.delete(handle);
      }
      const name = `Local\\crot-view-job-${randomBytes(24).toString("hex")}`;
      const job = createJob(k32, () => {
        setLast(0);
        const handle = create(null, name);
        const collision = Number(last()) === 183;
        if (!isNullHandle(handle) && collision) {
          // Never configure/terminate an existing foreign object on name collision.
          if (!succeeded(k32.CloseHandle(handle))) pending.add(handle);
          throw new CrotError("OPERATION_FAILED", "Projection Job name collision.");
        }
        return handle;
      });
      viewJobNames.set(job, name);
      return job;
    },
  };
}

/**
 * Bind the Job Object API and verify it with a self-test (create, configure,
 * query and close a job). Throws OPERATION_FAILED where it is unavailable:
 * not Windows, not 64-bit, koffi missing or unusable.
 */
export async function loadJobObjectApi(load: FfiLoader = defaultLoader): Promise<JobObjectApi> {
  if (process.platform !== "win32")
    throw new CrotError("OPERATION_FAILED", "Job Objects are only available on Windows.");
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new CrotError("OPERATION_FAILED", `Job Object support requires 64-bit Windows (arch ${process.arch}).`);
  }
  let loaded: unknown;
  try {
    loaded = await load();
  } catch (error) {
    throw new CrotError("OPERATION_FAILED", `the koffi FFI module is not available: ${describe(error)}`);
  }
  const candidate = ((loaded as { default?: unknown } | null | undefined)?.default ?? loaded) as
    { load?: unknown; struct?: unknown } | null | undefined;
  if (!candidate || typeof candidate.load !== "function" || typeof candidate.struct !== "function") {
    throw new CrotError("OPERATION_FAILED", "the koffi FFI module has an unexpected shape.");
  }
  const ffi = candidate as unknown as FfiModule;
  try {
    const api = bindJobObjectApi(ffi);
    const probe = api.createKillOnCloseJob();
    let selfTestError: unknown;
    try {
      const counters = probe.accounting();
      if (!counters || counters.active !== 0 || counters.total !== 0)
        throw new Error("job accounting could not be read");
    } catch (error) {
      selfTestError = error;
    }
    try {
      probe.close();
    } catch (error) {
      // The API is not returned on self-test failure. Retain its probe in
      // the binding's recovery set, not in a now-unreachable local variable.
      failedCreations.get(bind(ffi))!.add(probe);
      selfTestError ??= error;
    }
    if (selfTestError) throw selfTestError;
    return api;
  } catch (error) {
    throw new CrotError("OPERATION_FAILED", `Job Objects could not be initialized: ${describe(error)}`);
  }
}

/** AD-27 same canonical ESM FFI instance as the existing Job/token launch path. */
export async function loadViewJobObjectApi(load: FfiLoader = defaultLoader): Promise<JobObjectApi> {
  let loaded: unknown;
  // Preserve platform/ABI/optional-dependency admission and the normal exact
  // empty kill-on-close Job self-test. Never mix require(koffi)'s CJS wrapper
  // with import(koffi)'s ESM wrapper: they share a native type registry.
  await loadJobObjectApi(async () => {
    loaded = await load();
    return loaded;
  });
  const ffi = ((loaded as { default?: unknown } | null | undefined)?.default ?? loaded) as FfiModule;
  return bindViewJobObjectApi(ffi);
}
