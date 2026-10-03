import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import {
  canSymlinkFiles,
  createTestCore,
  isWindows,
  linkDirectory,
  makeTempDirs,
  testContext as ctx,
  type TempDirs,
} from "../helpers.js";

let dirs: TempDirs;
let core: CrotCore;

beforeEach(async () => {
  dirs = await makeTempDirs();
  core = await createTestCore({ workspace: { root: dirs.workspace }, limits: { maxReadBytes: 64 } });
});
afterEach(() => dirs.cleanup());

describe("filesystem: read/write", () => {
  it("writes and reads text with parent creation", async () => {
    const w = await core.filesystem.writeFile(ctx, { path: "src/a.txt", content: "hello" });
    expect(w).toEqual({ path: "src/a.txt", bytesWritten: 5, created: true });
    const r = await core.filesystem.readFile(ctx, { path: "src/a.txt" });
    expect(r).toMatchObject({ path: "src/a.txt", content: "hello", size: 5, truncated: false });
  });

  it("supports base64, append and create modes", async () => {
    await core.filesystem.writeFile(ctx, {
      path: "b.bin",
      content: Buffer.from([0, 1, 2]).toString("base64"),
      encoding: "base64",
    });
    await core.filesystem.writeFile(ctx, { path: "b.bin", content: "Aw==", encoding: "base64", mode: "append" });
    expect([...(await readFile(path.join(dirs.workspace, "b.bin")))]).toEqual([0, 1, 2, 3]);
    await expect(core.filesystem.writeFile(ctx, { path: "b.bin", content: "x", mode: "create" })).rejects.toMatchObject(
      {
        code: "ALREADY_EXISTS",
      },
    );
  });

  it("bounds reads by the configured limit and supports offsets", async () => {
    await writeFile(path.join(dirs.workspace, "big.txt"), "x".repeat(100));
    const r = await core.filesystem.readFile(ctx, { path: "big.txt" });
    expect(r.bytesRead).toBe(64);
    expect(r.truncated).toBe(true);
    const rest = await core.filesystem.readFile(ctx, { path: "big.txt", offset: 64 });
    expect(rest.bytesRead).toBe(36);
    expect(rest.truncated).toBe(false);
  });

  it("reports missing files as NOT_FOUND", async () => {
    await expect(core.filesystem.readFile(ctx, { path: "nope.txt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates input", async () => {
    await expect(core.filesystem.readFile(ctx, { path: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      core.filesystem.writeFile(ctx, { path: "a", content: "x", mode: "bogus" } as never),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("filesystem: sandbox enforcement", () => {
  it("denies reads and writes outside the workspace", async () => {
    await writeFile(path.join(dirs.outside, "secret.txt"), "s");
    await expect(core.filesystem.readFile(ctx, { path: "../outside/secret.txt" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(core.filesystem.readFile(ctx, { path: path.join(dirs.outside, "secret.txt") })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(core.filesystem.writeFile(ctx, { path: "../outside/new.txt", content: "x" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("denies writing through a directory link that points outside", async () => {
    await linkDirectory(dirs.outside, path.join(dirs.workspace, "escape"));
    await expect(core.filesystem.writeFile(ctx, { path: "escape/pwned.txt", content: "x" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("denies moving files out of the workspace", async () => {
    await writeFile(path.join(dirs.workspace, "a.txt"), "a");
    await expect(core.filesystem.move(ctx, { from: "a.txt", to: "../outside/a.txt" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("denies writes when filesystem.write is not granted", async () => {
    const readOnly = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { capabilities: ["filesystem.read"] },
    });
    await expect(readOnly.filesystem.writeFile(ctx, { path: "a.txt", content: "x" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("allows outside paths in full_control mode", async () => {
    const full = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    const w = await full.filesystem.writeFile(ctx, { path: path.join(dirs.outside, "ok.txt"), content: "ok" });
    expect(w.path).toBe(path.join(dirs.outside, "ok.txt"));
  });
});

describe("filesystem: directories", () => {
  beforeEach(async () => {
    await mkdir(path.join(dirs.workspace, "src", "lib"), { recursive: true });
    await writeFile(path.join(dirs.workspace, "src", "index.ts"), "x");
    await writeFile(path.join(dirs.workspace, "src", "lib", "util.ts"), "yy");
    await writeFile(path.join(dirs.workspace, ".env"), "z");
  });

  it("lists non-recursively and recursively", async () => {
    const flat = await core.filesystem.listDirectory(ctx, {});
    expect(flat.entries.map((e) => e.path)).toEqual([".env", "src"]);
    const deep = await core.filesystem.listDirectory(ctx, { path: "src", recursive: true });
    expect(deep.entries).toEqual([
      { path: "index.ts", type: "file", size: 1 },
      { path: "lib", type: "directory", size: 0 },
      { path: "lib/util.ts", type: "file", size: 2 },
    ]);
  });

  it("filters hidden entries and truncates", async () => {
    expect((await core.filesystem.listDirectory(ctx, { includeHidden: false })).entries.map((e) => e.path)).toEqual([
      "src",
    ]);
    const t = await core.filesystem.listDirectory(ctx, { recursive: true, maxEntries: 2 });
    expect(t.entries).toHaveLength(2);
    expect(t.truncated).toBe(true);
  });

  it("does not follow symlinks when recursing", async () => {
    await writeFile(path.join(dirs.outside, "secret.txt"), "s");
    await linkDirectory(dirs.outside, path.join(dirs.workspace, "src", "link"));
    const deep = await core.filesystem.listDirectory(ctx, { path: "src", recursive: true });
    expect(deep.entries.find((e) => e.path === "link")?.type).toBe("symlink");
    expect(deep.entries.some((e) => e.path.startsWith("link/"))).toBe(false);
  });

  it("stats entries", async () => {
    expect(await core.filesystem.stat(ctx, { path: "missing" })).toEqual({ path: "missing", exists: false });
    expect(await core.filesystem.stat(ctx, { path: "src/lib/util.ts" })).toMatchObject({
      exists: true,
      type: "file",
      size: 2,
    });
  });

  it("creates, moves and deletes", async () => {
    expect(await core.filesystem.createDirectory(ctx, { path: "a/b/c" })).toEqual({ path: "a/b/c", created: true });
    await core.filesystem.move(ctx, { from: "src/index.ts", to: "a/b/c/index.ts" });
    expect((await core.filesystem.stat(ctx, { path: "a/b/c/index.ts" })).exists).toBe(true);
    await expect(core.filesystem.move(ctx, { from: "src/lib/util.ts", to: "a/b/c/index.ts" })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
    await expect(core.filesystem.delete(ctx, { path: "a" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await core.filesystem.delete(ctx, { path: "a", recursive: true })).toEqual({ path: "a", deleted: true });
    expect((await core.filesystem.stat(ctx, { path: "a" })).exists).toBe(false);
  });

  it("deletes a file symlink itself, not its target", async (t) => {
    if (!(await canSymlinkFiles())) t.skip();
    await writeFile(path.join(dirs.outside, "keep.txt"), "k");
    await symlink(path.join(dirs.outside, "keep.txt"), path.join(dirs.workspace, "link.txt"), "file");
    await core.filesystem.delete(ctx, { path: "link.txt" });
    expect(await readFile(path.join(dirs.outside, "keep.txt"), "utf8")).toBe("k");
  });

  it("deletes a directory symlink/junction itself, not its target", async () => {
    await writeFile(path.join(dirs.outside, "keep.txt"), "k");
    await linkDirectory(dirs.outside, path.join(dirs.workspace, "dirlink"));
    expect(await core.filesystem.delete(ctx, { path: "dirlink" })).toEqual({ path: "dirlink", deleted: true });
    expect((await core.filesystem.stat(ctx, { path: "dirlink" })).exists).toBe(false);
    expect(await readFile(path.join(dirs.outside, "keep.txt"), "utf8")).toBe("k");
  });

  it("refuses to delete the workspace root", async () => {
    await expect(core.filesystem.delete(ctx, { path: ".", recursive: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("filesystem: special files", () => {
  it("refuses to read or write directories as files", async () => {
    await mkdir(path.join(dirs.workspace, "d"));
    await expect(core.filesystem.readFile(ctx, { path: "d" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(core.filesystem.writeFile(ctx, { path: "d", content: "x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it.skipIf(isWindows)("refuses FIFOs without blocking", async () => {
    const fifo = path.join(dirs.workspace, "pipe");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    await expect(core.filesystem.readFile(ctx, { path: "pipe" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(core.filesystem.writeFile(ctx, { path: "pipe", content: "x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(core.filesystem.writeFile(ctx, { path: "pipe", content: "x", mode: "append" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await stat(fifo)).isFIFO()).toBe(true);
  });

  it.runIf(isWindows)("rejects Windows device names instead of opening devices", async () => {
    for (const name of ["CON", "nul", "COM1.txt", "sub\\AUX"]) {
      await expect(core.filesystem.readFile(ctx, { path: name })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(core.filesystem.writeFile(ctx, { path: name, content: "x" })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it.runIf(isWindows)("rejects alternate data streams", async () => {
    await writeFile(path.join(dirs.workspace, "a.txt"), "a");
    await expect(core.filesystem.writeFile(ctx, { path: "a.txt:hidden", content: "x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it.runIf(isWindows)("accepts forward slashes and mixed case on Windows", async () => {
    await core.filesystem.writeFile(ctx, { path: "Dir/Sub/File.txt", content: "x" });
    expect((await core.filesystem.readFile(ctx, { path: "dir\\sub\\FILE.TXT" })).content).toBe("x");
  });
});
