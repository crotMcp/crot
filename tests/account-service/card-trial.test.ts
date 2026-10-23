import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider } from "../../src/account-service/billing.js";
import { AccountService } from "../../src/account-service/service.js";

const now = 1900000000000;
const raw = Buffer.from(
  JSON.stringify({ id: "evt_trial", type: "customer.subscription.created", data: { object: { id: "sub_trial" } } }),
);
const signature = `t=${now / 1000},v1=${createHmac("sha256", "whsec_test")
  .update(`${now / 1000}.`)
  .update(raw)
  .digest("hex")}`;
function fixture(overrides: object = {}) {
  const subscription = {
    id: "sub_trial",
    status: "trialing",
    metadata: { crot_account_id: "user_trial", crot_trial: "7-day-card" },
    default_payment_method: "pm_verified",
    trial_start: now / 1000,
    trial_end: now / 1000 + 7 * 86400,
    items: { data: [{ price: { id: "price_pro" } }] },
    ...overrides,
  };
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    Response.json(
      String(input).includes("/prices/")
        ? {
            id: "price_pro",
            active: true,
            unit_amount: 300,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          }
        : String(input).includes("checkout/sessions")
          ? { url: "https://checkout.stripe.com/test" }
          : subscription,
    ),
  );
  const provider = new StripeBillingProvider({
    secretKey: "sk_test",
    webhookSecret: "whsec_test",
    prices: { pro: "price_pro", team: "price_team" },
    returnUrl: "https://crot.example/portal",
    now: () => now,
    fetch: fetcher,
  });
  return { provider, fetcher };
}
describe("Card-backed seven-day trial", () => {
  it("requires a card and seven provider trial days; checkout itself grants no entitlement", async () => {
    const { provider, fetcher } = fixture();
    const account = new AccountService({ now: () => now });
    await provider.checkout("user_trial", "trial");
    expect(account.snapshot("user_trial").entitled).toBe(false);
    const init = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    const form = new URLSearchParams(init[1].body as string);
    expect(form.get("payment_method_collection")).toBe("always");
    expect(form.get("subscription_data[trial_period_days]")).toBe("7");
    expect(form.get("line_items[0][price]")).toBe("price_pro");
    expect(form.get("subscription_data[metadata][crot_account_id]")).toBe("user_trial");
    // Inspect the actual request, not a duplicated implementation constant.
    expect(init[0]).toBe("https://api.stripe.com/v1/checkout/sessions");
  });
  it("grants only the verified trial, with two devices and exact expiry", async () => {
    const { provider } = fixture();
    const account = new AccountService({ now: () => now });
    await account.billing(provider, raw, signature);
    expect(account.snapshot("user_trial")).toMatchObject({
      plan: "trial",
      entitled: true,
      maxDevices: 2,
      expiresAt: now + 7 * 86400000,
    });
    expect(account.trialAvailable("user_trial")).toBe(false);
  });
  it.each([
    { default_payment_method: undefined },
    { trial_end: now / 1000 + 14 * 86400 },
    { metadata: { crot_account_id: "user_trial" } },
  ])("refuses unverified trial data %j", async (overrides) => {
    const { provider } = fixture(overrides);
    await expect(provider.verifyAndResolve(raw, signature)).rejects.toThrow("unverified card-backed trial");
  });
  it("rejects a tampered webhook before provider access", async () => {
    const { provider, fetcher } = fixture();
    await expect(provider.verifyAndResolve(Buffer.from("tampered"), signature)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
