/**
 * Paths holding CROT secrets (WP-21, AD-18): no CROT tool may read, stat,
 * list, modify, move or delete them, or use them as a working directory, in
 * sandbox or full_control mode; following a symlink to them is denied too.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import { canSymlinkFiles, createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
let core: CrotCore | undefined;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  await dirs.cleanup();
});

const SECRET = "secret-value-0123456789-abcdefghijklmnopqrstuvwxyz";
const denied = { code: "PERMISSION_DENIED", message: expect.stringMatching(/CROT secrets/) };

/** A CROT state directory with a token file and a DPAPI-style directory, inside `root`. */
async function stateIn(root: string) {
  const state = path.join(root, "state");
  await mkdir(path.join(state, "secrets"), { recursive: true });
  await writeFile(path.join(state, "http-token"), `${SECRET}\n`);
  await writeFile(path.join(state, "secrets", "service-token.dpapi"), "blob\n");
  await writeFile(path.join(state, "notes.txt"), "not a secret\n");
  return { state, file: path.join(state, "http-token"), dir: path.join(state, "secrets") };
}

describe.each(["sandbox", "full_control"] as const)("secret paths in %s mode", (mode) => {
  it("cannot be read, listed, statted, written, moved or deleted", async () => {
    // In sandbox only the workspace is reachable: the state directory is placed inside it.
    const s = await stateIn(mode === "sandbox" ? dirs.workspace : dirs.outside);
    core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode } }, undefined, {
      secretPaths: [s.file, s.dir],
    });
    const fs = core.filesystem;
    await expect(fs.readFile(ctx, { path: s.file })).rejects.toMatchObject(denied);
    await expect(fs.stat(ctx, { path: s.file })).rejects.toMatchObject(denied);
    await expect(fs.readFile(ctx, { path: path.join(s.dir, "service-token.dpapi") })).rejects.toMatchObject(denied);
    await expect(fs.listDirectory(ctx, { path: s.dir })).rejects.toMatchObject(denied);
    await expect(fs.writeFile(ctx, { path: s.file, content: "forged" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(fs.delete(ctx, { path: s.file })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(fs.move(ctx, { from: s.file, to: path.join(s.state, "copy") })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    // Removing or moving the state directory would take the secrets with it.
    await expect(fs.delete(ctx, { path: s.state, recursive: true })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    // A working directory inside the secret directory.
    await expect(
      core.processes.exec(ctx, { command: process.execPath, args: ["-v"], cwd: s.dir }),
    ).rejects.toMatchObject(denied);
    // The rest of the state directory stays usable.
    expect((await fs.readFile(ctx, { path: path.join(s.state, "notes.txt") })).content).toContain("not a secret");
    expect(await readFile(s.file, "utf8")).toBe(`${SECRET}\n`);
    const status = core.status();
    expect(status.secretPaths).toEqual(expect.arrayContaining([s.dir]));
    expect(status.protectedPaths).toEqual(expect.arrayContaining([s.dir]));
  });

  it("cannot be reached through a symlink", async (c) => {
    if (!(await canSymlinkFiles())) c.skip();
    const s = await stateIn(dirs.outside);
    core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode } }, undefined, {
      secretPaths: [s.file],
    });
    await symlink(s.file, path.join(dirs.workspace, "innocent.txt"), "file");
    await expect(core.filesystem.readFile(ctx, { path: "innocent.txt" })).rejects.toMatchObject(
      mode === "sandbox" ? { code: "PERMISSION_DENIED" } : denied,
    );
  });
});
