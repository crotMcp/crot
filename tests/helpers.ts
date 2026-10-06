import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NullAuditSink, type AuditSink } from "../src/core/audit/audit.js";
import { localPrincipal, type AuthContext } from "../src/core/auth/principal.js";
import { CrotCore, type CrotCoreOptions } from "../src/core/crot-core.js";

export const isWindows = process.platform === "win32";
export const testContext: AuthContext = { principal: localPrincipal("test") };

export interface TempDirs {
  /** Canonical workspace root. */
  readonly workspace: string;
  /** Canonical directory outside the workspace. */
  readonly outside: string;
  cleanup(): Promise<void>;
}

export async function makeTempDirs(): Promise<TempDirs> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-test-")));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return {
    workspace,
    outside,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/** Create a directory link: a symlink on POSIX, a junction on Windows (no privileges required). */
export function linkDirectory(target: string, link: string): Promise<void> {
  return symlink(target, link, isWindows ? "junction" : "dir");
}

let fileSymlinks: boolean | undefined;
/** File symlinks need Developer Mode or elevation on Windows. */
export async function canSymlinkFiles(): Promise<boolean> {
  if (fileSymlinks !== undefined) return fileSymlinks;
  const dirs = await makeTempDirs();
  try {
    await writeFile(path.join(dirs.outside, "t"), "");
    await symlink(path.join(dirs.outside, "t"), path.join(dirs.workspace, "l"), "file");
    fileSymlinks = true;
  } catch {
    fileSymlinks = false;
  } finally {
    await dirs.cleanup();
  }
  return fileSymlinks;
}

/** Create a CrotCore with auditing silenced unless a sink is supplied. */
export function createTestCore(
  config: unknown,
  auditSink: AuditSink = new NullAuditSink(),
  options: CrotCoreOptions = {},
): Promise<CrotCore> {
  return CrotCore.create(config, { auditSink, ...options });
}

export const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

/** Whether a process with `pid` is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * An isolated per-user CROT state for tests that run the built crot-mcp
 * (WP-20: every stdio client attaches to the user's CROT service, which lives
 * in the state directory). Linux $XDG_STATE_HOME/crot, macOS
 * ~/Library/Application Support/CROT/State (a short HOME: Unix socket paths
 * are limited to 103 bytes), Windows %LOCALAPPDATA%\CROT.
 */
export interface ServiceHost {
  readonly env: Record<string, string>;
  readonly stateDir: string;
  /** Stop the service of this state (if running) and remove the temporary HOME. */
  cleanup(bin: string): Promise<void>;
}

export async function makeServiceHost(base: string): Promise<ServiceHost> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  let env: Record<string, string>;
  let stateDir: string;
  let removeHome: (() => Promise<void>) | undefined;
  if (isWindows) {
    const local = path.join(base, "local");
    env = { ...inherited, LOCALAPPDATA: local, APPDATA: path.join(base, "roaming") };
    stateDir = path.join(local, "CROT");
  } else if (process.platform === "darwin") {
    const home = await realpath(await mkdtemp("/tmp/crot-h-"));
    env = { ...inherited, HOME: home };
    stateDir = path.join(home, "Library", "Application Support", "CROT", "State");
    removeHome = () => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else {
    env = { ...inherited, XDG_STATE_HOME: path.join(base, "state"), XDG_CONFIG_HOME: path.join(base, "config") };
    stateDir = path.join(base, "state", "crot");
  }
  // Owner-only files (the secret store's file backend): tests read the credential files directly.
  // The OS secure storage backends and the automatic choice are tested in tests/service/secrets.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, "secrets.json"), JSON.stringify({ version: 1, backend: "file" }) + "\n", {
    mode: 0o600,
  });
  return {
    env,
    stateDir,
    cleanup: async (bin) => {
      await stopService(bin, env);
      await removeHome?.();
    },
  };
}

/** `crot-mcp service stop` for an environment; resolves when no service runs any more. */
export function stopService(bin: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, "service", "stop"], { env, timeout: 20_000 }, () => resolve());
  });
}
