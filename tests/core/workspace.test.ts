import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrotError } from "../../src/core/errors.js";
import { Workspace } from "../../src/core/workspace/workspace.js";
import { canSymlinkFiles, linkDirectory, makeTempDirs, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
let ws: Workspace;

beforeEach(async () => {
  dirs = await makeTempDirs();
  ws = await Workspace.open(dirs.workspace);
});
afterEach(() => dirs.cleanup());

describe("Workspace", () => {
  it("rejects relative or missing roots", async () => {
    await expect(Workspace.open("relative/path")).rejects.toThrow(CrotError);
    await expect(Workspace.open(path.join(dirs.workspace, "missing"))).rejects.toThrow(CrotError);
  });

  it("resolves relative paths against the root", async () => {
    const p = await ws.resolve("src/index.ts");
    expect(p).toEqual({
      absolute: path.join(dirs.workspace, "src", "index.ts"),
      relative: "src/index.ts",
      insideWorkspace: true,
    });
  });

  it("treats the root itself as inside", async () => {
    const p = await ws.resolve(".");
    expect(p.insideWorkspace).toBe(true);
    expect(p.relative).toBe(".");
    expect(ws.isRoot(p)).toBe(true);
  });

  it("detects traversal outside the root", async () => {
    const p = await ws.resolve("../outside/secret.txt");
    expect(p.insideWorkspace).toBe(false);
    expect(p.relative).toBeNull();
    expect(p.absolute).toBe(path.join(dirs.outside, "secret.txt"));
  });

  it("does not treat sibling prefixes as inside", async () => {
    const sibling = `${dirs.workspace}-other`;
    await mkdir(sibling);
    expect((await ws.resolve(path.join(sibling, "x"))).insideWorkspace).toBe(false);
  });

  it("classifies absolute paths", async () => {
    expect((await ws.resolve(path.join(dirs.workspace, "a"))).insideWorkspace).toBe(true);
    expect((await ws.resolve(dirs.outside)).insideWorkspace).toBe(false);
  });

  it("detects symlink/junction escapes through directories", async () => {
    await linkDirectory(dirs.outside, path.join(dirs.workspace, "link"));
    const p = await ws.resolve("link/file.txt");
    expect(p.insideWorkspace).toBe(false);
    expect(p.absolute).toBe(path.join(dirs.outside, "file.txt"));
  });

  it("follows or preserves a final symlink depending on options", async (t) => {
    if (!(await canSymlinkFiles())) t.skip();
    await writeFile(path.join(dirs.outside, "target.txt"), "x");
    await symlink(path.join(dirs.outside, "target.txt"), path.join(dirs.workspace, "link.txt"), "file");
    expect((await ws.resolve("link.txt")).insideWorkspace).toBe(false);
    const entry = await ws.resolve("link.txt", { followFinalSymlink: false });
    expect(entry.insideWorkspace).toBe(true);
    expect(entry.absolute).toBe(path.join(dirs.workspace, "link.txt"));
  });

  it("follows or preserves a final directory link depending on options", async () => {
    await linkDirectory(dirs.outside, path.join(dirs.workspace, "dirlink"));
    expect((await ws.resolve("dirlink")).insideWorkspace).toBe(false);
    expect((await ws.resolve("dirlink", { followFinalSymlink: false })).insideWorkspace).toBe(true);
  });

  it("compares paths according to the probed case sensitivity", async () => {
    const root = path.join(dirs.outside, "CaseRoot");
    await mkdir(root);
    await writeFile(path.join(root, "File.txt"), "x");
    const cased = await Workspace.open(root);
    const swapped = path.join(dirs.outside, "caseroot");
    const p = await cased.resolve(swapped);
    // Ground truth from the filesystem itself.
    const fsInsensitive = await import("node:fs/promises").then((fs) =>
      fs.stat(swapped).then(
        () => true,
        () => false,
      ),
    );
    expect(cased.caseSensitive).toBe(!fsInsensitive);
    expect(p.insideWorkspace).toBe(fsInsensitive);
    expect(cased.isRoot(p)).toBe(fsInsensitive);
    if (process.platform === "win32") expect(cased.caseSensitive).toBe(false);
  });

  it("rejects platform-invalid paths", async () => {
    if (process.platform === "win32") {
      for (const bad of ["CON", "sub\\nul.txt", "file.txt:stream", "D:relative", "\\\\?\\C:\\x", "trailing.", "a<b"]) {
        await expect(ws.resolve(bad)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
    } else {
      // On POSIX these are ordinary names.
      for (const ok of ["CON", "file.txt:stream", "trailing."]) {
        expect((await ws.resolve(ok)).insideWorkspace).toBe(true);
      }
    }
  });

  it("does not accept a home-relative root without expansion", async () => {
    await expect(Workspace.open("~")).rejects.toThrow(CrotError);
    expect(os.homedir()).toBeTruthy();
  });

  it("rejects NUL bytes and empty paths", async () => {
    await expect(ws.resolve("a\0b")).rejects.toThrow(CrotError);
    await expect(ws.resolve("")).rejects.toThrow(CrotError);
  });
});
