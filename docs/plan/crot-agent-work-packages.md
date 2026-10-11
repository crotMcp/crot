# CROT — Agent Work Packages (v1: Remote MCP)

Detailed cards for WP-17…WP-37. Order, dependencies and status are in
[`CROT_IMPLEMENTATION_ROADMAP.md`](../../CROT_IMPLEMENTATION_ROADMAP.md); architecture and
decisions are in [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Common rules for every work package

- **Read first:** `AGENTS.md`, ARCHITECTURE.md §1, §2, §19, §27 AD-13 and
  AD-14, plus the sections listed in the card.
- **Definition of done (applies to every card in addition to its own):**
  `npm run check` passes; new behaviour is covered by tests; existing tools
  and behaviour keep working unless the card states a change; ARCHITECTURE.md
  status markers (§2.4, §25) and the affected user docs are updated; the
  status in `CROT_IMPLEMENTATION_ROADMAP.md` is set to `Done`; one PR per work package.
- **Do not:** add client-specific logic; bypass the ExecutionGuard /
  PermissionEngine; add a second permission or approval mechanism; run host- or
  agent-supplied code in the browser; work on the external MCP gateway or other
  post-v1 items.

---

## Phase 0 — Contracts

### WP-17 — AD-15 "Remote MCP request contract"

- **Status:** Done — ARCHITECTURE.md §27 AD-15.
- **Type / size:** documents only, S. **Depends on:** —.
- **Why:** closes the contradictions of AD-14 point 3 before code is written.
- **Read:** §20, §22, §26 questions 9–10, AD-9, AD-10, AD-12, AD-13,
  `src/adapters/http/` (`context.ts`, `auth.ts`, `server.ts`), README "HTTP
  transport" and "Approval gates", `package.json` (MCP SDK version).
- **Scope:** write AD-15 in ARCHITECTURE.md §27, covering:
  - principal kinds: loopback HTTP -> `local`, relay -> `remote`; migration of
    existing rules that use `principalKinds: ["remote"]` for loopback clients;
  - exposure key for remote principals: token grant (account + device +
    client id); survives new sessions, repeated `initialize` and stateless
    requests; reset only by a user action in the approval provider or
    revocation; local principals keep AD-12;
  - supported MCP protocol versions (at least 2025-06-18, 2025-11-25,
    2026-07-28), SDK version, stateless requests in the HTTP pipeline next to
    session-based ones;
  - authorization: PRM (RFC 9728) per device URL, RFC 8707, audience-bound JWT,
    CIMD + DCR + PKCE, no token passthrough, re-verification on the device;
  - relay–device tunnel shape (outbound, multiplexed, streaming, routing by
    headers without parsing bodies, no payload logging);
  - identity-provider selection criteria.
- **Out of scope:** code; choosing a concrete identity provider (WP-28).
- **Done when:** AD-15 merged; §26 question 10 marked decided; §22 and AD-12
  cross-reference it.

### WP-18 — Browser spike and AD-16 "Browser contract v1"

- **Status:** Done — ARCHITECTURE.md §27 AD-16. Spike (throwaway, not merged):
  Chrome for Testing 153, headless, local cross-origin fixtures; the three
  real sites could not be run (no internet in the work environment) and moved
  to WP-24.
- **Type / size:** spike + documents, S–M. **Depends on:** — (parallel to
  WP-17).
- **Read:** §7, §7.1, §21 (presets), §26 question 11, AD-6, AD-8, AD-9, AD-11,
  AD-12, `docs/BROWSER_EXTENSION.md`, `extension/`, `src/core/browser*`,
  `tests-e2e/`.
- **Scope:** throwaway prototype (not merged as product code) of click, keys,
  a cross-origin frame and a file upload on three real sites, with
  `chrome.debugger` (CDP) and with `chrome.scripting`; then AD-16 fixing:
  technology; command list and schemas; element-reference model and
  invalidation; dialogs; explicit `tabId` for remote principals; per-tab
  serialization; rule set and configuration key of the two approval presets;
  exposure sources for new reads; extension permissions and their store
  justification. CDP, if chosen, is used only through fixed commands (no
  agent-controlled `Runtime.evaluate`).
- **Done when:** AD-16 merged with the spike findings summarized; §26
  question 11 decided; WP-24/WP-25 cards adjusted (merge them if CDP makes
  that simpler).

---

## Phase 1 — Local foundation

### WP-19 — Principal kinds, exposure key and stateless HTTP (per AD-15)

- **Size:** M. **Depends on:** WP-17.
- **Read:** AD-12, AD-15, `src/adapters/http/`, `src/core/approvals/`.
- **Scope (AD-15 points 3, 6, 7, 8 and constraints C1–C3, C5, C8):**
  - first, decide and record in the PR whether the SDK v1 line supports
    2026-07-28 or the adapters move to SDK v2 (Core is not affected);
  - loopback HTTP principal `kind: "local"`; README updated (principal,
    migration of `principalKinds: ["remote"]` rules);
  - exposure scope replaces `SessionRef` as the key of `ExposureTracker`
    (stdio and legacy local sessions unchanged; sessionless loopback requests:
    the local-token principal); remote scopes keyed by account, device and
    client, persisted in private state and failing closed — exercised with a
    test verifier that produces remote principals (the real verifier is
    WP-28);
  - request id generated by the adapter, unique per process;
  - HTTP pipeline accepts 2026-07-28 sessionless requests (header validation,
    `server/discover`, 405 for GET/DELETE, version negotiation) and the
    session-based versions 2025-11-25 and 2025-06-18 on the same endpoint.
- **Out of scope:** the OAuth verifier and identity provider (WP-28), the
  tunnel entry point (WP-30), the exposure reset UI (WP-22).
- **Done when:** the tests of AD-15 C8 that do not need the relay pass:
  sessionless client; repeated `initialize` and new sessions do not clear a
  remote scope; remote exposure survives a restart and fails closed;
  header–body mismatch and unsupported versions are rejected; stdio
  behaviour unchanged.

### WP-20 — Supervised service, thin stdio shim, local control channel

- **Size:** L. **Depends on:** WP-19.
- **Read:** §24, AD-13 point 3, `src/bin/`, browser bridge sources.
- **Scope:** one background service owns Core, the browser bridge, HTTP and
  (later) the tunnel; stdio clients attach through a thin shim; an
  owner-only, token-authenticated local IPC control channel for the tray.
  **Reuse** the framing, token and endpoint handling of the browser bridge and
  `createCrotMcpServer`.
- **Done when:** several stdio clients work at the same time through the shim,
  the browser state `in_use` no longer occurs in normal use, the control
  channel rejects other users and unauthenticated peers.

### WP-21 — Secret storage and child-process environment allowlist

- **Size:** M. **Depends on:** WP-20.
- **Scope:** CROT secrets (local token, device key, control-channel
  credentials) in Keychain / DPAPI / libsecret or owner-only private files;
  child processes get only an allowlisted environment.
- **Done when:** secrets are not readable through CROT tools or inherited
  environment; tests on all three OS.

### WP-22 — Tray v1 and approval provider

- **Size:** L. **Depends on:** WP-20.
- **Read:** §21, AD-5…AD-11, `docs/design/approval-gates.md`.
- **Scope:** tray UI over the control channel: approvals showing the subject
  digest; remote mode on/off; active sessions; connected browser profile;
  preset selection (§21, AD-16); device pairing screen (used by WP-28). The
  provider implements the existing `ApprovalProvider` interface; the broker is
  unchanged.
- **Done when:** approvals work end to end for file, shell and browser
  operations; dismissal/timeout deny; decisions audited.

---

## Phase 2 — Command confinement L1 (parallel)

Why: a remote shell without confinement can read CROT's tokens and approve its
own requests. Profile: AD-13 point 4.

### WP-23a — L1 for Linux (bubblewrap, AppArmor profile)
- **Size:** M. **Depends on:** WP-21, AD-20 (normative for this card; it
  also decides the Linux part of OD-9: Ubuntu 22.04 and 24.04 LTS, x86_64 and
  arm64, and §26 question 15 / roadmap OD-14 in point 14).
- **Read:** AD-13 point 4, AD-17, AD-18, AD-19, AD-20, AD-3, §8,
  `docs/NATIVE_HOST.md`, `src/native-host/`, `src/core/platform/`.
- **Scope (AD-20):** the L1 components and AppArmor policy with their install
  helper for source checkouts and CI (point 3: the stacked transition
  `allow pix /** -> &crot-l1-<v>//&crot-l1-payload-<v>` is the only
  production transition, plus installer-generated exact-path `ix` rules
  for the host's unconfined application profiles; ABI 3.0 on 22.04, ABI 4.0 with userns rules on 24.04;
  no nested user namespaces, point 5); the sandbox (read and write
  boundary, private home layer, network `on`/`off`, one sandbox per Core,
  points 5–10) behind the Native Host's `ProcessLauncher`; the Docker endpoint
  (point 9); refusal and failure (point 11); availability checks, reason codes
  and `confinement` in `crot_status` and the control overview (point 12);
  audit (point 13); best-effort host-network notes in `detail` (point 14).
- **Out of scope:** packaging, signing and loading the policy on user machines
  (WP-34); macOS and Windows (WP-23b/c); `full_control`; changes to
  `docker.use`, `git.*`, the PermissionEngine or approvals.
- **Done when:** the general L1 criteria below hold as made concrete by
  AD-20 — Docker works from the confined shell through the Docker endpoint
  (no direct daemon access), writes go to the workspace, the private temp and
  the private home layer — and real-mechanism tests on Ubuntu 22.04 and 24.04
  CI runners show the escape cases (including nested user namespaces), both
  network modes, the development
  workflows (npm, pip, cargo, Go, Git, Docker and Compose including a TCP
  daemon, a localhost service and background processes), the reason codes and
  the remote-only refusal.

### WP-23b — L1 for macOS (Seatbelt, Keychain)
- **Size:** M. **Depends on:** WP-21.

### WP-23c — L1 for Windows (spike, then restricted / low-IL token + Job Object)
- **Size:** L. **Depends on:** WP-21.

- **Done when (each):** the AD-13 point 4 profile passes tests — no access to
  tokens, configuration, audit log, Docker socket or the tray control channel;
  writes only to the workspace, a private temp directory and the cache
  allowlist. Where the mechanism is unavailable, `shell` and `process`
  operations of `remote` principals are refused with the reason in
  `crot_status`.

---

## Phase 2B — Browser v1 (parallel, required for v1)

All commands go through `BrowserService` and the ExecutionGuard; AD-6, AD-8,
AD-9 and AD-11 bind every new control command; new reads are exposure
sources (AD-12); audit never records content. Requirements: §7.1; normative
contract: AD-16 (CDP backend with its fixed surface, command table point 20,
tests point 19). The cards below implement it and must not weaken it.

### WP-24 — CDP backend, snapshot, references, trusted input, frames, shadow DOM
- **Size:** L. **Depends on:** WP-18.
- **Scope (AD-16 points 3, 5, 6, 7, 10):** `debugger` permission and the fixed
  CDP allowlist (no `Runtime.evaluate` with non-built-in text); attach on
  demand; `browser_snapshot` with document-bound references and
  `BROWSER_STALE_REF`; trusted click, hover, scroll, drag, type, keys,
  select, checked by `ref` or selector; actionability checks; frames
  (including cross-origin) and open shadow roots; control results with
  `navigated` and `newTabs`; `browser_wait`, `browser_history`, `waitUntil`;
  `openerTabId` in the tab list; new operation names and the exposure source
  `browser.snapshot`; legacy selector forms unchanged.
- **Done when:** E2E on real Chromium covers a multi-step form flow by
  references, stale-reference errors after navigation, reload, removal and
  detach, `isTrusted` events, a cross-origin frame and an open shadow root;
  a forbidden CDP method cannot be sent; manual run on at least three real
  sites recorded (carried over from the WP-18 spike).
- **Status:** in review (PR #22, branch `wp-24-browser-v1`). Implemented
  and covered by unit tests and the real-Chromium E2E
  (`tests-e2e/browser/browser-v1.e2e.test.ts`): everything above except the
  manual run on three real sites, which has **not** been performed.

### WP-25 — Dialogs, file choosers, background screenshots, debugger lifecycle
- **Size:** M. **Depends on:** WP-24 (trusted input, frames and shadow DOM
  moved to WP-24 by AD-16).
- **Scope (AD-16 points 3, 4, 9, 13):** pending dialogs, `browser_dialog_handle`,
  `BROWSER_DIALOG_OPEN`, 60 s dismissal; file chooser interception;
  background screenshots (`ref`, `fullPage`, viewport metadata); debugger
  detach handling and CDP availability in `browser_status`; the "CROT" tab
  group (`tabGroups`).
- **Done when:** E2E passes for `alert`, `confirm`, `prompt`, `beforeunload`
  and the dialog timeout; screenshot of a background tab without focus
  change; the debugger notice checked manually in headed Chrome, Edge and
  Brave.

### WP-26 — File upload and download
- **Size:** M. **Depends on:** WP-24.
- **Scope (AD-16 points 11, 12):** `browser_file_upload` from an immutable
  private copy of a workspace file (`filesystem.read` + `browser.control`);
  `browser_download` of exactly the download the command started, saved
  atomically (`filesystem.write` + `browser.control`; `downloads`
  permission); choice of the download hand-over mechanism; paths checked by
  the workspace rules.
- **Done when:** E2E "upload a video fixture into a form" and a download into
  the workspace pass; paths outside the workspace are denied in sandbox mode.

### WP-27 — Multi-agent safety
- **Size:** S–M. **Depends on:** WP-24, WP-19.
- **Scope (AD-16 points 4, 8, 14):** per-tab FIFO queue in Core after the
  approval gate (bounded, `RESOURCE_BUSY`), mirrored in the extension;
  explicit `tabId` required for `remote` principals; `openedBy` in the tab
  list.
- **Done when:** two parallel agents do not interfere with each other or with
  the user's tabs (E2E).

---

## Phase 3 — Remote MCP

### WP-28 — Identity and device binding
- **Size:** L. **Depends on:** WP-17, WP-21, WP-22 (pairing UI); AD-21
  (normative: provider, claim model, revocation model, device URI).
- **Scope:** the managed identity provider of AD-21 (WorkOS AuthKit: DCR,
  CIMD, PKCE, RFC 8707, JWT); device pairing from the tray; OAuth verifier
  behind the existing `AccessTokenVerifier` (AD-21 points 2–4: JWKS, `iss`,
  `aud` = canonical device URI, `exp`/`iat`/`nbf`, `sub` = paired account,
  `client_id`, device-side revocation); `Principal` carries account and
  device ids; revocation.
- **Done when:** a paired device verifies tokens locally, revocation ends
  access, credentials never reach Core or the audit log.

### WP-29 — Cloud Relay v1
- **Size:** XL. **Depends on:** WP-17, WP-28.
- **Scope:** `https://<relay-host>/d/<deviceId>/mcp` and the PRM location
  of AD-21 points 5–6; 401 with `WWW-Authenticate`; admission of AD-21
  point 7;
  outbound multiplexed tunnel with streaming responses; routing without
  parsing bodies (2026-07-28 `Mcp-Method` headers); no payload logging; hook
  for the entitlement check (WP-36). The relay does not implement MCP.
  Tunnel protocol, device registration, limits (4 MiB request, 32 MiB
  response), exchange deadline (15 min) and outcomes: ARCHITECTURE.md §27
  AD-22 (relay side).
- **Done when:** an SDK client reaches a test device through the relay with
  every supported protocol version; payloads never appear in relay logs;
  the AD-22 constraint T4 tests pass.

### WP-30 — Device tunnel adapter
- **Status:** Done — PR #20 (not merged yet). Implemented: the tunnel
  (handshake, refusals, reconnect, streams, limits, cancellation,
  connection loss without replay), the pipeline entry, remote mode on/off
  and registration at pairing (point 4,
  `src/identity/relay-registration.ts`). OD-5 decided and recorded in
  ARCHITECTURE.md §27 AD-22 points 12–13 and `Implementation (WP-30)`
  (commit `37b3126`): the tunnel ends a request 5 s before the exchange
  deadline. ARCHITECTURE.md status markers §2.4, §19 item 18, §22 and the
  two §25 rows updated (commit `01f4a20`). User docs:
  [`DEVICE_TUNNEL.md`](../DEVICE_TUNNEL.md), [`RELAY.md`](../RELAY.md).
  Open with other packages, not WP-30: measured client timeouts (WP-32,
  AD-22 open question 5); relay-side deregistration, key rotation and the
  orphaned-registration risk (AD-22 open question 3, relay side, WP-29).
- **Size:** M–L. **Depends on:** WP-20, WP-28, WP-29.
- **Scope:** tunnel requests enter the **existing** HTTP pipeline
  (authentication -> session or stateless handling per WP-19 ->
  `StreamableHTTPServerTransport`) without the loopback address check;
  reconnect; remote mode on/off from the tray. Device side of
  ARCHITECTURE.md §27 AD-22: registration at pairing (point 4), tunnel
  handshake with the device key, pinned relay host and
  `/d/<deviceId>/mcp` instead of the loopback checks (point 7), deadline and
  cancellation (points 12–13).
- **Done when:** remote requests run through the unchanged Core pipeline as
  `kind: "remote"`; turning remote mode off closes the tunnel; cancellation
  reaches pending approvals and not-yet-started operations (running
  operations are not interrupted, AD-22 point 13).

### WP-31 — Remote permission profile and presets
- **Size:** M. **Depends on:** WP-19, WP-22, WP-23a/b/c, WP-30.
- **Scope:** `remote` defaults to workspace mode with `untrusted-content` on;
  full control for remote principals only as an explicit per-device opt-in;
  the *autonomous browser* preset as
  `permissions.approvals.untrustedContent: "autonomous-browser"` with the
  rule set of AD-16 point 17 (including `browser.file_upload`); how the
  service applies a preset change; all through `principalKinds` and
  `exposed` matchers.
- **Done when:** tests show the defaults, the opt-in and both presets;
  `crot_status` and the tray show them.

### WP-32 — Remote E2E acceptance suite and client compatibility
- **Size:** L. **Depends on:** WP-30, WP-31, WP-24…WP-26.
- **Scope:** ARCHITECTURE.md §14. Automated: SDK client -> relay -> CROT ->
  fixture project (files, commands under L1, Git, Docker) -> real Chromium
  (multi-step scenario across tabs, form, dialog, upload, download). Manual:
  at least four different remote MCP clients (for example Notion, Claude,
  Cursor and one more) over all supported protocol versions; results recorded
  in the repository.
- **Done when:** automated suite runs in CI; manual compatibility table
  committed with no blocking failures.

### WP-33 — External security review and fixes
- **Size:** M. **Depends on:** WP-32.
- **Done when:** no open critical or high findings.

---

## Phase 4 — Commercial release

### WP-34 — Installers, signing, updates, native-host registration, autostart
- **Size:** L. **Depends on:** WP-20, WP-22, WP-23a (the Linux L1 components
  and AppArmor policy of AD-20 point 3: WP-34 packages and signs them, loads
  the policy on install and upgrade, unloads and removes it on removal, and
  excludes the L1 private storage from temporary-file cleanup).
- **Done when:** installation on all three OS without a terminal (§10, §24).

### WP-35 — Extension publication (Chrome Web Store, Edge Add-ons)
- **Size:** M. **Depends on:** WP-25. Submit early.
- **Done when:** published; permission justification of AD-16 point 3
  (`debugger`, `downloads`, `tabGroups`) accepted.

### WP-36 — Minimal accounts and plans, entitlement check at the relay
- **Size:** M. **Depends on:** WP-29.
- **Done when:** the relay admits only entitled devices; local mode works
  offline without an account (§23).

### WP-37 — Hardening, documentation, legal, release checklist
- **Size:** M. **Depends on:** all above.
- **Scope:** privacy policy, terms, disclosure of the residual risks of AD-13
  and AD-14, user documentation, release checklist.
- **Done when:** the release checklist is closed.
