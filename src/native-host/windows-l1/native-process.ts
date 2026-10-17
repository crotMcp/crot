/**
 * Native Win32 ProcessLauncher shared by production AppContainer confinement
 * and explicit research fixtures. The controller owns the filesystem, protected
 * state, IPC and readiness boundaries; this launcher alone never claims L1.
 */
import { bnoIsolationAttribute, type BnoIsolation } from "./bno-isolation.js";
import { CrotError } from "../../core/errors.js";
import type {
  CommandSpec,
  EnvironmentPolicy,
  ExitStatus,
  LaunchOptions,
  ManagedProcess,
  ProcessLauncher,
  ResolveCommandOptions,
  TerminationMode,
} from "../../core/platform/types.js";
import type { JobObject, JobObjectApi } from "../windows-job.js";
import { createNativeByteStdio, type BytePipeApi, type NativeByteStdio } from "./byte-stdio.js";
import type { ProbeProcess } from "./probe-process.js";
import type { OwnedDesktop } from "./owned-desktop.js";
import type { WindowsLaunchEnvironment } from "./launch-environment.js";
import type { RestrictedToken } from "./restricted-token.js";

export interface NativeProcessOptions {
  /** All dependencies are trusted host objects, never RPC parameters. */
  readonly token: Pick<RestrictedToken, "restrictingSid" | "launchProbe">;
  readonly pipes: BytePipeApi;
  readonly jobs: JobObjectApi;
  readonly ownerSid: string;
  readonly environment: EnvironmentPolicy;
  readonly childEnvironment: WindowsLaunchEnvironment;
  /** Ownership transfers to the launcher, which stops actors before teardown. */
  readonly desktop?: OwnedDesktop;
  readonly bnoIsolation?: BnoIsolation;
  readonly resolver: Pick<ProcessLauncher, "resolveCommand">;
}

class NativeManagedProcess implements ManagedProcess {
  readonly pid: number;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly exited: Promise<ExitStatus>;
  private resolveExit!: (status: ExitStatus) => void;
  private status?: ExitStatus;
  private fault?: Error;
  private disposing = false;
  private disposed = false;
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly child: ProbeProcess,
    private readonly io: NativeByteStdio,
    input: boolean,
    private readonly forget: () => void,
    private readonly cleanupFailed: (failure: Error) => void,
  ) {
    this.pid = child.pid;
    this.stdin = input ? io.stdin : null;
    this.stdout = io.stdout;
    this.stderr = io.stderr;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    for (const stream of [io.stdout, io.stderr]) stream.on("error", (error: Error) => this.fail(error));
    io.stdin.on("error", (error: Error) => {
      // Early stdin close is ordinary child behaviour, not a transport success
      // claim. No retry or invented bytes; all other I/O errors fail the run.
      if (error instanceof CrotError && [109, 232].includes(Number(error.details?.nativeCode))) return;
      this.fail(error);
    });
    if (!input) io.stdin.end();
    // Register ownership in the launcher before native polling can release it.
    this.timer = setTimeout(() => this.poll(), 0);
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  get hasExited(): boolean {
    return this.status !== undefined;
  }
  get failure(): Error | undefined {
    return this.fault;
  }
  private finish(code: number | null): void {
    if (this.status) return;
    this.status = { code, signal: null };
    if (this.timer) clearTimeout(this.timer);
    this.resolveExit(this.status);
  }
  private poll(): void {
    if (this.disposing || this.status) return;
    try {
      const code = this.child.exitCode();
      if (code !== null) {
        this.finish(code);
        return;
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    this.timer = setTimeout(() => this.poll(), 5);
  }
  private fail(cause: unknown): void {
    if (this.disposing) return;
    this.fault ??= new CrotError("OPERATION_FAILED", "Native process transport failed.", undefined, { cause });
    try {
      this.terminateSync();
    } catch {
      /* fault is observable through Core; launcher retains failed cleanup */
    }
  }
  async terminate(_mode: TerminationMode): Promise<void> {
    // Windows console graceful signalling is not promised. The owned Job is
    // forcibly ended even after the direct child exited.
    this.terminateSync();
    await this.io.close();
  }
  terminateSync(): void {
    if (this.disposed) return;
    this.disposing = true;
    if (this.timer) clearTimeout(this.timer);
    let failed: unknown;
    try {
      this.child.close();
    } catch (error) {
      failed = error;
    }
    try {
      this.io.closeSync();
    } catch (error) {
      failed ??= error;
    }
    this.finish(this.child.finalExitCode);
    if (failed) {
      this.fault ??= new CrotError("OPERATION_FAILED", "Native process cleanup failed.", undefined, { cause: failed });
      this.cleanupFailed(this.fault);
      throw this.fault;
    }
    this.disposed = true;
    this.forget();
  }
}

export class NativeProcessLauncher implements ProcessLauncher {
  readonly canTerminateOrphanedDescendants = true;
  readonly processControl = Object.freeze({
    treeTermination: "job-object",
    orphanedDescendants: true,
    gracefulTermination: false,
  } as const);
  private closed = false;
  private blocked?: Error;
  private readonly processes = new Set<NativeManagedProcess>();
  private readonly starting = new Set<Promise<ManagedProcess>>();
  private readonly failedStarts = new Set<{
    child: ProbeProcess | undefined;
    io: NativeByteStdio;
    job: JobObject | undefined;
  }>();
  constructor(private readonly options: NativeProcessOptions) {
    if (options.bnoIsolation) bnoIsolationAttribute(options.bnoIsolation);
    if (options.desktop) {
      if (options.desktop.closed || options.desktop.restrictingSid !== options.token.restrictingSid)
        throw new CrotError("INVALID_INPUT", "Native process desktop does not match the owned token.");
      const lostDesktop = () => {
        if (this.closed) return;
        this.blocked ??= new CrotError("OPERATION_FAILED", "Native process desktop helper exited.");
        for (const process of this.processes) void process.terminate("force").catch(() => undefined);
      };
      void options.desktop.exited.then(lostDesktop, lostDesktop);
    }
  }
  resolveCommand(command: string, args: readonly string[], options: ResolveCommandOptions): Promise<CommandSpec> {
    return this.options.resolver.resolveCommand(command, args, {
      ...options,
      env: this.options.childEnvironment.prepare(options.env),
    });
  }
  launch(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess> {
    const pending = this.start(spec, options);
    this.starting.add(pending);
    void pending.then(
      () => this.starting.delete(pending),
      () => this.starting.delete(pending),
    );
    return pending;
  }
  private async start(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess> {
    if (this.closed) throw new CrotError("OPERATION_FAILED", "Native process launcher is closed.");
    if (this.blocked) throw this.blocked;
    const io = await createNativeByteStdio(this.options.pipes, this.options.ownerSid);
    let child: ProbeProcess | undefined;
    let job: JobObject | undefined;
    try {
      if (this.closed) throw new CrotError("OPERATION_FAILED", "Native process launcher is closed.");
      if (this.blocked) throw this.blocked;
      job = this.options.jobs.createKillOnCloseJob();
      try {
        child = this.options.token.launchProbe(
          {
            executable: spec.file,
            args: spec.args,
            cwd: options.cwd,
            env: this.options.childEnvironment.prepare(this.options.environment.merge(options.env, spec.env)),
            ...(spec.windowsVerbatimArguments === undefined
              ? {}
              : { windowsVerbatimArguments: spec.windowsVerbatimArguments }),
            stdio: io,
            ...(this.options.bnoIsolation ? { bnoIsolation: this.options.bnoIsolation } : {}),
            ...(this.options.desktop
              ? { desktop: this.options.desktop.desktop, console: "owned-hidden" as const }
              : {}),
          },
          job,
        );
      } catch (error) {
        // A newly created Job belongs only to this launch, even if validation
        // rejected it before the low-level launcher accepted ownership.
        try {
          job.close();
        } catch {
          /* preserve startup error; low-level launch already owns kill-on-close */
        }
        throw error;
      }
      const process = new NativeManagedProcess(
        child,
        io,
        options.stdin,
        () => this.processes.delete(process),
        (failure) => {
          this.blocked ??= failure;
        },
      );
      this.processes.add(process);
      return process;
    } catch (error) {
      const owner = { child, io, job };
      try {
        await this.releaseFailedStart(owner);
      } catch (cause) {
        this.failedStarts.add(owner);
        this.blocked ??= new CrotError("OPERATION_FAILED", "Native process startup cleanup failed.", undefined, {
          cause,
        });
      }
      throw error;
    }
  }
  private async releaseFailedStart(owner: {
    child: ProbeProcess | undefined;
    io: NativeByteStdio;
    job: JobObject | undefined;
  }): Promise<void> {
    let failure: unknown;
    try {
      owner.child?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      owner.job?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await owner.io.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.starting]);
    const results = await Promise.allSettled([...this.processes].map((process) => process.terminate("force")));
    let failed: unknown = results.find((result) => result.status === "rejected")?.reason;
    for (const owner of this.failedStarts) {
      try {
        await this.releaseFailedStart(owner);
        this.failedStarts.delete(owner);
      } catch (error) {
        failed ??= error;
      }
    }
    if (failed) throw failed;
    await this.options.desktop?.close();
  }
  closeSync(): void {
    this.closed = true;
    let error: unknown;
    for (const process of this.processes) {
      try {
        process.terminateSync();
      } catch (failure) {
        error ??= failure;
      }
    }
    for (const owner of this.failedStarts) {
      let failure: unknown;
      for (const action of [() => owner.child?.close(), () => owner.job?.close(), () => owner.io.closeSync()]) {
        try {
          action();
        } catch (cause) {
          failure ??= cause;
        }
      }
      if (!failure) this.failedStarts.delete(owner);
      error ??= failure;
    }
    if (error) throw error;
    this.options.desktop?.closeSync();
  }
}
