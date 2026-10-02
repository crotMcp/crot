import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import type { ResolvedPath, Workspace } from "../../workspace/workspace.js";
import { display } from "../filesystem/service.js";
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
import { killTree, shellSpec, spawnChild, terminate, type SpawnSpec } from "./spawn.js";

export interface ProcessServiceDeps {
  readonly workspace: Workspace;
  readonly guard: ExecutionGuard;
  readonly limits: Pick<Limits, "defaultCommandTimeoutMs" | "maxCommandTimeoutMs" | "maxOutputBytes" | "maxBackgroundProcesses">;
}

/** How long to wait for stdio to close after the child exits (descendants may hold pipes open). */
const STDIO_CLOSE_GRACE_MS = 500;
/** Number of exited background process records kept for inspection. */
const MAX_EXITED_RECORDS = 50;

interface BackgroundProcess {
  readonly id: string;
  readonly child: ChildProcess;
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

/**
 * Process/shell capability of CROT Core.
 *
 * Commands are spawned without an implicit shell (argv form); shell scripts
 * are an explicit, separate operation. Every operation is authorized through
 * the ExecutionGuard, the working directory is checked against the
 * permission scope, and foreground commands always have a timeout.
 *
 * Note: SANDBOX confines the working directory and CROT's own file
 * operations; it is not OS-level isolation of what a command itself does.
 */
export class ProcessService {
  private readonly processes = new Map<string, BackgroundProcess>();
  private nextId = 1;

  constructor(private readonly deps: ProcessServiceDeps) {}

  /** Run an executable with arguments (no shell) and wait for it to finish. */
  async exec(context: AuthContext, input: ExecInput): Promise<ExecResult> {
    const args = parseInput(ExecInputSchema, input);
    const cwd = await this.resolveCwd(args.cwd);
    const timeoutMs = this.timeout(args.timeoutMs);
    return this.deps.guard.run(context, { operation: "process.exec", capability: "shell.execute", paths: [cwd] }, async () => {
      await assertDirectory(cwd);
      return this.runForeground(
        { file: args.command, args: args.args, cwd: cwd.absolute, env: args.env, stdin: args.stdin !== undefined },
        args.stdin,
        timeoutMs,
      );
    });
  }

  /** Run a script through the system shell and wait for it to finish. */
  async shell(context: AuthContext, input: ShellInput): Promise<ExecResult> {
    const args = parseInput(ShellInputSchema, input);
    const cwd = await this.resolveCwd(args.cwd);
    const timeoutMs = this.timeout(args.timeoutMs);
    return this.deps.guard.run(context, { operation: "process.shell", capability: "shell.execute", paths: [cwd] }, async () => {
      await assertDirectory(cwd);
      const sh = shellSpec(args.script);
      return this.runForeground(
        { file: sh.file, args: sh.args, cwd: cwd.absolute, env: args.env, stdin: args.stdin !== undefined },
        args.stdin,
        timeoutMs,
      );
    });
  }

  /** Start a long-running background process (dev server, watcher, ...). */
  async start(context: AuthContext, input: StartProcessInput): Promise<ProcessInfo> {
    const args = parseInput(StartProcessInputSchema, input);
    const cwd = await this.resolveCwd(args.cwd);
    const timeoutMs = args.timeoutMs === undefined ? undefined : this.timeout(args.timeoutMs);
    const op = { operation: "process.start", paths: [cwd] };
    // Starting a process both executes a command and creates a managed process.
    return this.deps.guard.run(context, { ...op, capability: ["process.manage", "shell.execute"] }, async () => {
      await assertDirectory(cwd);
      if (this.runningCount() >= this.deps.limits.maxBackgroundProcesses) {
        throw new CrotError("LIMIT_EXCEEDED", `Too many running background processes (limit ${this.deps.limits.maxBackgroundProcesses}).`);
      }
      const target = args.script !== undefined ? shellSpec(args.script) : { file: args.command!, args: args.args };
      const label = args.script ?? [args.command!, ...args.args].join(" ");
      const child = await spawnOrThrow({ file: target.file, args: target.args, cwd: cwd.absolute, env: args.env, stdin: false });
      const record: BackgroundProcess = {
        id: `p${this.nextId++}`,
        child,
        command: label,
        cwd,
        startedAt: new Date(),
        stdout: new OutputBuffer(this.deps.limits.maxOutputBytes),
        stderr: new OutputBuffer(this.deps.limits.maxOutputBytes),
        endedAt: null,
        exitCode: null,
        signal: null,
        timedOut: false,
      };
      child.stdout?.on("data", (c: Buffer) => record.stdout.append(c));
      child.stderr?.on("data", (c: Buffer) => record.stderr.append(c));
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          record.timedOut = true;
          terminate(child);
        }, timeoutMs);
        timer.unref();
      }
      child.once("exit", (code, signal) => {
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
        };
      },
    );
  }

  async stop(context: AuthContext, input: StopProcessInput): Promise<ProcessInfo> {
    const args = parseInput(StopProcessInputSchema, input);
    const record = this.get(args.id);
    return this.deps.guard.run(context, { operation: "process.stop", capability: "process.manage", paths: [record.cwd] }, async () => {
      if (!record.endedAt) {
        const exited = new Promise<void>((resolve) => record.child.once("exit", () => resolve()));
        if (args.force) killTree(record.child, true);
        else terminate(record.child);
        await Promise.race([exited, delay(5_000)]);
      }
      return toInfo(record);
    });
  }

  /** Forget an exited process record. */
  async remove(context: AuthContext, input: ProcessIdInput): Promise<{ id: string; removed: boolean }> {
    const args = parseInput(ProcessIdInputSchema, input);
    const record = this.get(args.id);
    return this.deps.guard.run(context, { operation: "process.remove", capability: "process.manage", paths: [record.cwd] }, async () => {
      if (!record.endedAt) throw new CrotError("INVALID_INPUT", `Process ${record.id} is still running; stop it first.`);
      this.processes.delete(record.id);
      return { id: record.id, removed: true };
    });
  }

  /** Terminate every running background process. Called when CROT shuts down. */
  async shutdown(): Promise<void> {
    const running = [...this.processes.values()].filter((p) => !p.endedAt);
    await Promise.all(
      running.map((p) => {
        const exited = new Promise<void>((resolve) => p.child.once("exit", () => resolve()));
        terminate(p.child, 1_000);
        return Promise.race([exited, delay(3_000)]);
      }),
    );
  }

  private async runForeground(spec: SpawnSpec, stdin: string | undefined, timeoutMs: number): Promise<ExecResult> {
    const started = Date.now();
    const child = await spawnOrThrow(spec);
    const stdout = new OutputBuffer(this.deps.limits.maxOutputBytes);
    const stderr = new OutputBuffer(this.deps.limits.maxOutputBytes);
    child.stdout?.on("data", (c: Buffer) => stdout.append(c));
    child.stderr?.on("data", (c: Buffer) => stderr.append(c));
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);

    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      let exit: { code: number | null; signal: string | null } | undefined;
      child.once("close", (c, s) => resolve(exit ?? { code: c, signal: s }));
      child.once("exit", (c, s) => {
        exit = { code: c, signal: s };
        // Descendants may keep stdio open; do not wait for them indefinitely.
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve(exit!);
        }, STDIO_CLOSE_GRACE_MS).unref();
      });
    });
    clearTimeout(timer);
    return {
      exitCode: code,
      signal,
      timedOut,
      durationMs: Date.now() - started,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }

  private async resolveCwd(cwd: string): Promise<ResolvedPath> {
    return this.deps.workspace.resolve(cwd);
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

function toInfo(p: BackgroundProcess): ProcessInfo {
  return {
    id: p.id,
    pid: p.child.pid ?? null,
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

/** Spawn and surface launch failures (e.g. unknown executable) as CrotErrors. */
function spawnOrThrow(spec: SpawnSpec): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(spec);
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new CrotError("NOT_FOUND", `Executable not found: ${spec.file}`)
          : new CrotError("OPERATION_FAILED", `Failed to start ${spec.file}: ${error.message}`),
      );
    };
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.on("error", () => undefined);
      resolve(child);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
