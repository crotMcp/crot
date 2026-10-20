/** Bounded admission state: untrusted identities cannot create unbounded counters. */
export interface RateLimit {
  readonly max: number;
  readonly windowMs: number;
}
export interface RelayLimits {
  readonly clientRequests: RateLimit;
  readonly deviceRequests: RateLimit;
  readonly accountRegistrations: RateLimit;
  readonly globalConcurrency: number;
  readonly clientConcurrency: number;
  readonly deviceConcurrency: number;
  readonly sourceConnections: number;
  readonly sourceHandshakes: number;
  readonly counterKeys: number;
}
export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  clientRequests: { max: 120, windowMs: 60_000 },
  deviceRequests: { max: 600, windowMs: 60_000 },
  accountRegistrations: { max: 10, windowMs: 60_000 },
  globalConcurrency: 64,
  clientConcurrency: 4,
  deviceConcurrency: 32,
  sourceConnections: 64,
  sourceHandshakes: 8,
  counterKeys: 10_000,
};
export function relayLimits(value: unknown = {}): RelayLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("limits must be an object");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!(key in DEFAULT_RELAY_LIMITS)) throw new Error("unknown relay limit: " + key);
  const result = { ...DEFAULT_RELAY_LIMITS, ...v } as unknown as RelayLimits;
  for (const [key, val] of Object.entries(result)) {
    if (typeof DEFAULT_RELAY_LIMITS[key as keyof RelayLimits] === "object") {
      const r = val as RateLimit;
      if (!r || Object.keys(r).sort().join(",") !== "max,windowMs" || !positive(r.max) || !positive(r.windowMs))
        throw new Error("invalid rate limit: " + key);
    } else if (!positive(val)) throw new Error("invalid relay limit: " + key);
  }
  if (
    result.deviceConcurrency > result.globalConcurrency ||
    result.clientConcurrency > result.deviceConcurrency ||
    result.sourceHandshakes > result.sourceConnections
  )
    throw new Error("client/source handshake limit exceeds its parent limit");
  return result;
}
function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 1_000_000;
}
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}
  take(key: string): number | undefined {
    const now = this.now();
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      for (const [k, hits] of this.hits) if (hits.every((t) => now - t >= this.limit.windowMs)) this.hits.delete(k);
      if (this.hits.size >= this.maxKeys) return this.limit.windowMs;
    }
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.limit.windowMs);
    if (list.length >= this.limit.max) {
      this.hits.set(key, list);
      return Math.max(1, this.limit.windowMs - (now - list[0]!));
    }
    list.push(now);
    this.hits.set(key, list);
    return undefined;
  }
  full(key: string): boolean {
    return (this.hits.get(key) ?? []).filter((t) => this.now() - t < this.limit.windowMs).length >= this.limit.max;
  }
}
