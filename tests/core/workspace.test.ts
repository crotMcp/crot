import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrotError } from "../../src/core/errors.js";
import { Workspace } from "../../src/core/workspace/workspace.js";
import { makeTempDirs, type TempDirs } from "../helpers.js";

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
    expect(p).toEqual({ absolute: path.join(dirs.workspace, "src", "index.ts"), relative: "src/index.ts", insideWorkspace: true });
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

  it("detects symlink escapes through directories", async () => {
    await symlink(dirs.outside, path.join(dirs.workspace, "link"));
    const p = await ws.resolve("link/file.txt");
    expect(p.insideWorkspace).toBe(false);
    expect(p.absolute).toBe(path.join(dirs.outside, "file.txt"));
  });

  it("follows or preserves a final symlink depending on options", async () => {
    await writeFile(path.join(dirs.outside, "target.txt"), "x");
    await symlink(path.join(dirs.outside, "target.txt"), path.join(dirs.workspace, "link.txt"));
    expect((await ws.resolve("link.txt")).insideWorkspace).toBe(false);
    const entry = await ws.resolve("link.txt", { followFinalSymlink: false });
    expect(entry.insideWorkspace).toBe(true);
    expect(entry.absolute).toBe(path.join(dirs.workspace, "link.txt"));
  });

  it("rejects NUL bytes and empty paths", async () => {
    await expect(ws.resolve("a\0b")).rejects.toThrow(CrotError);
    await expect(ws.resolve("")).rejects.toThrow(CrotError);
  });
});
