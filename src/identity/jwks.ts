/**
 * The issuer's signing keys (ARCHITECTURE.md §27, AD-21 points 2 and 7).
 *
 * - The JWKS location comes from the configured issuer's authorization server
 *   metadata (never from a token: `jku`, `x5u` and embedded `jwk` headers are
 *   never used), fetched directly from the issuer over TLS.
 * - Only RSA signature keys usable with RS256 (modulus of at least 2048 bits)
 *   with a unique `kid` are kept.
 * - Cached; refreshed when older than `maxAgeMs`, and refetched on an unknown
 *   `kid` at most once per `minRefetchIntervalMs` (key rotation, without
 *   letting unknown key ids drive the device into fetching on every request).
 *   A refresh replaces the whole set, so a key the issuer withdrew stops
 *   verifying at the next refresh.
 * - When the issuer cannot be reached, the last good set is used for at most
 *   `maxStaleMs` after it was fetched; then no key is known and every token is
 *   rejected (fail closed).
 */
import { createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import { discoverAuthorizationServer, type AuthorizationServerMetadata } from "./authorization-server.js";
import { IdentityHttpError, type IdentityHttp } from "./http.js";

const MAX_KEYS = 32;
const MIN_RSA_BITS = 2048;

export interface KeySetOptions {
  readonly issuer: string;
  readonly http: IdentityHttp;
  readonly now?: () => number;
  /** Shortest interval between two fetches triggered by an unknown kid (default 30 s). */
  readonly minRefetchIntervalMs?: number;
  /** Age after which the set is refreshed before use (default 10 min). */
  readonly maxAgeMs?: number;
  /** Longest use of the last good set while the issuer cannot be reached (default 1 h). */
  readonly maxStaleMs?: number;
  /** Diagnostics: why a fetch failed (never a token or key material). */
  readonly onError?: (message: string) => void;
}

/** Where a verifier gets its keys from. */
export interface SigningKeySource {
  /** The key for `kid`; "unavailable" when no current key set could be obtained. */
  keyFor(kid: string): Promise<KeyObject | undefined | "unavailable">;
}

export interface KeySetStatus {
  readonly keys: number;
  readonly fetchedAt?: string;
  readonly lastError?: string;
  readonly issParameterSupported?: boolean;
}

interface Loaded {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly fetchedAt: number;
  readonly metadata: AuthorizationServerMetadata;
}

/** Parse a JWKS document into RS256 verification keys by kid. Unusable entries are skipped. */
export function parseJwks(doc: unknown): Map<string, KeyObject> {
  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { keys?: unknown }).keys))
    throw new IdentityHttpError("JWKS is not a key set");
  const entries = (doc as { keys: unknown[] }).keys;
  const keys = new Map<string, KeyObject>();
  const duplicate = new Set<string>();
  for (const entry of entries.slice(0, MAX_KEYS * 4)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const jwk = entry as Record<string, unknown>;
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || jwk.kid.length === 0 || jwk.kid.length > 256) continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify")) continue;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    if (keys.has(jwk.kid) || duplicate.has(jwk.kid)) {
      keys.delete(jwk.kid);
      duplicate.add(jwk.kid);
      continue;
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" });
    } catch {
      continue;
    }
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) continue;
    keys.set(jwk.kid, key);
    if (keys.size >= MAX_KEYS) break;
  }
  return keys;
}

export class IssuerKeySet implements SigningKeySource {
  private loaded: Loaded | undefined;
  private inflight: Promise<void> | undefined;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private lastError: string | undefined;
  private readonly now: () => number;
  private readonly minRefetch: number;
  private readonly maxAge: number;
  private readonly maxStale: number;

  constructor(private readonly options: KeySetOptions) {
    this.now = options.now ?? Date.now;
    this.minRefetch = options.minRefetchIntervalMs ?? 30_000;
    this.maxAge = options.maxAgeMs ?? 10 * 60_000;
    this.maxStale = options.maxStaleMs ?? 60 * 60_000;
  }

  get issuer(): string {
    return this.options.issuer;
  }

  status(): KeySetStatus {
    return {
      keys: this.loaded?.keys.size ?? 0,
      ...(this.loaded ? { fetchedAt: new Date(this.loaded.fetchedAt).toISOString() } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.loaded ? { issParameterSupported: this.loaded.metadata.issParameterSupported } : {}),
    };
  }

  /** The issuer's metadata (fetched with the keys). */
  async metadata(): Promise<AuthorizationServerMetadata> {
    if (!this.loaded || this.now() - this.loaded.fetchedAt >= this.maxAge) await this.refresh(true);
    if (!this.loaded) throw new IdentityHttpError(this.lastError ?? "the issuer cannot be reached");
    return this.loaded.metadata;
  }

  async keyFor(kid: string): Promise<KeyObject | undefined | "unavailable"> {
    const now = this.now();
    if (!this.loaded || now - this.loaded.fetchedAt >= this.maxAge) {
      await this.refresh(false);
    } else if (!this.loaded.keys.has(kid)) {
      // Unknown kid: possibly a rotated key; refetch at a bounded rate.
      if (now - this.lastAttempt >= this.minRefetch) await this.refresh(false);
    }
    const loaded = this.loaded;
    if (!loaded || this.now() - loaded.fetchedAt >= this.maxStale) return "unavailable";
    return loaded.keys.get(kid);
  }

  /** Fetch metadata and keys (single flight). A failed attempt keeps the last good set. */
  private refresh(force: boolean): Promise<void> {
    if (this.inflight) return this.inflight;
    const now = this.now();
    // A failing issuer is not asked more often than minRefetch, even when the set is stale.
    if (!force && this.lastError !== undefined && now - this.lastAttempt < this.minRefetch) return Promise.resolve();
    this.lastAttempt = now;
    this.inflight = (async () => {
      try {
        const metadata = await discoverAuthorizationServer(this.options.issuer, this.options.http);
        const keys = parseJwks(await this.options.http.getJson(metadata.jwksUri));
        this.loaded = { keys, fetchedAt: this.now(), metadata };
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.onError?.(`identity: cannot fetch the issuer's keys: ${this.lastError}`);
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}
