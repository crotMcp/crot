import type { AuthContext } from "../auth/principal.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import type { Capability } from "./capabilities.js";
import type { PermissionPolicy } from "./policy.js";

/**
 * A request to perform an operation that needs `capability`, touching the given
 * resolved paths (target files, working directories, ...).
 */
export interface AuthorizationRequest {
  readonly context: AuthContext;
  readonly capability: Capability;
  readonly paths?: readonly ResolvedPath[];
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly missing: readonly Capability[] };

/**
 * The single authorization mechanism of CROT. Every Core operation is
 * authorized here; no other component makes permission decisions.
 *
 * Rules:
 * 1. The requested capability must be granted by the policy.
 * 2. Any path outside the workspace additionally requires `filesystem.full`
 *    (never grantable in sandbox mode).
 */
export class PermissionEngine {
  constructor(private readonly policy: PermissionPolicy) {}

  get mode() {
    return this.policy.mode;
  }

  get grantedCapabilities(): readonly Capability[] {
    return [...this.policy.grants];
  }

  isGranted(capability: Capability): boolean {
    return this.policy.grants.has(capability);
  }

  authorize(request: AuthorizationRequest): AuthorizationDecision {
    if (!this.policy.grants.has(request.capability)) {
      return {
        allowed: false,
        reason: `Capability '${request.capability}' is not granted (mode: ${this.policy.mode}).`,
        missing: [request.capability],
      };
    }
    const outside = (request.paths ?? []).filter((p) => !p.insideWorkspace);
    if (outside.length > 0 && !this.policy.grants.has("filesystem.full")) {
      return {
        allowed: false,
        reason:
          `Path outside the workspace requires 'filesystem.full' (mode: ${this.policy.mode}): ` +
          outside.map((p) => p.absolute).join(", "),
        missing: ["filesystem.full"],
      };
    }
    return { allowed: true };
  }
}
