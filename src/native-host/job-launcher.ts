/**
 * ProcessLauncher that contains every command in its own kill-on-close
 * Windows Job Object. It wraps the Core Windows launcher: command resolution,
 * argument quoting, environment and stdio stay in Core; only tree control is
 * replaced. There is no process policy here: the ProcessService (authorized by
 * the PermissionEngine) decides what runs, when and with which timeouts.
 */
import { CrotError } from "../core/errors.js";
import type {
  ExitStatus,
  ManagedProcess,
  ProcessControlInfo,
  ProcessLauncher,
  TerminationMode,
} from "../core/platform/types.js";
import type { Readable, Writable } from "node:stream";
import type { JobObject, JobObjectApi } from "./windows-job.js";

export const JOB_OBJECT_PROCESS_CONTROL: ProcessControlInfo = {
  treeTermination: "job-object",
  orphanedDescendants: true,
  // Console programs cannot be asked to exit cleanly from outside their console; graceful requests escalate.
  gracefulTermination: false,
};

export function closedError(): CrotError {
  return new CrotError("OPERATION_FAILED", "The CROT Native Host is closed; no new processes are started.");
}

/** Open Job Objects of one Native Host. */
export class JobTracker {
  private readonly jobs = new Set<JobObject>();
  private uncontainedCount = 0;

  get size(): number {
    return this.jobs.size;
  }

  /** Launches that could not be assigned to a job (the child had already exited, or assignment was refused). */
  get uncontained(): number {
    return this.uncontainedCount;
  }

  add(job: JobObject): void {
    this.jobs.add(job);
  }

  delete(job: JobObject): void {
    this.jobs.delete(job);
  }

  noteUncontained(): void {
    this.uncontainedCount++;
  }

  /** Forced, synchronous termination and release of every open job. */
  terminateAll(): void {
    for (const job of this.jobs) {
      try {
        job.terminate(1);
      } catch {
        // Continue with the remaining jobs.
      }
      try {
        job.close();
      } catch {
        // Continue with the remaining jobs.
      }
    }
    this.jobs.clear();
  }
}

/** Reject launches once the Native Host is closed; otherwise delegate. */
export function guardLauncher(inner: ProcessLauncher, isOpen: () => boolean): ProcessLauncher {
  return {
    canTerminateOrphanedDescendants: inner.canTerminateOrphanedDescendants,
    processControl: inner.processControl,
    resolveCommand: (command, args, options) => inner.resolveCommand(command, args, options),
    launch: async (spec, options) => {
      if (!isOpen()) throw closedError();
      return inner.launch(spec, options);
    },
  };
}

export function createJobObjectLauncher(
  inner: ProcessLauncher,
  api: JobObjectApi,
  tracker: JobTracker,
  isOpen: () => boolean,
): ProcessLauncher {
  return {
    canTerminateOrphanedDescendants: true,
    processControl: JOB_OBJECT_PROCESS_CONTROL,
    resolveCommand: (command, args, options) => inner.resolveCommand(command, args, options),
    launch: async (spec, options) => {
      if (!isOpen()) throw closedError();
      // Fail closed: no job, no process.
      const job = api.createKillOnCloseJob();
      let proc: ManagedProcess;
      try {
        proc = await inner.launch(spec, options);
      } catch (error) {
        job.close();
        throw error;
      }
      let assigned = false;
      try {
        assigned = proc.pid !== undefined && !proc.hasExited && job.assign(proc.pid);
      } catch {
        assigned = false;
      }
      if (!assigned) {
        // Core taskkill tree termination still applies to this process.
        job.close();
        tracker.noteUncontained();
        return proc;
      }
      if (!isOpen()) {
        job.terminate(1);
        job.close();
        throw closedError();
      }
      tracker.add(job);
      return new JobManagedProcess(proc, job, tracker);
    },
  };
}

class JobManagedProcess implements ManagedProcess {
  constructor(
    private readonly inner: ManagedProcess,
    private readonly job: JobObject,
    private readonly tracker: JobTracker,
  ) {
    // Release the job only once the whole tree is provably gone. Closing the
    // handle kills remaining members (kill-on-close), so an unreadable or
    // implausible count keeps the job open; forced termination and host close
    // still release it.
    void inner.exited.then(() => {
      if (job.closed) return;
      const counters = job.accounting();
      if (counters !== null && counters.total >= 1 && counters.active === 0) this.release();
    });
  }

  get pid(): number | undefined {
    return this.inner.pid;
  }
  get stdin(): Writable | null {
    return this.inner.stdin;
  }
  get stdout(): Readable {
    return this.inner.stdout;
  }
  get stderr(): Readable {
    return this.inner.stderr;
  }
  get exited(): Promise<ExitStatus> {
    return this.inner.exited;
  }
  get hasExited(): boolean {
    return this.inner.hasExited;
  }

  async terminate(mode: TerminationMode): Promise<void> {
    if (mode === "graceful") {
      if (!this.inner.hasExited) await this.inner.terminate("graceful");
      return;
    }
    this.kill();
  }

  terminateSync(): void {
    this.kill();
  }

  private kill(): void {
    if (!this.job.closed) this.job.terminate(1);
    this.release();
  }

  private release(): void {
    this.job.close();
    this.tracker.delete(this.job);
  }
}
