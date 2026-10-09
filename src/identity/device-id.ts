/**
 * Device identity and the canonical device resource URI (ARCHITECTURE.md §27,
 * AD-21 points 5 and 6; decides roadmap OD-3).
 *
 * - `<deviceId>`: 16 random bytes as lowercase RFC 4648 base32 without
 *   padding (26 characters, `[a-z2-7]`). It is not secret and carries no
 *   authority by itself. Only the canonical encoding is accepted (the two
 *   unused trailing bits are zero), so one device has exactly one spelling.
 * - Canonical resource URI: `https://<relay-host>/d/<deviceId>/mcp` —
 *   lowercase, no port, query, fragment, trailing slash or percent-encoding,
 *   compared byte for byte (never normalized).
 * - Protected Resource Metadata (RFC 9728 section 3.1, suffix inserted before
 *   the path): `https://<relay-host>/.well-known/oauth-protected-resource/d/<deviceId>/mcp`.
 *
 * This module is adapter-level: Core never sees device identity except as the
 * verified `deviceId` of a remote principal.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** Length of a device id: ceil(128 / 5). */
export const DEVICE_ID_LENGTH = 26;
const DEVICE_ID_PATTERN = /^[a-z2-7]{26}$/;

/** Lowercase RFC 4648 base32 without padding. */
export function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** A new random device id (AD-21 point 5). Assigned once per pairing. */
export function generateDeviceId(): string {
  return base32Lower(randomBytes(16));
}

/**
 * Whether `value` is a device id in its only (canonical) spelling: 26
 * characters of `[a-z2-7]` whose last character leaves the two padding bits
 * zero (130 encoded bits, 128 used).
 */
export function isDeviceId(value: unknown): value is string {
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) return false;
  const last = ALPHABET.indexOf(value[DEVICE_ID_LENGTH - 1]!);
  return (last & 0b11) === 0;
}

/**
 * Whether `value` is a relay host as AD-21 point 5 requires: a lowercase DNS
 * name (at least two labels, LDH labels of 1–63 characters), no port, no
 * IP literal, no trailing dot.
 */
export function isRelayHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** The canonical device resource URI `https://<relay-host>/d/<deviceId>/mcp` (AD-21 point 5). */
export function canonicalDeviceUri(relayHost: string, deviceId: string): string {
  if (!isRelayHost(relayHost)) throw new Error("not a valid relay host");
  if (!isDeviceId(deviceId)) throw new Error("not a valid device id");
  return `https://${relayHost}/d/${deviceId}/mcp`;
}

/** The PRM location of a device (AD-21 point 6), built from the device's own canonical URI. */
export function protectedResourceMetadataUrl(relayHost: string, deviceId: string): string {
  if (!isRelayHost(relayHost)) throw new Error("not a valid relay host");
  if (!isDeviceId(deviceId)) throw new Error("not a valid device id");
  return `https://${relayHost}/.well-known/oauth-protected-resource/d/${deviceId}/mcp`;
}
