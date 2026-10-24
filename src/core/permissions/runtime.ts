/** Owner configuration consumed only by PermissionEngine; never a separate authorizer. */
import { z } from "zod";
import { CapabilitySchema } from "./capabilities.js";

export const ProjectGrantSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\0\r\n]+$/),
    operation: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/),
  })
  .strict();

export const RuntimePolicySchema = z
  .object({
    strict: z.boolean(),
    projectGrants: z.array(ProjectGrantSchema).max(256).optional(),
    rules: z
      .array(
        z
          .object({
            operation: z
              .string()
              .regex(/^[a-z][a-z0-9_.]{0,127}$/)
              .optional(),
            capability: CapabilitySchema.optional(),
            state: z.enum(["allow", "ask", "deny"]),
          })
          .strict()
          .refine((r) => Boolean(r.operation) !== Boolean(r.capability), "Specify one operation or capability"),
      )
      .max(256),
  })
  .strict()
  .refine((p) => {
    const keys = p.rules.map((r) => (r.operation ? `op:${r.operation}` : `cap:${r.capability}`));
    const grants = (p.projectGrants ?? []).map((g) => JSON.stringify([g.workspace, g.operation]));
    return new Set(keys).size === keys.length && new Set(grants).size === grants.length;
  }, "Duplicate runtime policy rule");
export type RuntimePolicy = z.infer<typeof RuntimePolicySchema>;

/** Shared across Core replacements. Emergency stop cannot be reset by policy changes. */
export class RuntimePermissionState {
  private current: RuntimePolicy = { strict: false, rules: [] };
  private stopped = false;
  get halted(): boolean {
    return this.stopped;
  }
  stop(): void {
    this.stopped = true;
  }
  get policy(): RuntimePolicy {
    return structuredClone(this.current);
  }
  replace(input: unknown): void {
    const parsed = RuntimePolicySchema.parse(input);
    this.current = parsed;
  }
}
