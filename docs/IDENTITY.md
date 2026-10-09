# Identity and device binding (WP-28)

How a CROT device is paired with a CROT account and how it verifies the
OAuth access tokens of remote MCP clients. Normative model:
[ARCHITECTURE.md §27 AD-21](../ARCHITECTURE.md) (WorkOS AuthKit, claim
model, verification order, revocation, canonical device URI). This page
describes what the code does and how to run it against a development
environment.

Status: implemented on the device. Nothing reaches the device from the
internet yet: the Cloud Relay is WP-29 and the device tunnel WP-30. Until
then the relay entry point exists only in tests, and the verifier, the PRM
URL and the tunnel credential are ready for those work packages.

## Identity environment

An identity environment is one WorkOS environment plus the relay host of the
same CROT cloud environment:

| Field | Meaning |
| --- | --- |
| `issuer` | HTTPS origin of the authorization server (the AuthKit custom domain), exactly as in its RFC 8414 metadata; no port, no path |
| `relayHost` | relay host name (lowercase DNS name, no port); the device's canonical URI is `https://<relayHost>/d/<deviceId>/mcp` |
| `pairingClientId` | client id of the CROT device as a public native OAuth client (PKCE, loopback redirect) |
| `pairingRedirectPort` | optional; loopback port of the redirect (`0`, the default: any free port; set it if the environment needs one exact redirect URI) |
| `pairingScope` | optional; scope of the pairing request (default `openid`) |
| `id` | optional short name shown in the tray and recorded in the binding (default `development`) |

**Release builds** pin their environment in
`src/identity/environment.ts` (`RELEASE_IDENTITY_ENVIRONMENT`): staging is
configured by WP-38, production by WP-39. This build pins none, so pairing is
"not available" unless a development environment is named.

**Development** (implementation note to AD-21 point 5, "pinned in the
release configuration"): when no release environment is pinned, the
service reads a JSON file named by the environment variable
`CROT_IDENTITY_DEV_ENVIRONMENT` of the service process:

```json
{
  "id": "dev",
  "issuer": "https://auth.dev.crot.example",
  "relayHost": "relay.dev.crot.example",
  "pairingClientId": "client_01J…"
}
```

The variable is ignored (and the service logs a note) when a release
environment is pinned; it is never read from the CROT configuration file or
from a request. A malformed file, unknown fields, an `http:` issuer or an
issuer with a path or port make the environment unavailable (logged; pairing
refused, every remote token rejected).

### WorkOS development environment (AD-21 point 1)

Configure the development environment as AD-21 point 1 prescribes for every
CROT environment:

- AuthKit with a custom authentication domain; the issuer is that domain's
  HTTPS origin;
- Client ID Metadata Documents (CIMD) on; Dynamic Client Registration on;
- exactly **one** resource indicator, `https://<relayHost>/d/*`, and **no
  default resource indicator**;
- MFA required;
- the shortest access-token lifetime, at most 5 minutes;
- an OAuth application for the device (public client, PKCE) whose allowed
  redirect URIs include `http://127.0.0.1/callback` with any port (or the
  exact port set in `pairingRedirectPort`); its client id is
  `pairingClientId`.

## Pairing

From the tray ("Pair this device") or any control-channel client
(`pairing.start`):

1. The service creates a new random device id (16 bytes, lowercase base32,
   26 characters) and starts a loopback listener `http://127.0.0.1:<port>/callback`.
2. It answers with the authorization URL (authorization code flow, PKCE
   S256, `state`, `resource` = the new device's canonical URI); the tray
   opens it in the default browser (HTTPS URLs only).
3. The user signs in. The callback checks `state` (other callbacks are
   ignored) and, when present, that `iss` equals the issuer; the code is
   exchanged at the token endpoint with the same `resource`.
4. The access token is verified with the same checks as a remote request
   (signature, `iss`, `aud` = the new canonical URI, time claims,
   `client_id` = the pairing client). Its `sub` becomes the paired account.
   No token, code or verifier is stored, logged or shown.
5. The audit record `control` / `pairing` is written first; then a new
   Ed25519 device key is stored in the CROT secret store (`device-key`) and
   the binding in `<state>/device-binding.json` (account, device id,
   environment, issuer, relay host, time).

A pairing waits at most 10 minutes and can be cancelled (`pairing.cancel`).
Every pairing gets a new device id and a new device key: a device that was
unpaired and paired again is a new resource, and no token, client grant or
tunnel credential of the earlier pairing applies to it.

**Unpair** (`device.unpair`, tray "Unpair this device") takes effect at
once: no token is accepted, every remote request in flight ends, the device
key is removed. It also resets an unusable binding (for example a missing
device key).

## Token verification

The relay entry point's `AccessTokenVerifier` (`src/identity/verifier.ts`)
checks, in the order of AD-21 point 3:

1. signature: RS256 only (`none`, HMAC, other algorithms and `crit` are
   refused), key by `kid` from the issuer's JWKS;
2. `iss` byte for byte equal to the issuer;
3. `aud`: exactly one value, byte for byte equal to this device's canonical
   URI;
4. `exp` and `iat` required; `exp` without leeway; `nbf` and an `iat` in the
   future with 60 s clock skew; `iat` at most 15 minutes old (the device's
   ceiling);
5. `sub` equal to the paired account (an unpaired device, an unusable
   binding or a binding of another environment accepts no token);
6. `client_id` present.

Then admission (403 before MCP or Core): remote mode on, binding still
paired to that account and device, client not revoked, and the token not
issued before the client's last re-grant. Only `sub`, `client_id`, the
device id and `iat` reach the principal; `scope`, roles, permissions,
organization and session claims are ignored. Rejections are logged by
reason code only and answered with 401 and
`WWW-Authenticate: Bearer resource_metadata="https://<relayHost>/.well-known/oauth-protected-resource/d/<deviceId>/mcp"`
(plus `error="invalid_token"` when a token was presented). The local token
is refused on the relay entry point and OAuth tokens on loopback.

**Keys.** The JWKS location comes from the issuer's
`/.well-known/oauth-authorization-server`, whose `issuer` must equal the
configured one. Keys are cached for 10 minutes; an unknown `kid` triggers a
refetch at most every 30 seconds; when the issuer cannot be reached the last
set is used for at most one hour, then every token is rejected. Only RSA
keys of at least 2048 bits are used; duplicate `kid`s are dropped. Requests
are HTTPS only, without redirects, with size and time limits.

## Revocation and re-grant

- **Revoke** a client in the tray: immediate on the device (AD-19 point 8).
- **Re-grant** a revoked client (`remote.regrantClient`, tray "Re-grant"):
  audited first, written before it takes effect. The client starts with a
  clean exposure; access tokens issued before or in the second of the
  re-grant are refused (401 `invalid_token`), so the client signs in again.
- Revocations and re-grants are kept per account, device id and client.
  Unpairing and pairing again creates a **new device id** (a new resource,
  AD-15 point 8): clients revoked for the previous device id are not revoked
  for the new one, but they need new tokens for the new resource and appear
  as new clients there.
- **At the provider** (authorized application or account removed in
  WorkOS): the provider stops issuing tokens; tokens already issued end at
  their expiry (≤ 5 minutes configured, ≤ 15 minutes device ceiling). Asking
  the provider to revoke a client's authorization from the tray needs the
  CROT account service (WP-36), which holds the provider credentials; the
  service has a hook for it and reports it as not available today.

## Device credential (for the tunnel)

`CrotService.tunnelCredential()` gives the tunnel (WP-29/WP-30) the device
id, relay host, the Ed25519 public key and a signer for relay challenges
(16–1024 bytes). The signed message is
`"crot-device-tunnel-v1" 0x00 <deviceId> 0x00 <relayHost> 0x00 <challenge>`.
An unpaired device, an unusable binding or a binding of another environment
gets no credential, and a credential handed out before an unpairing stops
signing.

## Open points

- **RFC 9207** (`iss` in authorization responses) is still an open condition
  of AD-21 (R7) before Gate G4. The pairing flow checks `iss` when present
  but does not require it; the tray shows whether the issuer advertises it.
- No staging or production environment exists yet (WP-38, WP-39); the tests
  run against an in-process emulation of an AuthKit environment
  (`tests/identity/test-authorization-server.ts`).
- **Release pinning.** No release configuration pins an identity environment
  yet, so every build today honours `CROT_IDENTITY_DEV_ENVIRONMENT`. AD-21
  point 5 requires the environment to be pinned in release configuration;
  WP-38/WP-39 must pin it (and WP-34 must ship only builds that pin it)
  before any release build. Once pinned, the variable is ignored (tested).
- **Provider-side revocation** (asking WorkOS to revoke a client's
  authorization from the tray, AD-21 point 4 "best effort") is not part of
  WP-28: AD-21 point 4 allows no provider client secret on a device, so it
  needs the CROT account service (WP-36). The bound in AD-21 point 4 (a)
  holds without it. Recorded in roadmap §2.6 N3.

### Not yet verified against a live WorkOS environment

The emulation is protocol-level (real RS256 signatures, JWKS rotation and
refetch, PKCE S256 verification, a real loopback HTTP callback, RFC 8707
`resource` handling with `invalid_target`); it is not a copy of WorkOS. The
following assumptions are checked only against it and must be confirmed in
WP-38:

- the location and content of the AuthKit authorization server metadata and
  JWKS for a custom domain;
- AuthKit access tokens carrying `client_id` (mapped to `clientId`), and
  `aud` equal to the RFC 8707 `resource` requested;
- a native public client using PKCE without a client secret, with a loopback
  redirect URI on any port (RFC 8252 §7.3);
- `token_type` `Bearer`, token lifetime as configured (≤ 5 minutes), and the
  claims used for `sub`/`accountId`;
- whether AuthKit returns `iss` in authorization responses (RFC 9207, above).
