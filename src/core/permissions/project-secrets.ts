/** Project-file policy, not a substitute for native child-process confinement. */
import { z } from "zod";
import { CrotError } from "../errors.js";
import type { ResolvedPath, Workspace } from "../workspace/workspace.js";

export const isProjectSecretName = (name: string): boolean => /^(?:\.env(?:\..*)?|.*\.(?:pem|key))$/i.test(name);
export const ProjectSecretRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    const parts = value.split("/");
    return (
      !/[\\\x00-\x1f\x7f:*?"<>|]/.test(value) &&
      parts.every((part) => part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part)) &&
      isProjectSecretName(parts.at(-1)!) &&
      !parts.slice(0, -1).some(isProjectSecretName)
    );
  }, "Use an exact project-relative secret filename, not a directory, wildcard or traversal");
export const ProjectSecretAccessSchema = z
  .object({
    allow: z
      .array(
        z
          .object({
            workspace: z
              .string()
              .min(1)
              .max(4096)
              .regex(/^[^\x00-\x1f\x7f]+$/),
            path: ProjectSecretRelativePathSchema,
          })
          .strict(),
      )
      .max(256)
      .default([]),
  })
  .strict();
export type ProjectSecretAccess = z.infer<typeof ProjectSecretAccessSchema>;

/** Immutable exact-file opt-ins for one canonical workspace, shared with native policy compilers. */
export class ProjectSecretPolicy {
  private constructor(
    private readonly workspace: Workspace,
    readonly allowedPaths: readonly string[],
  ) {}
  static async create(workspace: Workspace, input: ProjectSecretAccess): Promise<ProjectSecretPolicy> {
    const parsed = ProjectSecretAccessSchema.parse(input);
    const allowed = new Set<string>();
    for (const grant of parsed.allow) {
      workspace.rules.validate(grant.workspace);
      if (!workspace.rules.isAbsolute(grant.workspace))
        throw new CrotError("CONFIG_ERROR", "Secret access workspace must be absolute");
      // Exact canonical workspace only; changing projects never transfers a relative grant.
      if (!workspace.contains(workspace.root, grant.workspace) || !workspace.contains(grant.workspace, workspace.root))
        continue;
      const target = await workspace.resolve(grant.path, { followFinalSymlink: false });
      if (!target.insideWorkspace)
        throw new CrotError("CONFIG_ERROR", "Secret access target must belong to its workspace");
      const followed = await workspace.resolve(grant.path);
      if (!workspace.rules.equals(target.absolute, followed.absolute, workspace.caseSensitive))
        throw new CrotError("CONFIG_ERROR", "Secret access must name a file, not a symbolic link");
      allowed.add(target.absolute);
    }
    return new ProjectSecretPolicy(workspace, Object.freeze([...allowed]));
  }
  denies(target: ResolvedPath): boolean {
    return (
      target.insideWorkspace &&
      target.relative !== null &&
      target.relative.split("/").some(isProjectSecretName) &&
      !this.allowedPaths.some(
        (allowed) =>
          this.workspace.contains(allowed, target.absolute) && this.workspace.contains(target.absolute, allowed),
      )
    );
  }
}
