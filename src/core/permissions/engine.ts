import { DEFAULT_APPROVAL_TIMEOUT_MS, ruleMatches, validateApprovalRules } from "../approvals/rules.js";
import type { ApprovalRequirement, ApprovalRule } from "../approvals/types.js";
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
  /**
   * Approval gate rules (permissions.approvals). Validated against the policy
   * here; an invalid rule is a CONFIG_ERROR. No rules: nothing is gated.
   */
  readonly approvals?: { readonly rules: readonly ApprovalRule[]; readonly timeoutMs?: number };
}

/** The facts approvalRequirement() evaluates (a subset of an OperationDescriptor). */
export interface ApprovalRequirementRequest {
  readonly operation: string;
  readonly capabilities: readonly Capability[];
  readonly paths?: readonly ResolvedPath[];
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
  private readonly approvalRules: readonly ApprovalRule[];
  private readonly approvalTimeoutMs: number;

  constructor(
    private readonly policy: PermissionPolicy,
    options: PermissionEngineOptions = {},
  ) {
    this.protectedPaths = options.protectedPaths ?? [];
    this.contains = options.contains ?? ((a, c) => a === c || c.startsWith(a.endsWith("/") ? a : `${a}/`));
    this.networkPolicy = options.network ?? NetworkPolicy.denyAll();
    const rules = options.approvals?.rules ?? [];
    validateApprovalRules(rules, policy);
    this.approvalRules = Object.freeze(rules.map((r) => Object.freeze({ ...r, match: Object.freeze({ ...r.match }) })));
    this.approvalTimeoutMs = options.approvals?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /** Configured gate rules (immutable). */
  get approvals(): { readonly rules: readonly ApprovalRule[]; readonly timeoutMs: number } {
    return { rules: this.approvalRules, timeoutMs: this.approvalTimeoutMs };
  }

  /**
   * Whether an operation that authorize() allowed needs the user's approval
   * (docs/design/approval-gates.md §5). Pure; the first matching rule wins.
   * It can only add a gate, never allow anything authorize() denied.
   */
  approvalRequirement(context: AuthContext, request: ApprovalRequirementRequest): ApprovalRequirement {
    const facts = {
      context,
      operation: request.operation,
      capabilities: request.capabilities,
      paths: request.paths ?? [],
      mode: this.policy.mode,
    };
    const rule = this.approvalRules.find((r) => ruleMatches(r, facts));
    return rule ? { required: true, rule: rule.id, timeoutMs: this.approvalTimeoutMs } : { required: false };
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
