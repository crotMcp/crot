import { spawn, type ChildProcess } from "node:child_process";

const isWindows = process.platform === "win32";

export interface SpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly stdin: boolean;
}

/** Build the executable + arguments for running a script through the system shell. */
export function shellSpec(script: string): { file: string; args: string[] } {
  if (isWindows) return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", script] };
  return { file: "/bin/sh", args: ["-c", script] };
}

/**
 * Spawn a child process without an intermediate shell. On POSIX the child gets
 * its own process group so the whole tree can be terminated.
 */
export function spawnChild(spec: SpawnSpec): ChildProcess {
  return spawn(spec.file, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    shell: false,
    detached: !isWindows,
    windowsHide: true,
  });
}

/** Terminate a child process and its descendants. */
export function killTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    const args = ["/pid", String(child.pid), "/T"];
    if (force) args.push("/F");
    spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** Request graceful termination, escalating to a forced kill after `graceMs`. */
export function terminate(child: ChildProcess, graceMs = 2_000): void {
  killTree(child, false);
  const timer = setTimeout(() => killTree(child, true), graceMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
