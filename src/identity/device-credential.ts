/**
 * The device credential (ARCHITECTURE.md §27, AD-15 points 10 and 11, AD-21
 * point 4; WP-28).
 *
 * An Ed25519 key pair created at pairing. The private key (its 32-byte seed)
 * is kept only in the CROT secret store (`device-key`, AD-18) and never
 * leaves the service: not to Core, the audit log, logs, child processes or
 * any outbound request. The public key is what the CROT cloud records for
 * the device (WP-29/WP-36).
 *
 * The credential proves to the relay which device holds the tunnel; it never
 * authenticates an MCP request (every request carries its own client token).
 * It signs only domain-separated tunnel and deregistration challenges, never
 * arbitrary messages. The removal domain is `crot-device-deregister-v1`;
 * the two proof types are not interchangeable. It cannot be used as
 * a general signing oracle: the signed message is
 * `crot-device-tunnel-v1 \0 <deviceId> \0 <relayHost> \0 <challenge>`.
 * The relay protocol that sends the challenge is WP-29/WP-30.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/** DER prefix of a PKCS #8 Ed25519 private key, followed by the 32-byte seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export const TUNNEL_PROOF_CONTEXT = "crot-device-tunnel-v1";
/** Challenge sizes accepted for a tunnel proof (bytes). */
export const MIN_CHALLENGE_BYTES = 16;
export const MAX_CHALLENGE_BYTES = 1024;

/** Public part of the device credential, as the relay records it. */
export interface DevicePublicKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

/** The device key from its stored seed (base64url, 32 bytes). */
export function deviceKeyFromSeed(seed: string): KeyObject {
  const bytes = Buffer.from(seed, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== seed) throw new Error("the device key is not valid");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes]), format: "der", type: "pkcs8" });
}

export function devicePublicKey(privateKey: KeyObject): DevicePublicKey {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string")
    throw new Error("the device key is not an Ed25519 key");
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

/** The exact bytes a tunnel proof signs. */
export function tunnelProofMessage(deviceId: string, relayHost: string, challenge: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`${TUNNEL_PROOF_CONTEXT}\0${deviceId}\0${relayHost}\0`, "utf8"),
    Buffer.from(challenge),
  ]);
}

export function signTunnelProof(
  privateKey: KeyObject,
  deviceId: string,
  relayHost: string,
  challenge: Uint8Array,
): Buffer {
  if (challenge.byteLength < MIN_CHALLENGE_BYTES || challenge.byteLength > MAX_CHALLENGE_BYTES)
    throw new Error("the tunnel challenge has an invalid size");
  return sign(null, tunnelProofMessage(deviceId, relayHost, challenge), privateKey);
}

/** Relay-side check of a tunnel proof (reference for WP-29 and tests). */
export function verifyTunnelProof(
  publicKey: DevicePublicKey,
  deviceId: string,
  relayHost: string,
  challenge: Uint8Array,
  proof: Uint8Array,
): boolean {
  try {
    const key = createPublicKey({ key: { ...publicKey }, format: "jwk" });
    return verify(null, tunnelProofMessage(deviceId, relayHost, challenge), key, proof);
  } catch {
    return false;
  }
}

/** Removal proofs cannot be replayed as tunnel authentication (or vice versa). */
function removalMessage(deviceId: string, relayHost: string, challenge: Uint8Array): Buffer {
  if (challenge.byteLength !== 32) throw new Error("invalid removal challenge");
  return Buffer.concat([Buffer.from(`crot-device-deregister-v1\0${deviceId}\0${relayHost}\0`), Buffer.from(challenge)]);
}
export function signDeregistrationProof(key: KeyObject, deviceId: string, host: string, challenge: Uint8Array): Buffer {
  return sign(null, removalMessage(deviceId, host, challenge), key);
}
export function verifyDeregistrationProof(
  key: DevicePublicKey,
  deviceId: string,
  host: string,
  challenge: Uint8Array,
  proof: Uint8Array,
): boolean {
  try {
    return verify(
      null,
      removalMessage(deviceId, host, challenge),
      createPublicKey({ key: { ...key }, format: "jwk" }),
      proof,
    );
  } catch {
    return false;
  }
}

export type ManagementAction = "account_status" | "revoke_client";
function managementMessage(
  deviceId: string,
  host: string,
  action: ManagementAction,
  clientId: string,
  challenge: Uint8Array,
): Buffer {
  if (
    !["account_status", "revoke_client"].includes(action) ||
    challenge.byteLength !== 32 ||
    clientId.includes("\0") ||
    clientId.length > 512 ||
    (action === "account_status" && clientId !== "") ||
    (action === "revoke_client" && clientId === "")
  )
    throw new Error("invalid management challenge");
  return Buffer.concat([
    Buffer.from(`crot-device-management-v1\0${deviceId}\0${host}\0${action}\0${clientId}\0`),
    Buffer.from(challenge),
  ]);
}
export function signManagementProof(
  key: KeyObject,
  deviceId: string,
  host: string,
  action: ManagementAction,
  clientId: string,
  challenge: Uint8Array,
): Buffer {
  return sign(null, managementMessage(deviceId, host, action, clientId, challenge), key);
}
export function verifyManagementProof(
  key: DevicePublicKey,
  deviceId: string,
  host: string,
  action: ManagementAction,
  clientId: string,
  challenge: Uint8Array,
  proof: Uint8Array,
): boolean {
  try {
    return verify(
      null,
      managementMessage(deviceId, host, action, clientId, challenge),
      createPublicKey({ key: { ...key }, format: "jwk" }),
      proof,
    );
  } catch {
    return false;
  }
}
