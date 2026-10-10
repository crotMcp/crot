# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## In progress

**WP-30 — Device tunnel adapter — Done, awaiting merge** (PR #20, branch
`wp-30-device-tunnel`; ARCHITECTURE.md §27 AD-22, device side). User docs:
[`docs/DEVICE_TUNNEL.md`](docs/DEVICE_TUNNEL.md),
[`docs/RELAY.md`](docs/RELAY.md).

- **Tunnel** (`DeviceTunnel`, `RemoteTunnel` in
  `src/service/remote-tunnel.ts`): outbound `crot-tunnel.v1` connection,
  challenge-signed handshake with the WP-28 device credential, pinned relay
  host, refusals 4401/4403/4426 (blocked state), reconnect with backoff;
  streams forwarded to the existing relay entry point of `CrotHttpServer`
  (token verification, admission, sessions, PermissionEngine,
  ExecutionGuard, approvals, audit unchanged); stream limit
  `min(1024, maxConcurrentRequests + maxSessions)`, 4 MiB / 32 MiB, flow
  control; tunnel loss and RESET abort through the AbortSignal, nothing is
  replayed; remote mode, unpairing and shutdown close the tunnel.
- **Registration at pairing** (AD-22 point 4,
  `src/identity/relay-registration.ts`): after the pairing token has passed
  the device's checks, the device registers its key at the relay; any
  failure fails pairing (`relay_registration_failed`).
- **OD-5 decided and recorded** in ARCHITECTURE.md §27 AD-22 points 12–13
  (commit `37b3126`): the tunnel ends a request 5 s before the relay's
  exchange deadline (`deadline_exceeded`, outcome `unknown`); long approvals
  and bounded browser waits run inside the deadline; no automatic retry;
  measured client timeouts in WP-32.
- **Acceptance and Definition of done:** the card's own criteria are met
  (remote requests run through the unchanged Core pipeline as
  `kind: "remote"`; remote mode off closes the tunnel; cancellation reaches
  pending approvals and not-yet-started operations, running ones are not
  interrupted, AD-22 point 13), the AD-15 C8 tests and the existing local
  stdio/HTTP behaviour are unchanged, the user docs above are written, and
  the ARCHITECTURE.md status markers §2.4, §19 item 18, §22 and the two
  §25 rows now record the device side of the tunnel as implemented
  (commit `01f4a20`).
- **Not WP-30, open with their own packages:** the relay has no device
  deregistration or key rotation, and a registration stays orphaned if the
  device fails to store its binding after registering (AD-22 open
  question 3; relay side, WP-29 scope, see `docs/RELAY.md` "Known
  limitations"); the 5 s margin of the OD-5 decision is measured against
  real client timeouts by WP-32 (AD-22 open question 5).

Tests: `tests/cloud-relay/device-tunnel.test.ts` (real relay → tunnel →
relay entry → Core: SDK clients of every supported version, parallel and
streamed requests, approval and cancellation, tunnel loss with outcome
`unknown` and no replay, tokens for another device or account and expired
tokens, bad signature, unknown device, unsupported version, reconnect,
secret-free logs) and `tests/cloud-relay/device-registration.test.ts`
(registration against the real relay and pairing end to end). CI test
setup only: the L1 ARM jobs pull `alpine:3.20` from `public.ecr.aws` with
retries (Docker Hub rate limit).

## Last completed

**WP-29 — Cloud Relay v1, relay side — partial** (merged into `main`,
`515fcb9`; ARCHITECTURE.md
§27 AD-22, included as the PR's first commit because it had not been merged
yet). User docs: [`docs/RELAY.md`](docs/RELAY.md). WP-29 is **not complete**:
the open items below are release-blocking (before WP-38 exposes a public
relay); they do not block WP-30.

- **Open WP-29 items:** per-client / per-device request rate and
  concurrency limits at the relay (AD-15 point 10, WP-29 scope "size/rate
  limits"); per-source limits on connections and pending handshakes (the
  256 pending-handshake limit is global); a registration rate limit per
  account; device deregistration and key rotation with the orphaned-
  registration case (AD-22 open question 3); the load/backpressure test of
  the WP-29 card. Either done in a WP-29 follow-up PR or explicitly
  reassigned to WP-39.

- **Tunnel protocol, shared code** (`src/tunnel/`): `crot-tunnel.v1` frame
  codec, limits, close/RESET/GOAWAY codes, header validation and hop-by-hop
  removal, version negotiation; a minimal RFC 6455 WebSocket client and
  server (Node 20 has no built-in WebSocket; no new dependency).
- **Relay** (`src/cloud-relay/`): PRM per registered device; device
  registration endpoint (pairing-client token only, checked before the body;
  Ed25519 key; first registration binds the account; idempotent);
  `/d/<id>/mcp` admission (token signature, `iss`, `aud` = canonical URI,
  times, `sub` = owner; entitlement hook for WP-36); routing by device id,
  one tunnel per device with supersession; challenge-signed handshake with
  timeout, a per-device rate limit counted only after a valid proof, and
  version refusal (4426); multiplexed streams with
  credit flow control in both directions; keep-alive, GOAWAY/drain,
  connection loss; a response completed before the request body frees the
  stream with `RESET cancel`; 4 MiB / 32 MiB limits; absolute exchange
  deadline (15 min, also for bodies buffered before forwarding: 408) and
  stall limit; WebSocket memory per connection bounded by one message
  (fragments, segments, pings), bodies of refused requests dropped within
  10 s; refusals with the AD-22 outcome
  (`not_executed` / `unknown`), never a retry; structured logs without
  tokens, headers or bodies. Binary `src/bin/crot-cloud-relay.ts`
  (`--config`, requires `pairingClientId`), not yet in `package.json` `bin`.
- **AD-22 clarifications** (in this PR, no wire change): the 4426 upgrade
  names the device's highest offered `crot-tunnel.v<N>` (point 10);
  malformed stream-0 frames are connection errors, malformed `OPEN` /
  `RESPONSE` heads stream errors (points 5, 14); a response completed before
  the request ends closes the stream with `RESET cancel`, which never
  affects the completed request (points 6, 13); handshake rate limiting
  counts only valid proofs (point 14); registration requires the pairing
  client (point 4).

Tests: `tests/cloud-relay/` — WebSocket endpoint limits (fragments,
byte-wise segments, ping backlog), registration and proofs (pairing client,
ownership, failed proofs do not lock a device out), forwarding and
outcomes, tunnel state machine (fake socket), tunnel over real sockets
(handshakes, versions, limits, flow control, keep-alive, connection loss,
supersession/reconnect), end to end with the MCP SDK (2026-07-28 and every
legacy version, streamed responses, gated approval and its cancellation,
injected identity headers ignored, log scrubbing) through a protocol-level
test device into a real `CrotHttpServer` relay entry. The device tunnel
adapter is WP-30 (PR #20); no deployed relay or live WorkOS environment yet
(WP-38).

## Previously completed

**WP-28 — Identity and device binding** (merged in crot-mcp PR #16,
`4d574f0`;
ARCHITECTURE.md §27 AD-21 with its implementation note). User docs:
[`docs/IDENTITY.md`](docs/IDENTITY.md), [`docs/TRAY.md`](docs/TRAY.md),
[`docs/SERVICE.md`](docs/SERVICE.md), README.

- **Verifier** (`src/identity/verifier.ts`) behind `AccessTokenVerifier` for
  the relay entry point, in the order of AD-21 point 3: RS256 with JWKS from
  the issuer's RFC 8414 metadata (bounded cache and refetch), `iss`, a single
  `aud` = the device's canonical URI, `exp` (no leeway) / `nbf` / `iat`
  (60 s skew, 15 min ceiling), `sub` = paired account, `client_id`. Only
  verified facts reach `AuthInfo`; `authMethod: "oauth"` is accepted only on
  the relay entry point, the local token never there. 401s carry
  `WWW-Authenticate` with the device's PRM URL.
- **Device binding** (`src/service/device-binding.ts`): paired account,
  device id (16 random bytes, base32), environment; Ed25519 device key in
  the secret store (`device-key`); protected private state, fail closed; a
  new device id and key per pairing; tunnel credential (domain-separated
  challenge signature) only for a paired device in its environment.
- **Pairing** (`src/identity/pairing.ts`): authorization code + PKCE S256,
  loopback redirect, `resource` = the new device's canonical URI; the token
  is verified like a remote request's, `sub` becomes the account; audited
  first; tray "Pair this device" opens the sign-in in the browser.
- **Revocation:** unpair (immediate, ends requests in flight, removes the
  key); re-grant of a revoked client (audited first, persisted before
  effect, older tokens refused); admission also checks the binding.
  Provider-side revocation from the tray is a hook reporting "not
  available" until WP-36.
- **Environment:** no release environment is pinned (WP-38/WP-39); a
  development environment comes from `CROT_IDENTITY_DEV_ENVIRONMENT`, which
  every build honours until one is pinned (release-gate item, roadmap §2.6
  N3).
- **Review** (independent review of PR #16 against AD-15, AD-21 and the
  WP-28 card): re-grant now takes effect inside its queued write, so a
  background write cannot serialize the revoked state after it (hardening,
  with a regression test); tray "Cancel pairing" message cleaned up; docs
  list the assumptions not yet verified against live WorkOS, the re-pairing
  effect on revocations, and the provider-side revocation deferral (N3).

Tests: `tests/identity/` (verifier with real RS256 JWTs and JWKS rotation,
pairing over a real loopback callback, binding, credential, environment,
re-grant boundary) against an in-process emulated AuthKit environment
(`tests/identity/test-authorization-server.ts`); the WP-22 relay tests now
pair the device and use the real verifier (`tests/service/tray-control.test.ts`,
new WP-28 block covering the AD-21 point 8 device column), tray controller
and view model. No live WorkOS environment was available for this PR.

**WP-23a — Linux command confinement L1** (ARCHITECTURE.md §27 AD-20,
decides the Linux part of OD-9 and OD-14; PR #6, `e1d1f61`). User docs:
[`docs/L1.md`](docs/L1.md), README. Follow-up CI test fixes after the merge:
PR #9 (`4df63c6`, Windows other-user probe without profile load), PR #11
(`2b803eb`, L1 renderer probe report race), PR #7 (`22abf89`, `git.write`
no-identity test with an isolated home); no production code changed.

- CROT-owned `crot-bwrap` (bubblewrap 0.11.0, pinned SHA-256) and
  `crot-l1-init` in `/usr/lib/crot/l1/<v>/`, AppArmor policy (ABI 3.0/4.0)
  installed and loaded by `scripts/l1-install.sh` (root; packaging WP-34);
  the service only verifies them.
- One sandbox per Core in workspace mode: read-only host, hidden protected
  paths and runtime directory (agent sockets bound back), writable workspace,
  private temp and home layer, network `on`/`off`, no nested user namespaces,
  process-tree cleanup.
- Docker endpoint on every transport (Unix, TCP, TLS, SSH, contexts) with
  checks a–d, HTTP 403, `confinement.docker_refused`, container profile for
  local daemons.
- `CONFINEMENT_UNAVAILABLE` (remote, before admission) and
  `CONFINEMENT_FAILED` (after admission, never retried unconfined); reason
  codes in `crot_status` and the tray.

- Home layer: directories the user owns with a supplementary group (e.g.
  `~/.docker`, group `docker`, on the GitHub runners) get a *group layer*
  (empty copies with the mapped uid/gid as a lower layer), because overlayfs
  cannot copy up an entry whose group is not mapped in the sandbox's user
  namespace (`EOVERFLOW`; `docker buildx` failed). Limitation: such *files*
  cannot be modified in place, only replaced ([`docs/L1.md`](docs/L1.md)).

Tests: real suites in the new L1 workflow (`.github/workflows/l1.yml`,
Ubuntu 22.04/24.04 x64/arm64, `CROT_L1_REQUIRED=1`), fixtures and mocks in
`tests/native-host/linux-l1/` and `tests/core/confinement.test.ts`. The L1
harness gives its remote scopes an in-memory (clean) exposure store, as the
Core unit tests do; without one every remote scope is exposed (fail closed)
and the untrusted-content gate refuses remote commands before L1 is reached.

Ubuntu 24.04 x86_64 with Google Chrome: Ubuntu's `chrome` profile
(`flags=(unconfined)`, `userns,`) was added to the stack on exec, so Chrome
ran as `chrome//&crot-l1-<v>//&crot-l1-payload-<v>` and the L1 peer rules
denied its own IPC. Fixed: the installer adds exact-path `ix` rules for the
host's loaded unconfined userns profiles (`scripts/l1-host-exec.py`), and
the payload inherits its label on exec (`file rwlkmix`, as AD-20 states);
AD-20 point 3 carries the explicit amendment. The L1 workflow drives the
installed browser inside L1 over CDP and checks labels, denials and the
boundary of its process tree; on the arm64 runners there is no browser and
these checks are reported as not applicable (notice), not as passed.

Previous: **WP-22 — Tray v1 and approval provider on the control channel**
(PR #2, `4639392`; ARCHITECTURE.md §27 AD-19, decides roadmap OD-7). User docs:
[`docs/TRAY.md`](docs/TRAY.md), [`docs/SERVICE.md`](docs/SERVICE.md), README.

- **Tray.** Separate Electron app (`npm run tray`), only a client of the
  authenticated control channel: no MCP, no tools, no Core access. Sandboxed,
  context-isolated page from memory (`crot-tray://app/`, strict CSP,
  `textContent` only), fixed 4-function preload, IPC checked by origin and
  validated; navigation, new windows and permissions denied.
- **Approval provider.** Service-side provider `tray`, registered through a
  `CrotCore.create` composition option while a tray is subscribed; decisions
  only for presented, pending requests with the presented digest; no
  auto-decision, no "always allow". Presentation per approval-gates §6.3;
  page-supplied values flagged (`ApprovalEffect.flag: "page_supplied"`).
- **Preset (OD-7).** Device state in `service-settings.json`; applied by
  switching to a new Core only while idle (no operation, approval or
  background process); exposure and bridge carried over; `require-approval`
  and `off` selectable, `autonomous-browser` with WP-31; unreadable state →
  `require-approval`.
- **Remote controls.** Remote mode (off by default; relay entry point refuses
  before MCP/Core while off), full-control opt-in (recorded and audited only,
  no enforcement), remote client list `remote-clients.json`, per-client
  exposure reset and revocation (fail closed; aborts requests, closes
  sessions; no re-grant). Every change audited (`control` records); widening
  changes need their audit record first.
- **Status.** `overview` / `crot_status` show preset and source, remote
  switches, agents, browser, trays, and L1/CDP/pairing as not available.

Tests: `tests/tray/` (view model, controller against a real service, Electron
smoke test — runs under xvfb-run on Linux CI, skipped with a reason where
Electron cannot start, required on CI), `tests/service/tray-control.test.ts`,
`tests/service/control-center.test.ts`, updated core tests (browser approval,
approval gates, remote exposure reset) and HTTP relay admission.

Before: **WP-21 — Secret storage and child-process environment allowlist**
(PR #1, `881663b`; AD-18), **WP-20 — Supervised service, thin stdio
shim, local control channel** (mcp-crot PR #16, `92cce3b`; AD-17,
[`docs/SERVICE.md`](docs/SERVICE.md)).

## Next

**Current: WP-30 — Device tunnel adapter, Done in PR #20, awaiting merge**
(see "In progress"). Critical path: yes — chain B continues WP-30 → WP-31 →
WP-32 → WP-33 → WP-40. The device connects with the WP-28 credential
(`CrotService.tunnelCredential()`), registers at pairing and reuses the
tunnel codec in `src/tunnel/`. **Next after WP-30: WP-31** (needs the
per-principal profile AD, §26 Q25, and WP-23b/c).

| WP | What | State |
| --- | --- | --- |
| WP-30 | Device tunnel adapter (AD-22, device side) | Done, PR #20 (awaiting merge): tunnel, pipeline entry and registration at pairing implemented; OD-5 decided and recorded in ARCHITECTURE.md (`37b3126`), status markers updated (`01f4a20`); open elsewhere: relay-side deregistration, key rotation and orphaned registration (AD-22 open question 3, WP-29), measured client timeouts (WP-32); per-principal profile AD (§26 Q25) needed before WP-31, not WP-30 |
| WP-24 | Browser v1: CDP backend, snapshot and references, trusted input, frames, shadow DOM, waiting, history (AD-16) | unblocked (WP-18), no open decision; parallel to WP-31 |
| WP-23b/c | Command confinement L1 on macOS and Windows (Linux done: WP-23a, AD-20) | blocked by the macOS/Windows part of OD-9; WP-23c starts with its spike (OD-6); release-blocking (AD-13), needed before WP-31 |
| WP-35 | Extension publication, submitted early | preparation now; submission after WP-24…WP-26 (`debugger`, `downloads`, `tabGroups`) |
| WP-41, WP-42 | Extensibility invariant tests; workspace image view (post-v1 phase 5; depend on no open contract — WP-42 without downscale, see product-reassessment §8) | can start now with spare capacity; never displace the critical path; WP-43/44/49 wait for OD-16/15/17 ADs |
| OD-15…OD-20, OD-23 | ADs of the expanded product goal (jobs, components, media, edit description, connectors, credentials; release staging) | documentation work, parallel to WP-31; see roadmap §4.2 |

**Expanded product goal (proposal, not implemented).** CROT is to become an
extensible execution environment for local and remote agents with full
media work, video editors and external services. Reassessment, decisions
and order: [`docs/plan/product-reassessment.md`](docs/plan/product-reassessment.md);
cards WP-41…WP-70: [`docs/plan/extension-work-packages.md`](docs/plan/extension-work-packages.md);
roadmap §2.7, §3, §4.2 (OD-15…OD-23), §8.5. v1 scope and the critical path
are unchanged; none of phases 5–8 is release-blocking (OD-23, recommended).
Nothing of it is implemented: media work today is only possible through
`shell.execute` (untested; remote on macOS/Windows refused without L1),
and no external service has a CROT integration.

## Open questions and follow-ups

| Item | Where it is decided |
| --- | --- |
| Full move of stdio and legacy sessions to MCP SDK v2 (today: v1 + v2 side by side) | follow-up after WP-19 |
| `server/discover` lists only 2026-07-28 (legacy versions are reachable via `initialize`) | follow-up / WP-32 |
| Concurrency limit for the tunnel entry point (loopback has `http.maxConcurrentRequests` since WP-20) | WP-30 (PR #20): the tunnel accepts at most `min(1024, maxConcurrentRequests + maxSessions)` streams; more are refused as `not_executed` |
| Background processes are owned by the service, not by the stdio client that started them (shared by all clients; they outlive that client until the service stops) | follow-up (AD-17 scope) |
| Approval deadlines are not extended across system sleep; sleep detection is a clock-jump heuristic (not changed by WP-22) | follow-up |
| All stdio clients of a user share one configuration and one process environment (supervisor's or starting shim's; differing PATH/shell/home is reported to the client; commands get only the allowlisted part since WP-21) | AD-17 residual risk; WP-34 |
| Windows named pipes keep Node's default security descriptor (no explicit owner-only DACL) | WP-34 |
| Unconfined children can use the OS secret store (or the file fallback) as the same user | AD-18 residual risk; Linux workspace mode: closed by WP-23a; `full_control`, macOS, Windows: open (WP-23b/c) |
| Host-local services that accept the user's authority without a CROT credential (Docker on TCP without TLS, SSH server on this host accepting the user's keys, debugging/notebook endpoints without authentication, container engines without the CROT container profile) are reachable with network `on` | Accepted residual risk of the host-network model (AD-20 point 14, OD-14 decided); reported in `detail` where detectable; disclosure in WP-37 |
| macOS, Windows and browser parts of the v1 platform matrix | roadmap OD-9 (Linux part decided by AD-20); blocks WP-23b/c and WP-34 |
| L1 components on user machines (installing `crot-bwrap`, `crot-l1-init`, the AppArmor policy and host exec rules; `scripts/l1-install.sh` until then) | WP-34 |
| AD-18/AD-19 texts still say "until L1 (WP-23)" although Linux is confined since AD-20 | roadmap §2.6 N1 (not amended silently) |
| `secrets.store: "auto"` keeps the file fallback once chosen; switching needs `"os"` | AD-18 residual risk |
| Autostart registration (systemd user unit, LaunchAgent, Task Scheduler) | WP-34 |
| Revoking a client's authorization at the identity provider from the tray (best effort after the device-side revocation; hook exists, reports "not available") | WP-36 (CROT account service holds the provider credentials) |
| No live WorkOS environment exercised yet (tests use an emulated AuthKit environment; unverified assumptions listed in docs/IDENTITY.md); no release configuration pins an identity environment, so every build honours the development override until then | WP-38 (staging), WP-39 (production), WP-34 (ship only pinned builds); release-gate item, roadmap §2.6 N3 |
| Relay–device tunnel protocol that uses the device credential (challenge signature format fixed by WP-28) | Decided by ARCHITECTURE.md §27 AD-22 (roadmap OD-4, OD-5); relay side implemented by WP-29, device side by WP-30 (PR #20, Done); AD-22 open questions 1–8 remain |
| Device deregistration and key rotation at the relay; a registration stays orphaned if the device fails to store its binding after registering | AD-22 open question 3 — relay side, WP-29 scope (not WP-30); listed in `docs/RELAY.md` "Known limitations" |
| Remote full-control opt-in is recorded only; how it takes effect (per-principal profile; `principalKinds` exists only in approval rules) | AD-19 point 7; WP-31 |
| Per-principal permission profile: grants and mode are global per Core, so AD-13 point 5 cannot be enforced with existing matchers | ARCHITECTURE.md §26 question 25 — an AD before WP-31 (did not block WP-30) |
| Preset `autonomous-browser` (rule set not implemented yet) | WP-31 |
| Any process of the same OS user can read the control credential and act like the tray | AD-19 residual risk; confined Linux children: closed by WP-23a; macOS, Windows, `full_control` and other processes of the user: open (WP-23b/c) |
| Tray packaging, signing and autostart (Electron is a dev dependency today) | WP-34 |
| Identity provider and the token claims carrying the subject, account, device and `clientId` | Decided by ARCHITECTURE.md §27 AD-21 (roadmap OD-2): WorkOS AuthKit; `sub` → principal id and `accountId`, device id in `aud`, `client_id` → `clientId`; implemented on the device by WP-28 |
| Exact device resource URI form and PRM location | Decided by AD-21 points 5–6 (roadmap OD-3): `https://<relay-host>/d/<deviceId>/mcp`, PRM at `https://<relay-host>/.well-known/oauth-protected-resource/d/<deviceId>/mcp` (relay: implemented by WP-29) |
| RFC 9207 (`iss` in authorization responses) not provided by the selected provider yet | **Still open** — AD-21 open condition: met before Gate G4 or accepted by a separate AD; WP-28 checks `iss` when present but neither requires nor claims it |
| Revocation at the identity provider reaches the device only through token expiry (≤ 5 min configured, ≤ 15 min device ceiling); device-side revocation is immediate | AD-21 point 4 (accepted bound) |
| Extensibility beyond v1 (media, video editors, external services, jobs, optional components) | Audit revision 2: [`docs/design/extensibility-audit.md`](docs/design/extensibility-audit.md); open decisions OD-15…OD-23 (roadmap §4.2, ARCHITECTURE.md §26 questions 16–24) |
| GUI control of desktop applications ("never in scope: OS-level input") | unchanged for v1; reassessed by OD-22 after spike WP-69 |
| Vendor API facts (YouTube, ElevenLabs, TikTok, Canva) | unverified; confirmed by WP-60, WP-62 and the first step of WP-58/WP-59 ([`docs/design/integration-map.md`](docs/design/integration-map.md)) |
| Transport matcher to gate loopback HTTP separately from stdio | ARCHITECTURE.md §26 question 12 (not required for v1) |
| Relay/tunnel timeouts for gated requests and bounded browser waits | Decided by ARCHITECTURE.md §27 AD-22 points 12–13 (§26 question 13); relay side implemented (WP-29); device side WP-30 (PR #20): a request ends 5 s before the exchange deadline (OD-5, recorded in ARCHITECTURE.md by `37b3126`); measured client timeouts WP-32 (AD-22 open question 5) |
| Relay request rate and concurrency limits, per-source connection and handshake limits, registration rate limit, relay load test | Open WP-29 items (AD-15 point 10; ARCHITECTURE.md §27 AD-22, Implementation (WP-29)); release-blocking before WP-38 exposes a public relay, or reassigned to WP-39 |
| Approval policy in general (beyond presets) | §26 question 6 |
| Limit remote agents to tabs they opened | §26 question 14 (opened by AD-16; not required for v1) |
| Input into background tabs on real sites; validation on at least three real sites | WP-24 |
| Debugger notice in headed Chrome/Edge/Brave on all OS; enterprise policies blocking `chrome.debugger` | WP-25 |
| Download hand-over mechanism (staging in the download directory or stream over the bridge) | WP-26 |
| Store acceptance of the `debugger` permission | WP-35 |
| How a preset change is applied by the supervised service (reload or restart) | WP-31 |
