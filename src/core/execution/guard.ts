import type { AuthContext } from "../auth/principal.js";
import { PermissionDeniedError } from "../errors.js";
import type { Capability } from "../permissions/capabilities.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { ResolvedPath } from "../workspace/workspace.js";

/** Description of one Core operation, used for authorization. */
export interface OperationDescriptor {
  /** Stable operation name, e.g. "filesystem.read_file". */
  readonly operation: string;
  readonly capability: Capability;
  /** Every path the operation touches (targets, working directories). */
  readonly paths?: readonly ResolvedPath[];
}

/**
 * The execution pipeline every Core operation passes through:
 * authorize (PermissionEngine) -> execute.
 *
 * Capability services never call the operating system before the guard has
 * authorized the operation.
 */
export class ExecutionGuard {
  constructor(private readonly engine: PermissionEngine) {}

  async run<T>(context: AuthContext, op: OperationDescriptor, execute: () => Promise<T>): Promise<T> {
    const decision = this.engine.authorize({ context, capability: op.capability, paths: op.paths ?? [] });
    if (!decision.allowed) {
      throw new PermissionDeniedError(decision.reason, { operation: op.operation, missing: decision.missing });
    }
    return execute();
  }
}
