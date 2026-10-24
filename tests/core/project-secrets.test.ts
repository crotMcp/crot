import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { ProjectSecretAccessSchema, isProjectSecretName } from "../../src/core/permissions/project-secrets.js";
import { RuntimePermissionState } from "../../src/core/permissions/runtime.js";
import { createTestCore, makeTempDirs, testContext } from "../helpers.js";

describe("mandatory project secret-file policy", () => {
  it("recognizes environment variants and key files without broad extension guesses", () => {
    for (const name of [".env", ".env.local", ".ENV.PRODUCTION", "server.pem", "private.KEY"])
      expect(isProjectSecretName(name)).toBe(true);
    for (const name of ["environment.ts", "env", "key.txt", "file.pem.txt", "safe"])
      expect(isProjectSecretName(name)).toBe(false);
  });
  it("accepts exact file opt-ins only, never wildcard, traversal, directory or alternate stream grants", () => {
    const grant = (name: string) =>
      ProjectSecretAccessSchema.safeParse({ allow: [{ workspace: "/ws", path: name }] }).success;
    expect(grant("certs/server.pem")).toBe(true);
    for (const name of [
      "../.env",
      "/.env",
      "*.key",
      "a\\b.key",
      "x.key:stream",
      "folder/",
      ".env/safe.key",
      "x/../a.key",
      "a.key ",
      "a.key\n",
      "safe.txt",
    ])
      expect(grant(name), name).toBe(false);
  });
  it("denies existing and newly created secret names in full_control, writes and runtime approval grants too", async () => {
    const dirs = await makeTempDirs(),
      runtime = new RuntimePermissionState(),
      audit = new MemoryAuditSink();
    const core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      audit,
      { runtimePermissions: runtime },
    );
    try {
      runtime.replace({
        strict: true,
        rules: [{ operation: "filesystem.read_file", state: "allow" }],
        projectGrants: [{ workspace: dirs.workspace, operation: "filesystem.read_file" }],
      });
      await mkdir(path.join(dirs.workspace, "certs"));
      for (const name of [".env", ".env.local", "certs/server.pem", "private.KEY"]) {
        await writeFile(path.join(dirs.workspace, name), "unlogged-test-secret");
        await expect(core.filesystem.readFile(testContext, { path: name })).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
        await expect(core.filesystem.writeFile(testContext, { path: name, content: "bad" })).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
        expect(await readFile(path.join(dirs.workspace, name), "utf8")).toBe("unlogged-test-secret");
      }
      expect(JSON.stringify(audit.events)).not.toContain("unlogged-test-secret");
      expect(audit.events.some((event) => "outcome" in event && event.outcome === "denied")).toBe(true);
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });
  it("binds an exact owner opt-in to one workspace and revokes it on a fresh immutable Core", async () => {
    const dirs = await makeTempDirs();
    const config = {
      workspace: { root: dirs.workspace },
      permissions: { mode: "full_control", projectSecrets: { allow: [{ workspace: dirs.workspace, path: ".env" }] } },
    };
    let core = await createTestCore(config);
    try {
      await writeFile(path.join(dirs.workspace, ".env"), "approved");
      await writeFile(path.join(dirs.workspace, ".env.local"), "not-approved");
      expect((await core.filesystem.readFile(testContext, { path: ".env" })).content).toBe("approved");
      await expect(core.filesystem.readFile(testContext, { path: ".env.local" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await core.shutdown();
      core = await createTestCore({ ...config, workspace: { root: dirs.outside } });
      await writeFile(path.join(dirs.outside, ".env"), "other-project");
      await expect(core.filesystem.readFile(testContext, { path: ".env" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await core.shutdown();
      core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
      await expect(core.filesystem.readFile(testContext, { path: ".env" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });
  it("does not let an owner file opt-in override capability denial or CROT service-secret protection", async () => {
    const dirs = await makeTempDirs(),
      secret = path.join(dirs.workspace, ".env");
    await writeFile(secret, "service-secret");
    const permissions = {
      mode: "full_control",
      projectSecrets: { allow: [{ workspace: dirs.workspace, path: ".env" }] },
    };
    const restricted = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { ...permissions, capabilities: [] },
    });
    const protectedCore = await createTestCore({ workspace: { root: dirs.workspace }, permissions }, undefined, {
      secretPaths: [secret],
    });
    try {
      await expect(restricted.filesystem.readFile(testContext, { path: ".env" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(protectedCore.filesystem.readFile(testContext, { path: ".env" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    } finally {
      await restricted.shutdown();
      await protectedCore.shutdown();
      await dirs.cleanup();
    }
  });
  it.runIf(process.platform !== "win32")("denies a benign-named symlink resolving to a project secret", async () => {
    const dirs = await makeTempDirs();
    const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    try {
      await writeFile(path.join(dirs.workspace, ".env"), "secret");
      await symlink(".env", path.join(dirs.workspace, "innocent.txt"));
      await expect(core.filesystem.readFile(testContext, { path: "innocent.txt" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });
  it.runIf(process.platform !== "win32")("refuses an owner grant that silently follows a secret symlink", async () => {
    const dirs = await makeTempDirs();
    try {
      await writeFile(path.join(dirs.workspace, "other.pem"), "private");
      await symlink("other.pem", path.join(dirs.workspace, ".env"));
      await expect(
        createTestCore({
          workspace: { root: dirs.workspace },
          permissions: {
            mode: "full_control",
            projectSecrets: { allow: [{ workspace: dirs.workspace, path: ".env" }] },
          },
        }),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    } finally {
      await dirs.cleanup();
    }
  });
});
