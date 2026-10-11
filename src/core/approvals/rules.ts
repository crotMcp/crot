import type { AuthContext } from "../auth/principal.js";
import { CrotError } from "../errors.js";
import type { Capability } from "../permissions/capabilities.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import { RESERVED_RULE_IDS } from "./exposure.js";
import { KNOWN_OPERATIONS } from "./operations.js";
import type { ApprovalRule } from "./types.js";

/** Default time a request stays pending (AD-10). Below the common MCP client request timeout of 60 s. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 45_000;
/** Upper bound of permissions.approvals.timeoutMs (AD-10). */
export const MAX_APPROVAL_TIMEOUT_MS = 300_000;
/** Default bound of the pending-request queue (AD-10). */
export const DEFAULT_APPROVAL_MAX_PENDING = 8;

const KNOWN: ReadonlySet<string> = new Set(KNOWN_OPERATIONS);

/**
 * Startup validation of gate rules against the immutable policy. Unknown
 * operation names, duplicate ids and rules that can never match are a
 * CONFIG_ERROR (docs/design/approval-gates.md §5).
 */
export function validateApprovalRules(rules: readonly ApprovalRule[], policy: PermissionPolicy): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    const where = `permissions.approvals.rules: rule '${rule.id}'`;
    if (rule.id.trim().length === 0) throw new CrotError("CONFIG_ERROR", "permissions.approvals.rules: empty rule id.");
    if (RESERVED_RULE_IDS.includes(rule.id))
      throw new CrotError(
        "CONFIG_ERROR",
        `${where}: the id '${rule.id}' is reserved for a built-in rule ` +
          "(permissions.approvals.untrustedContent, remote full-control).",
      );
    if (ids.has(rule.id)) throw new CrotError("CONFIG_ERROR", `${where} is defined more than once.`);
    ids.add(rule.id);
    const m = rule.match;
    for (const key of ["operations", "capabilities", "principalKinds", "modes"] as const) {
      if (m[key] !== undefined && m[key].length === 0)
        throw new CrotError("CONFIG_ERROR", `${where}: '${key}' is empty and can never match.`);
    }
    const unknown = (m.operations ?? []).filter((op) => !KNOWN.has(op));
    if (unknown.length > 0)
      throw new CrotError("CONFIG_ERROR", `${where}: unknown operation(s): ${unknown.join(", ")}.`);
    if (m.modes !== undefined && !m.modes.includes(policy.mode))
      throw new CrotError("CONFIG_ERROR", `${where} can never match: the permission mode is '${policy.mode}'.`);
    if (m.capabilities !== undefined && !m.capabilities.some((c) => policy.grants.has(c)))
      throw new CrotError(
        "CONFIG_ERROR",
        `${where} can never match: none of its capabilities is granted (${m.capabilities.join(", ")}).`,
      );
    if (m.outsideWorkspace === true && !policy.grants.has("filesystem.full"))
      throw new CrotError(
        "CONFIG_ERROR",
        `${where} can never match: paths outside the workspace require 'filesystem.full', which is not granted.`,
      );
  }
}

export interface ApprovalFacts {
  readonly context: AuthContext;
  readonly operation: string;
  readonly capabilities: readonly Capability[];
  readonly paths: readonly ResolvedPath[];
  readonly mode: PermissionPolicy["mode"];
  /** Whether the session has read untrusted content (AD-12). */
  readonly exposed: boolean;
}

/** Whether every condition of the rule holds. Uses only facts Core knows (never principal.client). */
export function ruleMatches(rule: ApprovalRule, facts: ApprovalFacts): boolean {
  const m = rule.match;
  if (m.operations !== undefined && !m.operations.includes(facts.operation)) return false;
  if (m.capabilities !== undefined && !facts.capabilities.some((c) => m.capabilities?.includes(c))) return false;
  if (m.principalKinds !== undefined && !m.principalKinds.includes(facts.context.principal.kind)) return false;
  if (m.modes !== undefined && !m.modes.includes(facts.mode)) return false;
  if (m.exposed !== undefined && m.exposed !== facts.exposed) return false;
  if (m.outsideWorkspace !== undefined) {
    const outside = facts.paths.some((p) => !p.insideWorkspace);
    if (outside !== m.outsideWorkspace) return false;
  }
  return true;
}
