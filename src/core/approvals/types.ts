import type { Principal, PrincipalKind } from "../auth/principal.js";
import type { Capability } from "../permissions/capabilities.js";
import type { PermissionMode } from "../permissions/policy.js";

/**
 * Approval gates (ARCHITECTURE.md §21, §27 AD-5 … AD-11; docs/design/approval-gates.md).
 *
 * An approval gate suspends an operation the PermissionEngine has already
 * authorized until the local user decides. It can only narrow: every outcome
 * other than `approved` denies the operation, and an approval never grants a
 * capability, a path or a network destination.
 */

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "cancelled", "unavailable"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type TerminalApprovalStatus = Exclude<ApprovalStatus, "pending">;

/** Why a request was cancelled (`cancelled`) or never queued (`unavailable`). */
export type ApprovalCancelReason = "caller_aborted" | "shutdown" | "provider_gone" | "no_provider" | "queue_full";

export type ApprovalRuleId = string;

/** A gate rule: an operation needs approval when every given condition matches. */
export interface ApprovalRule {
  readonly id: ApprovalRuleId;
  readonly match: {
    readonly operations?: readonly string[];
    /** Matches when the operation requires any of these capabilities. */
    readonly capabilities?: readonly Capability[];
    readonly principalKinds?: readonly PrincipalKind[];
    readonly modes?: readonly PermissionMode[];
    /** true: some path is outside the workspace; false: every path is inside. */
    readonly outsideWorkspace?: boolean;
    /** The session's exposure state (AD-12): true after it read untrusted content. */
    readonly exposed?: boolean;
  };
}

export type ApprovalRequirement =
  { readonly required: false } | { readonly required: true; readonly rule: ApprovalRuleId; readonly timeoutMs: number };

/** One structured item of what will be executed. Values are untrusted text; providers render them as plain text. */
export interface ApprovalEffect {
  readonly label: string;
  readonly value: string;
  /**
   * outside_workspace: a path outside the workspace; secret_size_only: only the
   * size of a secret value is shown; page_supplied: the value was supplied by a
   * web page (tab URL, title, element name) and must be shown as such (AD-16
   * point 16, AD-19 point 4).
   */
  readonly flag?: "outside_workspace" | "secret_size_only" | "page_supplied";
}

/**
 * Expected browser subject of a gated browser operation (AD-6, AD-8, AD-9,
 * AD-11): the concrete tab, its normalized http(s) origin and the browser
 * connection, recorded when the request is created and checked again
 * immediately before the action.
 */
export interface ApprovalBrowserSubject {
  /** Absent only for browser.tab_open (bound to the origin of the URL it opens). */
  readonly tabId?: number;
  readonly origin: string;
  readonly connectionId: string;
}

/** Facts a service binds the operation to before the request is created (browser: tabs.resolve). */
export interface ApprovalBinding {
  readonly browser?: ApprovalBrowserSubject;
  readonly effects?: readonly ApprovalEffect[];
}

/**
 * What a capability service adds to an OperationDescriptor for the approval
 * subject. Optional, never audited. Without it Core describes the operation
 * from its audit-safe details, paths and network destinations.
 */
export interface ApprovalSubjectInput {
  /** Fixed template per operation, never agent text. */
  readonly summary: string;
  readonly effects: readonly ApprovalEffect[];
  /**
   * Called only for gated operations, after authorization and before the
   * request is created. A failure (or a result Core cannot use) denies the
   * operation without creating a request.
   */
  readonly bind?: () => Promise<ApprovalBinding>;
  /** Re-check after approval that resolved paths/targets are unchanged; false denies. */
  readonly revalidate?: () => Promise<boolean>;
}

/** The immutable, Core-generated description of what runs if the user approves it. */
export interface ApprovalSubject {
  readonly operation: string;
  readonly capabilities: readonly Capability[];
  readonly summary: string;
  readonly effects: readonly ApprovalEffect[];
  readonly paths: readonly { readonly absolute: string; readonly insideWorkspace: boolean }[];
  readonly network: readonly { readonly scheme: string; readonly host: string; readonly port: number }[];
  /** `client` is self-reported and must be marked as such by providers. */
  readonly principal: Principal;
  readonly mode: PermissionMode;
  readonly rule: ApprovalRuleId;
  readonly browser?: ApprovalBrowserSubject;
}

export interface PresentedApproval {
  readonly requestId: string;
  readonly subject: ApprovalSubject;
  readonly subjectDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type DecideResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "not_pending" | "digest_mismatch" };

/** The per-request handle a provider decides with. The only way to decide a request. */
export interface ApprovalTicket {
  readonly requestId: string;
  approve(subjectDigest: string): DecideResult;
  reject(): DecideResult;
}

/**
 * A UI that asks the local user (implemented outside Core, e.g. the tray app).
 * Registered only in the composition root (CrotCoreOptions.approvalProviders).
 * A provider must never decide automatically.
 */
export interface ApprovalProvider {
  readonly id: string;
  readonly channel: "local-ui";
  present(request: PresentedApproval, ticket: ApprovalTicket): void;
  resolved(requestId: string, status: TerminalApprovalStatus): void;
}

export interface ApprovalOutcome {
  readonly requestId: string;
  readonly status: TerminalApprovalStatus;
  readonly subjectDigest: string;
  readonly requestedAt: string;
  readonly resolvedAt: string;
  readonly provider?: { readonly id: string; readonly channel: string };
  readonly cancelReason?: ApprovalCancelReason;
}

/** The `approval` block of an audit event (never contains the subject itself). */
export interface AuditApproval {
  readonly requestId: string;
  readonly status: TerminalApprovalStatus;
  readonly rule: ApprovalRuleId;
  readonly subjectDigest: string;
  readonly requestedAt: string;
  readonly resolvedAt: string;
  readonly waitMs: number;
  readonly provider?: { readonly id: string; readonly channel: string };
  readonly cancelReason?: ApprovalCancelReason;
  /** Approved, but denied after the approval (re-authorization, revalidation, browser binding, audit). */
  readonly reauthorization?: string;
}
