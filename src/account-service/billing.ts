/** Provider credentials remain on the cloud host. No Core or device dependency. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthorizationRevoker, SubscriptionStatus } from "./service.js";
export interface SubscriptionUpdate {
  eventId: string;
  accountId: string;
  subscriptionId: string;
  plan: "trial" | "pro" | "team";
  status: SubscriptionStatus;
  expiresAt: number;
}
export interface BillingProvider {
  verifyAndResolve(raw: Buffer, signature: string): Promise<SubscriptionUpdate | undefined>;
  checkout(accountId: string, plan: "trial" | "pro" | "team"): Promise<string>;
  portal?(accountId: string, subscriptionId: string): Promise<string>;
}
/** Bounded, fixed-provider HTTPS; redirects never carry server credentials to another host. */
async function providerJson(url: string, key: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { ...init.headers, authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("provider request failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider response missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 256 * 1024) throw new Error("provider response too large");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export class StripeBillingProvider implements BillingProvider {
  constructor(
    private readonly options: {
      secretKey: string;
      webhookSecret: string;
      prices: { pro: string; team: string };
      returnUrl: string;
      now?: () => number;
      fetch?: typeof fetch;
    },
  ) {
    if (
      !options.secretKey ||
      !options.webhookSecret ||
      options.prices.pro === options.prices.team ||
      !/^price_[A-Za-z0-9]+$/.test(options.prices.pro) ||
      !/^price_[A-Za-z0-9]+$/.test(options.prices.team) ||
      new URL(options.returnUrl).protocol !== "https:"
    )
      throw new Error("invalid billing configuration");
  }
  async checkout(accountId: string, plan: "trial" | "pro" | "team"): Promise<string> {
    const fields = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": this.options.prices[plan === "trial" ? "pro" : plan],
      "line_items[0][quantity]": "1",
      success_url: this.options.returnUrl,
      cancel_url: this.options.returnUrl,
      "subscription_data[metadata][crot_account_id]": accountId,
    });
    if (plan === "trial") {
      fields.set("payment_method_collection", "always");
      fields.set("subscription_data[trial_period_days]", "7");
      fields.set("subscription_data[metadata][crot_trial]", "7-day-card");
      fields.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel");
    }
    const doc = (await providerJson(
      "https://api.stripe.com/v1/checkout/sessions",
      this.options.secretKey,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(plan === "trial"
            ? {
                "Idempotency-Key":
                  "crot-trial-" + createHmac("sha256", this.options.secretKey).update(accountId).digest("hex"),
              }
            : {}),
        },
        body: fields.toString(),
      },
      this.options.fetch ?? fetch,
    )) as { url?: unknown };
    if (typeof doc.url !== "string" || new URL(doc.url).origin !== "https://checkout.stripe.com")
      throw new Error("invalid checkout response");
    return doc.url;
  }
  async portal(accountId: string, subscriptionId: string): Promise<string> {
    if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) throw new Error("invalid subscription");
    const subscription = (await providerJson(
      `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
      this.options.secretKey,
      { method: "GET" },
      this.options.fetch ?? fetch,
    )) as { customer?: string; metadata?: { crot_account_id?: string } };
    if (subscription.metadata?.crot_account_id !== accountId || !/^cus_[A-Za-z0-9]+$/.test(subscription.customer ?? ""))
      throw new Error("subscription ownership mismatch");
    const result = (await providerJson(
      "https://api.stripe.com/v1/billing_portal/sessions",
      this.options.secretKey,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ customer: subscription.customer!, return_url: this.options.returnUrl }).toString(),
      },
      this.options.fetch ?? fetch,
    )) as { url?: string };
    if (typeof result.url !== "string" || new URL(result.url).origin !== "https://billing.stripe.com")
      throw new Error("invalid billing portal");
    return result.url;
  }
  async verifyAndResolve(raw: Buffer, signature: string): Promise<SubscriptionUpdate | undefined> {
    if (raw.length > 64 * 1024 || signature.length > 2048) throw new Error("invalid webhook");
    const parts = signature.split(","),
      times = parts.filter((p) => p.startsWith("t="));
    if (times.length !== 1 || !/^t=\d{1,12}$/.test(times[0]!)) throw new Error("invalid webhook");
    const time = Number(times[0]!.slice(2));
    if (Math.abs((this.options.now ?? Date.now)() / 1000 - time) > 300) throw new Error("stale webhook");
    const digest = createHmac("sha256", this.options.webhookSecret).update(`${time}.`).update(raw).digest();
    if (!parts.some((p) => /^v1=[a-f0-9]{64}$/.test(p) && timingSafeEqual(Buffer.from(p.slice(3), "hex"), digest)))
      throw new Error("invalid webhook signature");
    const event = JSON.parse(raw.toString("utf8")) as {
      id?: unknown;
      type?: unknown;
      data?: { object?: { id?: unknown } };
    };
    if (
      !["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(
        String(event.type),
      )
    )
      return undefined;
    const id = event.data?.object?.id;
    if (typeof event.id !== "string" || typeof id !== "string" || !/^sub_[A-Za-z0-9]+$/.test(id))
      throw new Error("invalid subscription event");
    // Never grant from an event snapshot: Stripe retries/out-of-order events resolve to the current subscription.
    const s = (await providerJson(
      `https://api.stripe.com/v1/subscriptions/${id}`,
      this.options.secretKey,
      { method: "GET" },
      this.options.fetch ?? fetch,
    )) as {
      id?: string;
      status?: string;
      metadata?: { crot_account_id?: string; crot_trial?: string };
      default_payment_method?: string;
      trial_start?: number;
      trial_end?: number;
      current_period_end?: number;
      items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number }> };
    };
    const items = s.items?.data;
    if (s.id !== id || !items || items.length !== 1 || !s.metadata?.crot_account_id)
      throw new Error("unknown subscription");
    const price = items[0]?.price?.id;
    const paidPlan =
      price === this.options.prices.pro ? "pro" : price === this.options.prices.team ? "team" : undefined;
    const trial = s.status === "trialing";
    if (
      trial &&
      (s.metadata.crot_trial !== "7-day-card" ||
        !/^pm_[A-Za-z0-9]+$/.test(s.default_payment_method ?? "") ||
        !Number.isSafeInteger(s.trial_start) ||
        !Number.isSafeInteger(s.trial_end) ||
        s.trial_end! - s.trial_start! !== 7 * 86400 ||
        paidPlan !== "pro")
    )
      throw new Error("unverified card-backed trial");
    const plan = trial ? "trial" : paidPlan;
    const expiry = trial ? s.trial_end : (s.current_period_end ?? items[0]?.current_period_end);
    if (!plan || !Number.isSafeInteger(expiry)) throw new Error("unknown subscription price or expiry");
    const status: SubscriptionStatus =
      s.status === "active" || trial
        ? "active"
        : s.status === "past_due"
          ? "past_due"
          : s.status === "canceled"
            ? "canceled"
            : "expired";
    return {
      eventId: event.id,
      accountId: s.metadata.crot_account_id,
      subscriptionId: id,
      plan,
      status,
      expiresAt: expiry! * 1000,
    };
  }
}
/** WorkOS AuthKit session API. Only a verified token's sid is eligible; no account-wide guessing. */
export class WorkOSRevoker implements AuthorizationRevoker {
  constructor(
    private readonly secretKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async revokeSession(sessionId: string): Promise<void> {
    if (!/^session_[A-Za-z0-9]+$/.test(sessionId)) throw new Error("invalid provider session");
    const response = await this.fetcher("https://api.workos.com/user_management/sessions/revoke", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("provider revocation failed");
  }
}
