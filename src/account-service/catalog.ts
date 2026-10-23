/** Public display contract. Stripe price IDs remain operator configuration, never device authority. */
export const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({ monthlyUsdCents: 0, advertisedProjects: 3 }),
  pro: Object.freeze({ monthlyUsdCents: 300, currency: "usd", interval: "month", trialDays: 7 }),
});
