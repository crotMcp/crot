/**
 * The product approval provider (ARCHITECTURE.md §27, AD-19 point 3; AD-5).
 *
 * It lives in the service and fans approval requests out to every tray
 * subscribed on the authenticated control channel. The service registers it
 * with the broker of the current Core while at least one tray is subscribed,
 * so with no tray a gated operation is `unavailable` at once and losing the
 * last tray cancels pending requests (AD-5 point 4).
 *
 * The provider never decides on its own. A decision is accepted only from a
 * subscribed tray, only for a pending request that was presented to that
 * tray, and an approval only with the presented subject digest.
 */
import type {
  ApprovalProvider,
  ApprovalTicket,
  PresentedApproval,
  TerminalApprovalStatus,
} from "../core/approvals/types.js";

export const TRAY_PROVIDER_ID = "tray";

/** A subscribed tray (one control connection). */
export interface ApprovalSubscriber {
  requested(approval: PresentedApproval): void;
  resolved(requestId: string, status: TerminalApprovalStatus): void;
}

export type TrayDecision = "approve" | "reject";

export type TrayDecideResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_pending" | "digest_mismatch" | "unknown_request" };

interface Entry {
  readonly presented: PresentedApproval;
  readonly ticket: ApprovalTicket;
  readonly shownTo: Set<ApprovalSubscriber>;
}

export class TrayApprovalProvider implements ApprovalProvider {
  readonly id = TRAY_PROVIDER_ID;
  readonly channel = "local-ui" as const;
  private readonly pending = new Map<string, Entry>();
  private readonly subscribers = new Set<ApprovalSubscriber>();

  constructor(
    private readonly hooks: {
      /** The first tray subscribed: register with the broker. */
      readonly onFirstSubscriber: () => void;
      /** The last tray left: unregister (pending requests are cancelled by the broker). */
      readonly onLastSubscriberGone: () => void;
    },
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  present(request: PresentedApproval, ticket: ApprovalTicket): void {
    const entry: Entry = { presented: request, ticket, shownTo: new Set() };
    this.pending.set(request.requestId, entry);
    for (const subscriber of this.subscribers) {
      entry.shownTo.add(subscriber);
      subscriber.requested(request);
    }
  }

  resolved(requestId: string, status: TerminalApprovalStatus): void {
    if (!this.pending.delete(requestId)) return;
    for (const subscriber of this.subscribers) subscriber.resolved(requestId, status);
  }

  /** Add a tray; returns the snapshot of pending requests, which now count as presented to it. */
  subscribe(subscriber: ApprovalSubscriber): PresentedApproval[] {
    // Register first: requests the broker presents now go into the snapshot below, not into events.
    if (this.subscribers.size === 0) this.hooks.onFirstSubscriber();
    this.subscribers.add(subscriber);
    const snapshot: PresentedApproval[] = [];
    for (const entry of this.pending.values()) {
      entry.shownTo.add(subscriber);
      snapshot.push(entry.presented);
    }
    return snapshot;
  }

  unsubscribe(subscriber: ApprovalSubscriber): void {
    if (!this.subscribers.delete(subscriber)) return;
    for (const entry of this.pending.values()) entry.shownTo.delete(subscriber);
    if (this.subscribers.size === 0) {
      this.hooks.onLastSubscriberGone();
      // The broker cancelled what was pending (provider_gone); nothing can be decided any more.
      this.pending.clear();
    }
  }

  /** Called by the service when it registers the provider with a new Core (AD-19 point 5). */
  forgetPending(): void {
    this.pending.clear();
  }

  decide(
    subscriber: ApprovalSubscriber,
    requestId: string,
    decision: TrayDecision,
    subjectDigest?: string,
  ): TrayDecideResult {
    if (!this.subscribers.has(subscriber)) return { ok: false, reason: "unknown_request" };
    const entry = this.pending.get(requestId);
    if (!entry || !entry.shownTo.has(subscriber)) return { ok: false, reason: "unknown_request" };
    if (decision === "approve") {
      if (subjectDigest === undefined) return { ok: false, reason: "digest_mismatch" };
      return entry.ticket.approve(subjectDigest);
    }
    return entry.ticket.reject();
  }
}
