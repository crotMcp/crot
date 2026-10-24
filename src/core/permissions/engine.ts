import type { ProjectSecretPolicy } from "./project-secrets.js";
import { RuntimePermissionState } from "./runtime.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, ruleMatches, validateApprovalRules } from "../approvals/rules.js";
import { presetRules, REMOTE_FULL_CONTROL_RULES, type UntrustedContentSetting } from "../approvals/exposure.js";
import type { ApprovalRequirement, ApprovalRule } from "../approvals/types.js";
import type { AuthContext } from "../auth/principal.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import type { Capability } from "./capabilities.js";
import { NetworkPolicy, type NetworkTarget } from "./network/policy.js";
import { SANDBOX_FORBIDDEN_CAPABILITIES, type PermissionMode, type PermissionPolicy } from "./policy.js";

/**
 * A request to perform an operation that needs `capability`, touching the given
 * resolved paths (target files, working directories, ...).
 */
export interface AuthorizationRequest {
  readonly operation?: string;
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

/** The device a remote full-control opt-in is bound to (WP-31): the paired device of this service. */
export interface RemoteFullControlBinding {
  readonly deviceId: string;
  /** The paired account; when given, the principal's account must match too. */
  readonly accountId?: string;
}

/** How remote principals are authorized (WP-31). Every field is optional; the defaults are the safe ones. */
export interface RemoteProfileOptions {
  /**
   * The user's remote full-control opt-in, bound to one device. Absent (the
   * default): remote principals stay in the remote default profile.
   */
  readonly fullControl?: RemoteFullControlBinding;
}

/** The effective remote profile, for crot_status and the tray (WP-31). */
export interface RemoteProfileSummary {
  /** Permission mode of remote principals without an effective full-control opt-in. */
  readonly mode: PermissionMode;
  readonly capabilities: readonly Capability[];
  /** The preset applied to remote principals (never "off"). */
  readonly untrustedContent: UntrustedContentSetting;
  readonly fullControl: {
    readonly enabled: boolean;
    readonly deviceId?: string;
    readonly accountId?: string;
    readonly capabilities?: readonly Capability[];
  };
  readonly restrictions: readonly string[];
}

export interface PermissionEngineOptions {
  /** Canonical Core workspace, never a request-supplied project identifier. */
  readonly workspaceRoot?: string;
  readonly projectSecrets?: ProjectSecretPolicy;
  readonly runtime?: RuntimePermissionState;
  /**
   * Paths CROT itself depends on (audit log, configuration). Write operations
   * on them, or on any ancestor (delete/move of a parent), are always denied.
   */
  readonly protectedPaths?: readonly string[];
  /**
   * Paths holding CROT secrets (AD-18). No operation of any capability may
   * touch them or anything inside them, in any mode; write operations on an
   * ancestor are denied through protectedPaths.
   */
  readonly secretPaths?: readonly string[];
  /** Path containment using the workspace's platform semantics. */
  readonly contains?: (ancestor: string, candidate: string) => boolean;
  /** Host policy of network.access. Defaults to a policy that refuses every destination. */
  readonly network?: NetworkPolicy;
  /**
   * Approval gate rules (permissions.approvals). Validated against the policy
   * here; an invalid rule is a CONFIG_ERROR. No rules: nothing is gated.
   */
  readonly approvals?: {
    readonly rules: readonly ApprovalRule[];
    readonly timeoutMs?: number;
    /** The preset of the built-in rules (AD-12, WP-31). Default: "require-approval". */
    readonly untrustedContent?: UntrustedContentSetting;
  };
  /** Remote principals (WP-31). Without it remote principals get the remote default profile. */
  readonly remote?: RemoteProfileOptions;
}

/** The facts approvalRequirement() evaluates (a subset of an OperationDescriptor). */
export interface ApprovalRequirementRequest {
  readonly operation: string;
  readonly capabilities: readonly Capability[];
  readonly paths?: readonly ResolvedPath[];
  /** The session's exposure state, computed by Core (ExposureTracker). Default false. */
  readonly exposed?: boolean;
}

/**
 * Capabilities whose operations modify the filesystem. git.write modifies Git
 * metadata and the worktree (ARCHITECTURE.md §27, AD-2), so a git.write
 * operation whose paths contain a protected path is denied.
 */
const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["filesystem.write", "git.write"]);

/**
 * Capabilities whose remote default is decided (ARCHITECTURE.md §27, AD-23
 * point 4). Remote principals get at most these, intersected with the
 * configured grants; filesystem.full is never among them
 * (SANDBOX_FORBIDDEN_CAPABILITIES) and only the full-control opt-in adds it.
 * A capability added to CAPABILITIES later is denied to every remote principal
 * until its remote default is decided and it is listed here
 * (tests/core/remote-capabilities.test.ts fails until then).
 */
export const REMOTE_DEFAULT_CAPABILITIES: readonly Capability[] = [
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "process.manage",
  "git.read",
  "git.write",
  "docker.use",
  "browser.read",
  "browser.control",
  "network.access",
];

const REMOTE_DEFAULT_SET: ReadonlySet<Capability> = new Set<Capability>(REMOTE_DEFAULT_CAPABILITIES);

/** The configured capabilities that may reach a remote principal (AD-23 point 4). */
function remoteGrants(policy: PermissionPolicy): Capability[] {
  return [...policy.grants].filter((c) => REMOTE_DEFAULT_SET.has(c) && !SANDBOX_FORBIDDEN_CAPABILITIES.includes(c));
}

/** One permission profile: the policy, preset and gate rules a principal is evaluated with. */
interface Profile {
  readonly policy: PermissionPolicy;
  readonly untrustedContent: UntrustedContentSetting;
  /** Built-in rules first, then user rules; the first match wins. */
  readonly rules: readonly ApprovalRule[];
}

/**
 * The single authorization mechanism of CROT. Every Core operation is
 * authorized here; no other component makes permission decisions.
 *
 * Rules:
 * 1. The requested capability must be granted by the policy of the
 *    principal's profile.
 * 2. Any path outside the workspace additionally requires `filesystem.full`
 *    (never grantable in sandbox mode).
 * 3. Write operations never touch CROT's protected paths (audit log,
 *    configuration), in any mode; no operation at all touches a path holding
 *    CROT secrets (AD-18), in any mode.
 * 4. Network destinations are only authorized for `network.access`
 *    operations, and every destination must pass the network policy (host
 *    allow/deny rules, non-public addresses only by explicit IP/CIDR rules;
 *    ARCHITECTURE.md §27, AD-4). No other capability grants network access.
 *
 * Profiles (WP-31; one engine, one rule language):
 * - local principals: the configured policy and preset, unchanged;
 * - remote principals: sandbox mode (the workspace only, never
 *   filesystem.full), the configured capabilities that have a decided remote
 *   default (REMOTE_DEFAULT_CAPABILITIES), and the preset with
 *   untrusted-content protection always on ("off" becomes "require-approval");
 * - remote principals of the device bound by the user's full-control opt-in:
 *   full_control with the same capabilities plus filesystem.full, the same
 *   preset, and their shell commands always need approval.
 */
export class PermissionEngine {
  readonly runtime: RuntimePermissionState;
  readonly workspaceRoot: string | undefined;
  private readonly protectedPaths: readonly string[];
  private readonly secretPaths: readonly string[];
  private readonly projectSecrets: ProjectSecretPolicy | undefined;
  private readonly contains: (ancestor: string, candidate: string) => boolean;
  private readonly networkPolicy: NetworkPolicy;
  private readonly approvalRules: readonly ApprovalRule[];
  private readonly approvalTimeoutMs: number;
  private readonly untrustedContent: UntrustedContentSetting;
  private readonly localProfile: Profile;
  private readonly tokenProfile: Profile;
  private readonly remoteDefault: Profile;
  private readonly remoteFullControl: Profile | undefined;
  private readonly fullControlBinding: RemoteFullControlBinding | undefined;

  constructor(
    private readonly policy: PermissionPolicy,
    options: PermissionEngineOptions = {},
  ) {
    this.runtime = options.runtime ?? new RuntimePermissionState();
    this.workspaceRoot = options.workspaceRoot;
    this.protectedPaths = options.protectedPaths ?? [];
    this.secretPaths = options.secretPaths ?? [];
    this.projectSecrets = options.projectSecrets;
    this.contains = options.contains ?? ((a, c) => a === c || c.startsWith(a.endsWith("/") ? a : `${a}/`));
    this.networkPolicy = options.network ?? NetworkPolicy.denyAll();
    const rules = options.approvals?.rules ?? [];
    validateApprovalRules(rules, policy);
    this.approvalRules = Object.freeze(rules.map((r) => Object.freeze({ ...r, match: Object.freeze({ ...r.match }) })));
    this.approvalTimeoutMs = options.approvals?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.untrustedContent = options.approvals?.untrustedContent ?? "require-approval";
    // Built-in rules are not validated against the policy: a capability that is
    // not granted is simply never authorized, so the rule never fires for it.
    this.localProfile = this.profile(policy, this.untrustedContent);
    this.tokenProfile = this.profile(
      Object.freeze({
        mode: "sandbox" as const,
        grants: new Set<Capability>([...policy.grants].filter((c) => c !== "filesystem.full")),
      }),
      this.untrustedContent === "off" ? "require-approval" : this.untrustedContent,
    );
    const remoteSetting: UntrustedContentSetting =
      this.untrustedContent === "off" ? "require-approval" : this.untrustedContent;
    this.remoteDefault = this.profile(
      Object.freeze({
        mode: "sandbox" as const,
        grants: new Set<Capability>(remoteGrants(policy)),
      }),
      remoteSetting,
    );
    const binding = options.remote?.fullControl;
    if (binding && binding.deviceId.length > 0 && (binding.accountId === undefined || binding.accountId.length > 0)) {
      this.fullControlBinding = Object.freeze({
        deviceId: binding.deviceId,
        ...(binding.accountId !== undefined ? { accountId: binding.accountId } : {}),
      });
      this.remoteFullControl = this.profile(
        Object.freeze({
          mode: "full_control" as const,
          grants: new Set<Capability>([...remoteGrants(policy), "filesystem.full"]),
        }),
        remoteSetting,
        REMOTE_FULL_CONTROL_RULES,
      );
    }
  }

  private profile(
    policy: PermissionPolicy,
    untrustedContent: UntrustedContentSetting,
    extra: readonly ApprovalRule[] = [],
  ): Profile {
    return Object.freeze({
      policy,
      untrustedContent,
      rules: Object.freeze([...extra, ...presetRules(untrustedContent), ...this.approvalRules]),
    });
  }

  /** The profile a principal is evaluated with. Only Core facts decide it (never principal.client). */
  private profileFor(context: AuthContext): Profile {
    const principal = context.principal;
    if (principal.tokenAccess) return this.tokenProfile;
    if (principal.kind !== "remote") return this.localProfile;
    const binding = this.fullControlBinding;
    if (
      this.remoteFullControl &&
      binding &&
      principal.deviceId === binding.deviceId &&
      (binding.accountId === undefined || principal.accountId === binding.accountId)
    )
      return this.remoteFullControl;
    return this.remoteDefault;
  }

  /** The permission mode a principal's operations run in. */
  modeFor(context: AuthContext): PermissionMode {
    return this.profileFor(context).policy.mode;
  }

  /** Configured gate rules (immutable) and the preset of local principals. */
  get approvals(): {
    readonly rules: readonly ApprovalRule[];
    readonly timeoutMs: number;
    readonly untrustedContent: UntrustedContentSetting;
  } {
    return { rules: this.approvalRules, timeoutMs: this.approvalTimeoutMs, untrustedContent: this.untrustedContent };
  }

  /** The effective remote profile (WP-31). */
  get remoteProfile(): RemoteProfileSummary {
    const d = this.remoteDefault;
    const fc = this.remoteFullControl;
    const binding = this.fullControlBinding;
    const restrictions = [
      "workspace only: paths outside the workspace are denied (filesystem.full is never granted)",
      `untrusted-content protection: ${d.untrustedContent}`,
      "shell and process operations need command confinement L1 and are refused where it is unavailable",
      ...(fc && binding
        ? [
            `full-control opt-in: only for remote clients of device ${binding.deviceId}; ` +
              "their shell commands always need approval; local clients are not affected",
          ]
        : []),
    ];
    return {
      mode: d.policy.mode,
      capabilities: [...d.policy.grants],
      untrustedContent: d.untrustedContent,
      fullControl:
        fc && binding
          ? {
              enabled: true,
              deviceId: binding.deviceId,
              ...(binding.accountId !== undefined ? { accountId: binding.accountId } : {}),
              capabilities: [...fc.policy.grants],
            }
          : { enabled: false },
      restrictions,
    };
  }

  /**
   * Whether an operation that authorize() allowed needs the user's approval
   * (docs/design/approval-gates.md §5). Pure; the first matching rule wins.
   * It can only add a gate, never allow anything authorize() denied.
   */
  approvalRequirement(context: AuthContext, request: ApprovalRequirementRequest): ApprovalRequirement {
    const profile = this.profileFor(context);
    const facts = {
      context,
      operation: request.operation,
      capabilities: request.capabilities,
      paths: request.paths ?? [],
      mode: profile.policy.mode,
      exposed: request.exposed ?? false,
    };
    // Runtime allow never suppresses mandatory exposure, remote or configured gates.
    const runtime = this.runtime.policy;
    const ask =
      runtime.strict ||
      (!(
        (request.paths ?? []).every((p) => p.insideWorkspace) &&
        runtime.projectGrants?.some((g) => g.workspace === this.workspaceRoot && g.operation === request.operation)
      ) &&
        runtime.rules.some(
          (r) =>
            r.state === "ask" &&
            (r.operation === request.operation ||
              (r.capability !== undefined && request.capabilities.includes(r.capability))),
        ));
    if (ask)
      return {
        required: true,
        rule: runtime.strict ? "runtime.strict" : "runtime.ask",
        timeoutMs: this.approvalTimeoutMs,
      };
    const rule = profile.rules.find((r) => ruleMatches(r, facts));
    return rule ? { required: true, rule: rule.id, timeoutMs: this.approvalTimeoutMs } : { required: false };
  }

  /** The host policy of network.access. */
  get network(): NetworkPolicy {
    return this.networkPolicy;
  }

  get protected(): readonly string[] {
    return this.protectedPaths;
  }

  get secrets(): readonly string[] {
    return this.secretPaths;
  }

  /** The secret path that `absolute` is or lies inside, if any. */
  secretPathOf(absolute: string): string | undefined {
    return this.secretPaths.find((secret) => this.contains(secret, absolute));
  }

  /** The configured (local) permission mode. */
  get mode(): PermissionMode {
    return this.policy.mode;
  }

  /** The configured (local) capabilities. */
  get grantedCapabilities(): readonly Capability[] {
    return [...this.policy.grants];
  }

  isGranted(capability: Capability): boolean {
    return this.policy.grants.has(capability);
  }

  authorize(request: AuthorizationRequest): AuthorizationDecision {
    if (this.runtime.halted)
      return { allowed: false, reason: "Emergency stop is active; restart the service to resume.", missing: [] };
    if (
      this.runtime.policy.rules.some(
        (r) =>
          r.state === "deny" &&
          ((request.operation !== undefined && r.operation === request.operation) ||
            r.capability === request.capability),
      )
    )
      return { allowed: false, reason: "Runtime policy denies this operation.", missing: [] };
    const token = request.context.principal.tokenAccess;
    if (token) {
      const scope =
        request.capability.startsWith("filesystem.") && request.capability !== "filesystem.full"
          ? "files"
          : ["shell.execute", "process.manage", "git.read", "git.write"].includes(request.capability)
            ? "terminal"
            : request.capability.startsWith("browser.")
              ? "browser"
              : undefined;
      if (!scope || !token.scopes.includes(scope))
        return {
          allowed: false,
          reason: "Client token scope does not permit this capability.",
          missing: [request.capability],
        };
    }
    const policy = this.profileFor(request.context).policy;
    const scope = request.context.principal.kind === "remote" ? ", remote client" : "";
    if (!policy.grants.has(request.capability)) {
      return {
        allowed: false,
        reason: `Capability '${request.capability}' is not granted (mode: ${policy.mode}${scope}).`,
        missing: [request.capability],
      };
    }
    const outside = (request.paths ?? []).filter((p) => !p.insideWorkspace);
    if (outside.length > 0 && !policy.grants.has("filesystem.full")) {
      return {
        allowed: false,
        reason:
          `Path outside the workspace requires 'filesystem.full' (mode: ${policy.mode}${scope}): ` +
          outside.map((p) => p.absolute).join(", "),
        missing: ["filesystem.full"],
      };
    }
    for (const p of request.paths ?? []) {
      const secret = this.secretPathOf(p.absolute);
      if (secret) {
        return {
          allowed: false,
          reason: `Path holds CROT secrets and is not accessible through CROT tools: ${secret}`,
          missing: [],
        };
      }
    }
    if ((request.paths ?? []).some((target) => this.projectSecrets?.denies(target)))
      return { allowed: false, reason: "Project secret file requires explicit owner file access.", missing: [] };
    if (
      (WRITE_CAPABILITIES.has(request.capability) || request.operation === "browser.file_upload") &&
      this.protectedPaths.length > 0
    ) {
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
