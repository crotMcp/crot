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
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
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
