/**
 * Compact JWS verification for access tokens (ARCHITECTURE.md §27, AD-21
 * point 2, "Signature" row): RS256 only, the key chosen by `kid` from the
 * configured issuer's JWKS. No other algorithm is accepted (in particular not
 * `none` and no HMAC), and no header can point at a key (`jku`, `x5u`, `jwk`
 * and `x5c` are never used). A header with `crit` is rejected, because no
 * extension is understood.
 */
import { verify as verifySignature } from "node:crypto";
import type { SigningKeySource } from "./jwks.js";

/** Longest accepted token (characters). */
export const MAX_TOKEN_LENGTH = 16 * 1024;

export type JwsFailure = "malformed" | "unsupported_alg" | "unknown_key" | "keys_unavailable" | "bad_signature";

export type JwsResult =
  | {
      readonly ok: true;
      readonly header: Readonly<Record<string, unknown>>;
      readonly claims: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly reason: JwsFailure };

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function decodeSegment(segment: string): Buffer | undefined {
  if (!BASE64URL.test(segment) || segment.length % 4 === 1) return undefined;
  const bytes = Buffer.from(segment, "base64url");
  // Only the canonical encoding (re-encoding yields the same text).
  return bytes.toString("base64url") === segment ? bytes : undefined;
}

function decodeObject(segment: string): Record<string, unknown> | undefined {
  const bytes = decodeSegment(segment);
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Verify the signature of a compact JWS and return its header and claims. */
export async function verifyJws(token: string, keys: SigningKeySource): Promise<JwsResult> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeObject(h);
  const claims = decodeObject(p);
  const signature = decodeSegment(s);
  if (!header || !claims || !signature || signature.length === 0) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (header.crit !== undefined) return { ok: false, reason: "unsupported_alg" };
  if (header.b64 !== undefined) return { ok: false, reason: "unsupported_alg" };
  if (typeof header.kid !== "string" || header.kid.length === 0) return { ok: false, reason: "unknown_key" };
  const key = await keys.keyFor(header.kid);
  if (key === "unavailable") return { ok: false, reason: "keys_unavailable" };
  if (!key) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    valid = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`, "ascii"), key, signature);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, header, claims } : { ok: false, reason: "bad_signature" };
}
