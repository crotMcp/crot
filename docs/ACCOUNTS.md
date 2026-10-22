# Accounts, plans, billing and device management — WP-36 / AD-34

## Boundary and plans

Local / Free is free, offline and accountless. Core, PermissionEngine and
ExecutionGuard do not import the commercial service or check a license. Only
Cloud Relay admission uses account entitlements; device/tray status is
informational and never grants or blocks local capabilities.

| Plan | Remote enabled | Device limit | Duration |
| --- | --- | --- | --- |
| free | no | 0 | unlimited local use |
| trial | yes | 2 | 7 days, card-backed Stripe Checkout, once per account |
| pro | yes | 5 | active paid period |
| team | yes | 20 | active paid period; v1 remains one account per user |

Only `active` and unexpired plans admit remote traffic. `past_due`, `canceled`
and `expired` fail closed. `remoteEnabled`, `entitled`, `plan`, `status`,
`maxDevices`, `deviceCount` and `expiresAt` are account metadata. A downgrade
keeps the first non-revoked registered devices up to the new limit. Registration
order is persisted and cannot be client-selected. Remaining registrations stay
visible but cannot open remote sessions. Registration over the limit returns
403 `device_limit_reached`; without an active plan, 403 `entitlement_required`.

Subscription changes synchronously invalidate ineligible active tunnels with
4403 `not_entitled` before acknowledging the transaction. Every HTTP/HELLO
admission checks again. Wall-clock expiry closes existing tunnels on the
one-second watcher even without a webhook. MCP admission refusals include
`CROT-Request-Outcome: not_executed`. None of these changes affects offline stdio
or loopback HTTP execution on the user's device.

## Deployment and storage

The existing `crot-cloud-relay` binary co-hosts the service; there is no second
port or separate daemon to provision. `CommercialService` is the clean cloud
interface for a future transactional shared-store adapter. The current
`AccountService` is a **single-writer/single-relay** adapter with serialized
transactions, schema validation, exclusive random temporary files, fsync and
atomic rename. Its file is owner-only (0600 with a 0700 parent on POSIX).
Do not share a JSON account file between relay processes. Scale-out database
operation and capacity qualification remain WP-39.

The existing device registry stores device public keys, separately from the
commercial account metadata. Account reservations are durably committed before
registry registration: a crash/disk failure between them may retain a reserved
slot, but does not grant remote admission. Retry the same pairing id/key to
complete it; an owner can revoke the reservation to recover quota. Do not reset
account data to recover a registration. Revocation tombstones and trial-used
state must survive restart. Back up **both files together with the relay
stopped**; loss of account state is a security incident, not permission to
reissue trials or restore revoked devices.

Existing pre-WP-36 device registrations do not automatically create plans or
commercial rights. After the owner starts a trial/pays, re-pair a device with a
fresh id/key. The old registry alone is never evidence of entitlement.
Malformed/unreadable account data fails startup closed. Startup errors are
reported as a generic event, not raw filesystem/provider exceptions.

Add the following fields to the existing relay configuration (this is not a
complete relay config):

```json
{
  "accountFile": "/state/accounts.json",
  "portalClientIds": ["client_OWNER_PORTAL"],
  "workosSecretFile": "/config/secrets/workos-api-key",
  "billing": {
    "secretKeyFile": "/config/secrets/stripe-api-key",
    "webhookSecretFile": "/config/secrets/stripe-webhook-secret",
    "prices": { "pro": "price_OWNERPRO", "team": "price_OWNERTEAM" },
    "returnUrl": "https://crot.network/portal"
  }
}
```

`accountFile` defaults to `<registryFile>.accounts`, distinct from the registry.
`portalClientIds` defaults to an empty allowlist (owner access denied).
Without billing configuration Free local use remains available; trial checkout,
paid checkout and webhooks return unavailable. No cardless HTTP trial is granted. Without `workosSecretFile`, provider revocation
reports `not_available`. Configured secret files must exist; provider secrets
are read **only on the cloud host**. They never enter an installed device,
release identity artifact, Git, or logs. The staging compose already mounts
`./config:/config:ro` and a writable `/state` volume; put secrets below config
with owner-restricted permissions readable by container uid 10001. No live
merchant account, credential, legal entity or jurisdiction is invented here.

## Hosted account portal and owner API

Open **`https://<relayHost>/portal`**. The shipped static page signs in through
the provider's hosted authorization endpoint using PKCE S256, random one-use
state and a ten-minute callback deadline. It lists the plan, device quota,
devices, online/offline/revoked status and observed clients. It can start a
card-backed trial checkout, redirect to hosted Stripe Checkout for Pro/Team, refresh status and
revoke a lost device after confirmation. All dynamic labels use textContent;
there are no third-party scripts, telemetry or embedded card/password forms.

Configure a public first-party provider OAuth client with the exact callback
`https://<relayHost>/portal/callback`, PKCE S256, and a separate account resource
**`https://<relayHost>/account`**. Allow its client id in `portalClientIds`.
The token endpoint must allow this approved public portal client to perform its
PKCE exchange from the relay origin. `/portal/config` reads the configured
issuer's validated discovery metadata; it never takes endpoints from the
browser. Live provider approval/CORS/redirect/resource setup is an owner release
gate, not replaced by the local authorization-server fixture. Existing RFC 9207
release conditions remain in force; a returned callback `iss` must match.

Access tokens live only in page memory. Only the short-lived verifier/state is
in sessionStorage until callback. The page removes callback query parameters,
uses no-store and no-referrer headers, and has a restrictive self-script CSP.
Refresh or sign-out loses the token; provider SSO can remain signed in. The
portal never asks for a token to be pasted. OAuth codes/tokens must not be logged
by an external ingress proxy either.

Owner APIs require `Authorization: Bearer` with verified issuer, signature,
expiry, `aud=https://<relayHost>/account`, `sub=accountId`, and an allowlisted
portal `client_id`. Ordinary MCP/device tokens cannot administer an account.
No account id, limits or subscription state from a request body is trusted.

| Path | Method | Result |
| --- | --- | --- |
| `/account` | GET | plan/status/quota and device/client list; no device public keys or provider session ids |
| `/account/trial` | POST `{}` | create hosted 7-day card-backed checkout; no entitlement until a verified subscription; 409 when unavailable |
| `/account/checkout` | POST `{"plan":"pro"}` or `{"plan":"team"}` | fixed-provider hosted checkout URL |
| `/account/billing-portal` | POST `{}` | fixed-provider billing portal for subscription management/cancellation |
| `/account/devices/<deviceId>/revoke` | POST `{}` | revoke this owner's device, 404 for foreign ids |
| `/.well-known/oauth-protected-resource/account` | GET | distinct account resource metadata |

Lost-device revocation first persists a tombstone, ends all active tunnels with
**4403 `device_revoked`**, removes its registration/public key from the relay,
returns **404** for PRM and subsequent MCP, and blocks registration of the old
id/key forever. Reconnecting the revoked device receives 4403. If registry
cleanup fails, the durable tombstone still denies admission and PRM; retry the
owner operation to remove the key. Pair a fresh id/key, do not resurrect a
revoked identifier. Provider revocation is then best-effort and cannot undo the
cloud/device revocation.

## Billing verification and ordering

**POST `/billing/stripe`** accepts only signed raw-byte Stripe subscription
created/updated/deleted events. The adapter verifies HMAC-SHA256 with the
server webhook secret, one timestamp within ±300 seconds, rotated v1 signatures,
a 64KiB body bound, and a bounded response/deadline before trusting anything.
After signature verification it reads the **current authoritative subscription**
from Stripe over fixed-host HTTPS without redirects. It does not grant from an
old webhook snapshot, so delayed/reordered activation events cannot restore a
canceled subscription. The provider read and commit are in one serialized
transaction domain. Unknown prices, malformed subscriptions and provider
failure cannot grant access. Failed webhooks are refused for provider retry;
operators should alert on HTTP failures, without retaining webhook bodies.

Checkout uses only server-configured recurring price ids and writes
`subscription_data[metadata][crot_account_id]` from authenticated `sub`, never
from caller-supplied metadata. Configure created/updated/deleted webhook events
and forbid customer editing of account metadata. Event ids are idempotent in a
bounded durable 10,000-event ledger. Replays beyond that window still resolve
current provider state. Subscription ids cannot move to another account.
After a canceled/expired subscription is replaced, its id remains retired and
late events cannot replace/reactivate it. An already active subscription cannot
be displaced by a second subscription. Cancel-at-period-end stays active until
its period ends; actual cancellation/past_due closes remote access immediately.
Live payment, refund, tax and contract terms remain owner WP-37/WP-39 gates.

## Device/tray and provider revocation

Device management uses fresh 30-second, single-use Ed25519 challenges with a
separate management-proof domain binding device id, relay host, operation and
exact client id. Tunnel/removal signatures cannot be replayed for management.
`GET /d/<id>/account` returns a challenge; the signed POST returns informational
plan/quota and **device-specific** entitled state. Client revocation uses
`GET/POST /d/<id>/clients/<encoded-client-id>/revoke`. Public ids or unsigned JSON
cannot invoke it. Body limits, source rates, deadlines and a 1024-challenge cap
bound this surface. Revocation while a proof body is being read is rechecked.

The service refreshes commercial metadata only on an explicit `overview`
request, at most once per minute, not as a background telemetry task.
Tray/overview labels offline/stale state unknown after two minutes; a missing
cloud response never gates a local operation. Local client revocation is
persisted first, then the existing tray hook asks the cloud for best-effort
provider revocation. Only session ids observed in **signature-verified** remote
tokens for the same account/device/client are eligible. Provider credentials
never reach the device. WorkOS `POST /user_management/sessions/revoke` receives
only those `sid` values; unrelated account sessions are neither guessed nor
listed/revoked. `requested`, `failed` and `not_available` are explicit. An absent
sid means not_available, not a false success. Revoking a provider session may
affect other uses of that same session; already issued JWTs retain the AD-21
expiry bound. This is best-effort session revocation, not a claim that the
provider's entire OAuth grant database was deleted.

## Compatibility, logs and diagnostics

OD-11/12/13 are **Decided in AD-34**. Tunnel `crot-tunnel.vN` majors have at least
12 months of support after actual publication; no production release is
claimed by tests. Unsupported tunnel majors close **4426 / update required**.
Optional `minimumDeviceVersion` and `minimumClientVersion` (strict x.y.z) apply
only to relay admission. Devices are checked in HELLO (4426); MCP HTTP clients
send `CROT-Client-Version` and receive 426/update_required/not_executed when
below the floor. That unauthenticated version string is an update hint, not
identity or authority. It never widens local permissions. Do not silently remove
a supported protocol major inside its release window.

Browser hello protocol mismatch is explicit in `crot_status` (`update_required`)
and the extension's update-required message, without crashing the service. A
compatible reconnect clears that state. Tray/service retain their existing
local versioned control handshake.

There is **no hidden device telemetry**, crash collector or automatic report
upload. Any future diagnostic export must be explicit, local, secret/path-free.
Relay/account logs contain only allowlisted operational ids, statuses, error
codes, byte counts and durations. They exclude bodies, authorization headers,
payment signatures, tab URLs and file paths; even hostile Mcp-Method/software
strings are sanitized. Commercial HTTP routing never hands `/mcp` requests to
the account handler. AccountService receives typed identity/plan/device/client
metadata only, never an MCP message or computer/project contents.

## Automated acceptance and remaining release gates

PR **#36**, branch **`feat/wp36-commercial`**, is the only WP-36 delivery.
The accidental duplicate PR #37 is closed and its remote branch deleted; it is
not a prerequisite, merge source or continuation branch.

Tests in `tests/account-service/` cover quota races, persistence/restart/failure,
retired subscription ownership, HMAC freshness/tampering, authoritative event
ordering, provider failure, owner isolation, lost-device key removal and replay,
expiry/downgrade tunnel closure, device proof purpose/replay, metadata/log
canaries and actual service identity hooks. `tests/service/service.test.ts`
executes real filesystem tools through stdio and loopback without an account.
`tests-e2e/browser/wp36.e2e.test.ts` executes the actual shipped portal in real
Chromium through PKCE login, trial, client/device listing and lost-device revoke;
WP-32's three-revision × two-preset HTTPS/WSS/browser fixture uses real trial
admission, not an allow-all entitlement stub.

Required final-head gates: `npm run check`, `npm run test:e2e:browser` and all
**11 CI jobs** (six OS/Node jobs, four installed-L1 Linux x64/ARM64 jobs and real
Chromium). Skipped local platform/headed tests are not counted as qualification.
The test providers are fixtures: live WorkOS/Stripe, crot.network DNS/TLS,
Oracle ARM64 host deployment, financial/legal/residency decisions and operational
runbooks remain explicit owner release gates. No merge or live payment is part
of this PR's automated acceptance.

## Flagship UI and revised trial contract

The first-party `/` and `/welcome` routes present implemented capabilities and
explicitly labeled roadmap integrations. `/portal` uses the shared Obsidian
system, PKCE sign-in and friendly device labels with opt-in technical details.
Installation cards disclose package qualification status rather than linking
nonexistent installers.

`POST /account/trial` redirects to Stripe Checkout with
`payment_method_collection=always`, `subscription_data[trial_period_days]=7`,
and a configured Pro recurring price. The trial converts to Pro unless canceled;
Checkout presents the operator's configured price and billing period before
confirmation. The return URL grants no rights. The signed webhook's authoritative
subscription must be `trialing`, carry the server trial marker, have a default
payment method and an exact seven-day provider trial interval. Trial remote
quota is two devices. A second trial subscription cannot reissue entitlement.
Retries use an account-bound provider idempotency key. Trial eligibility and
provider fixture coverage are distinct from live merchant qualification.

The legacy trusted `AccountService.startTrial` fixture/provisioning helper is
not exposed by the owner HTTP API. Its removal/migration is tracked as a remaining
hardening task in the flagship work; it is not evidence of card verification.
Live Stripe/card/cancellation qualification remains an external release gate.
