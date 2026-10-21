# CROT Cloud Relay v1 (WP-29)

The Cloud Relay is the public entry point of a CROT device:
`https://<relay-host>/d/<deviceId>/mcp`. It authenticates MCP clients
(OAuth 2.1 access tokens, AD-21), authenticates the device's outbound
tunnel (Ed25519 proof, AD-21 point 5) and forwards whole HTTP exchanges to
the device through the tunnel protocol `crot-tunnel.v1`
(ARCHITECTURE.md §27 AD-22).

The relay **never executes tools, never parses MCP payloads, never decides
permissions and never replays a request**. Every MCP decision is taken by the
device (its CROT service) after it has validated the token again.

```text
MCP client ── HTTPS POST/GET/DELETE /d/<id>/mcp ──► Cloud Relay
                                                     │ token check (iss, aud, time, sub = device owner)
                                                     │ route by deviceId (one tunnel per device)
                                                     ▼
CROT device ◄──── wss /.crot/tunnel (crot-tunnel.v1, device-initiated) ────┘
```

The device side of the tunnel (connecting, reconnecting, Remote mode,
feeding requests to the loopback HTTP entry, registration at pairing) is
**WP-30** and is described in [DEVICE_TUNNEL.md](DEVICE_TUNNEL.md). The
WP-29 tests use a protocol-level test device
(`tests/cloud-relay/test-device.ts`) that proxies to a real
`CrotHttpServer` relay entry; the WP-30 tests use the real device side.

## Accounts and commercial admission (WP-36)

The same relay binary co-hosts durable AccountService and `/portal` with OAuth
PKCE, Trial/Pro/Team checkout, owner/device/client management and lost-device
revocation. Free is default; pre-commercial registry entries do not grant plans.
Registration checks account entitlement/quota. HELLO and MCP check it again;
webhook changes and wall-clock expiry close ineligible tunnels. Local Core never
receives this commercial policy. Account HTTP routing excludes MCP payloads.

See [ACCOUNTS](ACCOUNTS.md) for all owner/device/billing routes, secret files,
portal OAuth resource/client setup, storage/recovery, version floors and tests.
`accountFile` defaults to `<registryFile>.accounts`; preserve both files when
backing up with the relay stopped. Single writer only. Live provider/payment
and public-host configuration remain owner deployment gates.

## Running

```sh
node dist/bin/crot-cloud-relay.js --config relay.json
```

```json
{
  "relayHost": "relay.example.com",
  "issuer": "https://auth.example.com",
  "pairingClientId": "client_01EXAMPLEPAIRING",
  "environment": "staging",
  "host": "0.0.0.0",
  "port": 8443,
  "registryFile": "/var/lib/crot-relay/devices.json",
  "tls": { "certFile": "/etc/crot-relay/cert.pem", "keyFile": "/etc/crot-relay/key.pem" },
  "exchangeDeadlineMs": 900000
}
```

| Field | Meaning |
| --- | --- |
| `relayHost` | Public DNS name; part of the canonical resource URI and of the tunnel proof |
| `issuer` | Authorization server (HTTPS origin); its JWKS is fetched like on the device (`IssuerKeySet`) |
| `pairingClientId` | Required. `client_id` of the environment's pairing client (the same value as the device's identity environment); only its tokens register devices |
| `environment` | Short name stored with each registration (default `development`) |
| `host`, `port` | Listen address (default `0.0.0.0:8443`) |
| `registryFile` | Device registry (JSON, written atomically, mode 0600) |
| `tls` | Optional; without it the relay speaks plain HTTP and TLS must terminate in front of it |
| `limits` | Optional admission settings; defaults and effective fairness bounds below |
| `exchangeDeadlineMs` | Absolute exchange deadline, 60 000…900 000 ms (AD-22 point 12, default 15 min); the device ends a request 5 s before it (OD-5) |

When TLS terminates at a load balancer, its idle timeout must be at least the
exchange deadline and it must pass WebSocket upgrades through. Deployment is
WP-38 (staging) and WP-39 (production). The binary is not yet listed in
`package.json` `bin`.

## Endpoints

| Path | Method | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource/d/<id>/mcp` | GET | Protected resource metadata (AD-21 point 6); 404 for unregistered devices |
| `/d/<id>/register` | POST | Device registration (pairing token of the owner; body `{"publicKey": <Ed25519 JWK>}`) |
| `/d/<id>/deregister` | GET, POST | Fresh device-key challenge and signed removal; no pairing bearer |
| `/d/<id>/mcp` | POST, GET, DELETE | MCP endpoint, forwarded to the device |
| `/.crot/tunnel` | GET (WebSocket upgrade) | Device tunnel, subprotocol `crot-tunnel.v1` |
| `/.crot/health` | GET | `{"status":"ok"}` (`shutting_down` while closing) |

### Registration

`POST /d/<id>/register` with `Authorization: Bearer <token>` whose `aud` is
the device's canonical URI and whose `client_id` is the configured pairing
client (AD-22 point 4): the token of the device's own pairing. Tokens of any
other client for the URI are refused with `403`
`{"error":"pairing_client_required"}` — the provider issues tokens for any
device URI to any account, so `aud` alone does not prove a pairing. The token
is checked before the body is read. The first successful registration binds
the device to the token's `sub` (account) and stores the public key. `201`
created, `200` same account and same key again (idempotent), `409` a
different account or key, `400` bad body or key, `401` with
`WWW-Authenticate` for a missing or invalid token, `403` another client's
token, `408` body not received within 10 s, `413` for a body above 4 KiB.
Valid pairing-client tokens are limited per `sub` before reading the body:
excess returns `429`, `Retry-After: 1`, `CROT-Request-Outcome: not_executed`.

The device calls this endpoint during pairing, after it has verified the
pairing token itself (WP-30, `src/identity/relay-registration.ts`); only
`201` and `200` complete pairing.

### Signed deregistration and pairing compensation

`GET /d/<id>/deregister` returns `{challenge}` (32 cryptographically random
bytes, base64url, 30 s, single use, bound to the exact current registry record).
`POST` accepts `{challenge, proof}` with a 64-byte Ed25519 signature over
`crot-device-deregister-v1\0<deviceId>\0<relayHost>\0<challenge bytes>`.
Tunnel proofs, different keys/hosts/ids, expiry and replay are rejected.
Proofs and challenges never enter logs. A successful conditional durable
removal returns 204, removes routing/PRM (subsequent lookup 404) and closes
active tunnels. Already absent returns 404; the device treats this as successful
cleanup. Challenge cache: 1024 total; removal endpoint: 30/source/minute.

Before any register POST, the device stores/read-verifies its secret key and a
private inactive registration intent. Failed/cancelled/lost registration or final
binding commit is compensated with this signed protocol. Unavailable cleanup
retains the intent/key across restart; the next pairing cannot overwrite it.
A committed binding discards the inactive intent. No pairing bearer is retained.
Local unpair captures only a removal signer, revokes locally/deletes the stored
key, closes the tunnel with GOAWAY unpaired, then sends best-effort removal.
Network delay never holds the local unpair result.

### Admission configuration (`limits`)

All values are positive safe integers. Rate objects require both `max` and
`windowMs`; omitted settings use these defaults. Unknown settings fail startup.

| Setting | Default | Scope |
| --- | --- | --- |
| `clientRequests` | `{ "max": 120, "windowMs": 60000 }` | `(deviceId, clientId)` |
| `deviceRequests` | `{ "max": 600, "windowMs": 60000 }` | device |
| `accountRegistrations` | `{ "max": 10, "windowMs": 60000 }` | verified pairing-token `sub` |
| `clientConcurrency` | 4 | active exchanges **and** pending body buffers/client |
| `deviceConcurrency` | 32 | active exchanges and pending body buffers/device |
| `globalConcurrency` | 64 | all admitted exchanges/body buffers |
| `sourceConnections` | 64 | concurrent TCP sockets per peer address, including pre-HTTP |
| `sourceHandshakes` | 8 | pending tunnel handshakes per peer; global 256 remains |
| `counterKeys` | 10000 | maximum identity keys retained per rate counter |

Client concurrency is also capped at half the device's advertised stream
budget (minimum 1) and half the 8 MiB connection credit in 1 MiB stream windows
(4). Device concurrency is capped by advertised maxStreams; configuration
requires client ≤ device ≤ global. This reserves stream/credit headroom so a
single slow client does not exhaust the shared tunnel. Rates return 429 and
concurrency returns 503, both `Retry-After: 1`/`not_executed`, before tunnel OPEN.
Slots are reserved before reading chunked bodies and released on finish/abort.
Chunked body max remains 4 MiB/exchange; global admission bounds simultaneous
body assembly (transient concatenation copies are additional bounded memory).
Counter capacity exhaustion fails closed; expired entries are reclaimed.

**Source means TCP peer address, never Forwarded/X-Forwarded-For.** A load
balancer makes its users share a peer quota; WP-38 deployment must additionally
enforce real-source limits at the edge, not relax trust in forwarded headers.
The pre-TLS socket cap can close a TLS connection before an HTTP response is
possible. Pending-handshake HTTP refusals carry 503/Retry-After/not_executed.

### Client admission

For `/d/<id>/mcp` the relay checks, before touching the tunnel: exactly one
bearer token, signature and `iss`, `aud` = `https://<relay-host>/d/<id>/mcp`,
validity times, `sub` = registered owner, and real cloud-only AccountService
entitlement (WP-36 / AD-34). Default Free denies remote admission. Failures produce
`401` (with `WWW-Authenticate: Bearer resource_metadata=…`) or `403`; the
request is never forwarded. Identity headers sent by the client are forwarded
as ordinary headers and have no meaning to the device; the device validates
the token itself.

## Tunnel protocol details fixed by this implementation

AD-22 fixes the protocol; the following points are implementation choices
or restate clarified AD-22 points:

- **Subprotocol and 4426** (AD-22 point 10). The device offers
  `crot-tunnel.v<N>` values. If none is supported, the relay accepts the
  upgrade, names the device's highest offered value in the 101 response and
  immediately closes with `4426` and reason
  `unsupported_version;supported=v1` (no frame is sent). Naming it is needed
  because standard WebSocket clients (WHATWG, Node's built-in client) fail
  the connection with 1006 when the 101 response names no requested
  subprotocol, so they would never see 4426.
- **READY** carries `limits`: `frameBytes`, `jsonBytes`, `requestBodyBytes`
  (4 MiB), `responseBodyBytes` (32 MiB), `connectionWindow` (8 MiB),
  `streamWindow` (1 MiB), `exchangeDeadlineMs`.
- **Handshake rate limit**: 30 authenticated handshakes per minute per
  device, then close `4429` with reason `rate_limited;retryAfterMs=<n>`.
  Only handshakes with a valid proof count; a failed proof is closed `4401`
  and never uses up the device's allowance (the device id is public). At
  most 256 handshakes are pending at once (further upgrades get `503`); this
  global cap is supplemented by the configurable per-peer TCP and pending caps below.
- **WebSocket endpoint limits**: one connection retains at most one message
  (64 KiB + header), however the peer fragments it or splits it into TCP
  segments; while a peer does not read its output, only its latest
  WebSocket ping is answered.
- **Supersession**: a new authenticated tunnel replaces the old one (the old
  one receives `GOAWAY superseded` and drains). More than 10 supersessions
  per hour: the *new* tunnel is closed with `4409`.
- **Hop-by-hop headers** removed in both directions: `connection`,
  `keep-alive`, `transfer-encoding`, `te`, `upgrade`, `trailer`, `expect`,
  `proxy-*` and every header named in `Connection`.
- **Request bodies**: with `Content-Length` they are streamed under flow
  control; chunked bodies are buffered (at most 4 MiB, within the exchange
  deadline, else `408`) before `OPEN` so that a too-large body is refused as
  `not_executed`. When the device's response is complete before the request
  body was sent, the relay stops forwarding it and resets the stream with
  `cancel` (AD-22 point 6); the client already has the complete response.
- **Bodies the relay does not forward** (refusals before admission, PRM,
  unknown paths) are dropped; if such a body is not complete within 10 s the
  connection is closed.
- **Malformed frames** (AD-22 point 5): malformed stream-0 frames are
  connection errors (`GOAWAY protocol_error`, close `4400`); a malformed
  `RESPONSE` head resets only its stream (`502 device_reset`, `unknown`).
- **Streams above the device's `GOAWAY lastStream`** are answered `503
  refused` (`not_executed`). A `RESET` with an unknown code is treated as
  `internal_error`.
- The relay does not check `Host` (the device does).

## Outcomes

A failure response is a JSON-RPC error body
`{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":…,"data":{"crot":<code>,"outcome":<outcome>}}}`
with header `crot-request-outcome: not_executed | unknown`. Once the device
has started a response, a failure can only abort the HTTP response.

| Code | Status | Outcome | When |
| --- | --- | --- | --- |
| `unknown_device` | 404 | not_executed | device not registered |
| `method_not_allowed` | 405 | not_executed | method other than POST/GET/DELETE |
| `unauthorized` | 401 | not_executed | missing or invalid token |
| `not_entitled` | 403 | not_executed | AccountService denies remote admission |
| `device_offline` | 503 | not_executed | no tunnel (Remote mode off, offline, draining) |
| `request_rate_limited` | 429 + `Retry-After: 1` | not_executed | client/device sliding window exhausted |
| `busy` | 503 + `Retry-After` | not_executed | admission concurrency or device's stream limit reached |
| `refused` | 503 + `Retry-After` | not_executed | device `RESET refused` or stream above `lastStream` |
| `request_too_large` | 413 | not_executed | body above 4 MiB |
| `headers_too_large` | 431 | not_executed | header block does not fit one frame |
| `bad_request` | 400 | not_executed | malformed request |
| `request_timeout` | 408 | not_executed | a body without `Content-Length` not received within the deadline |
| `tunnel_lost` | 502 | unknown | tunnel closed after `OPEN` |
| `device_reset` | 502 | unknown | device ended the stream before responding |
| `deadline_exceeded` | 504 | unknown | absolute deadline reached |

The relay **never retries** a request on another tunnel, after reconnect or
after a timeout; the client decides.

## Logging

One JSON line per record on stderr. Records contain only: event, device id,
tunnel id, stream id, HTTP method, `Mcp-Method`, status, outcome, code,
close code, sizes, durations, software name and counts. String values are
reduced to a safe vocabulary (`[A-Za-z0-9_./:-]{1,64}`, otherwise
`invalid`). Tokens, other headers, bodies, paths, query strings, challenges
and proofs are never logged (tested).

## Qualification and remaining scope

WP-29 completion evidence, reproduction and test mapping:
[relay-wp29-completion.md](design/relay-wp29-completion.md). Real socket tests
exercise four unread slow streams alongside 48 data-bearing requests from
other clients; this does **not** claim production throughput or RSS capacity.

- Single relay instance and file registry; multi-instance routing/capacity is WP-39.
- Re-pair rotates to a new id/key (AD-21); no in-place key replacement.
- Offline local unpair remains immediate but best-effort remote removal can fail,
  leaving a stale relay record. It cannot re-enable the locally revoked device.
  Account-side management/revocation is implemented by WP-36 (AD-34).
- No CORS/OPTIONS for browser-based clients (AD-22 question 7).
- WP-36 implements real entitlement admission; relay is still not a local authorizer.
  The explicit entitlement hook is for transport tests only, never the deployed binary.
- Binary packaging is WP-34/38; public staging and real-client/timeouts acceptance
  remain WP-38/32, not implied by green component tests.

## WP-38 staging artifacts and WP-32 automatic acceptance

[STAGING.md](STAGING.md) documents the non-root TLS container/compose, bounded
metadata-only logging, explicit reset and release-identity artifact builder.
[WP-32 acceptance](acceptance/WP-32-acceptance.md) maps the actual HTTPS/WSS SDK,
OAuth, service, project, Chromium, approval and installed-L1 tests. Measured
SDK/approval timeout precedence is recorded there, not inferred from constants.
Public staging, live WorkOS and four external-cloud-client runs remain separate
operational/manual criteria; these repository tests do not claim them complete.
