import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../errors.js";
import type { EnvironmentPolicy, ExitStatus, LaunchOptions, ManagedProcess, ProcessLauncher, CommandSpec, TerminationMode } from "./types.js";
import { batchFileCommand, comspecFrom, findWindowsExecutable, isBatchFile } from "./windows-command.js";

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  if (!(await isFile(candidate))) return false;
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on POSIX: explicit paths relative to cwd, otherwise PATH entries. */
export async function findPosixExecutable(command: string, cwd: string, pathValue: string | undefined): Promise<string | null> {
  if (command.includes("/")) {
    const candidate = path.posix.resolve(cwd, command);
    return (await isExecutableFile(candidate)) ? candidate : null;
  }
  for (const dir of (pathValue ?? "").split(":")) {
    if (!dir) continue;
    const candidate = path.posix.join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

class NodeManagedProcess implements ManagedProcess {
  readonly exited: Promise<ExitStatus>;
  private exitStatus: ExitStatus | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly killTree: (child: ChildProcess, mode: TerminationMode, exited: boolean) => Promise<void>,
    private readonly killTreeSync: (child: ChildProcess, exited: boolean) => void,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        resolve(this.exitStatus);
      });
    });
  }

  get pid() {
    return this.child.pid;
  }
  get stdin() {
    return this.child.stdin;
  }
  get stdout() {
    return this.child.stdout!;
  }
  get stderr() {
    return this.child.stderr!;
  }
  get hasExited() {
    return this.exitStatus !== undefined;
  }

  terminate(mode: TerminationMode): Promise<void> {
    return this.killTree(this.child, mode, this.hasExited);
  }

  terminateSync(): void {
    this.killTreeSync(this.child, this.hasExited);
  }
}

function startChild(spec: CommandSpec, options: LaunchOptions, detached: boolean): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.file, [...spec.args], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
        detached,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments ?? false,
      });
    } catch (error) {
      reject(new CrotError("OPERATION_FAILED", `Failed to start ${spec.file}: ${(error as Error).message}`));
      return;
    }
    const onError = (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new CrotError("NOT_FOUND", `Executable not found: ${spec.file}`)
          : new CrotError("OPERATION_FAILED", `Failed to start ${spec.file}: ${error.message}`),
      );
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.on("error", () => undefined);
      child.stdin?.on("error", () => undefined);
      resolve(child);
    });
  });
}

/**
 * POSIX launcher: each child leads a new process group, so the whole tree
 * (including descendants that outlive the direct child) can be signalled.
 */
export function createPosixLauncher(): ProcessLauncher {
  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // ESRCH: the group no longer exists.
    }
  };
  const killTree = async (child: ChildProcess, mode: TerminationMode): Promise<void> => signalGroup(child, mode === "force" ? "SIGKILL" : "SIGTERM");
  // kill(2) is synchronous already.
  const killTreeSync = (child: ChildProcess): void => signalGroup(child, "SIGKILL");
  return {
    canTerminateOrphanedDescendants: true,
    processControl: { treeTermination: "process-group", orphanedDescendants: true, gracefulTermination: true },
    async resolveCommand(command, args, { cwd, env }) {
      const file = await findPosixExecutable(command, cwd, env.PATH);
      if (!file) throw new CrotError("NOT_FOUND", `Executable not found: ${command}`);
      return { file, args, display: [command, ...args].join(" ") };
    },
    async launch(spec, options) {
      return new NodeManagedProcess(await startChild(spec, options, true), killTree, killTreeSync);
    },
  };
}

/**
 * Windows launcher: PATHEXT-aware resolution, batch files through cmd.exe,
 * and tree termination with taskkill /T.
 *
 * Limits of the Core implementation (see ProcessControlInfo):
 * - taskkill /T follows parent-child links, so descendants whose parent has
 *   already exited cannot be found. Reliable containment needs a Job Object
 *   assigned at process creation (CREATE_SUSPENDED + AssignProcessToJobObject,
 *   JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE), which requires native code and is the
 *   responsibility of the CROT Native Host implementing this same interface.
 * - Console programs cannot be asked to exit gracefully without
 *   GenerateConsoleCtrlEvent (native code as well), so graceful termination
 *   escalates to forced termination after the grace period.
 */
export function createWindowsLauncher(environment: EnvironmentPolicy, hostEnv: Readonly<Record<string, string | undefined>>): ProcessLauncher {
  const systemRoot = environment.get(hostEnv, "SystemRoot") ?? "C:\\Windows";
  const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
  const killTree = async (child: ChildProcess, mode: TerminationMode, exited: boolean): Promise<void> => {
    if (child.pid === undefined || exited) return;
    const args = ["/PID", String(child.pid), "/T"];
    if (mode === "force") args.push("/F");
    await new Promise<void>((resolve) => {
      const p = spawn(taskkill, args, { stdio: "ignore", windowsHide: true });
      p.once("error", () => {
        child.kill();
        resolve();
      });
      p.once("exit", () => resolve());
    });
  };
  const killTreeSync = (child: ChildProcess, exited: boolean): void => {
    if (child.pid === undefined || exited) return;
    const r = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    if (r.error) child.kill();
  };
  return {
    canTerminateOrphanedDescendants: false,
    // Graceful requests to console programs are ignored by taskkill without /F; CROT escalates after the grace period.
    processControl: { treeTermination: "taskkill-tree", orphanedDescendants: false, gracefulTermination: false },
    async resolveCommand(command, args, { cwd, env }) {
      const file = await findWindowsExecutable(command, {
        cwd,
        path: environment.get(env, "PATH"),
        pathExt: environment.get(env, "PATHEXT"),
        isFile,
      });
      if (!file) throw new CrotError("NOT_FOUND", `Executable not found: ${command}`);
      if (isBatchFile(file)) return batchFileCommand(comspecFrom((n) => environment.get(env, n)), file, args);
      return { file, args, display: [command, ...args].join(" ") };
    },
    async launch(spec, options) {
      return new NodeManagedProcess(await startChild(spec, options, false), killTree, killTreeSync);
    },
  };
}
