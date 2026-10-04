import type { ApprovalBroker } from "../approvals/broker.js";
import { ExposureTracker, UNTRUSTED_CONTENT_MESSAGE, UNTRUSTED_CONTENT_RULE_ID } from "../approvals/exposure.js";
import { newApprovalRequestId, normalizedHttpOrigin, subjectDigest } from "../approvals/subject.js";
import type {
  ApprovalBinding,
  ApprovalEffect,
  ApprovalOutcome,
  ApprovalSubject,
  ApprovalSubjectInput,
  AuditApproval,
  TerminalApprovalStatus,
} from "../approvals/types.js";
import type { AuditEvent, AuditSink } from "../audit/audit.js";
import { newAuditEventId } from "../audit/audit.js";
import type { AuthContext } from "../auth/principal.js";
import { CrotError, PermissionDeniedError } from "../errors.js";
import type { Capability } from "../permissions/capabilities.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { NetworkTarget } from "../permissions/network/policy.js";
import type { ResolvedPath } from "../workspace/workspace.js";

/** Description of one Core operation, used for authorization and auditing. */
export interface OperationDescriptor {
  /** Stable operation name, e.g. "filesystem.read_file". */
  readonly operation: string;
  /** Capability, or capabilities that must all be granted. */
  readonly capability: Capability | readonly Capability[];
  /** Every path the operation touches (targets, working directories). */
  readonly paths?: readonly ResolvedPath[];
  /** Every network destination the operation contacts (network.access only). */
  readonly network?: readonly NetworkTarget[];
  /** Audit-safe summary of the operation. Never include file contents, output or secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Input for the approval subject, used only when a gate rule matches. There
   * is deliberately no opt-out: whether an operation is gated is decided by
   * the PermissionEngine policy, never by the service.
   */
  readonly approval?: ApprovalSubjectInput;
  /**
   * For the steps of one network_request call (network.resolve and
   * network.request, including redirect hops): the session's exposure state
   * when the call started, from ExecutionGuard.exposureSnapshot(). Honoured
   * only for those two operations, for the same session and until
   * endExposureSnapshot(); otherwise the current state is used. Marking is
   * unaffected.
   */
  readonly exposure?: ExposureSnapshot;
}

/** Operations that may be evaluated with an exposure snapshot (AD-12 point 10). */
const SNAPSHOT_OPERATIONS: ReadonlySet<string> = new Set(["network.resolve", "network.request"]);

/** Opaque exposure state of a session at one moment; only the guard creates and reads it. */
export interface ExposureSnapshot {
  readonly __brand: "ExposureSnapshot";
}

export interface ExecutionGuardOptions {
  /**
   * Called when the audit sink fails. For operations without an approval gate
   * the operation is not affected; for gated operations a failed mandatory
   * approval record refuses the operation (AD-7).
   */
  readonly onAuditError?: (error: unknown) => void;
  /** Approval broker. Without one, every gated operation is denied (no provider). */
  readonly approvals?: ApprovalBroker;
  /**
   * Re-resolves one path of an approved operation; false when it no longer
   * resolves to the same place (e.g. an ancestor was swapped for a symlink
   * while the request was pending). Used in step 4 for every path.
   */
  readonly revalidatePath?: (path: ResolvedPath) => Promise<boolean>;
  /**
   * Session exposure (AD-12). The guard marks the session after a source
   * operation succeeded and passes the state to approvalRequirement().
   * Defaults to a tracker of its own.
   */
  readonly exposure?: ExposureTracker;
}

/**
 * Thrown by a capability service from inside execute() when the binding of an
 * approved operation no longer holds (browser: tab, origin or connection
 * changed; AD-6, AD-11). The action was not performed. The guard audits the
 * operation as denied and reports PERMISSION_DENIED with the approval details.
 */
export class ApprovalBindingError extends PermissionDeniedError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalBindingError";
  }
}

/**
 * The execution pipeline every Core operation passes through:
 * authorize (PermissionEngine) -> execute -> audit.
 *
 * Capability services never call the operating system before the guard has
 * authorized the operation, and every authorized or denied operation is audited.
 */
export class ExecutionGuard {
  /** Operations that have not finished (including their audit record). */
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly exposure: ExposureTracker;
  private readonly snapshots = new WeakMap<
    ExposureSnapshot,
    { readonly context: AuthContext; readonly exposed: boolean }
  >();

  constructor(
    private readonly engine: PermissionEngine,
    private readonly audit: AuditSink,
    private readonly options: ExecutionGuardOptions = {},
  ) {
    this.exposure = options.exposure ?? new ExposureTracker();
  }

  /**
   * The session's current exposure state, for the steps of one network_request
   * call (OperationDescriptor.exposure). The caller must end it with
   * endExposureSnapshot() when the call returns.
   */
  exposureSnapshot(context: AuthContext): ExposureSnapshot {
    const snapshot = Object.freeze({}) as ExposureSnapshot;
    this.snapshots.set(snapshot, { context, exposed: this.exposure.isExposed(context) });
    return snapshot;
  }

  /** Ends a snapshot; later operations passing it are evaluated with the current state. */
  endExposureSnapshot(snapshot: ExposureSnapshot): void {
    this.snapshots.delete(snapshot);
  }

  run<T>(context: AuthContext, op: OperationDescriptor, execute: () => Promise<T>): Promise<T> {
    const running = this.runGuarded(context, op, execute);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
    return running;
  }

  /**
   * Wait until operations in flight have finished and written their audit
   * records, or until `timeoutMs` elapses. Returns the number still running.
   */
  async drain(timeoutMs: number): Promise<number> {
    if (this.inFlight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...this.inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    return this.inFlight.size;
  }

  private async runGuarded<T>(context: AuthContext, op: OperationDescriptor, execute: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const capabilities: readonly Capability[] = typeof op.capability === "string" ? [op.capability] : op.capability;
    const base = {
      operation: op.operation,
      capabilities,
      principal: context.principal,
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      paths: (op.paths ?? []).map((p) => p.absolute),
      ...(op.network !== undefined && op.network.length > 0 ? { network: op.network.map(auditTarget) } : {}),
      ...(op.details !== undefined ? { details: op.details } : {}),
    };
    const record = (outcome: AuditEvent["outcome"], error?: unknown, approval?: AuditApproval) =>
      this.record({
        id: newAuditEventId(),
        timestamp: new Date(started).toISOString(),
        ...base,
        outcome,
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error: summarizeError(error) } : {}),
        ...(approval !== undefined ? { approval } : {}),
      });

    const denial = this.authorizeAll(context, op, capabilities);
    if (denial) {
      await record("denied", denial);
      throw denial;
    }

    const exposed = this.exposedFor(context, op);
    const requirement = this.engine.approvalRequirement(context, {
      operation: op.operation,
      capabilities,
      ...(op.paths !== undefined ? { paths: op.paths } : {}),
      exposed,
    });
    if (!requirement.required) {
      try {
        const result = await execute();
        // AD-12: mark before the result is returned and independent of the audit write.
        this.exposure.recordSuccess(context, op.operation);
        await record("success");
        return result;
      } catch (error) {
        await record("error", error);
        throw error;
      }
    }

    // ---- approval gate (docs/design/approval-gates.md §4): it can only narrow.
    const deny = async (approval: AuditApproval, message: string): Promise<never> => {
      const denied = new PermissionDeniedError(message, {
        operation: op.operation,
        missing: [],
        approval: { requestId: approval.requestId, status: approval.status },
      });
      await record("denied", denied, approval);
      throw denied;
    };

    let subject = this.subject(context, op, capabilities, requirement.rule, exposed);
    const broker = this.options.approvals;
    const unavailable = broker ? broker.unavailableReason() : "no_provider";
    if (unavailable === undefined && op.approval?.bind) {
      let binding: ApprovalBinding;
      try {
        binding = checkBinding(await op.approval.bind());
      } catch (error) {
        // AD-8: the target could not be determined -> no request, denied.
        const now = new Date().toISOString();
        return deny(
          {
            requestId: newApprovalRequestId(),
            status: "unavailable",
            rule: requirement.rule,
            subjectDigest: subjectDigest(subject),
            requestedAt: now,
            resolvedAt: now,
            waitMs: 0,
          },
          `Approval is required for ${op.operation}, but its target could not be determined ` +
            `(${summarizeError(error).message}); no approval was requested and the operation was denied.`,
        );
      }
      subject = {
        ...subject,
        effects: [...subject.effects, ...(binding.effects ?? [])],
        ...(binding.browser ? { browser: binding.browser } : {}),
      };
    }

    const outcome: ApprovalOutcome = broker
      ? await broker.request(subject, requirement.timeoutMs, context.signal)
      : syntheticUnavailable(subject);
    const approval = auditApproval(outcome, requirement.rule);
    if (outcome.status !== "approved") {
      const message = notApprovedMessage(op.operation, outcome);
      return deny(
        approval,
        requirement.rule === UNTRUSTED_CONTENT_RULE_ID ? `${UNTRUSTED_CONTENT_MESSAGE} ${message}` : message,
      );
    }

    // Step 4: re-authorize and revalidate; nothing the approval saw may have changed.
    const changed = async (reason: string, message: string): Promise<never> =>
      deny({ ...approval, reauthorization: reason }, message);
    const again = this.authorizeAll(context, op, capabilities);
    if (again) return changed(again.message, `Approved, but no longer authorized: ${again.message}`);
    let valid: boolean;
    try {
      valid = true;
      const revalidatePath = this.options.revalidatePath;
      if (revalidatePath) {
        for (const p of op.paths ?? []) if (!(await revalidatePath(p))) valid = false;
      }
      if (valid && op.approval?.revalidate) valid = await op.approval.revalidate();
    } catch {
      valid = false;
    }
    if (!valid)
      return changed(
        "revalidation failed: the target changed while waiting for approval",
        `Approved, but the target of ${op.operation} changed while waiting for approval; the operation was denied.`,
      );
    if (context.signal?.aborted)
      return changed(
        "the caller cancelled the request",
        `Approved, but the caller cancelled ${op.operation}; it was not executed.`,
      );

    // Step 4a (AD-7): the mandatory approval record; without it the approval is not completed.
    try {
      await this.audit.record({
        kind: "approval",
        id: newAuditEventId(),
        timestamp: new Date(started).toISOString(),
        ...base,
        durationMs: Date.now() - started,
        approval,
      });
    } catch (error) {
      this.options.onAuditError?.(error);
      return changed(
        "the mandatory approval audit record could not be written",
        `Approved, but the approval could not be recorded in the audit log; ${op.operation} was not executed.`,
      );
    }

    try {
      const result = await execute();
      this.exposure.recordSuccess(context, op.operation);
      await record("success", undefined, approval);
      return result;
    } catch (error) {
      if (error instanceof ApprovalBindingError) {
        return changed(
          `binding no longer holds: ${error.message}`,
          `Approved, but the approved target of ${op.operation} changed; the action was not performed.`,
        );
      }
      await record("error", error, approval);
      throw error;
    }
  }

  /** Exposure is monotone, so a snapshot of the same session can only be the earlier, never a weaker-than-real state. */
  private exposedFor(context: AuthContext, op: OperationDescriptor): boolean {
    const snapshot = SNAPSHOT_OPERATIONS.has(op.operation) ? op.exposure : undefined;
    const taken = snapshot !== undefined ? this.snapshots.get(snapshot) : undefined;
    if (taken !== undefined && taken.context.session === context.session) return taken.exposed;
    return this.exposure.isExposed(context);
  }

  /** authorize() for every capability of the operation; the first denial, if any. */
  private authorizeAll(
    context: AuthContext,
    op: OperationDescriptor,
    capabilities: readonly Capability[],
  ): PermissionDeniedError | undefined {
    for (const capability of capabilities) {
      const decision = this.engine.authorize({
        context,
        capability,
        paths: op.paths ?? [],
        ...(op.network !== undefined ? { network: op.network } : {}),
      });
      if (!decision.allowed) {
        return new PermissionDeniedError(decision.reason, { operation: op.operation, missing: decision.missing });
      }
    }
    return undefined;
  }

  /** The approval subject, built by Core from the descriptor (the same captured arguments execute() uses). */
  private subject(
    context: AuthContext,
    op: OperationDescriptor,
    capabilities: readonly Capability[],
    rule: string,
    exposed: boolean,
  ): ApprovalSubject {
    const paths = (op.paths ?? []).map((p) => ({ absolute: p.absolute, insideWorkspace: p.insideWorkspace }));
    const effects: ApprovalEffect[] = op.approval
      ? [...op.approval.effects]
      : Object.entries(op.details ?? {}).map(([label, value]) => ({ label, value: effectValue(value) }));
    for (const p of paths) {
      effects.push(
        p.insideWorkspace
          ? { label: "path", value: p.absolute }
          : {
              label: "path",
              value: p.absolute,
              flag: "outside_workspace",
            },
      );
    }
    // Computed only by Core (AD-12), never reported by the agent.
    if (exposed) effects.push({ label: "exposure", value: "this session read untrusted content before this request" });
    return {
      operation: op.operation,
      capabilities,
      summary: op.approval?.summary ?? op.operation,
      effects,
      paths,
      network: (op.network ?? []).map((t) => ({ scheme: t.scheme, host: t.host, port: t.port })),
      principal: context.principal,
      mode: this.engine.mode,
      rule,
    };
  }

  private async record(event: AuditEvent): Promise<void> {
    try {
      await this.audit.record(event);
    } catch (error) {
      this.options.onAuditError?.(error);
    }
  }
}

/** Destination as recorded in the audit log: no path, query, headers or body. */
function auditTarget(t: NetworkTarget): { scheme: string; host: string; port: number; addresses?: string[] } {
  return {
    scheme: t.scheme,
    host: t.host,
    port: t.port,
    ...(t.addresses !== undefined ? { addresses: t.addresses.map((a) => a.text) } : {}),
  };
}

function summarizeError(error: unknown): { code: string; message: string } {
  if (error instanceof CrotError) return { code: error.code, message: error.message };
  return { code: "OPERATION_FAILED", message: error instanceof Error ? error.message : String(error) };
}

function effectValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Shape check of a service binding; anything Core cannot use means the target is undeterminable. */
function checkBinding(binding: ApprovalBinding): ApprovalBinding {
  const browser = binding.browser;
  if (browser !== undefined) {
    if (browser.tabId !== undefined && (!Number.isSafeInteger(browser.tabId) || browser.tabId < 0))
      throw new CrotError("OPERATION_FAILED", "invalid tab id");
    if (normalizedHttpOrigin(browser.origin) !== browser.origin)
      throw new CrotError("OPERATION_FAILED", "the tab has no http(s) origin");
    if (typeof browser.connectionId !== "string" || browser.connectionId.length === 0)
      throw new CrotError("OPERATION_FAILED", "the browser connection has no id");
  }
  return binding;
}

function syntheticUnavailable(subject: ApprovalSubject): ApprovalOutcome {
  const now = new Date().toISOString();
  return {
    requestId: newApprovalRequestId(),
    status: "unavailable",
    subjectDigest: subjectDigest(subject),
    requestedAt: now,
    resolvedAt: now,
    cancelReason: "no_provider",
  };
}

function auditApproval(outcome: ApprovalOutcome, rule: string): AuditApproval {
  return {
    requestId: outcome.requestId,
    status: outcome.status,
    rule,
    subjectDigest: outcome.subjectDigest,
    requestedAt: outcome.requestedAt,
    resolvedAt: outcome.resolvedAt,
    waitMs: Math.max(0, Date.parse(outcome.resolvedAt) - Date.parse(outcome.requestedAt)),
    ...(outcome.provider ? { provider: outcome.provider } : {}),
    ...(outcome.cancelReason ? { cancelReason: outcome.cancelReason } : {}),
  };
}

const NOT_APPROVED: Record<Exclude<TerminalApprovalStatus, "approved">, string> = {
  rejected: "the user rejected the request",
  expired: "the request expired without a decision",
  cancelled: "the request was cancelled",
  unavailable: "the request could not be shown to the user",
};

const REASONS: Record<string, string> = {
  caller_aborted: "the caller cancelled the operation",
  shutdown: "CROT is shutting down",
  provider_gone: "the approval UI disconnected",
  no_provider: "no approval UI is connected",
  queue_full: "too many approval requests are pending",
};

function notApprovedMessage(operation: string, outcome: ApprovalOutcome): string {
  const status = outcome.status as Exclude<TerminalApprovalStatus, "approved">;
  const reason = outcome.cancelReason ? ` (${REASONS[outcome.cancelReason]})` : "";
  return (
    `${operation} requires the user's approval and was not approved: ${NOT_APPROVED[status]}${reason}. ` +
    "The operation was not executed. Do not retry it in a loop; ask the user instead."
  );
}
