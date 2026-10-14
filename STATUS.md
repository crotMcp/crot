# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## Last completed

**WP-24 — Browser v1: CDP backend, snapshot and refs, trusted input,
frames, shadow DOM, waits, history — implemented, merged; acceptance open**
(PR #22 merged into `main` as `d273473`; started from `main` `9ce0574`).
Manual run 1 fixes merged in PR #23 (`96dde26`); manual run 2 fixes merged in
PR #24 (`a101008`). Manual run 3 is recorded in
[`docs/acceptance/WP-24-manual-run-3.md`](docs/acceptance/WP-24-manual-run-3.md);
run-3 fixes merged in PR #25 (`32334aa`). Manual
[runs 4](docs/acceptance/WP-24-manual-run-4.md) and
[5 / follow-up](docs/acceptance/WP-24-manual-run-5.md) are recorded.
Default-load timeout signalling is addressed in `wp-24-load-timeout-and-acceptance`
(acceptance open). User docs: [`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md)
("Browser v1: CDP backend"), [`docs/BROWSER_E2E.md`](docs/BROWSER_E2E.md)
("Browser v1 suite"). Normative contract: ARCHITECTURE.md §27 AD-16 (not
changed).

- **Implemented:** `chrome.debugger` backend with the fixed CDP allowlist
  (29 methods, no `Runtime.*`; one Emulation method: focus emulation), attach on demand, idle detach after 5 min,
  detach of every session when the CROT connection ends; `browser_snapshot`
  (exposure source) with document-bound refs and frame refs,
  `BROWSER_STALE_REF` without re-resolution; frames up to depth 8 / 100,
  including **out-of-process (cross-site) frames** as auto-attached child
  sessions (`Target.setAutoAttach` flatten) with coordinates translated to
  the top-level viewport; open shadow roots; trusted click, hover, scroll,
  drag, type, keys, select, checked by ref or selector (`frameRef` names the
  frame of a selector) with actionability checks (`INVALID_INPUT`, no
  `force`; hit test in document coordinates, a covered element is scrolled
  towards the centre once); JavaScript dialogs fail commands at once; settle with `waitUntil`, `navigated`,
  `newTabs`; `browser_wait`, `browser_history`; `openerTabId`; per-tab queue
  (16); 19 MCP tools. Approval subject and audit of ref targets (AD-16
  points 10, 16): element role and page-supplied accessible name, and the
  frame origin for a target in a child frame, from the last snapshot of that
  tab and connection (Core cache, reset per connection); the audit records
  role and frame origin only, never names, values, typed text or keys.
- **Confirmed by tests:** `npm run check` (unit and extension tests,
  including `tests/core/browser-approval.test.ts` element subjects and
  digest, `tests/capabilities/browser.test.ts` ref descriptions,
  `extension/test/frames.test.ts` child sessions, routing, coordinate
  translation and stale refs of out-of-process frames); real-Chromium E2E
  `tests-e2e/browser/browser-v1.e2e.test.ts` (form flow by refs, stale refs
  after navigation / reload / removal / debugger detach, `isTrusted` for
  click, keys and text, cross-origin out-of-process frame, open shadow root,
  pop-up `newTabs` / `openerTabId`, only allowlisted CDP methods sent).
- **Manual run 1 on real sites (owner):** Wikipedia, CodePen, Polymer shop,
  the-internet — 7 pass, 4 fail, 1 partial; recorded with causes and fixes
  in [`docs/acceptance/WP-24-manual-run-1.md`](docs/acceptance/WP-24-manual-run-1.md).
  Fixed in PR #23 (merged): input to background tabs (the tab is made visible first,
  `activated`; undelivered clicks and drags fail), rendered-text-only text
  waits, post-conditions for `select_option` / `set_checked`, bounded
  screenshots, focus emulation for keys, `loadTimedOut`, scrolling of
  elements in partly visible frames; new E2E case for a background tab.
- **Manual run 2 (owner, blocks A–F on the PR #23 build):** shadow DOM,
  background tabs, window states and reconnection passed; frames and
  scrolled pages failed. Recorded in
  [`docs/acceptance/WP-24-manual-run-2.md`](docs/acceptance/WP-24-manual-run-2.md).
  Fixed in PR #24: hit tests used viewport instead of document coordinates
  (false `obscured` on every scrolled page and frame), covered elements
  (sticky headers) are scrolled clear once and the error names the cover,
  text refs, false `BROWSER_STALE_REF` in same-process frames, `selector` +
  `frameRef` (AD-16 point 5) on all target commands and waits, JavaScript
  dialogs fail at once instead of after 30 s, dialogs first in snapshots;
  new E2E file `tests-e2e/browser/browser-layout.e2e.test.ts`.
- **Manual run 3 (owner, Chrome 153, run-2 build):** 22 executed rows:
  16 pass, 4 partial, 2 fail; G5 pending, H not run. Recorded in
  [`docs/acceptance/WP-24-manual-run-3.md`](docs/acceptance/WP-24-manual-run-3.md).
  Own/descendant pseudo-elements are included in hit-test ancestry (B4);
  waits observe native tab removal and an absolute deadline even during a
  blocked CDP poll (E5). Two native windows report distinct IDs in local E2E.
  CodePen's AX hang and Wikipedia's transient obscured error remain open;
  local history regressions do not prove those incidents fixed.
- **Manual run 4:** B4/E5/windows and cover protection passed; CodePen AX
  hang not reproduced, back scenario partial. See
  [`run 4`](docs/acceptance/WP-24-manual-run-4.md).
- **Manual run 5 + follow-up:** owner reports G5 audit and H0–H6 approvals
  passed, no-UI denial in 13 ms and restoration; exactly two approved audit
  pairs. See [`run 5`](docs/acceptance/WP-24-manual-run-5.md). Two 20 s opens
  succeeded before restricted snapshots. Local Chromium reproduces default
  load expiry without loadTimedOut; fixed in this branch without weakening
  page access restrictions.
- **Not done — WP-24 acceptance still open:** manual timeout-signal confirmation,
  C1's partial/unreproduced incident and final owner review. ARCHITECTURE.md
  §7.1 / AD-16 markers are unchanged (only an approved owner AD edit).
- **Out of scope (own packages):** dialogs, file chooser, background
  screenshots, tab group (WP-25); upload and download (WP-26, OD-8);
  remote explicit `tabId`, `openedBy`, two-agent ordering tests (WP-27).

## Previously completed

**WP-31 — Remote permission profile and presets — Done, merged** (PR #21,
merged into `main` as `9ce0574`; started from `main` `63a7d63`). Code verified at `9ca7b5b`, CI 11/11 green. The
per-principal profile decision is recorded as ARCHITECTURE.md §27 AD-23
(commit `69408c3`; point 4 names `REMOTE_DEFAULT_CAPABILITIES`, commit
`4a654f5`), together with §26 question 25 marked as decided by AD-23 and the
amendments of AD-19 point 7 and residual risk D. User docs updated for WP-31
(commit `99fb2c6`): [`docs/TRAY.md`](docs/TRAY.md),
[`docs/SERVICE.md`](docs/SERVICE.md), [`docs/L1.md`](docs/L1.md).

- **Implemented:** remote principals get their own profile in the one
  PermissionEngine, local principals are unchanged: workspace only, only the
  capabilities with an explicitly decided remote default
  (`REMOTE_DEFAULT_CAPABILITIES`: every current capability except
  `filesystem.full`) intersected with the configured grants, a capability
  added later denied until its remote default is decided, untrusted-content
  protection always on (with preset `off` they get `require-approval`); preset
  `autonomous-browser` selectable (browser control without repeated
  approval; uploads, shell, filesystem write, Git write, network and Docker
  Compose stay gated); the remote full-control opt-in is stored with the
  device id and account of the pairing it was given for and is restored
  after a restart only for that pairing (unpairing ends it; a new pairing
  has a new device id); missing, unreadable or mismatching state applies no
  full control; changes are applied through a new Core only while CROT is
  idle, never to other devices or to local principals; remote shell and
  process operations stay refused without L1 (`CONFINEMENT_UNAVAILABLE`,
  AD-20); `crot_status`, the control overview and the tray report the
  effective preset and its source, the remote profile, the opt-in (recorded
  and in effect) and the restrictions.
- **Confirmed by tests** (CI 11/11 green on `ae6b880`, `7d21f36`,
  `69408c3`, `723e7cf`, `99fb2c6`, `a0dba42`, `56db9ae` and `9ca7b5b`:
  Node 20/22 on Ubuntu, macOS and Windows, L1 on Ubuntu 22.04/24.04
  x64/arm64, real-chromium):
  - tools cannot reach the device controls: no MCP tool is a control
    method; writing the settings, the client list or the binding through
    tools is refused even in `full_control`; control requests naming another
    device, account or client, and approvals without the subject digest, are
    malformed (`tests/core/untrusted-sources.test.ts`);
  - relay entry point: only the MCP tools, no write to the state files,
    local `full_control` does not widen the remote principal, full control
    for another device does not apply, a pending approval is decided only by
    the approval provider; browser bridge: hostile page content changes
    neither the profile nor approvals and marks the scope untrusted
    (`tests/adapters/relay-untrusted.test.ts`);
  - `crot_status` reports the remote profile end to end through the MCP
    adapter and the relay entry point;
  - full control across restarts of the real service: restored for the same
    pairing; unpairing and a new pairing end it; a stored opt-in for another
    pairing or with an unusable binding does not apply
    (`tests/service/full-control-grant.test.ts`);
  - remote default capabilities: a guard test fails for a capability
    without an explicitly decided remote default; the agreed remote default
    is pinned; full control adds only `filesystem.full`; local grants are
    unchanged (`tests/core/remote-capabilities.test.ts`);
  - control center: every preset applied, refusal while busy, rollback when
    a new Core cannot be built, audit record first
    (`tests/service/control-center.test.ts`).
- **Upload/download gate (AD-23 point 8):** the rule
  `autonomous-browser-upload` gates `browser.file_upload` in every scope and
  is covered by rule-set tests (defensive, it matches nothing today); a
  download will need `filesystem.write`, which `autonomous-browser` keeps
  gated in an exposed scope, as `require-approval` does. Neither operation
  exists before WP-26 (`browser_file_upload`, `browser_download`), so the
  end-to-end check of the real gates is part of the WP-26 acceptance
  (roadmap WP-26 card) and is not claimed by WP-31.
- **Accepted, not closed:** a process of the same OS user with an
  unconfined local shell can write the state files directly (AD-19 residual
  risk D); a forged full-control opt-in still applies only to the pairing it
  names (AD-23 point 6).
- **Release blockers outside WP-31:** L1 on macOS and Windows (WP-23b/c;
  there remote shell and process operations are refused with
  `CONFINEMENT_UNAVAILABLE`); the end-to-end upload/download check (WP-26).

**WP-30 — Device tunnel adapter** (merged into `main` through PR #20;
WP-31 starts from `main` `63a7d63`; ARCHITECTURE.md §27 AD-22, device
side). User docs:
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

**Active engineering stage — WP-23c restricted-token spike.** Owner authorized
implementation work after the OD-9 proposal; native Windows x64 and ARM64 stay
in the v1 target. Native restricted-token/DACL primitives and a required
architecture-specific CI matrix are being added (workflow publication is
blocked by GitHub Workflows write permission); see
[`docs/design/windows-l1-spike.md`](docs/design/windows-l1-spike.md).
Stage 2 adds research-only suspended restricted child creation, pre-resume Job
assignment and actual file/descendant/failure probes; native CI is required
before these cases count as passed. This is not a production L1 backend or a
completed OD-6 decision. macOS and
Windows runtime confinement remains `not_implemented`/fail-closed until the
full boundary and positive remote shell/process acceptance are implemented.
`ARCHITECTURE.md` and WP-25/26/27 are unchanged in this stage.

**WP-24 — Browser v1 (CDP backend): implemented, merged** (PR #22, `d273473`; run-1 fixes in PR #23; run-2 fixes in PR #24;
see "Last completed"). Real-site manual runs are recorded; acceptance remains
open for default-load timeout signalling, C1 and final acceptance review. Owner's order after
WP-24: OD-9 (L1 on macOS and Windows; opens WP-23b/c and the OD-6 spike),
OD-8 (download hand-over, before WP-26), then WP-38 preparation starting
with the open WP-29 items. Critical path: chain B continues WP-32 → WP-33 →
WP-40; WP-32 waits for WP-24…WP-27 and WP-38.

| WP | What | State |
| --- | --- | --- |
| WP-24 | Browser v1: CDP backend, snapshot and references, trusted input, frames, shadow DOM, waiting, history (AD-16) | implemented, PR #22–#25 merged; manual runs 1–5/follow-up recorded; B4/E5/windows and G5/H passed by owner; default-load timeout signalling in `wp-24-load-timeout-and-acceptance`; C1 partial, final acceptance open |
| WP-31 | Remote permission profile and presets (AD-13, AD-19, AD-23) | Done, merged (PR #21, `9ce0574`); code verified at `9ca7b5b`, CI 11/11 green; AD-23 recorded (`69408c3`; point 4 wording `4a654f5`); user docs updated (`99fb2c6`); end-to-end check of the real upload/download gates: WP-26 acceptance; see "Last completed" |
| WP-30 | Device tunnel adapter (AD-22, device side) | Done, merged (PR #20): tunnel, pipeline entry and registration at pairing implemented; OD-5 decided and recorded in ARCHITECTURE.md (`37b3126`), status markers updated (`01f4a20`); open elsewhere: relay-side deregistration, key rotation and orphaned registration (AD-22 open question 3, WP-29), measured client timeouts (WP-32) |
| WP-25, WP-27 | Browser dialogs / file chooser / background screenshots / tab group; per-tab queue for remote, explicit `tabId`, `openedBy` | unblocked by WP-24 |
| WP-26 | Browser upload and download (AD-16 points 11–12) | after WP-24 and OD-8; also provides the end-to-end check of the WP-31 upload/download gate (AD-23 point 8) |
| WP-23b/c | Command confinement L1 on macOS and Windows (Linux done: WP-23a, AD-20) | WP-23c native token/DACL spike in progress following owner authorization; production boundaries still require OD-9/OD-6 decisions; WP-23b not implemented; release-blocking (AD-13); not a prerequisite of WP-31: where L1 is unavailable (macOS, Windows), remote shell and process operations are refused with `CONFINEMENT_UNAVAILABLE` and an explanation (AD-20, [`docs/L1.md`](docs/L1.md)); WP-23b/c stay open as separate packages |
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
| Relay–device tunnel protocol that uses the device credential (challenge signature format fixed by WP-28) | Decided by ARCHITECTURE.md §27 AD-22 (roadmap OD-4, OD-5); relay side implemented by WP-29, device side by WP-30 (PR #20, merged); AD-22 open questions 1–8 remain |
| Device deregistration and key rotation at the relay; a registration stays orphaned if the device fails to store its binding after registering | AD-22 open question 3 — relay side, WP-29 scope (not WP-30); listed in `docs/RELAY.md` "Known limitations" |
| Remote full-control opt-in is recorded only on `main`; how it takes effect (per-principal profile; `principalKinds` exists only in approval rules) | Decided by AD-23 point 6 and AD-19 point 7 (`69408c3`); implemented in PR #21 (not merged): bound to the device id and account of its pairing and kept across restarts |
| Per-principal permission profile: grants and mode are global per Core, so AD-13 point 5 cannot be enforced with existing matchers | Decided by ARCHITECTURE.md §27 AD-23 (§26 question 25, `69408c3`); implemented in PR #21 (not merged) |
| Preset `autonomous-browser` (rule set not on `main` yet) | AD-23 point 5; implemented in PR #21 (not merged); its upload gate is not verified end to end until an upload operation exists (AD-23 point 8, WP-26) |
| Any process of the same OS user can read the control credential and act like the tray, including writing the protected state files directly | AD-19 residual risk D (amended by WP-31); confined Linux children: closed by WP-23a; macOS, Windows, `full_control` and other processes of the user: open (WP-23b/c) |
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
| How a preset change is applied by the supervised service (reload or restart) | Decided by AD-23 point 10: a new Core, switched only while idle; refused while busy; restored settings and the previous Core if the new Core cannot be built; implemented in PR #21 (not merged) |
