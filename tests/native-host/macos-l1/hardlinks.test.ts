import { mkdtemp, mkdir, writeFile, link, symlink, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import {
  inspectProtected,
  workspaceHardlinks,
  projectSecretTargets,
} from "../../../src/native-host/macos-l1/hardlinks.js";
describe.runIf(process.platform !== "win32")("macOS hardlink identity preflight", () => {
  it("keeps workspace multilinks read-only and refuses multiply named secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-mac-links-"));
    try {
      const w = path.join(root, "w"),
        s = path.join(root, "s");
      await mkdir(w);
      await mkdir(s);
      const file = path.join(root, "outside");
      await writeFile(file, "public");
      await link(file, path.join(w, "alias"));
      expect(await workspaceHardlinks(w)).toEqual([path.join(w, "alias")]);
      const internal = path.join(w, "internal");
      await writeFile(internal, "allowed");
      await link(internal, path.join(w, "internal-alias"));
      expect(await workspaceHardlinks(w)).toEqual([path.join(w, "alias")]);
      const secret = path.join(s, "secret");
      await writeFile(secret, "private");
      await link(secret, path.join(root, "secret-alias"));
      await expect(inspectProtected([s])).rejects.toThrow("multiple names");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("resolves nested protected symlinks without following workspace symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-mac-alias-"));
    try {
      const s = path.join(root, "s"),
        external = path.join(root, "external");
      await mkdir(s);
      await writeFile(external, "secret");
      await symlink(external, path.join(s, "alias"));
      expect(await inspectProtected([s])).toContain(await realpath(external));
      expect(await workspaceHardlinks(s)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("collects named secrets and sensitive symlink targets, and refuses pre-existing aliases", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-project-links-")));
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const secret = path.join(workspace, ".env"),
        approved = path.join(workspace, "approved.key");
      await writeFile(secret, "private");
      await writeFile(approved, "opt-in");
      const external = path.join(root, "external");
      await writeFile(external, "private-target");
      await symlink(external, path.join(workspace, "server.pem"));
      const targets = await projectSecretTargets(workspace, [approved]);
      expect(targets).toContain(secret);
      expect(targets).toContain(external);
      expect(targets).not.toContain(approved);
      await link(secret, path.join(workspace, "innocent.txt"));
      await expect(projectSecretTargets(workspace, [approved])).rejects.toThrow("multiple names");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
