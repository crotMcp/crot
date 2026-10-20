# WP-29 — Cloud Relay completion evidence

Base: PR #33 merged at `ca6280a467d4fc0f7787ff27dd0806c84042534e`.
This completion is a separate PR; package Done does not mean merged, deployed
or accepted as a whole-product release. AD-22 point 4/question 3 is refined
within the curator-approved scope; no authorization or payload execution moves
to the relay.

## Criterion-level qualification

| Criterion / expected result | Actual implementation and executable evidence | Status / limits |
| --- | --- | --- |
| Verified client/device request rates refuse before OPEN | `tests/cloud-relay/load.test.ts`: sliding windows, independent client/account keys, device aggregate, recovery; 429, Retry-After 1, not_executed; test-device OPEN count unchanged | Passed in targeted suite; full CI attached to PR |
| Concurrent requests and unfinished unknown-length bodies cannot evade admission | Same suite: reserve client/device/global slots before chunked buffering; abort releases bytes, identity maps and slots; another device exercises global cap | Passed in final targeted suite; real HTTP sockets |
| One source cannot occupy all 256 pending handshakes | Same suite: per-peer pending cap, release and recovery; raw pre-HTTP sockets hit TCP cap; spoofed forwarded headers do not alter identity | Passed; peer address means load-balancer address behind a proxy, requiring edge quotas in WP-38 |
| Registration abuse bounded after token verification | Same suite: valid pairing-client account rate, invalid client does not consume account quota, separate account/recovery; no record on 429 | Passed; defaults 10/min, configurable |
| Fresh device-key authenticated deregistration | `tests/cloud-relay/deregistration.test.ts`: remove registry/PRM/tunnel, reject foreign key/id/host, tunnel-domain proof, expired/replayed challenge and malformed body; pending entitlement handshake cannot restore removed device | Passed; challenge 30 s/32 bytes, exact record, cache 1024 |
| Durable deletion does not remove a replacement record or silently lose state | Same suite: FileDeviceRegistry conditional identity, reopen after delete, failed persistence restores live record | Passed; single-instance file registry, not distributed storage |
| No unrecoverable orphan after failed local pairing commit | Same suite: verify key/intent before POST; failed key preflight sends no POST; binding commit failure signs compensation; lost response/offline cleanup survives restart; cancellation waits for in-flight register before compensation; absent record is idempotent cleanup | Passed; unavailable cleanup retains private inactive intent/key and blocks overwrite by new pairing |
| Crash between binding commit and intent removal | `tests/identity/binding.test.ts`: reopening paired state cleans obsolete intent; subsequent unpair leaves no pending registration | Passed in targeted suite |
| Local unpair does not wait for relay; teardown precedes signed removal | `tests/service/control-center.test.ts`: real control center and binding/Core, controlled tunnel teardown/network promises; result/control queue available before either finishes; `tests/cloud-relay/deregistration.test.ts`: captured removal-only signer works after stored secret deletion | Passed in final targeted suite. Offline unpair may leave stale relay metadata, never local authority |
| Slow client cannot monopolize credit and block fast peers | Real socket load: four unread 12 MiB test-device responses for one client, 48 × 64 KiB responses to eight other clients; exact byte checks, connection ≤8 MiB credit, stream ≤1 MiB, no stuck streams/maps/buffers after abort, same tunnel usable afterward | Passed; deterministic bounded-credit qualification, not production throughput/RSS benchmark |
| Existing SDK/protocol/approval/identity/outcome/no-replay/logging behavior preserved | `tests/cloud-relay/device-tunnel.test.ts`, `end-to-end.test.ts`, `forwarding.test.ts`, `registration.test.ts`, `tunnel.test.ts`, `websocket.test.ts`, `units.test.ts` and identity/service regression suites | Targeted regression passed; full check/CI recorded below |

No payload, bearer, private key, challenge or proof is logged. Logs remain
safe-vocabulary metadata; refusal responses never retry or forward an exchange.
New admission observability is aggregate only (active identities/exchanges,
pending request bytes, outstanding response credit), not a new HTTP admin API.

## Configuration and resource bounds

`limits` is validated on startup; see [RELAY.md](../RELAY.md) for all defaults.
Defaults: client/device rates 120/600 per minute, client/device/global concurrency
4/32/64, source TCP/pending 64/8, account registrations 10/minute, rate counter
keys 10,000. Counter exhaustion refuses rather than growing state. Requests
without length remain bounded at 4 MiB per admitted exchange, with transient
bounded concatenation copies. This is not an assertion of process RSS.

Effective client concurrency is also ≤half the advertised stream budget
(minimum one) and ≤half the connection credit in stream windows (four).
No single client can consume all eight stream windows of connection credit.
Multiple cooperating principals/whole-device overload remain governed by the
aggregate cap; this is isolation, not an unbounded fairness guarantee.

Unpair is immediately local and best effort remote. Re-pair assigns a fresh id
and key (AD-21); no in-place key rotation or provider-side revocation is added.
Offline pending *pairing* rollback differs: its key/intent persist for recovery,
unlike a completed local unpair. Tokens are never persisted in either path.

## Reproduction

```sh
npm run check
npx vitest run tests/cloud-relay tests/identity tests/service/control-center.test.ts
CROT_E2E_CHROME=/path/to/chromium npm run test:e2e:browser
```

CI uses the existing six real OS/Node 20/22 matrices, four platform L1 jobs and
one real Chromium job (11 required jobs). Tests are not skipped by OS in the
new relay suites. No workflow/security permission changes are required.

## Verification record

- Targeted relay/identity/control regression: 217/217 passed before the two
  final global-admission/control-order assertions were added.
- Final targeted global-admission/control-order suite: 31/31 passed.
- Full `npm run check`, real Chromium regression and all 11 CI checks are
  required on the PR head before Ready for review. Their exact head SHA/run
  links and final counts are attached to the PR verification record; use those
  results rather than treating a branch status label as test evidence.

## Not claimed

No public staging (WP-38), live WorkOS/external-client qualification (WP-32),
entitlement service (WP-36), multi-instance routing/capacity planning (WP-39),
CORS support or whole-product GA. RFC 9207 remains the separate G4 condition.
