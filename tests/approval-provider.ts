import type {
  ApprovalProvider,
  ApprovalTicket,
  PresentedApproval,
  TerminalApprovalStatus,
} from "../src/core/approvals/types.js";
import { waitFor } from "./helpers.js";

/** Test-only approval provider: records requests; the test decides through the tickets. */
export class TestProvider implements ApprovalProvider {
  readonly channel = "local-ui" as const;
  readonly shown: { request: PresentedApproval; ticket: ApprovalTicket }[] = [];
  readonly ended: { requestId: string; status: TerminalApprovalStatus }[] = [];
  constructor(readonly id = "test-ui") {}
  present(request: PresentedApproval, ticket: ApprovalTicket): void {
    this.shown.push({ request, ticket });
  }
  resolved(requestId: string, status: TerminalApprovalStatus): void {
    this.ended.push({ requestId, status });
  }
  last(): { request: PresentedApproval; ticket: ApprovalTicket } {
    const item = this.shown.at(-1);
    if (!item) throw new Error("nothing presented");
    return item;
  }
  private taken = 0;
  /** Wait for the next request not yet returned by next() (it may already have been presented). */
  async next(): Promise<{ request: PresentedApproval; ticket: ApprovalTicket }> {
    await waitFor(() => this.shown.length > this.taken);
    const item = this.shown[this.taken++];
    if (!item) throw new Error("nothing presented");
    return item;
  }
  approveLast(): void {
    const { request, ticket } = this.last();
    const result = ticket.approve(request.subjectDigest);
    if (!result.ok) throw new Error(`approve failed: ${result.reason}`);
  }
}
