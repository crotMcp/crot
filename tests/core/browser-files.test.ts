import { chmod, link, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserFiles, BROWSER_FILE_BYTES_MAX } from "../../src/core/capabilities/browser/files.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { Workspace } from "../../src/core/workspace/workspace.js";
import { makeTempDirs, linkDirectory, type TempDirs } from "../helpers.js";

describe("BrowserFiles descriptor-bound staging", () => {
  let dirs: TempDirs, ws: Workspace, files: BrowserFiles;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    ws = await Workspace.open(dirs.workspace);
    files = new BrowserFiles(
      ws,
      path.join(dirs.outside, "uploads"),
      path.join(dirs.outside, "CROT-private-staging"),
      createPrivateFileProtection(false),
    );
  });
  afterEach(async () => {
    await files?.close();
    await dirs?.cleanup();
  });
  const stage = async (body = "original") => {
    const lease = await files.download();
    const file = path.join(lease.directory, lease.stem + "-file.bin");
    await writeFile(file, body);
    return { lease, file, size: Buffer.byteLength(body) };
  };
  it("keeps a read-only independent copy until explicit document release", async () => {
    await writeFile(path.join(ws.root, "fixture.txt"), "original");
    const upload = await files.upload([await ws.resolve("fixture.txt")]);
    await writeFile(path.join(ws.root, "fixture.txt"), "changed");
    expect(await readFile(upload.paths[0]!, "utf8")).toBe("original");
    if (process.platform !== "win32") expect((await stat(upload.paths[0]!)).mode & 0o777).toBe(0o400);
    expect(upload.files).toEqual([{ name: "fixture.txt", size: 8 }]);
    await files.release("unrelated");
    expect(await readFile(upload.paths[0]!, "utf8")).toBe("original");
    await files.release(upload.token);
    await expect(stat(upload.paths[0]!)).rejects.toThrow();
  });
  it("rejects a swapped symlink and nonregular source without leftovers", async () => {
    const source = await ws.resolve("source");
    if (process.platform === "win32") await linkDirectory(dirs.outside, source.absolute);
    else await symlink("missing", source.absolute);
    await expect(files.upload([source])).rejects.toThrow();
    await expect(files.upload([await ws.resolve(".")])).rejects.toThrow(/regular|identity|reparse/);
    expect(await readdir(files.uploadRoot)).toEqual([]);
  });
  it("publishes exact bytes atomically, refuses overwrite by default and permits explicit replacement", async () => {
    const s = await stage();
    const dest = await ws.resolve("result.bin");
    await files.publish(s.lease, "file.bin", s.size, dest, false);
    expect(await readFile(dest.absolute, "utf8")).toBe("original");
    await expect(files.publish(s.lease, "file.bin", s.size, dest, false)).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
    await files.publish(s.lease, "file.bin", s.size, dest, true);
    expect(await readdir(ws.root)).toEqual(["result.bin"]);
    await files.discard(s.lease);
    expect(await readdir(files.downloadRoot)).toEqual([]);
  });
  it.each(["symlink", "hardlink", "size", "traversal"])("rejects unsafe staging: %s", async (kind) => {
    const s = await stage();
    if (kind === "symlink") {
      const { unlink } = await import("node:fs/promises");
      await unlink(s.file);
      if (process.platform === "win32") await linkDirectory(dirs.outside, s.file);
      else await symlink(path.join(ws.root, "secret"), s.file);
    }
    if (kind === "hardlink") await link(s.file, path.join(ws.root, "other"));
    await expect(
      files.publish(
        s.lease,
        kind === "traversal" ? "../file.bin" : "file.bin",
        kind === "size" ? s.size + 1 : s.size,
        await ws.resolve("result"),
        false,
      ),
    ).rejects.toThrow();
    await expect(stat(path.join(ws.root, "result"))).rejects.toThrow();
  });
  it("rejects replacement of an approved destination parent by a symlink", async () => {
    const s = await stage();
    const dir = path.join(ws.root, "dir");
    await mkdir(dir);
    const dest = await ws.resolve("dir/result");
    const { rmdir } = await import("node:fs/promises");
    await rmdir(dir);
    await linkDirectory(dirs.outside, dir);
    await expect(files.publish(s.lease, "file.bin", s.size, dest, false)).rejects.toThrow();
    await expect(stat(path.join(dirs.outside, "result"))).rejects.toThrow();
  });
  it("refuses insecure roots and oversized metadata", async () => {
    await mkdir(files.uploadRoot, { mode: 0o755 });
    await chmod(files.uploadRoot, 0o755);
    // On Windows chmod does not express a DACL: inherited public ACL must be rejected too.
    await expect(files.download()).rejects.toThrow(/private/);
  });
  it("bounds metadata and cleans all owned leases on shutdown", async () => {
    const s = await stage();
    await expect(
      files.publish(s.lease, "file.bin", BROWSER_FILE_BYTES_MAX + 1, await ws.resolve("result"), false),
    ).rejects.toThrow();
    await files.close();
    expect(await readdir(files.downloadRoot)).toEqual([]);
    await expect(files.download()).rejects.toThrow(/closed/);
  });
});
