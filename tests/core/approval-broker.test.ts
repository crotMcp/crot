import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../../src/core/approvals/broker.js";
import { canonicalJson, normalizedHttpOrigin, subjectDigest } from "../../src/core/approvals/subject.js";
import type { ApprovalSubject } from "../../src/core/approvals/types.js";
import { localPrincipal } from "../../src/core/auth/principal.js";
import { TestProvider } from "../approval-provider.js";

const SUBJECT: ApprovalSubject = {
  operation: "process.shell",
  capabilities: ["shell.execute"],
  summary: "process.shell",
  effects: [{ label: "script", value: "echo hi" }],
  paths: [{ absolute: "/w", insideWorkspace: true }],
  network: [],
  principal: localPrincipal("test"),
  mode: "sandbox",
  rule: "shell",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("approval subject", () => {
  it("serializes canonically and hashes with SHA-256", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe(
      '{"a":[true,null,{"d":"x"}],"b":1}',
    );
    const reordered: ApprovalSubject = { ...SUBJECT, rule: SUBJECT.rule, operation: SUBJECT.operation };
    expect(subjectDigest(reordered)).toBe(subjectDigest(SUBJECT));
    expect(subjectDigest(SUBJECT)).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectDigest({ ...SUBJECT, effects: [{ label: "script", value: "echo HI" }] })).not.toBe(
      subjectDigest(SUBJECT),
    );
  });

  it("normalizes http(s) origins only", () => {
    expect(normalizedHttpOrigin("HTTPS://Example.COM:443/a?b#c")).toBe("https://example.com");
    expect(normalizedHttpOrigin("http://example.com:8080/")).toBe("http://example.com:8080");
    expect(normalizedHttpOrigin("https://bücher.example/")).toBe("https://xn--bcher-kva.example");
    for (const bad of ["file:///etc/passwd", "data:text/html,x", "chrome://settings", "about:blank", "", "nope", 1])
      expect(normalizedHttpOrigin(bad)).toBeUndefined();
  });
});

describe("ApprovalBroker", () => {
  it("presents a request and resolves approved only with the shown digest", async () => {
    const broker = new ApprovalBroker();
    const ui = new TestProvider();
    broker.register(ui);
    const pending = broker.request(SUBJECT, 10_000);
    const { request, ticket } = ui.last();
    expect(request.subject).toEqual(SUBJECT);
    expect(request.subjectDigest).toBe(subjectDigest(SUBJECT));
    expect(request.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(request.expiresAt) - Date.parse(request.createdAt)).toBe(10_000);
    expect(broker.pendingCount).toBe(1);

    expect(ticket.approve("0".repeat(64))).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(broker.pendingCount).toBe(1); // still pending
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: true });
    const outcome = await pending;
    expect(outcome).toMatchObject({
      requestId: request.requestId,
      status: "approved",
      subjectDigest: request.subjectDigest,
      provider: { id: "test-ui", channel: "local-ui" },
    });
    expect(outcome.cancelReason).toBeUndefined();
    expect(ui.ended).toEqual([{ requestId: request.requestId, status: "approved" }]);
    expect(broker.pendingCount).toBe(0);
  });

  it("double approve: the first decision wins, the approval is single-use", async () => {
    const broker = new ApprovalBroker();
    const ui = new TestProvider();
    broker.register(ui);
    const pending = broker.request(SUBJECT, 10_000);
    const { request, ticket } = ui.last();
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: true });
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    expect(ticket.reject()).toEqual({ ok: false, reason: "not_pending" });
    expect((await pending).status).toBe("approved");
    expect(ui.ended).toHaveLength(1);

    // Reuse: the old ticket cannot decide a new request, even for an identical subject.
    const second = broker.request(SUBJECT, 10_000);
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    const next = ui.last();
    expect(next.request.requestId).not.toBe(request.requestId);
    expect(next.ticket.reject()).toEqual({ ok: true });
    expect((await second).status).toBe("rejected");
  });

  it("approve vs timeout: whichever comes first wins", async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const ui = new TestProvider();
    broker.register(ui);

    const expiring = broker.request(SUBJECT, 1_000);
    const late = ui.last();
    vi.advanceTimersByTime(1_000);
    expect((await expiring).status).toBe("expired");
    expect(late.ticket.approve(late.request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    expect(ui.ended.at(-1)?.status).toBe("expired");

    const approved = broker.request(SUBJECT, 1_000);
    const early = ui.last();
    vi.advanceTimersByTime(999);
    expect(early.ticket.approve(early.request.subjectDigest)).toEqual({ ok: true });
    vi.advanceTimersByTime(10_000); // the timer was cleared: no second transition
    expect((await approved).status).toBe("approved");
    expect(ui.ended.filter((e) => e.requestId === early.request.requestId)).toHaveLength(1);
  });

  it("approve vs cancel: a caller abort cancels, a later approval is a no-op", async () => {
    const broker = new ApprovalBroker();
    const ui = new TestProvider();
    broker.register(ui);
    const controller = new AbortController();
    const pending = broker.request(SUBJECT, 10_000, controller.signal);
    const { request, ticket } = ui.last();
    controller.abort();
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    expect(await pending).toMatchObject({ status: "cancelled", cancelReason: "caller_aborted" });

    // Approved first: the abort afterwards changes nothing.
    const controller2 = new AbortController();
    const second = broker.request(SUBJECT, 10_000, controller2.signal);
    const next = ui.last();
    expect(next.ticket.approve(next.request.subjectDigest)).toEqual({ ok: true });
    controller2.abort();
    expect((await second).status).toBe("approved");

    // Already aborted: never presented.
    const before = ui.shown.length;
    expect(await broker.request(SUBJECT, 10_000, AbortSignal.abort())).toMatchObject({
      status: "cancelled",
      cancelReason: "caller_aborted",
    });
    expect(ui.shown).toHaveLength(before);
  });

  it("is unavailable without a provider and when the queue is full", async () => {
    const broker = new ApprovalBroker({ maxPending: 2 });
    expect(broker.unavailableReason()).toBe("no_provider");
    expect(await broker.request(SUBJECT, 10_000)).toMatchObject({ status: "unavailable", cancelReason: "no_provider" });

    const ui = new TestProvider();
    broker.register(ui);
    const first = broker.request(SUBJECT, 10_000);
    const second = broker.request(SUBJECT, 10_000);
    expect(broker.unavailableReason()).toBe("queue_full");
    const overflow = await broker.request(SUBJECT, 10_000);
    expect(overflow).toMatchObject({ status: "unavailable", cancelReason: "queue_full" });
    expect(ui.shown).toHaveLength(2); // the overflow was never shown and evicted nothing
    expect(broker.pendingCount).toBe(2);

    // FIFO order is kept for the snapshot; deciding one frees a slot.
    const [a, b] = ui.shown;
    expect(Date.parse(a!.request.createdAt)).toBeLessThanOrEqual(Date.parse(b!.request.createdAt));
    a!.ticket.reject();
    expect((await first).status).toBe("rejected");
    expect(broker.unavailableReason()).toBeUndefined();
    b!.ticket.approve(b!.request.subjectDigest);
    expect((await second).status).toBe("approved");
  });

  it("shutdown cancels pending requests and refuses new ones", async () => {
    const broker = new ApprovalBroker();
    const ui = new TestProvider();
    broker.register(ui);
    const pending = [broker.request(SUBJECT, 10_000), broker.request(SUBJECT, 10_000)];
    broker.cancelAll("shutdown");
    for (const outcome of await Promise.all(pending))
      expect(outcome).toMatchObject({ status: "cancelled", cancelReason: "shutdown" });
    for (const { request, ticket } of ui.shown)
      expect(ticket.approve(request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    expect(await broker.request(SUBJECT, 10_000)).toMatchObject({ status: "cancelled", cancelReason: "shutdown" });
    expect(ui.shown).toHaveLength(2);
    broker.cancelAll("shutdown"); // idempotent
  });

  it("cancels pending requests when the last provider unregisters", async () => {
    const broker = new ApprovalBroker();
    const a = new TestProvider("a");
    const b = new TestProvider("b");
    const offA = broker.register(a);
    const offB = broker.register(b);
    const pending = broker.request(SUBJECT, 10_000);
    offA();
    expect(broker.pendingCount).toBe(1); // b still shows it
    // A provider that is gone can no longer decide.
    const shownToA = a.last();
    expect(shownToA.ticket.approve(shownToA.request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    offB();
    expect(await pending).toMatchObject({ status: "cancelled", cancelReason: "provider_gone" });
  });

  it("gives a registering provider a snapshot; with several providers the first decision wins", async () => {
    const broker = new ApprovalBroker();
    const a = new TestProvider("a");
    broker.register(a);
    const pending = broker.request(SUBJECT, 10_000);
    const b = new TestProvider("b");
    broker.register(b);
    expect(b.shown.map((s) => s.request.requestId)).toEqual([a.last().request.requestId]);
    expect(b.last().ticket.approve(b.last().request.subjectDigest)).toEqual({ ok: true });
    expect(a.last().ticket.reject()).toEqual({ ok: false, reason: "not_pending" });
    expect((await pending).provider).toEqual({ id: "b", channel: "local-ui" });
    expect(a.ended.map((e) => e.status)).toEqual(["approved"]);
    expect(() => broker.register(new TestProvider("a"))).toThrow(/already registered/);
  });

  it("never approves because a provider fails", async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    broker.register({
      id: "broken",
      channel: "local-ui",
      present: () => {
        throw new Error("ui crashed");
      },
      resolved: () => {
        throw new Error("ui crashed");
      },
    });
    const pending = broker.request(SUBJECT, 500);
    vi.advanceTimersByTime(500);
    expect((await pending).status).toBe("expired");
  });
});
