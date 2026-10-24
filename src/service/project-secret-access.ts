/** Owner-only immutable Core policy storage. No file contents or credentials are stored. */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CrotError } from "../core/errors.js";
import { ProjectSecretAccessSchema, type ProjectSecretAccess } from "../core/permissions/project-secrets.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { writePrivateFileAtomic } from "./secrets/backends.js";
const fileSchema = z
  .object({ version: z.literal(1), policy: ProjectSecretAccessSchema, pending: ProjectSecretAccessSchema.optional() })
  .strict();
export const projectSecretAccessPath = (dir: string) => path.join(dir, "project-secret-access.json");
export class ProjectSecretAccessStore {
  private current: ProjectSecretAccess;
  private pending = false;
  private constructor(
    private readonly file: string,
    private readonly protection: PrivateFileProtection,
    initial: ProjectSecretAccess,
  ) {
    this.current = initial;
  }
  static async open(
    file: string,
    protection: PrivateFileProtection,
    baseline: ProjectSecretAccess,
  ): Promise<ProjectSecretAccessStore> {
    const store = new ProjectSecretAccessStore(file, protection, ProjectSecretAccessSchema.parse(baseline));
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 256 * 1024)
        throw new CrotError("CONFIG_ERROR", "Invalid project secret access file");
      await protection.protectFile?.(file);
      if ((await protection.inspect(file)).ownerOnly === false)
        throw new CrotError("CONFIG_ERROR", "Project secret access state is not private");
      const value = fileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      // Never restore a widening or an old grant after a crash during revocation.
      store.current = value.pending ? { allow: [] } : value.policy;
      if (value.pending) await store.commit({ allow: [] });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }
  get policy(): ProjectSecretAccess {
    return structuredClone(this.pending ? { allow: [] } : this.current);
  }
  async stage(next: ProjectSecretAccess): Promise<void> {
    const parsed = ProjectSecretAccessSchema.parse(next);
    await writePrivateFileAtomic(
      this.file,
      JSON.stringify({ version: 1, policy: { allow: [] }, pending: parsed }),
      this.protection,
    );
    this.pending = true;
  }
  async commit(next: ProjectSecretAccess): Promise<void> {
    const parsed = ProjectSecretAccessSchema.parse(next);
    await writePrivateFileAtomic(this.file, JSON.stringify({ version: 1, policy: parsed }), this.protection);
    this.current = parsed;
    this.pending = false;
  }
}
