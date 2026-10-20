/**
 * The device's OAuth access-token verifier behind `AccessTokenVerifier`
 * (ARCHITECTURE.md §27, AD-15 point 4, AD-21 points 2–4; WP-28).
 *
 * Verification order (AD-21 point 3), every failure is a rejection (the HTTP
 * pipeline answers 401 with `WWW-Authenticate`):
 *
 * 1. signature and `alg` (RS256, key from the configured issuer's JWKS);
 * 2. `iss` equal, byte for byte, to the configured issuer;
 * 3. `aud`: exactly one value equal, byte for byte, to this device's
 *    canonical resource URI — the device claim (AD-21 point 5);
 * 4. `exp` and `iat` required, `nbf` checked when present, 60 s clock skew
 *    for `nbf` and an `iat` in the future, `iat` not more than 15 minutes in
 *    the past (the device's own ceiling, AD-21 point 4);
 * 5. `sub` equal to the account this device was paired with (an unpaired
 *    device, or one paired in another identity environment, accepts no token);
 * 6. `client_id` present.
 *
 * Revocation of a client on this device (AD-21 point 4 (a)) is checked next
 * by the relay entry point's admission (403 before MCP or Core). There is no
 * per-request call to the provider or the relay.
 *
 * Only `iss`, `aud`, `sub`, `client_id` and the time claims reach device authorization. A verified AuthKit `sid` may be used only by the cloud for best-effort provider revocation. All are trusted only
 * after the signature check. `scope`, `sid`, `jti`, `org_id`, roles,
 * profile claims and anything else in the token never reach the principal:
 * token contents never grant capabilities (AD-15 point 4). The token itself
 * is never logged; rejections are reported by reason code only.
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AccessTokenVerifier } from "../adapters/http/auth.js";
import { canonicalDeviceUri } from "./device-id.js";
import type { IdentityEnvironment } from "./environment.js";
import type { SigningKeySource } from "./jwks.js";
import { verifyJws, type JwsFailure } from "./jwt.js";

/** Authentication method of verified OAuth access tokens (AD-21 point 3). */
export const OAUTH_AUTH_METHOD = "oauth";
/** Clock skew tolerated for `nbf` and `iat` (AD-21 point 2). */
export const CLOCK_SKEW_SECONDS = 60;
/** The device's ceiling on token age after `iat` (AD-21 point 4). */
export const MAX_TOKEN_AGE_SECONDS = 15 * 60;
/** Longest accepted `sub` / `client_id` (the remote client registry's limit). */
const MAX_ID_LENGTH = 512;

export type TokenRejection =
  | JwsFailure
  | "issuer"
  | "audience"
  | "missing_time"
  | "expired"
  | "not_yet_valid"
  | "issued_in_future"
  | "too_old"
  | "not_paired"
  | "binding_unavailable"
  | "environment_mismatch"
  | "subject"
  | "account"
  | "client_id";

/** The device binding as the verifier sees it (written only by pairing and unpairing). */
export type BindingView =
  | {
      readonly state: "paired";
      readonly deviceId: string;
      readonly accountId: string;
      readonly issuer: string;
      readonly relayHost: string;
    }
  | { readonly state: "unpaired" }
  | { readonly state: "unavailable"; readonly error: string };

export interface VerifiedToken {
  readonly subject: string;
  readonly clientId: string;
  readonly audience: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Cloud-only provider revocation metadata; never copied into the principal. */
  readonly sessionId?: string;
}

export type TokenCheck =
  { readonly ok: true; readonly token: VerifiedToken } | { readonly ok: false; readonly reason: TokenRejection };

const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH && !v.includes("\0");
const numericDate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Steps 1–4 and 6 for a given audience, and step 5 when `account` is given.
 * Pairing uses it without an account: the token of the pairing sign-in
 * establishes the account (its `sub`).
 */
export async function checkAccessToken(
  token: string,
  expected: {
    readonly issuer: string;
    readonly audience: string;
    readonly account?: string;
    readonly keys: SigningKeySource;
    readonly nowSeconds: number;
  },
): Promise<TokenCheck> {
  const jws = await verifyJws(token, expected.keys);
  if (!jws.ok) return jws;
  const c = jws.claims;
  if (c.iss !== expected.issuer) return { ok: false, reason: "issuer" };
  const aud = Array.isArray(c.aud) ? (c.aud.length === 1 ? c.aud[0] : undefined) : c.aud;
  if (typeof aud !== "string" || aud !== expected.audience) return { ok: false, reason: "audience" };
  if (!numericDate(c.exp) || !numericDate(c.iat)) return { ok: false, reason: "missing_time" };
  if (c.nbf !== undefined && !numericDate(c.nbf)) return { ok: false, reason: "missing_time" };
  const now = expected.nowSeconds;
  // exp gets no leeway: a device clock ahead of the issuer only makes the client refresh earlier.
  if (c.exp <= now) return { ok: false, reason: "expired" };
  if (c.nbf !== undefined && (c.nbf as number) > now + CLOCK_SKEW_SECONDS)
    return { ok: false, reason: "not_yet_valid" };
  if (c.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "issued_in_future" };
  if (now - c.iat > MAX_TOKEN_AGE_SECONDS) return { ok: false, reason: "too_old" };
  if (!validId(c.sub)) return { ok: false, reason: "subject" };
  if (expected.account !== undefined && c.sub !== expected.account) return { ok: false, reason: "account" };
  if (!validId(c.client_id)) return { ok: false, reason: "client_id" };
  return {
    ok: true,
    token: {
      subject: c.sub,
      clientId: c.client_id,
      audience: aud,
      issuedAt: c.iat,
      expiresAt: c.exp,
      ...(typeof c.sid === "string" && /^session_[A-Za-z0-9]+$/.test(c.sid) ? { sessionId: c.sid } : {}),
    },
  };
}

export interface OAuthVerifierOptions {
  /** The identity environment active in this process. */
  readonly environment: IdentityEnvironment;
  /** The configured issuer's signing keys. */
  readonly keys: SigningKeySource;
  /** The device binding, read on every request (pairing and unpairing take effect at once). */
  readonly binding: () => BindingView;
  readonly now?: () => number;
  /** Rejections by reason code (diagnostics; never the token or its claims). */
  readonly onReject?: (reason: TokenRejection) => void;
}

/**
 * `AccessTokenVerifier` of the relay entry point. AuthInfo carries only
 * verified facts: `clientId` from `client_id`; `extra.subject` and
 * `extra.accountId` from `sub`; `extra.deviceId` from the paired binding the
 * `aud` was checked against; `extra.issuedAt` from `iat` (re-grant boundary);
 * no scopes.
 */
export class OAuthAccessTokenVerifier implements AccessTokenVerifier {
  readonly method = OAUTH_AUTH_METHOD;
  private readonly now: () => number;

  constructor(private readonly options: OAuthVerifierOptions) {
    this.now = options.now ?? Date.now;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo | undefined> {
    const reject = (reason: TokenRejection): undefined => {
      this.options.onReject?.(reason);
      return undefined;
    };
    const binding = this.options.binding();
    if (binding.state === "unavailable") return reject("binding_unavailable");
    if (binding.state !== "paired") return reject("not_paired");
    const env = this.options.environment;
    if (binding.issuer !== env.issuer || binding.relayHost !== env.relayHost) return reject("environment_mismatch");
    const audience = canonicalDeviceUri(binding.relayHost, binding.deviceId);
    const checked = await checkAccessToken(token, {
      issuer: env.issuer,
      audience,
      account: binding.accountId,
      keys: this.options.keys,
      nowSeconds: this.now() / 1000,
    });
    if (!checked.ok) return reject(checked.reason);
    // The binding may have changed while the keys were fetched: the request is judged against the current one.
    const current = this.options.binding();
    if (current.state !== "paired" || current.deviceId !== binding.deviceId || current.accountId !== binding.accountId)
      return reject("not_paired");
    const t = checked.token;
    return {
      token,
      clientId: t.clientId,
      scopes: [],
      expiresAt: Math.floor(t.expiresAt),
      resource: new URL(t.audience),
      extra: {
        subject: t.subject,
        authMethod: OAUTH_AUTH_METHOD,
        accountId: t.subject,
        deviceId: binding.deviceId,
        issuedAt: t.issuedAt,
      },
    };
  }
}

/** A relay verifier for a process without an identity environment: every token is rejected. */
export class UnavailableTokenVerifier implements AccessTokenVerifier {
  readonly method = OAUTH_AUTH_METHOD;
  async verifyAccessToken(): Promise<AuthInfo | undefined> {
    return undefined;
  }
}
