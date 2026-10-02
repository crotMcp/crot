import { stat } from "node:fs/promises";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import type { CommandSpec, ManagedProcess, Platform, ResolvedEncoding } from "../../platform/types.js";
import { displayPath as display, type ResolvedPath, type Workspace } from "../../workspace/workspace.js";
import { OutputBuffer } from "./output-buffer.js";
import {
  ExecInputSchema,
  ProcessIdInputSchema,
  ReadOutputInputSchema,
  ShellInputSchema,
  StartProcessInputSchema,
  StopProcessInputSchema,
  type ExecInput,
  type ExecResult,
  type ProcessIdInput,
  type ProcessInfo,
  type ProcessOutput,
  type ReadOutputInput,
  type ShellInput,
  type StartProcessInput,
  type StopProcessInput,
} from "./schemas.js";

export interface ProcessServiceDeps {
  readonly workspace: Workspace;
  readonly guard: ExecutionGuard;
  readonly platform: Pick<Platform, "launcher" | "shells" | "environment" | "encodings" | "baseEnvironment">;
  readonly limits: Pick<Limits, "defaultCommandTimeoutMs" | "maxCommandTimeoutMs" | "maxOutputBytes" | "maxBackgroundProcesses">;
  /** Base environment for children (defaults to the platform base environment). */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** How long to wait for stdio to close after the child exits (descendants may hold pipes open). */
const STDIO_CLOSE_GRACE_MS = 500;
/** Delay before a graceful termination is escalated to a forced one. */
const TERMINATION_GRACE_MS = 2_000;
/** Grace period before forced termination when CROT shuts down. */
const SHUTDOWN_GRACE_MS = 1_000;
/** Number of exited background process records kept for inspection. */
const MAX_EXITED_RECORDS = 50;

interface BackgroundProcess {
  readonly id: string;
  readonly proc: ManagedProcess;
  readonly command: string;
  readonly cwd: ResolvedPath;
  readonly startedAt: Date;
  readonly stdout: OutputBuffer;
  readonly stderr: OutputBuffer;
  endedAt: Date | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

type EnvOverrides = Readonly<Record<string, string | null>> | undefined;

/**
 * Process/shell capability of CROT Core.
 *
 * Commands are resolved and launched through the platform ProcessLauncher
 * (argv form, no implicit shell); shell scripts are a separate, explicit
 * operation through the ShellProvider. Every operation is authorized through
 * the ExecutionGuard, the working directory is checked against the permission
 * scope, and foreground commands always have a timeout. A foreground command
 * owns its process tree: descendants still running when it finishes are
 * terminated (use background processes for long-running work).
 *
 * Note: SANDBOX confines the working directory and CROT's own file
 * operations; it is not OS-level isolation of what a command itself does.
 */
export class ProcessService {
  private readonly processes = new Map<string, BackgroundProcess>();
  /** Running foreground commands (terminated on shutdown). */
  private readonly foreground = new Set<ManagedProcess>();
  private nextId = 1;
  private closing = false;
  /** Every tree was terminated by shutdown(); nothing is left for terminateAllSync(). */
  private terminated = false;

  constructor(private readonly deps: ProcessServiceDeps) {}

  /** Run an executable with arguments (no shell) and wait for it to finish. */
  async exec(context: AuthContext, input: ExecInput): Promise<ExecResult> {
    const args = parseInput(ExecInputSchema, input);
    const encoding = this.deps.platform.encodings.resolve(args.encoding);
    const cwd = await this.deps.workspace.resolve(args.cwd);
    const timeoutMs = this.timeout(args.timeoutMs);
    const op = {
      operation: "process.exec",
      capability: "shell.execute",
      paths: [cwd],
      details: { command: args.command, args: args.args, ...commonDetails(args, timeoutMs) },
    } as const;
    return this.deps.guard.run(context, op, async () => {
      this.assertOpen();
      await assertDirectory(cwd);
      const env = this.env(args.env);
      const spec = await this.deps.platform.launcher.resolveCommand(args.command, args.args, { cwd: cwd.absolute, env });
      return this.runForeground(spec, cwd, env, args.stdin, timeoutMs, encoding);
    });
  }

  /** Run a script through a shell and wait for it to finish. */
  async shell(context: AuthContext, input: ShellInput): Promise<ExecResult> {
    const args = parseInput(ShellInputSchema, input);
    const encoding = this.deps.platform.encodings.resolve(args.encoding);
    const cwd = await this.deps.workspace.resolve(args.cwd);
    const timeoutMs = this.timeout(args.timeoutMs);
    const shell = args.shell ?? this.deps.platform.shells.defaultShell;
    const op = {
      operation: "process.shell",
      capability: "shell.execute",
      paths: [cwd],
      details: { shell, script: args.script, ...commonDetails(args, timeoutMs) },
    } as const;
    return this.deps.guard.run(context, op, async () => {
      this.assertOpen();
      await assertDirectory(cwd);
      const spec = this.deps.platform.shells.command(args.script, shell);
      return this.runForeground(spec, cwd, this.env(args.env), args.stdin, timeoutMs, encoding);
    });
  }

  /** Start a long-running background process (dev server, watcher, ...). */
  async start(context: AuthContext, input: StartProcessInput): Promise<ProcessInfo> {
    const args = parseInput(StartProcessInputSchema, input);
    const encoding = this.deps.platform.encodings.resolve(args.encoding);
    const cwd = await this.deps.workspace.resolve(args.cwd);
    const timeoutMs = args.timeoutMs === undefined ? undefined : this.timeout(args.timeoutMs);
    const label = args.script ?? [args.command!, ...args.args].join(" ");
    const shell = args.script !== undefined ? (args.shell ?? this.deps.platform.shells.defaultShell) : undefined;
    const details = {
      command: label,
      ...(shell ? { shell } : {}),
      envKeys: Object.keys(args.env ?? {}),
      timeoutMs: timeoutMs ?? null,
      encoding: args.encoding,
    };
    // Starting a process both executes a command and creates a managed process.
    const op = { operation: "process.start", capability: ["process.manage", "shell.execute"] as const, paths: [cwd], details };
    return this.deps.guard.run(context, op, async () => {
      this.assertOpen();
      await assertDirectory(cwd);
      if (this.runningCount() >= this.deps.limits.maxBackgroundProcesses) {
        throw new CrotError("LIMIT_EXCEEDED", `Too many running background processes (limit ${this.deps.limits.maxBackgroundProcesses}).`);
      }
      const env = this.env(args.env);
      const spec =
        args.script !== undefined
          ? this.deps.platform.shells.command(args.script, shell)
          : await this.deps.platform.launcher.resolveCommand(args.command!, args.args, { cwd: cwd.absolute, env });
      const proc = await this.deps.platform.launcher.launch(spec, { cwd: cwd.absolute, env, stdin: false });
      if (this.closing) {
        // Shutdown began while the process was starting.
        await proc.terminate("force");
        throw shuttingDown();
      }
      const record: BackgroundProcess = {
        id: `p${this.nextId++}`,
        proc,
        command: label,
        cwd,
        startedAt: new Date(),
        stdout: new OutputBuffer(this.deps.limits.maxOutputBytes, encoding),
        stderr: new OutputBuffer(this.deps.limits.maxOutputBytes, encoding),
        endedAt: null,
        exitCode: null,
        signal: null,
        timedOut: false,
      };
      capture(proc.stdout, record.stdout);
      capture(proc.stderr, record.stderr);
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          record.timedOut = true;
          void terminateTree(proc);
        }, timeoutMs);
        timer.unref();
      }
      void proc.exited.then(({ code, signal }) => {
        if (timer) clearTimeout(timer);
        record.endedAt = new Date();
        record.exitCode = code;
        record.signal = signal;
        this.pruneExited();
      });
      this.processes.set(record.id, record);
      return toInfo(record);
    });
  }

  async list(context: AuthContext): Promise<ProcessInfo[]> {
    return this.deps.guard.run(context, { operation: "process.list", capability: "process.manage" }, async () =>
      [...this.processes.values()].map(toInfo),
    );
  }

  async readOutput(context: AuthContext, input: ReadOutputInput): Promise<ProcessOutput> {
    const args = parseInput(ReadOutputInputSchema, input);
    const record = this.get(args.id);
    return this.deps.guard.run(
      context,
      { operation: "process.read_output", capability: "process.manage", paths: [record.cwd] },
      async () => {
        const out = record.stdout.readFrom(args.stdoutOffset);
        const err = record.stderr.readFrom(args.stderrOffset);
        return {
          id: record.id,
          status: record.endedAt ? "exited" : "running",
          stdout: out.data,
          stderr: err.data,
          nextStdoutOffset: out.nextOffset,
          nextStderrOffset: err.nextOffset,
          stdoutDroppedBytes: out.droppedBytes,
          stderrDroppedBytes: err.droppedBytes,
          encoding: { stdout: out.encoding, stderr: err.encoding },
        };
      },
    );
  }

  async stop(context: AuthContext, input: StopProcessInput): Promise<ProcessInfo> {
    const args = parseInput(StopProcessInputSchema, input);
    const record = this.get(args.id);
    const op = {
      operation: "process.stop",
      capability: "process.manage",
      paths: [record.cwd],
      details: { id: record.id, force: args.force },
    } as const;
    return this.deps.guard.run(context, op, async () => {
      if (args.force) await record.proc.terminate("force");
      else await terminateTree(record.proc);
      await Promise.race([record.proc.exited, delay(5_000)]);
      // Give the exit handler a chance to record the final status.
      await delay(0);
      return toInfo(record);
    });
  }

  /** Forget an exited process record. */
  async remove(context: AuthContext, input: ProcessIdInput): Promise<{ id: string; removed: boolean }> {
    const args = parseInput(ProcessIdInputSchema, input);
    const record = this.get(args.id);
    const op = { operation: "process.remove", capability: "process.manage", paths: [record.cwd], details: { id: record.id } } as const;
    return this.deps.guard.run(context, op, async () => {
      if (!record.endedAt) throw new CrotError("INVALID_INPUT", `Process ${record.id} is still running; stop it first.`);
      this.processes.delete(record.id);
      return { id: record.id, removed: true };
    });
  }

  /**
   * Stop accepting commands and terminate every process tree CROT started
   * (background processes and running foreground commands): graceful first,
   * forced after a short grace period. Called when CROT shuts down.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    const all = [...[...this.processes.values()].map((p) => p.proc), ...this.foreground];
    // Where graceful termination is not possible (Windows console programs), do not
    // spend the client's shutdown window on it: terminate the trees immediately.
    const grace = this.deps.platform.launcher.processControl.gracefulTermination ? SHUTDOWN_GRACE_MS : 0;
    await Promise.all(
      all.map(async (proc) => {
        await terminateTree(proc, grace);
        await Promise.race([proc.exited, delay(3_000)]);
      }),
    );
    this.terminated = this.foreground.size === 0;
  }

  /**
   * Forced, synchronous termination of every process tree. For the host
   * process 'exit' event and fatal errors, when asynchronous shutdown cannot run.
   */
  terminateAllSync(): void {
    this.closing = true;
    // Avoid signalling process groups that no longer exist (their ids may be reused).
    if (this.terminated) return;
    for (const p of this.processes.values()) p.proc.terminateSync();
    for (const proc of this.foreground) proc.terminateSync();
  }

  private assertOpen(): void {
    if (this.closing) throw shuttingDown();
  }

  private env(overrides: EnvOverrides): Record<string, string> {
    return this.deps.platform.environment.merge(this.deps.baseEnv ?? this.deps.platform.baseEnvironment, overrides ?? {});
  }

  private async runForeground(
    spec: CommandSpec,
    cwd: ResolvedPath,
    env: Record<string, string>,
    stdin: string | undefined,
    timeoutMs: number,
    encoding: ResolvedEncoding,
  ): Promise<ExecResult> {
    const started = Date.now();
    const proc = await this.deps.platform.launcher.launch(spec, { cwd: cwd.absolute, env, stdin: stdin !== undefined });
    this.foreground.add(proc);
    try {
      return await this.collectForeground(proc, started, stdin, timeoutMs, encoding);
    } finally {
      this.foreground.delete(proc);
    }
  }

  private async collectForeground(
    proc: ManagedProcess,
    started: number,
    stdin: string | undefined,
    timeoutMs: number,
    encoding: ResolvedEncoding,
  ): Promise<ExecResult> {
    if (this.closing) void proc.terminate("force");
    const stdout = new OutputBuffer(this.deps.limits.maxOutputBytes, encoding);
    const stderr = new OutputBuffer(this.deps.limits.maxOutputBytes, encoding);
    capture(proc.stdout, stdout);
    capture(proc.stderr, stderr);
    if (stdin !== undefined && proc.stdin) proc.stdin.end(stdin);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateTree(proc);
    }, timeoutMs);

    const status = await proc.exited;
    clearTimeout(timer);
    // Descendants may keep stdio open; wait briefly for the streams, then stop waiting.
    await Promise.race([Promise.all([ended(proc.stdout), ended(proc.stderr)]), delay(STDIO_CLOSE_GRACE_MS)]);
    // The command owns its process tree: terminate leftovers (POSIX process group).
    await proc.terminate("force");
    proc.stdout.destroy();
    proc.stderr.destroy();
    stdout.end();
    stderr.end();
    const out = stdout.readAll();
    const err = stderr.readAll();
    return {
      exitCode: status.code,
      signal: status.signal,
      timedOut,
      durationMs: Date.now() - started,
      stdout: out.data,
      stderr: err.data,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      encoding: { stdout: out.encoding, stderr: err.encoding },
    };
  }

  private timeout(requested: number | undefined): number {
    const max = this.deps.limits.maxCommandTimeoutMs;
    if (requested !== undefined && requested > max) {
      throw new CrotError("LIMIT_EXCEEDED", `Requested timeout ${requested}ms exceeds the configured maximum of ${max}ms.`);
    }
    return requested ?? Math.min(this.deps.limits.defaultCommandTimeoutMs, max);
  }

  private get(id: string): BackgroundProcess {
    const record = this.processes.get(id);
    if (!record) throw new CrotError("NOT_FOUND", `No background process with id '${id}'.`);
    return record;
  }

  private runningCount(): number {
    let n = 0;
    for (const p of this.processes.values()) if (!p.endedAt) n++;
    return n;
  }

  private pruneExited(): void {
    const exited = [...this.processes.values()].filter((p) => p.endedAt);
    for (const p of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_RECORDS))) this.processes.delete(p.id);
  }
}

/** Graceful termination, escalated to a forced one if the child is still running after `graceMs` (0: forced right away). */
async function terminateTree(proc: ManagedProcess, graceMs = TERMINATION_GRACE_MS): Promise<void> {
  if (graceMs > 0) {
    await proc.terminate("graceful");
    await Promise.race([proc.exited, delay(graceMs)]);
  }
  await proc.terminate("force");
}

function shuttingDown(): CrotError {
  return new CrotError("OPERATION_FAILED", "CROT is shutting down; no new commands are started.");
}

/** Collect a stream into a buffer; the buffer is finalized when the stream ends. */
function capture(stream: NodeJS.ReadableStream, buffer: OutputBuffer): void {
  stream.on("data", (c: Buffer) => buffer.append(c));
  stream.once("end", () => buffer.end());
  stream.once("close", () => buffer.end());
}

/** Audit-safe summary: environment variable names only, never values or stdin contents. */
function commonDetails(args: { env?: Record<string, string | null> | undefined; stdin?: string | undefined; encoding: string }, timeoutMs: number) {
  return { envKeys: Object.keys(args.env ?? {}), stdin: args.stdin !== undefined, timeoutMs, encoding: args.encoding };
}

function toInfo(p: BackgroundProcess): ProcessInfo {
  return {
    id: p.id,
    pid: p.proc.pid ?? null,
    command: p.command,
    cwd: display(p.cwd),
    status: p.endedAt ? "exited" : "running",
    startedAt: p.startedAt.toISOString(),
    endedAt: p.endedAt?.toISOString() ?? null,
    exitCode: p.exitCode,
    signal: p.signal,
    timedOut: p.timedOut,
  };
}

async function assertDirectory(cwd: ResolvedPath): Promise<void> {
  const info = await stat(cwd.absolute).catch(() => undefined);
  if (!info) throw new CrotError("NOT_FOUND", `Working directory does not exist: ${display(cwd)}`);
  if (!info.isDirectory()) throw new CrotError("INVALID_INPUT", `Working directory is not a directory: ${display(cwd)}`);
}

function ended(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    if ((stream as { readableEnded?: boolean }).readableEnded) return resolve();
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
