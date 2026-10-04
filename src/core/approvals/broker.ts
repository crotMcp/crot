import { CrotError } from "../errors.js";
import { DEFAULT_APPROVAL_MAX_PENDING } from "./rules.js";
import { newApprovalRequestId, subjectDigest } from "./subject.js";
import type {
  ApprovalCancelReason,
  ApprovalOutcome,
  ApprovalProvider,
  ApprovalSubject,
  ApprovalTicket,
  DecideResult,
  PresentedApproval,
  TerminalApprovalStatus,
} from "./types.js";

export interface ApprovalBrokerOptions {
  /** Bound of the pending queue; a request beyond it is `unavailable` (queue_full). */
  readonly maxPending?: number;
  /** Clock (tests). */
  readonly now?: () => number;
}

interface Entry {
  readonly presented: PresentedApproval;
  readonly createdMs: number;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  detach: (() => void) | undefined;
  settled: boolean;
}

/**
 * Owns the approval queue and the request state machine
 * (docs/design/approval-gates.md §7, §8).
 *
 * - One in-memory FIFO queue per Core process, bounded by `maxPending`. A
 *   request beyond the bound, or without any registered provider, is not
 *   queued: it ends `unavailable` immediately.
 * - Transitions are sequential; the first transition out of `pending` wins and
 *   every later decision, timer or cancel is a no-op (`not_pending`).
 * - An approval must carry the digest of the subject the provider showed and
 *   is consumed by the terminal transition (single use).
 * - Providers are registered only by the composition root; only their tickets
 *   can decide. The broker is never reachable by agents, adapters or the
 *   browser side.
 * - Every failure path denies: provider exceptions never approve, and the
 *   broker cancels every pending request on shutdown.
 */
export class ApprovalBroker {
  private readonly providers: ApprovalProvider[] = [];
  private readonly pending = new Map<string, Entry>();
  private readonly maxPending: number;
  private readonly now: () => number;
  private closed = false;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.maxPending = options.maxPending ?? DEFAULT_APPROVAL_MAX_PENDING;
    this.now = options.now ?? Date.now;
  }

  get providerCount(): number {
    return this.providers.length;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Register a provider (composition root only). It receives a snapshot of
   * every pending request, then request and resolution notifications. Returns
   * a function that unregisters it.
   */
  register(provider: ApprovalProvider): () => void {
    if (provider.channel !== "local-ui")
      throw new CrotError("CONFIG_ERROR", `Approval provider '${provider.id}': unsupported channel.`);
    if (this.providers.some((p) => p === provider || p.id === provider.id))
      throw new CrotError("CONFIG_ERROR", `Approval provider '${provider.id}' is already registered.`);
    this.providers.push(provider);
    for (const entry of [...this.pending.values()]) this.present(provider, entry);
    return () => this.unregister(provider);
  }

  /** When the last provider goes away, every pending request is cancelled (provider_gone). */
  unregister(provider: ApprovalProvider): void {
    const index = this.providers.indexOf(provider);
    if (index < 0) return;
    this.providers.splice(index, 1);
    if (this.providers.length === 0) {
      for (const entry of [...this.pending.values()])
        this.settle(entry, "cancelled", { cancelReason: "provider_gone" });
    }
  }

  /** Why a new request would not be queued right now, if it would not. */
  unavailableReason(): ApprovalCancelReason | undefined {
    if (this.closed) return "shutdown";
    if (this.providers.length === 0) return "no_provider";
    if (this.pending.size >= this.maxPending) return "queue_full";
    return undefined;
  }

  /** Ask the user. Never rejects: every outcome other than `approved` denies the operation. */
  request(subject: ApprovalSubject, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const requestId = newApprovalRequestId();
    const digest = subjectDigest(subject);
    const createdMs = this.now();
    const createdAt = new Date(createdMs).toISOString();
    const immediate = (status: TerminalApprovalStatus, cancelReason: ApprovalCancelReason) =>
      Promise.resolve<ApprovalOutcome>({
        requestId,
        status,
        subjectDigest: digest,
        requestedAt: createdAt,
        resolvedAt: createdAt,
        cancelReason,
      });
    if (this.closed) return immediate("cancelled", "shutdown");
    if (signal?.aborted) return immediate("cancelled", "caller_aborted");
    if (this.providers.length === 0) return immediate("unavailable", "no_provider");
    if (this.pending.size >= this.maxPending) return immediate("unavailable", "queue_full");

    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: Entry = {
        presented: Object.freeze({
          requestId,
          subject,
          subjectDigest: digest,
          createdAt,
          expiresAt: new Date(createdMs + timeoutMs).toISOString(),
        }),
        createdMs,
        resolve,
        timer: undefined,
        detach: undefined,
        settled: false,
      };
      this.pending.set(requestId, entry);
      entry.timer = setTimeout(() => this.settle(entry, "expired"), timeoutMs);
      if (signal) {
        const onAbort = () => this.settle(entry, "cancelled", { cancelReason: "caller_aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
      for (const provider of [...this.providers]) {
        if (entry.settled) break;
        this.present(provider, entry);
      }
    });
  }

  /** Cancel every pending request and refuse new ones (shutdown). Idempotent. */
  cancelAll(reason: "shutdown"): void {
    this.closed = true;
    for (const entry of [...this.pending.values()]) this.settle(entry, "cancelled", { cancelReason: reason });
  }

  private present(provider: ApprovalProvider, entry: Entry): void {
    const ticket: ApprovalTicket = Object.freeze({
      requestId: entry.presented.requestId,
      approve: (digest: string): DecideResult => {
        if (entry.settled || !this.providers.includes(provider)) return { ok: false, reason: "not_pending" };
        if (digest !== entry.presented.subjectDigest) return { ok: false, reason: "digest_mismatch" };
        this.settle(entry, "approved", { provider });
        return { ok: true };
      },
      reject: (): DecideResult => {
        if (entry.settled || !this.providers.includes(provider)) return { ok: false, reason: "not_pending" };
        this.settle(entry, "rejected", { provider });
        return { ok: true };
      },
    });
    try {
      provider.present(entry.presented, ticket);
    } catch {
      // A failing provider never approves; the request stays pending for the others or expires.
    }
  }

  private settle(
    entry: Entry,
    status: TerminalApprovalStatus,
    extra: { provider?: ApprovalProvider; cancelReason?: ApprovalCancelReason } = {},
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    const { requestId } = entry.presented;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.detach?.();
    entry.resolve({
      requestId,
      status,
      subjectDigest: entry.presented.subjectDigest,
      requestedAt: entry.presented.createdAt,
      resolvedAt: new Date(Math.max(this.now(), entry.createdMs)).toISOString(),
      ...(extra.provider ? { provider: { id: extra.provider.id, channel: extra.provider.channel } } : {}),
      ...(extra.cancelReason ? { cancelReason: extra.cancelReason } : {}),
    });
    for (const provider of [...this.providers]) {
      try {
        provider.resolved(requestId, status);
      } catch {
        // Notifications are best effort; the decision is already final.
      }
    }
  }
}
