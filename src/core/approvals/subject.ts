import { createHash, randomBytes } from "node:crypto";
import type { ApprovalSubject } from "./types.js";

/**
 * Canonical JSON: object keys in code-point order, no whitespace, `undefined`
 * members omitted. The same subject always produces the same text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("Value cannot be serialized canonically.");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 (hex) of the canonical UTF-8 JSON of the subject. */
export function subjectDigest(subject: ApprovalSubject): string {
  return createHash("sha256").update(canonicalJson(subject), "utf8").digest("hex");
}

/** A new 128-bit random request id. */
export function newApprovalRequestId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * WHATWG origin serialization of an http: or https: URL (lowercase scheme
 * and host, punycode host, default port omitted). Undefined for anything
 * else: opaque origins and other schemes never match (AD-11).
 */
export function normalizedHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const origin = url.origin;
  return origin === "null" ? undefined : origin;
}
