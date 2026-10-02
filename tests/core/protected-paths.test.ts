import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrotCore } from "../../src/core/crot-core.js";
import { makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

describe("protected paths (audit log and configuration)", () => {
  const create = (mode: "sandbox" | "full_control", extra: string[] = []) =>
    CrotCore.create(
      { workspace: { root: dirs.workspace }, permissions: { mode }, audit: { sink: "file", path: path.join(dirs.workspace, ".crot", "audit.jsonl") } },
      { protectedPaths: extra },
    );

  it.each(["sandbox", "full_control"] as const)("denies modifying the audit log in %s mode", async (mode) => {
    const core = await create(mode);
    await core.filesystem.writeFile(ctx, { path: "ok.txt", content: "x" });
    await expect(core.filesystem.writeFile(ctx, { path: ".crot/audit.jsonl", content: "forged" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(core.filesystem.delete(ctx, { path: ".crot", recursive: true })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(core.filesystem.move(ctx, { from: ".crot", to: "elsewhere" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(core.filesystem.move(ctx, { from: "ok.txt", to: ".crot/audit.jsonl", overwrite: true })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    // Reading remains possible.
    expect((await core.filesystem.readFile(ctx, { path: ".crot/audit.jsonl" })).content).toContain("filesystem.write_file");
    await core.shutdown();
    const log = await readFile(path.join(dirs.workspace, ".crot", "audit.jsonl"), "utf8");
    expect(log).not.toContain("forged");
    expect(log).toContain('"outcome":"denied"');
  });

  it("protects the configuration file and reports protected paths", async () => {
    const config = path.join(dirs.workspace, "crot.json");
    await writeFile(config, "{}");
    const core = await create("full_control", [config]);
    await expect(core.filesystem.writeFile(ctx, { path: "crot.json", content: "{}" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(core.filesystem.delete(ctx, { path: "crot.json" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(core.status().protectedPaths).toEqual(expect.arrayContaining([config, path.join(dirs.workspace, ".crot", "audit.jsonl")]));
    await core.shutdown();
  });

  it("matches protected paths case-insensitively where the filesystem does", async () => {
    const core = await create("sandbox");
    await mkdir(path.join(dirs.workspace, ".crot"), { recursive: true });
    await core.filesystem.writeFile(ctx, { path: "ok.txt", content: "x" });
    if (!core.workspace.caseSensitive) {
      await expect(core.filesystem.writeFile(ctx, { path: ".CROT/AUDIT.JSONL", content: "forged" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
    await core.shutdown();
  });
});
