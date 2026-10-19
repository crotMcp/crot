import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, link, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { PrivateFileProtection } from "../../platform/types.js";
import type { ResolvedPath, Workspace } from "../../workspace/workspace.js";
import { CrotError } from "../../errors.js";

export const BROWSER_FILE_COUNT_MAX = 16;
export const BROWSER_FILE_BYTES_MAX = 64 * 1024 * 1024;
const nonce = () => randomBytes(24).toString("hex");
const fail = (message: string): never => {
  throw new CrotError("OPERATION_FAILED", message);
};
export interface UploadLease {
  token: string;
  paths: string[];
  files: { name: string; size: number }[];
}
export interface DownloadLease {
  token: string;
  directory: string;
  prefix: string;
  stem: string;
}

/** Private files are never agent-visible paths. All entry points run inside ExecutionGuard. */
export class BrowserFiles {
  private readonly uploads = new Map<string, string>();
  private readonly pending = new Set<string>();
  private initialized?: Promise<void>;
  private closed = false;
  constructor(
    readonly workspace: Workspace,
    readonly uploadRoot: string,
    readonly downloadRoot: string,
    private readonly protection: PrivateFileProtection,
  ) {}

  private async ready(): Promise<void> {
    if (this.closed) fail("Browser file staging is closed.");
    // A descriptor-relative parent is required for publication, not a check-then-open pathname.
    if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
      fail("Safe browser file transfers require Linux descriptor-relative filesystem support on this host.");
    this.initialized ??= (async () => {
      for (const root of [this.uploadRoot, this.downloadRoot]) {
        const before = await lstat(root).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return undefined;
        });
        if (before?.isSymbolicLink() || (before && !before.isDirectory())) fail("Invalid browser staging directory.");
        await this.protection.ensureDirectory(root);
        if ((await realpath(root)) !== path.resolve(root) || (await this.protection.inspect(root)).ownerOnly !== true)
          fail("Browser staging is not a private canonical directory.");
        // Reclaim only our dead-process leases. Never delete another live Core's files.
        for (const entry of await readdir(root, { withFileTypes: true })) {
          const m = /^(\d+)-[a-f0-9]{48}$/.exec(entry.name);
          if (!m || !entry.isDirectory()) continue;
          try {
            process.kill(Number(m[1]), 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH")
              await rm(path.join(root, entry.name), { recursive: true, force: true });
          }
        }
      }
    })();
    return this.initialized;
  }
  private async lease(root: string): Promise<{ token: string; dir: string }> {
    await this.ready();
    const token = nonce(),
      dir = path.join(root, process.pid + "-" + token);
    await mkdir(dir, { mode: 0o700 });
    this.pending.add(dir);
    return { token, dir };
  }
  async upload(sources: readonly ResolvedPath[]): Promise<UploadLease> {
    if (sources.length < 1 || sources.length > BROWSER_FILE_COUNT_MAX)
      throw new CrotError("LIMIT_EXCEEDED", "Browser upload file count limit exceeded.");
    const { token, dir } = await this.lease(this.uploadRoot);
    const paths: string[] = [],
      files: UploadLease["files"] = [];
    let total = 0;
    try {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]!;
        const input = await open(source.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await input.stat();
          if (!info.isFile() || info.nlink < 1) fail("Upload source is not a regular file.");
          // The descriptor must name the authorized canonical source, not a swapped ancestor.
          if ((await readlink(`/proc/self/fd/${input.fd}`)) !== source.absolute) fail("Upload source changed.");
          total += info.size;
          if (total > BROWSER_FILE_BYTES_MAX)
            throw new CrotError("LIMIT_EXCEEDED", "Browser file byte limit exceeded.");
          const folder = path.join(dir, String(i));
          await mkdir(folder, { mode: 0o700 });
          const name = path.basename(source.absolute),
            target = path.join(folder, name);
          const output = await open(
            target,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await copy(input, output, info.size);
            await output.sync();
          } finally {
            await output.close();
          }
          const after = await input.stat();
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
            fail("Upload source changed while staging.");
          await chmod(target, 0o400);
          paths.push(target);
          files.push({ name, size: info.size });
        } finally {
          await input.close();
        }
      }
      this.pending.delete(dir);
      this.uploads.set(token, dir);
      return { token, paths, files };
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      this.pending.delete(dir);
      throw e;
    }
  }
  async release(token: string): Promise<void> {
    const dir = this.uploads.get(token);
    if (!dir) return;
    this.uploads.delete(token);
    await rm(dir, { recursive: true, force: true });
  }
  async download(): Promise<DownloadLease> {
    const { token, dir } = await this.lease(this.downloadRoot);
    return { token, directory: dir, prefix: path.basename(this.downloadRoot) + "/" + path.basename(dir), stem: token };
  }
  async discard(lease: DownloadLease): Promise<void> {
    if (!this.pending.delete(lease.directory)) return;
    await rm(lease.directory, { recursive: true, force: true });
  }
  async publish(
    lease: DownloadLease,
    name: string,
    size: number,
    destination: ResolvedPath,
    overwrite: boolean,
  ): Promise<void> {
    if (
      !this.pending.has(lease.directory) ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name) ||
      /[. ]$/.test(name) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > BROWSER_FILE_BYTES_MAX
    )
      fail("Invalid browser file metadata.");
    const file = path.join(lease.directory, lease.stem + "-" + name);
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== size) fail("Invalid browser staging file.");
    const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let parent: FileHandle | undefined, temp: string | undefined;
    try {
      const info = await source.stat();
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino || info.nlink !== 1 || info.size !== size)
        fail("Browser staging file changed.");
      parent = await open(
        path.dirname(destination.absolute),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const anchored = `/proc/self/fd/${parent.fd}`;
      const expected = await realpath(path.dirname(destination.absolute));
      if (
        (await readlink(anchored)) !== expected ||
        expected !== path.dirname(destination.absolute) ||
        !this.workspace.contains(this.workspace.root, expected)
      )
        fail("Download destination parent changed.");
      const target = anchored + "/" + path.basename(destination.absolute);
      temp = anchored + "/.crot-publish-" + nonce();
      const output = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await copy(source, output, size);
        await output.sync();
      } finally {
        await output.close();
      }
      const resolved = await this.workspace.resolve(destination.absolute);
      if (resolved.absolute !== destination.absolute || (await readlink(anchored)) !== expected)
        fail("Download destination changed.");
      const now = await lstat(expected),
        held = await parent.stat();
      if (now.dev !== held.dev || now.ino !== held.ino) fail("Download destination parent changed.");
      if (overwrite) await rename(temp, target);
      else {
        try {
          await link(temp, target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            throw new CrotError("ALREADY_EXISTS", "Download destination already exists.");
          throw e;
        }
      }
      await unlink(temp).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      temp = undefined;
      await parent.sync();
    } finally {
      if (temp) await unlink(temp).catch(() => undefined);
      await parent?.close();
      await source.close();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.uploads.keys()].map((id) => this.release(id)));
    await Promise.all([...this.pending].map((p) => rm(p, { recursive: true, force: true })));
    this.pending.clear();
  }
}
async function copy(source: FileHandle, destination: FileHandle, size: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) fail("File ended before its declared size.");
    let written = 0;
    while (written < bytesRead) {
      const r = await destination.write(buffer, written, bytesRead - written);
      if (!r.bytesWritten) fail("File write failed.");
      written += r.bytesWritten;
    }
    offset += bytesRead;
  }
  if ((await source.stat()).size !== size) fail("File size changed during transfer.");
}
