import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { ProjectSecretAccessStore, projectSecretAccessPath } from "../../src/service/project-secret-access.js";
import { makeTempDirs } from "../helpers.js";
const protection = createPrivateFileProtection(process.platform === "win32");
describe("owner project-secret state transaction", () => {
  it("persists exact opt-ins and recovers an interrupted grant or revoke as deny-all", async () => {
    const dirs = await makeTempDirs();
    try {
      const file = projectSecretAccessPath(dirs.outside),
        policy = { allow: [{ workspace: dirs.workspace, path: ".env" }] };
      const store = await ProjectSecretAccessStore.open(file, protection, { allow: [] });
      await store.stage(policy);
      expect(store.policy.allow).toEqual([]);
      expect((await ProjectSecretAccessStore.open(file, protection, policy)).policy.allow).toEqual([]);
      await store.commit(policy);
      expect((await ProjectSecretAccessStore.open(file, protection, { allow: [] })).policy).toEqual(policy);
      await store.stage({ allow: [] });
      expect((await ProjectSecretAccessStore.open(file, protection, policy)).policy.allow).toEqual([]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, policy: { allow: [] } });
      if (process.platform !== "win32") expect((await lstat(file)).mode & 0o077).toBe(0);
    } finally {
      await dirs.cleanup();
    }
  });
  it("refuses corrupt, overlarge, directory and symlink policy files rather than restoring config grants", async () => {
    const dirs = await makeTempDirs();
    try {
      for (const [name, body] of [
        ["bad.json", '{"version":2}'],
        ["large.json", "x".repeat(256 * 1024 + 1)],
      ]) {
        const file = path.join(dirs.outside, name!);
        await writeFile(file, body!, { mode: 0o600 });
        await expect(
          ProjectSecretAccessStore.open(file, protection, { allow: [{ workspace: dirs.workspace, path: ".env" }] }),
        ).rejects.toThrow();
      }
      const dir = path.join(dirs.outside, "directory");
      await mkdir(dir);
      await expect(ProjectSecretAccessStore.open(dir, protection, { allow: [] })).rejects.toThrow();
      if (process.platform !== "win32") {
        const alias = path.join(dirs.outside, "alias");
        await symlink(path.join(dirs.outside, "bad.json"), alias);
        await expect(ProjectSecretAccessStore.open(alias, protection, { allow: [] })).rejects.toThrow();
      }
    } finally {
      await dirs.cleanup();
    }
  });
  it("never publishes a policy when the protected write fails", async () => {
    const dirs = await makeTempDirs();
    try {
      const bad = {
        ...protection,
        protectFile: async () => {
          throw Error("injected ACL failure");
        },
      };
      const file = projectSecretAccessPath(dirs.outside),
        store = await ProjectSecretAccessStore.open(file, bad, { allow: [] });
      await expect(store.stage({ allow: [{ workspace: dirs.workspace, path: ".env" }] })).rejects.toThrow(
        "injected ACL failure",
      );
      expect(store.policy.allow).toEqual([]);
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await dirs.cleanup();
    }
  });
});
