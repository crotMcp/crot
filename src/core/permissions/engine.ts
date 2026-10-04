import type { AuthContext } from "../auth/principal.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import type { Capability } from "./capabilities.js";
import { NetworkPolicy, type NetworkTarget } from "./network/policy.js";
import type { PermissionPolicy } from "./policy.js";

/**
 * A request to perform an operation that needs `capability`, touching the given
 * resolved paths (target files, working directories, ...).
 */
export interface AuthorizationRequest {
  readonly context: AuthContext;
  readonly capability: Capability;
  readonly paths?: readonly ResolvedPath[];
  /**
   * Network destinations of the operation (scheme, host, port and every
   * address the connection may use). Only `network.access` operations may
   * carry them; they are checked against the network policy.
   */
  readonly network?: readonly NetworkTarget[];
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly missing: readonly Capability[] };

export interface PermissionEngineOptions {
  /**
   * Paths CROT itself depends on (audit log, configuration). Write operations
   * on them, or on any ancestor (delete/move of a parent), are always denied.
   */
  readonly protectedPaths?: readonly string[];
  /** Path containment using the workspace's platform semantics. */
  readonly contains?: (ancestor: string, candidate: string) => boolean;
  /** Host policy of network.access. Defaults to a policy that refuses every destination. */
  readonly network?: NetworkPolicy;
}

/**
 * Capabilities whose operations modify the filesystem. git.write modifies Git
 * metadata and the worktree (ARCHITECTURE.md §27, AD-2), so a git.write
 * operation whose paths contain a protected path is denied.
 */
const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["filesystem.write", "git.write"]);

/**
 * The single authorization mechanism of CROT. Every Core operation is
 * authorized here; no other component makes permission decisions.
 *
 * Rules:
 * 1. The requested capability must be granted by the policy.
 * 2. Any path outside the workspace additionally requires `filesystem.full`
 *    (never grantable in sandbox mode).
 * 3. Write operations never touch CROT's protected paths (audit log,
 *    configuration), in any mode.
 * 4. Network destinations are only authorized for `network.access`
 *    operations, and every destination must pass the network policy (host
 *    allow/deny rules, non-public addresses only by explicit IP/CIDR rules;
 *    ARCHITECTURE.md §27, AD-4). No other capability grants network access.
 */
export class PermissionEngine {
  private readonly protectedPaths: readonly string[];
  private readonly contains: (ancestor: string, candidate: string) => boolean;
  private readonly networkPolicy: NetworkPolicy;

  constructor(
    private readonly policy: PermissionPolicy,
    options: PermissionEngineOptions = {},
  ) {
    this.protectedPaths = options.protectedPaths ?? [];
    this.contains = options.contains ?? ((a, c) => a === c || c.startsWith(a.endsWith("/") ? a : `${a}/`));
    this.networkPolicy = options.network ?? NetworkPolicy.denyAll();
  }

  /** The host policy of network.access. */
  get network(): NetworkPolicy {
    return this.networkPolicy;
  }

  get protected(): readonly string[] {
    return this.protectedPaths;
  }

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
    if (WRITE_CAPABILITIES.has(request.capability) && this.protectedPaths.length > 0) {
      for (const p of request.paths ?? []) {
        const hit = this.protectedPaths.find((guarded) => this.contains(p.absolute, guarded));
        if (hit) {
          return {
            allowed: false,
            reason: `Path is protected by CROT and cannot be modified through CROT tools: ${hit}`,
            missing: [],
          };
        }
      }
    }
    const targets = request.network ?? [];
    if (targets.length > 0) {
      if (request.capability !== "network.access") {
        return {
          allowed: false,
          reason: `Network destinations can only be authorized by 'network.access', not by '${request.capability}'.`,
          missing: ["network.access"],
        };
      }
      for (const target of targets) {
        const decision = this.networkPolicy.evaluate(target);
        if (!decision.allowed) return { allowed: false, reason: decision.reason, missing: [] };
      }
    }
    return { allowed: true };
  }
}
