import { constants } from "node:fs";
import { appendFile, cp, lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, fromNodeError, parseInput } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import { displayPath as display, type Workspace } from "../../workspace/workspace.js";
import {
  CreateDirectoryInputSchema,
  DeleteInputSchema,
  ListDirectoryInputSchema,
  MoveInputSchema,
  ReadFileInputSchema,
  StatInputSchema,
  WriteFileInputSchema,
  type CreateDirectoryInput,
  type DeleteInput,
  type DirectoryEntry,
  type EntryType,
  type ListDirectoryInput,
  type ListDirectoryResult,
  type MoveInput,
  type ReadFileInput,
  type ReadFileResult,
  type StatInput,
  type StatResult,
  type WriteFileInput,
  type WriteFileResult,
} from "./schemas.js";

export interface FileSystemServiceDeps {
  readonly workspace: Workspace;
  readonly guard: ExecutionGuard;
  readonly limits: Pick<Limits, "maxReadBytes">;
}

/**
 * Filesystem capability of CROT Core.
 *
 * Every method validates its input, resolves paths through the Workspace and
 * runs through the ExecutionGuard before touching the filesystem.
 */
export class FileSystemService {
  constructor(private readonly deps: FileSystemServiceDeps) {}

  async readFile(context: AuthContext, input: ReadFileInput): Promise<ReadFileResult> {
    const args = parseInput(ReadFileInputSchema, input);
    const target = await this.deps.workspace.resolve(args.path);
    return this.deps.guard.run(context, { operation: "filesystem.read_file", capability: "filesystem.read", paths: [target] }, async () => {
      const limit = Math.min(args.length ?? this.deps.limits.maxReadBytes, this.deps.limits.maxReadBytes);
      // Refuse FIFOs, sockets and devices before opening: opening a FIFO blocks until a writer appears.
      await assertRegularFileOrMissing(target.absolute, display(target), true);
      // O_NONBLOCK (POSIX) guards against the path being swapped for a FIFO after the check.
      const handle = await open(target.absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch((e) => {
        throw fromNodeError(e, `Cannot open ${display(target)}`);
      });
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new CrotError("INVALID_INPUT", `Not a regular file: ${display(target)}`);
        const toRead = Math.max(0, Math.min(limit, info.size - args.offset));
        const buffer = Buffer.alloc(toRead);
        const { bytesRead } = toRead > 0 ? await handle.read(buffer, 0, toRead, args.offset) : { bytesRead: 0 };
        const data = buffer.subarray(0, bytesRead);
        return {
          path: display(target),
          encoding: args.encoding,
          content: data.toString(args.encoding),
          size: info.size,
          offset: args.offset,
          bytesRead,
          truncated: args.offset + bytesRead < info.size,
        };
      } finally {
        await handle.close();
      }
    });
  }

  async writeFile(context: AuthContext, input: WriteFileInput): Promise<WriteFileResult> {
    const args = parseInput(WriteFileInputSchema, input);
    const target = await this.deps.workspace.resolve(args.path);
    return this.deps.guard.run(context, {
        operation: "filesystem.write_file",
        capability: "filesystem.write",
        paths: [target],
        details: { mode: args.mode, encoding: args.encoding },
      }, async () => {
      const data = Buffer.from(args.content, args.encoding);
      // Writing to a FIFO or device would block or have side effects; only regular files are written.
      await assertRegularFileOrMissing(target.absolute, display(target), false);
      const existed = await exists(target.absolute);
      try {
        if (args.createParents) await mkdir(path.dirname(target.absolute), { recursive: true });
        if (args.mode === "append") await appendFile(target.absolute, data);
        else await writeFile(target.absolute, data, { flag: args.mode === "create" ? "wx" : "w" });
      } catch (e) {
        throw fromNodeError(e, `Cannot write ${display(target)}`);
      }
      return { path: display(target), bytesWritten: data.length, created: !existed };
    });
  }

  async listDirectory(context: AuthContext, input: ListDirectoryInput): Promise<ListDirectoryResult> {
    const args = parseInput(ListDirectoryInputSchema, input);
    const target = await this.deps.workspace.resolve(args.path);
    return this.deps.guard.run(context, { operation: "filesystem.list_directory", capability: "filesystem.read", paths: [target] }, async () => {
      const entries: DirectoryEntry[] = [];
      let truncated = false;
      const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
        let dirents;
        try {
          dirents = await readdir(dir, { withFileTypes: true });
        } catch (e) {
          throw fromNodeError(e, `Cannot list ${display(target)}${prefix ? `/${prefix}` : ""}`);
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of dirents) {
          if (!args.includeHidden && d.name.startsWith(".")) continue;
          if (entries.length >= args.maxEntries) {
            truncated = true;
            return;
          }
          const full = path.join(dir, d.name);
          const rel = prefix ? `${prefix}/${d.name}` : d.name;
          const info = await lstat(full).catch(() => undefined);
          const type: EntryType = info ? entryType(info) : "other";
          entries.push({ path: rel, type, size: info && type === "file" ? info.size : 0 });
          // Never follow symlinks while recursing.
          if (args.recursive && type === "directory" && depth < args.maxDepth) await walk(full, rel, depth + 1);
          if (truncated) return;
        }
      };
      await walk(target.absolute, "", 1);
      return { path: display(target), entries, truncated };
    });
  }

  async stat(context: AuthContext, input: StatInput): Promise<StatResult> {
    const args = parseInput(StatInputSchema, input);
    const target = await this.deps.workspace.resolve(args.path, { followFinalSymlink: false });
    return this.deps.guard.run(context, { operation: "filesystem.stat", capability: "filesystem.read", paths: [target] }, async () => {
      let info: Stats;
      try {
        info = await lstat(target.absolute);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path: display(target), exists: false };
        throw fromNodeError(e, `Cannot stat ${display(target)}`);
      }
      const type = entryType(info);
      const result: StatResult = { path: display(target), exists: true, type, size: info.size, modifiedAt: info.mtime.toISOString() };
      return type === "symlink" ? { ...result, symlinkTarget: await readlink(target.absolute) } : result;
    });
  }

  async createDirectory(context: AuthContext, input: CreateDirectoryInput): Promise<{ path: string; created: boolean }> {
    const args = parseInput(CreateDirectoryInputSchema, input);
    const target = await this.deps.workspace.resolve(args.path);
    return this.deps.guard.run(
      context,
      { operation: "filesystem.create_directory", capability: "filesystem.write", paths: [target] },
      async () => {
        const existed = await exists(target.absolute);
        try {
          await mkdir(target.absolute, { recursive: args.recursive });
        } catch (e) {
          throw fromNodeError(e, `Cannot create directory ${display(target)}`);
        }
        return { path: display(target), created: !existed };
      },
    );
  }

  async delete(context: AuthContext, input: DeleteInput): Promise<{ path: string; deleted: boolean }> {
    const args = parseInput(DeleteInputSchema, input);
    const target = await this.deps.workspace.resolve(args.path, { followFinalSymlink: false });
    return this.deps.guard.run(context, { operation: "filesystem.delete", capability: "filesystem.write", paths: [target], details: { recursive: args.recursive } }, async () => {
      if (this.deps.workspace.isRoot(target)) throw new CrotError("INVALID_INPUT", "Refusing to delete the workspace root.");
      if (target.absolute === path.parse(target.absolute).root) throw new CrotError("INVALID_INPUT", "Refusing to delete a filesystem root.");
      try {
        const info = await lstat(target.absolute);
        if (info.isDirectory() && !args.recursive) await rmdir(target.absolute);
        // Retries cover transient EBUSY/EPERM on Windows (e.g. antivirus or indexer holding a file).
        else await rm(target.absolute, { recursive: args.recursive, force: false, maxRetries: args.recursive ? 3 : 0, retryDelay: 100 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOTEMPTY") {
          throw new CrotError("INVALID_INPUT", `Directory is not empty (set recursive to delete it): ${display(target)}`);
        }
        throw fromNodeError(e, `Cannot delete ${display(target)}`);
      }
      return { path: display(target), deleted: true };
    });
  }

  async move(context: AuthContext, input: MoveInput): Promise<{ from: string; to: string }> {
    const args = parseInput(MoveInputSchema, input);
    const from = await this.deps.workspace.resolve(args.from, { followFinalSymlink: false });
    const to = await this.deps.workspace.resolve(args.to, { followFinalSymlink: false });
    return this.deps.guard.run(context, { operation: "filesystem.move", capability: "filesystem.write", paths: [from, to], details: { overwrite: args.overwrite } }, async () => {
      if (this.deps.workspace.isRoot(from)) throw new CrotError("INVALID_INPUT", "Refusing to move the workspace root.");
      if (!args.overwrite && (await exists(to.absolute))) {
        throw new CrotError("ALREADY_EXISTS", `Destination exists (set overwrite to replace it): ${display(to)}`);
      }
      try {
        await mkdir(path.dirname(to.absolute), { recursive: true });
        await rename(from.absolute, to.absolute);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw fromNodeError(e, `Cannot move ${display(from)}`);
        // Cross-device move: copy then remove.
        try {
          await cp(from.absolute, to.absolute, { recursive: true, force: args.overwrite, errorOnExist: !args.overwrite, verbatimSymlinks: true });
          await rm(from.absolute, { recursive: true });
        } catch (copyError) {
          throw fromNodeError(copyError, `Cannot move ${display(from)}`);
        }
      }
      return { from: display(from), to: display(to) };
    });
  }
}

function entryType(info: Stats): EntryType {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

/** Throw INVALID_INPUT unless `p` is a regular file (or, when `mustExist` is false, does not exist). */
async function assertRegularFileOrMissing(p: string, shown: string, mustExist: boolean): Promise<void> {
  let info: Stats;
  try {
    info = await stat(p);
  } catch (e) {
    if (!mustExist && (e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fromNodeError(e, `Cannot access ${shown}`);
  }
  if (info.isFile()) return;
  if (info.isDirectory()) throw new CrotError("INVALID_INPUT", `Is a directory: ${shown}`);
  throw new CrotError("INVALID_INPUT", `Not a regular file (FIFO, socket or device): ${shown}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
