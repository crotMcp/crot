import { describe, expect, it, vi } from "vitest";
import { PLAN_CATALOG } from "../../src/account-service/catalog.js";
import { StripeBillingProvider } from "../../src/account-service/billing.js";

describe("Owner-approved Pro price", () => {
  it("advertises USD 3 per month and seven trial days", () => {
    expect(PLAN_CATALOG.pro).toEqual({ monthlyUsdCents: 300, currency: "usd", interval: "month", trialDays: 7 });
  });
  it.each([
    { unit_amount: 1500 },
    { currency: "eur" },
    { active: false },
    { id: "price_other" },
    { recurring: { interval: "year", interval_count: 1 } },
    { recurring: { interval: "month", interval_count: 3 } },
  ])("rejects mismatched configured Stripe price before opening Checkout: %j", async (override) => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      Response.json({
        id: "price_pro",
        active: true,
        unit_amount: 300,
        currency: "usd",
        recurring: { interval: "month", interval_count: 1 },
        ...override,
      }),
    );
    const provider = new StripeBillingProvider({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      prices: { pro: "price_pro", team: "price_team" },
      returnUrl: "https://crot.example/portal",
      fetch: fetcher,
    });
    await expect(provider.checkout("user_price", "trial")).rejects.toThrow("USD 3 per month");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("checkout");
  });
});
