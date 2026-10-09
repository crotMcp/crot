/**
 * The device's registration at the Cloud Relay during pairing (ARCHITECTURE.md
 * AD-22 point 4; WP-30): `POST https://<relay-host>/d/<device-id>/register`
 * with the verified pairing access token as bearer and the device's public
 * key as the only body field. The relay checks the token itself (issuer,
 * signature, `aud` = the device's canonical URI, the pairing `client_id`) and
 * binds the device id to the account and the key; it is not an authorization
 * center for anything else.
 *
 * - Goes through IdentityHttp: HTTPS only, no redirects, no ambient
 *   credentials, a timeout and a response size limit.
 * - The result never contains the token or the relay's response body; a
 *   network error is reported without its message.
 * - There is no deregistration (AD-22 open question 3).
 */
import type { DevicePublicKey } from "./device-credential.js";
import { isDeviceId, isRelayHost } from "./device-id.js";
import { isHttpsUrl, type IdentityHttp } from "./http.js";

export type RelayRegistrationFailure =
  | "invalid_url"
  | "unavailable"
  | "unreachable"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "rejected"
  | "unexpected_status";

export type RelayRegistrationResult =
  | { readonly ok: true; readonly created: boolean; readonly status: number }
  | { readonly ok: false; readonly reason: RelayRegistrationFailure; readonly status?: number };

/** The registration endpoint of a device at its relay (AD-22 point 4). */
export function relayRegistrationUrl(relayHost: string, deviceId: string): string {
  if (!isRelayHost(relayHost) || !isDeviceId(deviceId)) throw new Error("invalid relay host or device id");
  return `{{https://${relayHost}}}/d/${deviceId}/register`;
}

export async function registerDeviceAtRelay(options: {
  readonly http: IdentityHttp;
  readonly url: string;
  readonly accessToken: string;
  readonly publicKey: DevicePublicKey;
}): Promise<RelayRegistrationResult> {
  if (!isHttpsUrl(options.url)) return { ok: false, reason: "invalid_url" };
  const post = options.http.postJsonWithBearer;
  if (!post) return { ok: false, reason: "unavailable" };
  let status: number;
  try {
    ({ status } = await post.call(options.http, options.url, options.accessToken, { publicKey: options.publicKey }));
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (status === 201) return { ok: true, created: true, status };
  if (status === 200) return { ok: true, created: false, status };
  if (status === 401) return { ok: false, reason: "unauthorized", status };
  if (status === 403) return { ok: false, reason: "forbidden", status };
  if (status === 409) return { ok: false, reason: "conflict", status };
  if (status === 400 || status === 408 || status === 413) return { ok: false, reason: "rejected", status };
  return { ok: false, reason: "unexpected_status", status };
}
