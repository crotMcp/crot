/**
 * Restricted-token ProcessLauncher component. It supplies the existing Core
 * contract; it is deliberately NOT registered as CommandConfinement. Filesystem,
 * protected-state and IPC boundaries must qualify before any availability claim.
 */
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
import type { JobObjectApi } from "../windows-job.js";
import { createNativeByteStdio, type BytePipeApi, type NativeByteStdio } from "./byte-stdio.js";
import type { ProbeProcess } from "./probe-process.js";
import type { RestrictedToken } from "./restricted-token.js";

export interface NativeProcessOptions {
  /** All dependencies are trusted host objects, never RPC parameters. */
  readonly token: RestrictedToken;
  readonly pipes: BytePipeApi;
  readonly jobs: JobObjectApi;
  readonly ownerSid: string;
  readonly environment: EnvironmentPolicy;
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
  private readonly processes = new Set<NativeManagedProcess>();
  private readonly starting = new Set<Promise<ManagedProcess>>();
  constructor(private readonly options: NativeProcessOptions) {}
  resolveCommand(command: string, args: readonly string[], options: ResolveCommandOptions): Promise<CommandSpec> {
    return this.options.resolver.resolveCommand(command, args, options);
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
    const io = await createNativeByteStdio(this.options.pipes, this.options.ownerSid);
    let child: ProbeProcess | undefined;
    try {
      if (this.closed) throw new CrotError("OPERATION_FAILED", "Native process launcher is closed.");
      const job = this.options.jobs.createKillOnCloseJob();
      try {
        child = this.options.token.launchProbe(
          {
            executable: spec.file,
            args: spec.args,
            cwd: options.cwd,
            env: this.options.environment.merge(options.env, spec.env),
            ...(spec.windowsVerbatimArguments === undefined
              ? {}
              : { windowsVerbatimArguments: spec.windowsVerbatimArguments }),
            stdio: io,
          },
          job,
        );
      } catch (error) {
        // A newly created Job belongs only to this launch, even if validation
        // rejected it before the low-level launcher accepted ownership.
        job.close();
        throw error;
      }
      const process = new NativeManagedProcess(child, io, options.stdin, () => this.processes.delete(process));
      this.processes.add(process);
      return process;
    } catch (error) {
      try {
        child?.close();
      } catch {
        /* preserve launch error */
      }
      await io.close().catch(() => undefined);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.starting]);
    const results = await Promise.allSettled([...this.processes].map((process) => process.terminate("force")));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
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
    if (error) throw error;
  }
}
