import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../../src/account-service/service.js";
import {
  StripeBillingProvider,
  WorkOSRevoker,
  type BillingProvider,
  type SubscriptionUpdate,
} from "../../src/account-service/billing.js";
import { generateDeviceId } from "../../src/identity/device-id.js";
import { versionAtLeast, MINIMUM_MAJOR_SUPPORT_MONTHS } from "../../src/cloud-relay/versions.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const commit = async () => "created" as const;
const provider = (u: Partial<SubscriptionUpdate> = {}): BillingProvider => ({
  checkout: async () => "https://checkout.stripe.com/test",
  verifyAndResolve: async () => ({
    eventId: "evt_1",
    accountId: "user_01",
    subscriptionId: "sub_1",
    plan: "pro",
    status: "active",
    expiresAt: Date.now() + 86400000,
    ...u,
  }),
});
const activate = (a: AccountService, u: Partial<SubscriptionUpdate> = {}) =>
  a.billing(provider(u), Buffer.from("{}"), "verified-test-provider");

describe("AD-34 cloud-only commercial state", () => {
  it("defaults Free, never enables remote without explicit trial or verified subscription", async () => {
    const a = new AccountService();
    expect(a.snapshot("user_01")).toMatchObject({ plan: "free", entitled: false, maxDevices: 0 });
    const register = vi.fn(commit);
    expect(await a.register("user_01", generateDeviceId(), register)).toBe("entitlement_required");
    expect(register).not.toHaveBeenCalled();
  });
  it("trial is explicit, fourteen days and one-time, including after restart", async () => {
    let now = Date.now();
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-commerce-"));
    dirs.push(dir);
    const file = path.join(dir, "accounts.json");
    let a = await AccountService.open(file, { now: () => now });
    expect(await a.startTrial("user_01")).toBe(true);
    expect(a.snapshot("user_01")).toMatchObject({ maxDevices: 2, expiresAt: now + 14 * 86400000, entitled: true });
    now += 14 * 86400000;
    a = await AccountService.open(file, { now: () => now });
    expect(a.snapshot("user_01")).toMatchObject({ status: "expired", entitled: false });
    expect(await a.startTrial("user_01")).toBe(false);
  });
  it("serializes concurrent device quota, idempotent retry and durable tombstones", async () => {
    const a = new AccountService();
    await a.startTrial("user_01");
    const ids = Array.from({ length: 20 }, generateDeviceId);
    const result = await Promise.all(ids.map((id) => a.register("user_01", id, commit)));
    expect(result.filter((r) => r === "created")).toHaveLength(2);
    expect(result.filter((r) => r === "device_limit_reached")).toHaveLength(18);
    expect(await a.register("user_01", ids[0]!, async () => "unchanged")).toBe("unchanged");
    expect(await a.register("other", ids[0]!, commit)).toBe("conflict");
    expect(await a.revoke("other", ids[0]!)).toBe(false);
    await a.revoke("user_01", ids[0]!);
    expect(await a.register("user_01", ids[0]!, commit)).toBe("device_revoked");
    expect(await a.register("user_01", ids[2]!, commit)).toBe("created");
  });
  it.each([
    ["pro", 5],
    ["team", 20],
  ] as const)("enforces %s limit %i", async (plan, max) => {
    const a = new AccountService();
    await activate(a, { plan });
    const r = await Promise.all(
      Array.from({ length: max + 1 }, () => a.register("user_01", generateDeviceId(), commit)),
    );
    expect(r.filter((r) => r === "created")).toHaveLength(max);
    expect(r.at(-1)).toBe("device_limit_reached");
  });
  it.each(["past_due", "canceled", "expired"] as const)(
    "denies %s with immediate change notification",
    async (status) => {
      const a = new AccountService();
      await activate(a);
      const id = generateDeviceId();
      await a.register("user_01", id, commit);
      const listener = vi.fn();
      a.onChange(listener);
      await activate(a, { status, eventId: "evt_2" });
      expect(a.deviceState("user_01", id)).toBe("not_entitled");
      expect(listener).toHaveBeenCalledOnce();
    },
  );
  it("plan downgrade deterministically revokes excess remote admissions", async () => {
    const a = new AccountService();
    await activate(a, { plan: "team" });
    const ids = Array.from({ length: 10 }, generateDeviceId);
    for (const id of ids) await a.register("user_01", id, commit);
    await activate(a, { eventId: "evt_2", plan: "pro" });
    expect(ids.map((id) => a.deviceState("user_01", id)).filter((s) => s === "entitled")).toHaveLength(5);
  });
  it("does not publish or notify a failed durable transaction", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-commerce-"));
    dirs.push(dir);
    const a = await AccountService.open(path.join(dir, "child", "accounts.json"));
    await writeFile(path.join(dir, "child"), "not a directory");
    const notify = vi.fn();
    a.onChange(notify);
    await expect(a.startTrial("user_01")).rejects.toThrow();
    expect(a.snapshot("user_01").entitled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
  it("failed registry commit can be retried with the same durable reservation without extra quota", async () => {
    const a = new AccountService();
    await a.startTrial("user_01");
    const id = generateDeviceId();
    await expect(
      a.register("user_01", id, async () => {
        throw new Error("disk");
      }),
    ).rejects.toThrow();
    expect(a.snapshot("user_01").deviceCount).toBe(1);
    expect(await a.register("user_01", id, commit)).toBe("created");
    expect(a.snapshot("user_01").deviceCount).toBe(1);
  });
  it("deduplicates signed billing event IDs durably", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-commerce-"));
    dirs.push(dir);
    const file = path.join(dir, "accounts");
    let a = await AccountService.open(file);
    expect(await activate(a)).toBe(true);
    a = await AccountService.open(file);
    expect(await activate(a, { status: "canceled" })).toBe(false);
    expect(a.snapshot("user_01").entitled).toBe(true);
    expect(await readFile(file, "utf8")).not.toContain("verified-test-provider");
  });
  it("provider revocation uses only observed, signature-verified session metadata for that device/client", async () => {
    const revokeSession = vi.fn(async () => undefined);
    const a = new AccountService({ revoker: { revokeSession } });
    await a.startTrial("user_01");
    const id = generateDeviceId();
    await a.register("user_01", id, commit);
    await a.noteClient("user_01", id, "https://agent.example/client", "session_A");
    await a.noteClient("user_01", id, "https://agent.example/client", "session_B");
    await a.noteClient("user_01", id, "other", "session_C");
    expect(await a.revokeProvider("user_01", id, "https://agent.example/client")).toBe("requested");
    expect(revokeSession.mock.calls).toEqual([["session_A"], ["session_B"]]);
    expect(await a.revokeProvider("foreign", id)).toBe("not_available");
  });
});

describe("Stripe signature and authoritative state adapter", () => {
  const now = 1900000000000;
  const event = (id = "evt_1", type = "customer.subscription.updated") =>
    Buffer.from(
      JSON.stringify({
        id,
        type,
        data: { object: { id: "sub_1", status: "active", metadata: { crot_account_id: "attacker" } } },
      }),
    );
  const signature = (body: Buffer, time = now / 1000) =>
    `t=${time},v1=${createHmac("sha256", "whsec_test").update(`${time}.`).update(body).digest("hex")}`;
  function fixture() {
    let status = "active",
      price = "price_pro";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input).startsWith("https://api.stripe.com/v1/")).toBe(true);
      expect(init?.redirect).toBe("error");
      return Response.json(
        String(input).includes("checkout")
          ? { url: "https://checkout.stripe.com/c/pay" }
          : {
              id: "sub_1",
              status,
              metadata: { crot_account_id: "user_01" },
              items: { data: [{ price: { id: price }, current_period_end: now / 1000 + 3600 }] },
            },
      );
    });
    const p = new StripeBillingProvider({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      prices: { pro: "price_pro", team: "price_team" },
      returnUrl: "https://crot.example/account",
      now: () => now,
      fetch: fetcher,
    });
    return {
      p,
      fetcher,
      setStatus: (s: string) => {
        status = s;
      },
      setPrice: (s: string) => {
        price = s;
      },
    };
  }
  it("checks timestamp/raw-body HMAC before any provider call", async () => {
    const { p, fetcher } = fixture();
    const raw = event();
    for (const sig of [
      "t=1,v1=" + "0".repeat(64),
      signature(raw, now / 1000 - 301),
      signature(Buffer.from("different")),
      "t=1,t=2,v1=" + "0".repeat(64),
    ])
      await expect(p.verifyAndResolve(raw, sig)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await p.verifyAndResolve(raw, signature(raw))).toMatchObject({
      accountId: "user_01",
      plan: "pro",
      status: "active",
    });
  });
  it("reordered activation event cannot restore a canceled authoritative subscription", async () => {
    const { p, setStatus } = fixture();
    const a = new AccountService({ now: () => now });
    let raw = event();
    await a.billing(p, raw, signature(raw));
    expect(a.snapshot("user_01").entitled).toBe(true);
    setStatus("canceled");
    raw = event("evt_2", "customer.subscription.deleted");
    await a.billing(p, raw, signature(raw));
    raw = event("evt_old", "customer.subscription.created");
    await a.billing(p, raw, signature(raw));
    expect(a.snapshot("user_01").entitled).toBe(false);
  });
  it("rejects unknown price and never trusts webhook metadata or event status", async () => {
    const { p, setPrice } = fixture();
    setPrice("price_foreign");
    const raw = event();
    await expect(p.verifyAndResolve(raw, signature(raw))).rejects.toThrow();
  });
  it("creates hosted checkout with only server-selected prices and account metadata", async () => {
    const { p, fetcher } = fixture();
    expect(await p.checkout("user_01", "team")).toBe("https://checkout.stripe.com/c/pay");
    const form = new URLSearchParams(fetcher.mock.calls[0]![1]?.body as string);
    expect(form.get("line_items[0][price]")).toBe("price_team");
    expect(form.get("subscription_data[metadata][crot_account_id]")).toBe("user_01");
  });
  it("WorkOS uses session revoke API, never stores server credentials on device", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await new WorkOSRevoker("sk_cloud", fetcher).revokeSession("session_A");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.workos.com/user_management/sessions/revoke",
      expect.objectContaining({ method: "POST", body: '{"session_id":"session_A"}', redirect: "error" }),
    );
    await expect(new WorkOSRevoker("sk_cloud", fetcher).revokeSession("../arbitrary")).rejects.toThrow();
  });
});

describe("OD-11 admission compatibility", () => {
  it("has a twelve-month minimum major support policy", () =>
    expect(MINIMUM_MAJOR_SUPPORT_MONTHS).toBeGreaterThanOrEqual(12));
  it.each([
    ["0.1.0", true],
    ["0.2.0", true],
    ["1.0.0", true],
    ["0.0.9", false],
    ["garbage", false],
    [undefined, false],
    ["0.1.0-beta", false],
  ])("version %s admission %s", (v, result) => expect(versionAtLeast(v, "0.1.0")).toBe(result));
});
