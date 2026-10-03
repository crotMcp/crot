import { open, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError, fromNodeError } from "../../errors.js";
import { displayPath as display, type ResolvedPath, type Workspace } from "../../workspace/workspace.js";

/** A repository located by CROT itself, without running Git. */
export interface DiscoveredRepository {
  /** Root of the worktree the start directory belongs to. */
  readonly worktree: ResolvedPath;
  /** The worktree's Git directory (`.git`, or the target of a `.git` file). */
  readonly gitDir: ResolvedPath;
  /** Shared Git directory (differs from gitDir for linked worktrees). */
  readonly commonDir: ResolvedPath;
}

const GITFILE_MAX_BYTES = 4096;

async function readSmallFile(p: string): Promise<string> {
  const handle = await open(p, "r");
  try {
    const buffer = Buffer.alloc(GITFILE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, GITFILE_MAX_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function statOrUndefined(p: string) {
  try {
    return await stat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw fromNodeError(e, `Cannot access ${p}`);
  }
}

/**
 * Locate the repository containing `start` by walking up from it, the way Git
 * does, but without running Git: every path Git will be pointed at is known
 * (and checked by the PermissionEngine) before any Git process starts.
 * GIT_DIR/GIT_WORK_TREE and similar environment variables are ignored.
 */
export async function discoverRepository(workspace: Workspace, start: ResolvedPath): Promise<DiscoveredRepository> {
  const info = await statOrUndefined(start.absolute);
  if (!info) throw new CrotError("NOT_FOUND", `Directory not found: ${display(start)}`);
  if (!info.isDirectory()) throw new CrotError("INVALID_INPUT", `Not a directory: ${display(start)}`);

  let current = start.absolute;
  for (;;) {
    const dotGit = path.join(current, ".git");
    const entry = await statOrUndefined(dotGit);
    if (entry?.isDirectory()) {
      const gitDir = await workspace.resolve(dotGit);
      return { worktree: workspace.describe(current), gitDir, commonDir: await commonDirOf(workspace, gitDir) };
    }
    if (entry?.isFile()) {
      let text: string;
      try {
        text = await readSmallFile(dotGit);
      } catch (e) {
        throw fromNodeError(e, `Cannot read ${dotGit}`);
      }
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(text.split(/\r?\n/)[0] ?? "");
      if (!match) throw new CrotError("INVALID_INPUT", `Malformed .git file: ${dotGit}`);
      const target = path.resolve(current, match[1]!);
      const targetInfo = await statOrUndefined(target);
      if (!targetInfo?.isDirectory()) throw new CrotError("NOT_FOUND", `Git directory not found: ${target}`);
      const gitDir = await workspace.resolve(target);
      return { worktree: workspace.describe(current), gitDir, commonDir: await commonDirOf(workspace, gitDir) };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new CrotError("NOT_FOUND", `Not inside a Git repository: ${display(start)}`);
}

async function commonDirOf(workspace: Workspace, gitDir: ResolvedPath): Promise<ResolvedPath> {
  const file = path.join(gitDir.absolute, "commondir");
  const info = await statOrUndefined(file);
  if (!info?.isFile()) return gitDir;
  let text: string;
  try {
    text = await readSmallFile(file);
  } catch (e) {
    throw fromNodeError(e, `Cannot read ${file}`);
  }
  const value = (text.split(/\r?\n/)[0] ?? "").trim();
  if (!value) return gitDir;
  return workspace.resolve(path.resolve(gitDir.absolute, value));
}
