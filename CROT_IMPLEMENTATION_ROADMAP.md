# CROT — Implementation Roadmap to Commercial v1

> **Status of this document.** This is the authoritative execution roadmap for
> CROT v1. It **replaces** `docs/plan/crot-implementation-plan.md` as the
> plan of record and supersedes the work-package cards in
> `docs/plan/crot-agent-work-packages.md` wherever they differ (§5 lists the
> differences). It does not change the architecture.
>
> **Precedence.** `ARCHITECTURE.md` (including §27 decisions) > this roadmap >
> the old plan and cards in `docs/plan/` > `README.md` and `docs/*` (which
> describe the current implementation).
>
> **Verified against:** `main` at `8169b1f` (merge of PR #14, WP-19, 2026-10-05).
> Status claims below were checked against the repository tree, the source
> files named, the CI workflows and the merged history, not taken from earlier
> plans.

---

## 0. How to use this roadmap

1. Read `AGENTS.md`, then `ARCHITECTURE.md` §1, §2, §7.1, §19–§24, §26 and the
   ADs a work package (WP) names. Then read this roadmap's §6 card for the WP.
2. **Pick the next WP** with the rule in §8.4: the lowest-numbered WP on the
   critical path whose dependencies are `Done`; otherwise any unblocked
   parallel WP. Never start a WP whose blocking decision (§4.2) is not
   recorded.
3. One WP — one PR. The PR updates: the status column in §6.1 of this file,
   `STATUS.md`, ARCHITECTURE.md status markers (§2.4, §16, §25) and the user
   docs it affects. If the WP changes an architectural boundary, the first
   commit (or a preceding PR) adds an AD to ARCHITECTURE.md §27.
4. Each card says **what must become true**. Classes, files, algorithms and
   libraries are the implementing agent's choice unless an AD fixes them.
5. Housekeeping (first docs PR after this file lands, or folded into the next
   WP PR): repoint `AGENTS.md` and `ARCHITECTURE.md` header references from
   `docs/plan/crot-implementation-plan.md` to this file, and mark the old plan
   and cards as superseded.

---

## 1. What CROT is (planning summary)

CROT is an installable, commercial, local AI-agent bridge. v1 is the chain:

```text
any compatible remote MCP client
        ↓  HTTPS, MCP authorization (OAuth 2.1, PRM, resource indicators)
internet / CROT Cloud Relay        (routes, never stores or logs payloads)
        ↓  outbound tunnel opened by the device
local CROT on the user's device    (supervised service; verifies every token;
                                    ExecutionGuard → PermissionEngine →
                                    approvals → execute → audit)
        ↓
user's computer (files, commands under L1, Git, Docker)
+ user's real Chromium browser (tabs, pages, forms, dialogs, files, pop-ups)
```

Non-negotiables used throughout this roadmap:

- **Client-neutral.** No client-specific code in Core, adapters or the relay;
  concrete clients are compatibility targets only (§11, AD-14 point 1).
- **One authority.** Every operation passes ExecutionGuard / PermissionEngine;
  no second permission or approval system (§6, AD-5).
- **Local-first.** Local mode works offline without an account; commercial
  entitlements never grant local capabilities and are checked only at the
  relay (§23, AD-13 point 6).
- **Function A vs B.** Remote access (CROT as MCP *server*) is mandatory in
  v1; the external MCP gateway (CROT as MCP *client*) is post-v1 and is not
  touched (AD-13 point 2).

---

## 2. Where we are now (verified state of `main`)

### 2.1 Last completed work package

**WP-20 — Supervised service, thin stdio shim, local control channel**
(§27 AD-17, decides OD-1). In the tree:

- `src/service/`: one CROT service per OS user (`service.ts`) owning Native
  Host, browser bridge, Core and HTTP; the thin stdio shim (`shim.ts`) that
  `crot-mcp` is on stdio, starting the service on demand; the authenticated
  channel (`channel.ts`: mutual HMAC challenge–response, per-message sequence
  numbers and HMACs) on two owner-only endpoints with separate credentials
  (`endpoints.ts`); the control channel (`control-client.ts`,
  `crot-mcp service status|stop`); sleep/wake detection
  (`resume-detector.ts`).
- `crot_status.service`; `http.maxConcurrentRequests` for sessionless
  requests (`src/adapters/http/server.ts`).
- Tests: `tests/service/*.test.ts` (channel negatives incl. replay, service and
  control channel, built shim end to end incl. another OS user (enabled by
  `CROT_TEST_OTHER_USER`, set in CI by `scripts/ci-other-user.mjs`; concurrent
  starts leave one owner), crash
  restart with persisted remote exposure, AD-7 shutdown audit),
  `tests/adapters/http-modern.test.ts` (concurrency limit), the existing stdio
  and browser E2E through the shim. User docs: `docs/SERVICE.md`.

Previous: **WP-19 — Remote MCP request pipeline per AD-15**, merged in PR #14
(`8169b1f`). Verified in the tree:

- `src/adapters/mcp/modern.ts` and `@modelcontextprotocol/server` (SDK v2)
  serve sessionless 2026-07-28 requests; SDK v1 (`@modelcontextprotocol/sdk`)
  serves stdio and legacy session versions 2025-11-25 / 2025-06-18 on the same
  `/mcp` endpoint.
- `src/adapters/http/context.ts`: entry points `loopback` → `kind: "local"`,
  `relay` → `kind: "remote"` with verified `accountId`, `deviceId`,
  `clientId`; the local token is refused on the relay entry point; exposure
  scopes per AD-15 point 8.
- `src/core/approvals/remote-exposure.ts`: persisted, fail-closed remote
  exposure (`<state>/remote-exposure.json`).
- Tests: `tests/adapters/http-modern.test.ts`, `tests/core/remote-exposure.test.ts`,
  `tests/adapters/invoke.test.ts`.
- No tunnel, verifier or relay code exists yet.

### 2.2 Complete (verified)

| Area | Evidence in repository | Decision |
| --- | --- | --- |
| Core, PermissionEngine, ExecutionGuard, audit, config, workspace | `src/core/*`, tests | — |
| Filesystem, shell, managed processes | `src/core/capabilities/{filesystem,process}` | — |
| Platform layer Linux/macOS/Windows; Native Host (Windows Job Objects, owner-only ACLs) | `src/core/platform`, `src/native-host`, `docs/NATIVE_HOST.md` | — |
| MCP over stdio; Streamable HTTP on loopback with local token | `src/adapters/mcp`, `src/adapters/http` | AD-13 p.6 |
| Per-user CROT service, thin stdio shim, authenticated owner-only control channel, sessionless concurrency limit | `src/service`, `docs/SERVICE.md` | AD-17 |
| `git.read`, `git.write` | `src/core/capabilities/git` | AD-1, AD-2 |
| `docker.use` (ps, logs, compose up/down) | `src/core/capabilities/docker` | AD-3 |
| `network.access` host policy for CROT's own requests | `src/core/capabilities/network` | AD-4 |
| Approval-gate mechanism (broker, rules, subject digest, gated guard path, tab/origin/`connectionId` binding, expected-subject check) | `src/core/approvals`, bridge, extension; `docs/design/approval-gates.md` | AD-5…AD-11 |
| Untrusted-content exposure and the `untrusted-content` rule | `src/core/approvals/exposure.ts` | AD-12 |
| Remote request pipeline (sessionless + legacy, principal kinds, exposure scopes, persisted remote exposure) | see §2.1 | AD-15 |
| Browser bridge, `crot-browser-relay`, MV3 extension, `browser install`, 10 basic tools | `src/browser-bridge`, `extension/`, `src/cli/browser-install.ts` | §7 |
| Real-browser E2E (Linux, Chrome for Testing, Xvfb) | `tests-e2e/browser`, `.github/workflows/browser-e2e.yml` | — |
| Lint/format/typecheck/test gate `npm run check`; CI on Ubuntu, macOS, Windows × Node 20, 22 | `.github/workflows/ci.yml` | — |
| Contracts: remote request contract, browser contract v1 | ARCHITECTURE.md §27 | AD-15, AD-16 |

### 2.3 Partially implemented

| Area | What exists | Gap to v1 |
| --- | --- | --- |
| Browser | 10 tools; `chrome.scripting`, synthetic `element.click()`, main frame only, active-tab screenshots; permissions `nativeMessaging`, `tabs`, `scripting`, `alarms` | Entire AD-16 contract: CDP backend, snapshot/refs, trusted input, frames, shadow DOM, waits, history, dialogs, upload, download, background screenshots, tab group, per-tab queue, explicit `tabId` for remote, `openedBy` (WP-24…WP-27) |
| User confirmations | Mechanism complete; `ApprovalProvider` interface; only a test provider (`tests/approval-provider.ts`) | No product provider: every gated operation is denied today (WP-22) |
| Identity | `Principal` with remote fields; `AccessTokenVerifier` seam; static local token | No OAuth verifier, identity provider, device identity, pairing or revocation (WP-28) |
| Relay entry point | HTTP pipeline accepts a `relay` entry point (tests only) | No tunnel (WP-30), no relay (WP-29) |
| Remote exposure lifecycle | Persisted, fail-closed | No user reset or revocation path (WP-22, WP-28); persistence write failures are only logged |
| Process lifecycle | One per-user service (on demand from the shim, or managed by an OS supervisor), shim, control channel (WP-20, AD-17) | No autostart registration / supervisor files (WP-34); background processes are owned by the service, not by the client that started them (follow-up) |
| Child-process environment | Overrides; Docker and Git have allowlists | No general allowlist for `shell.execute` / `process.manage` (WP-21) |
| Secrets | Owner-only private files (0600 / ACL) | Not in OS secure storage; readable by unconfined commands (WP-21, WP-23) |
| Cross-OS browser validation | Linux E2E only | macOS / Windows browser chain unverified end to end (WP-25, WP-40) |

### 2.4 Missing for v1 (nothing in the repository yet)

Supervised service, stdio shim, local control channel; tray app; secure
secret storage; command confinement L1 (all OS); identity provider integration
and device binding; Cloud Relay; device tunnel; remote permission profile and
presets; acceptance suite through a relay; external security review;
installers, signing, updates, autostart; published extension; accounts, plans,
billing, entitlements, device management; staging and production cloud
operations; user, privacy and security documentation; legal terms; release
process.

### 2.5 Discrepancies found and how this roadmap resolves them

| # | Discrepancy | Resolution |
| --- | --- | --- |
| D1 | Old plan §2 header says "`main` at `0f0634c`"; actual `main` is `8169b1f` | This roadmap is verified against `8169b1f` |
| D2 | WP-32 depended only on WP-24…WP-26, but AD-16 point 19 requires tests of per-tab ordering with two agents and `INVALID_INPUT` for a remote principal without `tabId` (WP-27) | WP-27 is a hard dependency of WP-32 |
| D3 | WP-35 depended only on WP-25, but the store permission set includes `downloads` (WP-26) and `debugger` (WP-24) | WP-35 submission depends on WP-24, WP-25, WP-26; preparation can start now |
| D4 | WP-34 depended only on WP-20, WP-22, but the installer must ship the Linux AppArmor profile for bubblewrap (AD-13 point 4) and register the published extension IDs | WP-34 also depends on WP-23a and WP-35 (for IDs) |
| D5 | The WP-22 card did not list exposure reset and client revocation, which AD-15 C5 places exclusively on the approval-provider channel | Added to WP-22 scope |
| D6 | WP-32's manual run needs real cloud-hosted clients to reach a public relay with TLS and a real identity provider; no WP provided such an environment | New WP-38 (staging cloud environment) |
| D7 | No WP covered production cloud operations, billing, device management for lost devices, version skew between store-updated extension and app, or the release process | New WP-39, WP-40; WP-34 and WP-36 scopes extended |
| D8 | AD-13 point 8 names a client-specific E2E ("Notion → relay → …") | Superseded by AD-14 point 5; this roadmap uses only the client-independent suite (§14) |
| D9 | AD-13 point 4 makes Windows L1 "to be confirmed by a spike"; no fallback decision exists if the spike fails | Recorded as open decision OD-6 with a deadline (§4.2) |

No contradiction was found that requires changing an accepted AD.

---

## 3. Phase and work-package overview

| Phase | Purpose | WPs |
| --- | --- | --- |
| 0 Contracts | Decide before code | WP-17, WP-18 — **Done** |
| 1 Local foundation | Supervised product on one machine | WP-19 **Done**, WP-20, WP-21, WP-22, WP-19b (optional) |
| 2 Confinement | L1 on all three OS | WP-23a, WP-23b, WP-23c |
| 2B Browser v1 | AD-16 contract | WP-24, WP-25, WP-26, WP-27 |
| 3 Remote | Identity → relay → tunnel → profile → acceptance → review | WP-28, WP-29, WP-30, WP-31, WP-38, WP-32, WP-33 |
| 4 Commercial | Ship and operate | WP-34, WP-35, WP-36, WP-37, WP-39, WP-40 |

Technical completion = Gate 6 (security review ready, §9). Commercial
readiness = Gates 7 and 8. Both are required for v1.

---

## 4. Architectural decisions

### 4.1 Already decided (constraints for every WP)

| AD | Constrains |
| --- | --- |
| AD-1 / AD-2 | Git never runs repository-controlled programs; fixed non-destructive write commands; no Git network ops in v1 |
| AD-3 | Docker only through fixed operations (ps, logs, compose up/down); no build/pull |
| AD-4 | `network.access` is a host policy for CROT's own requests; OS egress control is post-v1 |
| AD-5 | Approvals only narrow authorized operations; only the user opens them; no provider = deny; approval channel independent of the request path |
| AD-6, AD-8, AD-9, AD-11 | Browser approvals bound to tab, normalized origin and `connectionId`, resolved before the request and re-checked right before acting |
| AD-7 | Gated operation refused if its mandatory audit record cannot be written |
| AD-10 | Approval rules in `permissions.approvals` with fixed defaults; policy is immutable at runtime except through the user |
| AD-12 | Untrusted content marks the agent context exposed; effectful operations then need approval (amended by AD-15 for scopes, AD-16 for sources/presets) |
| AD-13 | v1 scope: remote access mandatory; external gateway post-v1; L1 required on all OS with refusal-only fallback; remote profile; managed IdP; relay TLS-terminating, no payload storage; no local licensing; local token stays for local clients |
| AD-14 | Browser contract v1 release-blocking; client-independent acceptance (§14); two presets; phase order |
| AD-15 | Sessionless request model; principal kind by entry point; request-scoped execution context; exposure scopes; supported versions 2026-07-28, 2025-11-25, 2025-06-18; PRM/RFC 8707/audience-bound JWT; relay and device responsibilities; constraints C1–C8 |
| AD-17 | One per-user CROT service (never a system service), on demand from the stdio shim or managed by an OS supervisor; thin shim without policy, one exposure scope per stdio connection, no silent reconnect; one configuration per service; authenticated owner-only shim and control endpoints (mutual HMAC, replay protection); control channel without MCP/tools; shutdown keeps AD-7 |
| AD-16 | CDP backend with fixed allowlist; command list v1; document-bound refs; explicit `tabId` for remote; per-tab FIFO; dialogs, files, screenshots; presets key `permissions.approvals.untrustedContent` = `require-approval` / `autonomous-browser` / `off`; store justification; required tests (point 19) |

### 4.2 Still open

Only genuinely unresolved questions are listed. "AD" means the answer changes
a boundary and must be recorded in ARCHITECTURE.md §27 before code.

| ID | Question | Why it matters | Blocks | Decide by |
| --- | --- | --- | --- | --- |
| OD-1 | **Decided in ARCHITECTURE.md §27 AD-17 (WP-20):** per-user service, never a system service; managed by a systemd user unit / LaunchAgent / per-user Task Scheduler logon task (registered by WP-34) or started on demand by the stdio shim, which fails with a clear error only when the service cannot be started or runs another configuration | — | (WP-34 registers autostart) | Decided |
| OD-2 | Concrete identity provider and the token claims carrying `clientId` and device id (AD-15 open item) | Verifier, PRM metadata, relay token check, DCR/CIMD support | WP-28, WP-29, WP-38 | Start of WP-28 (selection against AD-15 point 5 criteria; record in AD or WP-28 PR) |
| OD-3 | Exact device resource URI form and PRM location (AD-15 open item) | Token audience, client configuration UX, relay routing | WP-29, WP-30, WP-28 tests | Start of WP-29 |
| OD-4 | Relay–device tunnel wire protocol within the AD-15 shape (framing, multiplexing, flow control, keep-alive, versioning) | A long-lived contract between independently deployed relay and installed devices; version skew after release | WP-29, WP-30, WP-34 (updates) | Start of WP-29 — **AD required** (new boundary) |
| OD-5 | §26 Q13: relay/tunnel timeouts for gated requests (approval up to 300 s) and bounded browser waits; behaviour towards clients with shorter timeouts | Remote multi-step tasks with approvals must not fail silently | WP-29, WP-30, WP-32 | Before WP-30 is merged |
| OD-6 | Windows L1 mechanism (AD-13 p.4: "restricted / low-IL token + Job Object, to be confirmed by a spike") and what happens if the spike shows it cannot meet the profile | L1 is release-blocking on every OS; the only accepted fallback is refusing remote shell on machines where the mechanism is unavailable, not on a whole OS | WP-23c, WP-31, Gate 6 | End of the WP-23c spike; if infeasible, a new AD before WP-31 |
| OD-7 | How a preset / remote-profile change is applied by the service (reload vs restart) | Policy immutability (AD-5, AD-10) vs usability | WP-31 | Start of WP-31 (already assigned by AD-16 p.17) |
| OD-8 | Download hand-over mechanism (staging in download directory vs stream over bridge) | File-integrity guarantees of AD-16 p.12 | WP-26 | Start of WP-26 (already assigned by AD-16) |
| OD-9 | Supported platform matrix for v1 (minimum Windows, macOS, Linux distributions and their userns/AppArmor policies; Chrome/Edge/Brave minimum versions; architectures) | L1 mechanisms, installer formats and support promises depend on it | WP-23a/b/c, WP-34, WP-37 | Before WP-23a/b/c start |
| OD-10 | Store extension IDs vs native-host `allowed_origins` (Chrome Web Store and Edge Add-ons may assign different IDs; current manifest pins `bllcepanlhojbddfbbpegmnokpaakool`) and custody of the extension signing key | The native host must allow exactly the published extensions and nothing else | WP-34, WP-35 | When store items are created (WP-35 start) |
| OD-11 | Version-compatibility policy across extension (store auto-updates), local service, tray and relay/tunnel protocol; minimum supported versions; whether the relay may refuse outdated devices | Independent update channels can break the chain; refusing devices at the relay is admission, which must stay distinct from authorization (AD-15 p.10) | WP-29, WP-34, WP-39 | Before WP-34 — AD if the relay gains an admission rule |
| OD-12 | Diagnostics and crash reporting under "no hidden telemetry" (§12): none, or explicit opt-in; scope of relay operational logs (metadata only) | Operability vs privacy promise; must be stated in the privacy policy | WP-39, WP-37 | Before WP-39 |
| OD-13 | Commercial model: plans, what is entitled (remote mode, device count, other cloud features), trial, payment provider, legal entity and jurisdictions, data residency of relay/account data | Entitlement schema, billing integration, legal documents | WP-36, WP-37, WP-39 | Before WP-36 (product/business decision, not an AD unless it touches §23 boundaries) |

Implementation choices that are **not** architectural but have release impact
(the implementing WP decides and documents them): tray UI technology (WP-22),
Node runtime bundling (WP-34), relay hosting platform (WP-29/WP-38).

Questions that stay open and are **not required for v1**: §26 Q12 (transport
matcher), Q14 (limit remote agents to their own tabs), Q6 beyond the two
presets, Q3–Q5 (external gateway).

---

## 5. Changes to the previous plan

| Item | Change | Reason |
| --- | --- | --- |
| WP-17, WP-18, WP-19 | Kept, marked Done | Verified in `main` |
| WP-19b | **New, optional** | STATUS follow-ups: full SDK v2 move, `server/discover` listing |
| WP-20, WP-21 | Kept; WP-20 scope adds service lifecycle and sessionless concurrency limit | STATUS open items |
| WP-22 | Scope extended: exposure reset, client revocation, remote full-control opt-in UI | D5, AD-15 C5, AD-13 p.5 |
| WP-23a/b/c | Kept; WP-23c split into spike + implementation inside the card with an explicit decision point | D9 / OD-6 |
| WP-24…WP-27 | Kept as defined by AD-16 | Still match AD-16 |
| WP-28…WP-31 | Kept; dependencies refined | WP-28 core work can start now |
| WP-32 | Dependencies add WP-27 and WP-38 | D2, D6 |
| WP-33 | Scope makes threat-model refresh and production-config review explicit | Security gate needs it |
| WP-34 | Scope adds supply-chain integrity, version skew, uninstall/upgrade; deps add WP-23a, WP-35 | D4, D7 |
| WP-35 | Deps changed to WP-24, WP-25, WP-26; preparation early | D3 |
| WP-36 | Scope adds billing and account portal with device list and remote revocation | D7; §20 revocation of lost devices |
| WP-37 | Scope clarified: user, privacy, security docs and legal | — |
| WP-38, WP-39, WP-40 | **New** | D6, D7 |
| §16 items 8–9, `telegram-stream`, client-specific milestones | Not product work | AD-14 |

---

## 6. Work packages

Sizes: S ≤ 2 days, M 3–5 days, L 1–2 weeks, XL > 2 weeks.
**RB** = release-blocking for v1.

### 6.1 Status table

| WP | Phase | Title | Depends on | Size | RB | Parallel | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WP-17 | 0 | AD-15 remote MCP request contract | — | S | yes | — | **Done** |
| WP-18 | 0 | Browser spike, AD-16 browser contract v1 | — | S–M | yes | — | **Done** |
| WP-19 | 1 | Remote request pipeline per AD-15 | WP-17 | M | yes | — | **Done** (`8169b1f`) |
| WP-19b | 1 | MCP SDK consolidation | WP-19 | S–M | no | any time | Not started |
| WP-20 | 1 | Supervised service, stdio shim, local control channel | WP-19, OD-1 | L | yes | with 2B, WP-28/29 | **Done** (AD-17) |
| WP-21 | 1 | Secret storage, child-process environment allowlist | WP-20 | M | yes | with WP-22 | Not started |
| WP-22 | 1 | Tray v1 and approval provider | WP-20 | L | yes | with WP-21 | Not started |
| WP-23a | 2 | L1 Linux | WP-21, OD-9 | M | yes | with 23b/c | Not started |
| WP-23b | 2 | L1 macOS | WP-21, OD-9 | M | yes | with 23a/c | Not started |
| WP-23c | 2 | L1 Windows (spike → implementation) | WP-21, OD-9 | L | yes | with 23a/b | Not started |
| WP-24 | 2B | Browser: CDP backend, snapshot/refs, trusted input, frames, shadow DOM, waits, history | WP-18 | L | yes | now | Not started |
| WP-25 | 2B | Browser: dialogs, file chooser, background screenshots, debugger lifecycle, tab group | WP-24 | M | yes | with 26, 27 | Not started |
| WP-26 | 2B | Browser: upload and download | WP-24, OD-8 | M | yes | with 25, 27 | Not started |
| WP-27 | 2B | Browser: per-tab queue, explicit `tabId` for remote, `openedBy` | WP-24 | S–M | yes | with 25, 26 | Not started |
| WP-28 | 3 | Identity and device binding | WP-17, OD-2; WP-21 (device key storage) and WP-22 (pairing UI) for final steps | L | yes | starts now | Not started |
| WP-29 | 3 | Cloud Relay v1 | WP-28 (verifier facts), OD-3, OD-4 | XL | yes | with phase 1/2/2B | Not started |
| WP-30 | 3 | Device tunnel adapter | WP-20, WP-28, WP-29, OD-5 | M–L | yes | — | Not started |
| WP-31 | 3 | Remote permission profile and presets | WP-22, WP-23a/b/c, WP-30, OD-7 | M | yes | — | Not started |
| WP-38 | 3 | Staging cloud environment | WP-29, WP-28 | M | yes | with WP-30/31 | Not started |
| WP-32 | 3 | Remote E2E acceptance suite and client compatibility | WP-24…WP-27, WP-30, WP-31, WP-38 | L | yes | — | Not started |
| WP-33 | 3 | External security review and fixes | WP-32, WP-34 (release-candidate build), WP-38 | M (+fix time) | yes | with WP-37 | Not started |
| WP-34 | 4 | Installers, signing, updates, autostart, supply chain | WP-20, WP-22, WP-23a, WP-35 (IDs), OD-1, OD-10, OD-11 | L | yes | with phase 3 | Not started |
| WP-35 | 4 | Extension publication | WP-24, WP-25, WP-26 (prep: now) | M | yes | early | Not started |
| WP-36 | 4 | Accounts, plans, billing, entitlements, device management | WP-28, WP-29, OD-13 | M–L | yes | with phase 3 | Not started |
| WP-37 | 4 | Documentation, privacy/security docs, legal | content from all WPs; final after WP-33 | M | yes | ongoing | Not started |
| WP-39 | 4 | Production cloud and operational readiness | WP-38, WP-36, OD-12 | L | yes | with WP-33 | Not started |
| WP-40 | 4 | Release candidate, beta and GA release | all RB WPs | M | yes | — | Not started |

### 6.2 Common rules (apply to every card)

- **Definition of done (in addition to each card):** `npm run check` passes;
  new behaviour has tests; nothing implemented regresses unless the card
  states a behaviour change and documents it; status markers and docs updated;
  §6.1 status set to `Done`; one PR.
- **Never:** client-specific logic; bypassing ExecutionGuard /
  PermissionEngine; a second permission/approval mechanism; host- or
  agent-supplied code in the browser; approvals via MCP elicitation or the
  request path; payload logging in the relay; entitlement checks in local
  authorization; work on the external MCP gateway or other post-v1 items.

### 6.3 Phase 1 — Local foundation

#### WP-19b — MCP SDK consolidation (optional, non-blocking)

- **Objective:** one SDK line for all entry points, or a documented reason to
  keep two.
- **Why:** WP-19 runs SDK v1 and v2 side by side; `server/discover` lists only
  2026-07-28.
- **Scope:** evaluate/perform the move of stdio and legacy sessions to SDK v2;
  decide what `server/discover` lists.
- **Constraints:** AD-15 C1–C3, C8 unchanged; supported version list
  unchanged.
- **Acceptance / tests:** all existing HTTP, stdio, approval and exposure
  tests pass unchanged; version matrix tests for all three versions.
- **DoD:** merged or closed with a recorded decision. **RB:** no.
  **Parallel:** any time; avoid overlapping with WP-30 on the same files.

#### WP-20 — Supervised service, thin stdio shim, local control channel

- **Objective:** one long-running CROT service per user owns Core, the browser
  bridge, HTTP and (later) the tunnel; stdio clients attach through a thin
  shim; the tray talks to the service over an authenticated local control
  channel.
- **Why:** AD-13 point 3 (§26 Q2); removes `in_use`; prerequisite for tray,
  tunnel, installer.
- **Dependencies:** WP-19; decision OD-1.
- **Scope:** service lifecycle (start, health, graceful shutdown, crash
  restart, sleep/wake); shim that carries stdio MCP to the service without
  becoming a second Core; owner-only, token-authenticated control channel;
  concurrency limit for sessionless requests (STATUS follow-up); a single
  bridge owner; `crot_status` reporting service state.
- **Constraints:** the shim holds no permissions or policy; each stdio
  connection keeps its own exposure scope (AD-12, AD-15 p.8); the control
  channel is not reachable by other users or unauthenticated peers and
  carries no MCP tools; reuse existing bridge framing/token/endpoint handling
  where sensible (implementer's choice).
- **Acceptance criteria:** several stdio clients work concurrently through the
  shim; browser `in_use` no longer occurs in normal use; control channel
  rejects other OS users and peers without the credential; shutdown order
  preserves AD-7 audit guarantees; stdio behaviour observed by clients is
  unchanged.
- **Tests:** multi-client shim tests on all three OS in CI; control-channel
  negative tests (wrong user, bad token, replay); service restart with
  persisted remote exposure intact; existing E2E passes through the shim.
- **DoD:** README/`docs/*` describe the service, shim and control channel.
  **RB:** yes. **Parallel:** with WP-24…27, WP-28, WP-29.

#### WP-21 — Secret storage and child-process environment allowlist

- **Objective:** CROT secrets (local token, bridge token, control-channel
  credential, later device key) are protected from everything except the
  service; children of `shell.execute` / `process.manage` get only an
  allowlisted environment.
- **Why:** AD-13 point 3 / point 4; prerequisite for L1 and device binding.
- **Dependencies:** WP-20.
- **Scope:** Keychain / DPAPI-or-Credential-Manager / libsecret or owner-only
  files where secure storage is unavailable (documented); environment
  allowlist with documented override semantics; migration of existing
  token files.
- **Constraints:** credentials never reach Core, audit, logs, browser,
  children or outbound requests (AD-15 p.4).
- **Acceptance:** secrets not readable through CROT tools in any mode and not
  inherited by children; existing configurations keep working or fail with a
  clear migration message.
- **Tests:** per-OS tests in CI; env-leak tests for each process tool; token
  rotation.
- **DoD:** README security section updated. **RB:** yes. **Parallel:** with
  WP-22.

#### WP-22 — Tray v1 and approval provider

- **Objective:** the user can see and control CROT and answer approvals.
- **Why:** without a provider every gated operation is denied (AD-5), which
  breaks every remote workflow that reads a page and then acts (AD-13 p.3).
- **Dependencies:** WP-20.
- **Scope:** product `ApprovalProvider` over the control channel showing the
  subject digest (page-supplied text marked as such, AD-16 p.16); remote mode
  on/off; active agent contexts/sessions; connected browser profile; preset
  selection (AD-16 p.17); remote full-control per-device opt-in (AD-13 p.5);
  **exposure reset per remote client and client revocation** (AD-15 p.8, C5);
  device pairing screen (used by WP-28); status/errors (L1 availability, CDP
  availability).
- **Constraints:** the broker, digest and audit are unchanged; the tray is a
  UI only — control logic stays in the service; approvals cannot be granted by
  agents, pages, the relay or confined processes (§21, AD-13 p.4).
- **Acceptance:** approvals work end to end for file, shell, Git, Docker,
  network and browser operations; dismissal/timeout/no tray = deny; every
  decision, reset and revocation is audited; settings changes are applied
  only through the control channel.
- **Tests:** provider integration tests; UI smoke tests on all three OS;
  negative test that a tool call cannot change presets or reset exposure.
- **DoD:** user docs for the tray. **RB:** yes. **Parallel:** with WP-21.

### 6.4 Phase 2 — Command confinement L1

Common card for WP-23a (Linux: bubblewrap + installer-shipped AppArmor
profile), WP-23b (macOS: Seatbelt, secrets in Keychain), WP-23c (Windows:
spike first, then restricted / low-IL token + Job Object).

- **Objective:** children of `shell.execute` and `process.manage` in
  workspace mode run under the fixed AD-13 point 4 profile.
- **Why:** a remote shell without confinement can read CROT's tokens and
  approve its own requests.
- **Dependencies:** WP-21; OD-9. WP-23c additionally has the OD-6 decision
  point at the end of its spike.
- **Scope:** profile enforcement through the Platform / Native Host layer;
  `crot_status` reports L1 availability and reason; refusal of remote
  `shell`/`process` operations where the mechanism is unavailable on a
  specific machine.
- **Constraints:** one fixed Core-defined profile; network on/off only; full
  control mode remains unconfined (§6); no change to `git.*`/`docker.use`
  controls of AD-1…AD-3; the fallback is per machine, never "remote shell off
  for an OS".
- **Acceptance:** no access to CROT state (tokens, device key, control
  credential), configuration, audit log, Docker socket or tray control
  channel; writes only to workspace, private temp and cache allowlist; common
  dev workflows (npm/pip/cargo/go build and test, Git via shell) still work.
- **Tests:** per-OS escape test suite in CI (read token, write outside
  workspace, connect to control channel/Docker socket, spawn breakaway
  processes); dev-workflow smoke tests.
- **DoD:** residual risks listed for WP-37. **RB:** yes (all three).
  **Parallel:** the three run in parallel with each other, phase 2B and 3.

### 6.5 Phase 2B — Browser v1 (AD-16 is normative)

All cards: every command through `BrowserService` and ExecutionGuard; AD-6,
AD-8, AD-9, AD-11 bind every control command; new reads are exposure sources;
audit never records content; fixed CDP allowlist; legacy tool forms keep
today's behaviour.

#### WP-24 — CDP backend, snapshot and refs, trusted input, frames, shadow DOM, waits, history

- **Objective:** an agent can observe and operate any `http(s)` page by
  reference with trusted input, including cross-origin frames and open shadow
  roots.
- **Dependencies:** WP-18. **Scope:** AD-16 points 3, 5, 6, 7, 10; tools
  `browser_snapshot`, `browser_wait`, `browser_history`, `browser_hover`,
  `browser_scroll`, `browser_drag`, `browser_press_key`,
  `browser_select_option`, `browser_set_checked`, ref forms of click/type;
  `openerTabId`, `newTabs`, `navigated`; `debugger` permission.
- **Acceptance / tests (AD-16 p.19):** E2E on real Chromium: multi-step form
  flow by refs; stale refs after navigation, reload, removal and detach;
  `isTrusted` for click, keys, text; cross-origin frame; open shadow root;
  forbidden CDP method cannot be sent; audit without content; manual run on at
  least three real third-party sites recorded in the repository.
- **RB:** yes. **Parallel:** now, with phase 1 and 3.

#### WP-25 — Dialogs, file chooser, background screenshots, debugger lifecycle, CROT tab group

- **Dependencies:** WP-24. **Scope:** AD-16 points 3 (lifecycle, availability
  in `browser_status`), 4 (tab group), 9, 13; `browser_dialog_handle`,
  `BROWSER_DIALOG_OPEN`; `tabGroups` permission.
- **Acceptance / tests:** E2E for `alert`, `confirm`, `prompt`,
  `beforeunload`, dialog timeout; file chooser interception; background
  screenshot without focus change; debugger detach → stale refs and
  re-attach; manual check of the debugger notice in headed Chrome, Edge and
  Brave on Linux, macOS, Windows; enterprise-policy-blocked debugger reported,
  no fallback.
- **RB:** yes. **Parallel:** with WP-26, WP-27.

#### WP-26 — File upload and download

- **Dependencies:** WP-24; OD-8. **Scope:** AD-16 points 11, 12;
  `browser_file_upload` (`browser.control` + `filesystem.read`),
  `browser_download` (`browser.control` + `filesystem.write`); `downloads`
  permission.
- **Acceptance / tests:** E2E upload of a workspace video fixture into a form;
  denial of a path outside the workspace in sandbox mode; download into the
  workspace, atomic appearance, refused overwrite; unrelated downloads never
  touched; dangerous/interrupted downloads leave nothing.
- **RB:** yes. **Parallel:** with WP-25, WP-27.

#### WP-27 — Multi-agent safety

- **Dependencies:** WP-24 (WP-19 done). **Scope:** AD-16 points 4, 8, 14:
  bounded per-tab FIFO after the approval gate (`RESOURCE_BUSY`), mirrored in
  the extension; `tabId` required for `kind: "remote"`; `openedBy`.
- **Acceptance / tests:** two concurrent agents on separate and shared tabs do
  not interfere (E2E); `INVALID_INPUT` for a remote principal without
  `tabId`; binding checked at queue front.
- **RB:** yes. **Parallel:** with WP-25, WP-26.

### 6.6 Phase 3 — Remote access

#### WP-28 — Identity and device binding

- **Objective:** a user account and a paired device; remote tokens verified
  locally; revocation ends access.
- **Dependencies:** WP-17; OD-2 at start. IdP selection and the verifier can
  start now; device key storage needs WP-21; pairing UI needs WP-22.
- **Scope:** managed IdP meeting AD-15 p.5 (PKCE S256, CIMD + DCR, RFC 8707,
  audience-bound JWT with device claim, RFC 9207, grant revocation, MFA);
  device identity and credential; pairing from the tray; OAuth verifier behind
  `AccessTokenVerifier` (JWKS, `iss`, `aud` = device resource URI, `exp`,
  `nbf`, device claim, revocation); remote principal fields populated.
- **Constraints:** Core depends on no IdP (§15); token contents never grant
  capabilities (AD-15 p.4); credentials never reach Core/audit.
- **Acceptance:** a paired device verifies tokens; token for another device or
  resource rejected; local token rejected on the relay entry point; revoked
  grant fails within a documented bound; unpaired/revoked device cannot open
  a tunnel.
- **Tests:** verifier unit tests with real signed JWTs and JWKS rotation;
  AD-15 C8 items "token for another device", "local token on tunnel".
- **RB:** yes. **Parallel:** starts now, alongside phase 1.

#### WP-29 — Cloud Relay v1

- **Objective:** public HTTPS endpoint per device that admits authorized
  requests and streams them to the device's tunnel and back.
- **Dependencies:** WP-28 (token facts), OD-3, OD-4 (AD), OD-5 (with WP-30).
- **Scope:** AD-15 p.10 exactly: TLS; PRM and 401 `WWW-Authenticate`; token
  and entitlement check (hook for WP-36); routing by device id; unchanged
  forwarding of headers and bodies; streaming; size/rate limits; offline and
  remote-off refusal; device-credential-authenticated outbound tunnel; no
  payload logging; no MCP implementation or session state.
- **Acceptance:** an SDK client reaches a test device with each supported
  protocol version, including streamed responses and a gated request waiting
  for approval; payloads never appear in relay logs (log inspection test);
  identity headers injected by clients/relay are ignored by the device.
- **Tests:** relay integration suite with a test device; load/backpressure and
  reconnect tests; log-scrubbing test.
- **RB:** yes. **Parallel:** with phases 1, 2, 2B. Longest branch — start
  early.

#### WP-30 — Device tunnel adapter

- **Objective:** tunnel requests enter the existing HTTP pipeline as
  `transport: "relay"`, `kind: "remote"`.
- **Dependencies:** WP-20, WP-28, WP-29; OD-5 decided before merge.
- **Scope:** AD-15 C4: same pipeline minus loopback Host check, OAuth verifier
  instead of local token; reconnect with backoff; remote mode on/off from the
  tray closes/opens the tunnel; cancellation propagates to pending approvals
  and running operations.
- **Acceptance:** remote requests run through the unchanged Core pipeline;
  remote off → tunnel closed and no request processed; survives network
  changes and sleep/wake; persisted exposure keyed correctly across
  reconnects.
- **Tests:** full AD-15 C8 list over a real tunnel; chaos tests (drop, delay,
  relay restart).
- **RB:** yes. **Parallel:** none on the critical path.

#### WP-31 — Remote permission profile and presets

- **Objective:** safe remote defaults and the two presets, chosen only by the
  user.
- **Dependencies:** WP-22, WP-23a/b/c, WP-30; OD-7.
- **Scope:** AD-13 p.5 (remote defaults to workspace mode, `untrusted-content`
  on; full control only as per-device opt-in); AD-16 p.17 presets via
  `permissions.approvals.untrustedContent`; L1-unavailable refusal for remote
  shell/process; reporting in `crot_status` and tray.
- **Constraints:** only existing matchers (`principalKinds`, `exposed`,
  capabilities, operations); no new mechanism.
- **Acceptance / tests:** defaults, opt-in and both presets proven by tests
  for local and remote principals; `browser.file_upload` and downloads stay
  gated in *Autonomous browser*; preset change impossible via tools, pages or
  relay.
- **RB:** yes.

#### WP-38 — Staging cloud environment (new)

- **Objective:** a publicly reachable, production-like relay, IdP tenant and
  account/entitlement service for acceptance and security review.
- **Why:** real remote clients run in the cloud and cannot reach a test relay
  on a developer machine (D6).
- **Dependencies:** WP-28, WP-29; WP-36 hook stubbed until WP-36 lands.
- **Scope:** TLS domain, deployment automation, secrets management, metadata-
  only logging, test accounts and devices, teardown/reset.
- **Acceptance:** an external MCP client completes OAuth and calls a tool on a
  test device through staging; logs verified payload-free.
- **RB:** yes (enables WP-32/WP-33). **Parallel:** with WP-30, WP-31.

#### WP-32 — Remote E2E acceptance suite and client compatibility

- **Objective:** prove the complete chain, client-independently (§14,
  AD-14 p.5).
- **Dependencies:** WP-24…WP-27, WP-30, WP-31, WP-38.
- **Scope:** **automated** (CI): MCP SDK client → relay → device tunnel →
  service → fixture project (files, commands under L1, Git, Docker) → real
  Chromium with the extension; one multi-step scenario across several tabs
  with navigation, form, dialog, pop-up/related tab, upload and download,
  for each supported protocol version; approvals answered through a test
  provider on the control channel; both presets; negative paths (revoked
  token, remote off, other device's token, missing `tabId`). **Manual:** at
  least four different remote MCP clients over every supported protocol
  version against staging; results table committed.
- **Constraints:** no client-specific code or tests in Core, adapters or
  relay; client quirks are recorded, not special-cased.
- **Acceptance:** automated suite green in CI on Linux and run (CI or
  recorded) on macOS and Windows; compatibility table with no blocking
  failures.
- **RB:** yes.

#### WP-33 — External security review and fixes

- **Objective:** independent assessment of device, extension, relay, IdP
  integration and installer.
- **Dependencies:** WP-32, a release-candidate build from WP-34, WP-38.
- **Scope:** updated threat model (all §19 boundaries incl. remote, device,
  commercial); review of CDP allowlist, approval channel, L1 escapes, token
  verification, tunnel, relay logging, update signing; fixes and re-test.
- **Acceptance:** no open critical or high findings; medium findings fixed or
  accepted with documented rationale; residual-risk list final for WP-37.
- **RB:** yes. **Parallel:** with WP-37, WP-39.

### 6.7 Phase 4 — Commercial readiness

#### WP-34 — Installers, signing, updates, native-host registration, autostart, supply chain

- **Objective:** install, update and uninstall CROT on Linux, Windows and
  macOS without a terminal (§10, §24).
- **Dependencies:** WP-20, WP-22, WP-23a (AppArmor profile), WP-35 (store
  IDs), OD-1, OD-10, OD-11.
- **Scope:** packages per OS (formats per OD-9); code signing (Windows
  Authenticode, macOS Developer ID + notarization, Linux package signing);
  bundled runtime; service autostart; native-host registration for the
  published extension IDs; guided extension install; signed auto-update with
  rollback; config/state migration; clean uninstall; version-compatibility
  checks between app, extension and relay protocol; reproducible CI release
  builds, SBOM, dependency audit, signing-key custody; third-party license
  notices.
- **Acceptance:** fresh install → pair → enable remote → agent task works on
  all three OS with a non-developer user; upgrade from previous release keeps
  config, pairing and persisted exposure; tampered update rejected; uninstall
  removes service, host registration and autostart.
- **RB:** yes. **Parallel:** with phase 3.

#### WP-35 — Extension publication (Chrome Web Store, Edge Add-ons)

- **Dependencies:** WP-24, WP-25, WP-26 (full permission set). Preparation
  (developer accounts, listing, privacy disclosures, permission justification
  text from AD-16 p.3) can start now.
- **Acceptance:** published in both stores with `debugger`, `downloads`,
  `tabGroups` accepted; store IDs recorded for WP-34 (OD-10); update path via
  store tested against the compatibility policy (OD-11).
- **RB:** yes. **Parallel:** early, alongside phase 3.

#### WP-36 — Accounts, plans, billing, entitlements, device management

- **Objective:** a user can sign up, choose a plan, pay, manage devices and
  revoke a lost device; the relay admits only entitled devices.
- **Dependencies:** WP-28, WP-29; OD-13.
- **Scope:** Account & Commercial service (§23) separate from Core; plans and
  entitlements (e.g. remote mode, device limits); payment integration;
  account portal with device and client list and remote revocation;
  entitlement check at the relay; tray shows plan state.
- **Constraints:** entitlements never enter local authorization; local mode
  works offline without an account; the commercial service never receives
  computer, browser or workspace contents.
- **Acceptance:** unentitled device refused at the relay with a clear error;
  downgrade/expiry ends remote admission without affecting local mode;
  revoking a device from the portal ends its access.
- **RB:** yes. **Parallel:** with phase 3.

#### WP-37 — Documentation, privacy/security documentation, legal

- **Scope:** user guide (install, pair, connect any MCP client, presets,
  approvals, remote on/off, troubleshooting); admin/security whitepaper
  (architecture summary, trust boundaries, L1 profile, data flows, relay
  logging); disclosure of AD-13/AD-14/AD-15/AD-16 residual risks; privacy
  policy, terms of service, subscription terms, DPA where applicable,
  extension store privacy disclosures; vulnerability disclosure policy;
  support process.
- **Dependencies:** content from all WPs; finalized after WP-33.
- **Acceptance:** documents reviewed (legal review for legal texts) and
  published; every residual risk in ARCHITECTURE.md is disclosed to users.
- **RB:** yes. **Parallel:** start drafting now; finalize late.

#### WP-39 — Production cloud and operational readiness (new)

- **Objective:** relay, IdP configuration and account service run in
  production with defined reliability and incident handling.
- **Dependencies:** WP-38, WP-36; OD-12.
- **Scope:** production deployment, capacity and rate limits, abuse
  handling, monitoring/alerting on metadata only, backups, key and
  certificate rotation, IdP signing-key rotation drills, incident response
  and on-call, status page, SLOs, disaster recovery test.
- **Acceptance:** runbooks exercised (relay restart, key rotation, IdP outage,
  mass revocation); verified no payload logging in production configuration;
  load test at target launch capacity.
- **RB:** yes. **Parallel:** with WP-33, WP-37.

#### WP-40 — Release candidate, beta and GA (new)

- **Objective:** ship v1.
- **Dependencies:** every RB WP; Gates 1–7.
- **Scope:** RC build through the WP-34 pipeline; full acceptance on all three
  OS with installed signed packages, store extension and production-like
  cloud; closed beta with external users; release checklist; GA rollout and
  rollback plan.
- **Acceptance:** §10 definition satisfied; release checklist closed.
- **RB:** yes.

---

## 7. Release-blocking security work (summary)

1. Secrets in secure storage, env allowlist (WP-21).
2. L1 on Linux, macOS, Windows with escape tests (WP-23a/b/c).
3. Approval provider authenticity: owner-only control channel unreachable from
   confined processes, agents, pages and relay (WP-20, WP-22, WP-23).
4. Remote exposure persistent and fail-closed, reset only by the user
   (done in WP-19 + WP-22).
5. Token verification on the device, audience binding, revocation (WP-28).
6. Relay never stores or logs payloads, never authorizes (WP-29, WP-39).
7. Fixed CDP allowlist; forbidden methods unreachable; no agent code in the
   browser (WP-24).
8. Remote explicit `tabId`, per-tab serialization, document-bound refs
   (WP-24, WP-27).
9. Remote profile defaults and presets (WP-31).
10. Signed builds and updates, supply-chain controls (WP-34).
11. External review with no open critical/high findings (WP-33).
12. Residual risks disclosed (WP-37).

---

## 8. Dependency graph and critical path

### 8.1 Graph

```text
DONE: WP-17 ─► WP-19
      WP-18

WP-19 ─► WP-20 ─┬─► WP-21 ─┬─► WP-23a ─┐
                │          ├─► WP-23b ─┤
                │          └─► WP-23c ─┤ (OD-6 at spike end)
                └─► WP-22 ─────────────┤
                                       ▼
WP-17 ─► WP-28 ─► WP-29 ─► WP-30 ─► WP-31 ─► WP-32 ─► WP-33 ─► WP-40 ─► GA
            │        │       ▲          ▲        ▲        ▲
            │        │  WP-20┘    WP-22,┘        │        │
            │        │            WP-23*         │        │
            │        └─► WP-38 ──────────────────┤        │
            │                                    │        │
WP-18 ─► WP-24 ─┬─► WP-25 ──┐                    │        │
                ├─► WP-26 ──┼────────────────────┘        │
                └─► WP-27 ──┘                             │
                                                          │
WP-24,25,26 ─► WP-35 ─► WP-34 (also WP-20, WP-22, WP-23a) ┤ (RC build for WP-33)
WP-28, WP-29 ─► WP-36 ─► WP-39 (also WP-38) ──────────────┤
all ─► WP-37 (final after WP-33) ─────────────────────────┘
```

### 8.2 Critical path

Two near-critical chains meet at WP-30:

```text
A: WP-20 (L) ─► WP-22 (L) ─────────────┐
B: WP-28 (L) ─► WP-29 (XL) ────────────┴─► WP-30 ─► WP-31 ─► WP-32 ─► WP-33 ─► WP-40
```

Chain B is the longest by size and is unblocked now; start WP-28 immediately.
L1 (WP-23a/b/c, after WP-21) must be done before WP-31; WP-23c (spike + L)
is the highest schedule risk among them. Browser v1 (WP-24 L + 3×M/S–M) must
finish before WP-32.

### 8.3 Classification

| Class | WPs |
| --- | --- |
| Sequential on critical path | WP-20 → WP-22; WP-28 → WP-29 → WP-30 → WP-31 → WP-32 → WP-33 → WP-40 |
| Parallelizable now | WP-20, WP-24, WP-28, WP-35 (prep), WP-37 (drafting), WP-19b |
| Parallel after prerequisites | WP-21 ∥ WP-22; WP-23a ∥ b ∥ c; WP-25 ∥ WP-26 ∥ WP-27; WP-34, WP-36, WP-38 with phase 3; WP-37 ∥ WP-39 ∥ WP-33 |
| Release blockers | every WP except WP-19b |
| Optional / non-blocking | WP-19b; §26 Q12 transport matcher; §26 Q14 tab-scope matcher |
| Post-v1 | §11 of this roadmap |

### 8.4 Next-WP selection rule

1. If any OD that blocks an unblocked WP is undecided, the next task is that
   decision (docs-only PR or first commit of the WP).
2. Otherwise choose, in order: an unblocked WP on chain A or B; then WP-23x;
   then WP-24…WP-27; then phase-4 WPs whose dependencies are done.
3. **Right now (after WP-20):** WP-22 (tray v1 and approval provider on the
   control channel) and WP-21 on chain A, WP-28 (decide OD-2 first) on the
   critical path; WP-24 on the browser branch; WP-35 preparation and WP-37
   drafting may run in the background.

---

## 9. Release gates

Each gate is passed only when all its criteria are objectively met and
recorded in `STATUS.md`.

| Gate | Name | Criteria |
| --- | --- | --- |
| G1 | Architecture/foundation ready | AD-1…AD-16 merged (met); OD-1 (met: AD-17), OD-2, OD-9 decided; WP-19 done (met); OD-4 recorded as an AD before WP-29 implementation |
| G2 | Local supervised product ready | WP-20, WP-21, WP-22 done: multiple stdio clients via shim; no `in_use`; approvals work end to end in the tray for every capability; secrets not readable by tools/children; CI green on all OS |
| G3 | Browser v1 ready | WP-24…WP-27 done; every AD-16 point 19 test passes in real-Chromium E2E; three real sites recorded; debugger notice checked in Chrome/Edge/Brave on all three OS |
| G4 | Remote chain ready | WP-23a/b/c, WP-28, WP-29, WP-30, WP-31, WP-38 done; AD-15 C8 tests pass over a real tunnel; OD-5 and OD-6 decided; relay log-scrubbing verified |
| G5 | End-to-end acceptance ready | WP-32 done: automated suite green in CI; ≥ 4 different remote MCP clients × all supported protocol versions with no blocking failure; results committed |
| G6 | Security review ready (technical completion) | WP-33 done: no open critical/high findings; threat model and residual-risk list final |
| G7 | Commercial release candidate | WP-34, WP-35, WP-36, WP-37 done; WP-39 runbooks exercised; signed RC installs, updates and uninstalls on all three OS; extension published; entitlement path works end to end; legal documents published-ready |
| G8 | Production / commercial v1 | WP-40 done: beta completed with no open blocking issues; production cloud live and monitored; release checklist closed; §10 holds for the shipped build |

---

## 10. CROT v1 is ready to ship when…

all of the following are true **for the signed, installed release build**, not
for a development checkout:

1. **Remote MCP client compatibility.** Any MCP client that implements the
   specification can connect over the internet using standard MCP
   authorization (PRM, RFC 8707, PKCE, CIMD or DCR) and protocol versions
   2026-07-28, 2025-11-25 and 2025-06-18; this is demonstrated by the
   automated SDK suite and by at least four different remote clients, with no
   client-specific code anywhere.
2. **Cloud Relay.** Production relay routes per-device, streams responses,
   verifies tokens and entitlements, enforces limits, refuses offline or
   remote-off devices, and provably never stores or logs payloads.
3. **Local CROT.** One supervised per-user service owns Core, the browser
   bridge, local HTTP and the tunnel; local stdio and loopback clients keep
   working offline without an account; every remote request is re-verified
   on the device and runs as `kind: "remote"` through the unchanged
   ExecutionGuard / PermissionEngine pipeline.
4. **Local computer capabilities.** A remote agent can read and modify project
   files, run commands and processes under L1 on Linux, macOS and Windows, use
   `git.read`/`git.write` and `docker.use`, within the workspace rules.
5. **Real browser capabilities.** A remote agent can carry out multi-step tasks
   in the user's real Chromium browser per AD-16: snapshot and references,
   trusted input, frames and shadow DOM, waits and history, dialogs, upload
   and download, multiple tabs and pop-ups, background screenshots, explicit
   tabs, per-tab ordering, visible CROT tab group.
6. **Security.** L1 enforced on all supported OS (refusal only on individual
   machines lacking the mechanism); secrets protected; CDP surface fixed;
   external review closed with no open critical/high findings.
7. **Permissions and approvals.** Remote defaults to workspace mode with
   `untrusted-content` on; the tray approval provider works for every
   capability; both presets and the per-device full-control opt-in work and are
   changeable only by the user; exposure reset and revocation exist only on
   the provider channel.
8. **Persistence and lifecycle.** Pairing, configuration and remote exposure
   survive restarts, updates and sleep/wake; failure of persisted state fails
   closed; the tunnel reconnects; remote off closes it immediately.
9. **Installation.** A non-developer installs CROT and the store extension on
   each supported OS without a terminal and reaches "Ready" (§10 flow).
10. **Updates.** Signed updates with rollback for app and service; store
    updates for the extension; version-compatibility policy enforced.
11. **Commercial path.** Sign-up, plan, payment, entitlement, device limits and
    device revocation from the account portal work end to end; local mode
    needs none of them.
12. **Operational readiness.** Production monitoring (metadata only), incident
    response, key rotation and support processes are in place and exercised.
13. **Documentation and legal.** User and security documentation, privacy
    policy, terms and store disclosures are published and disclose every
    accepted residual risk of AD-13…AD-16.

---

## 11. Post-v1 boundary (explicitly out of scope)

- **External MCP gateway** — CROT as MCP client of external servers (function
  B, §18, AD-13 point 2); §26 questions 3–5. Keep architectural separation:
  nothing in v1 may depend on it or pre-build it.
- OS-level egress allowlists for processes and containers (§16 item 23, AD-4).
- Confinement level L2 (read-deny of common user secrets), including Windows.
- Relay end-to-end encryption (TLS terminates at the relay in v1).
- Firefox and Safari; multiple simultaneously connected browser profiles.
- Team features; a rule editor; general approval policy beyond the two
  presets.
- Dedicated Git network operations and Docker build/pull capabilities (usable
  through confined shell in v1).
- Transport matcher (§26 Q12) and tab-scope matcher for remote agents (§26
  Q14) — optional, additive.
- MCP Tasks extension, Multi Round-Trip Requests, server-to-client requests.
- HTTP authentication and permission prompts in the browser, unless a v1
  acceptance scenario proves them necessary.
- Own authorization server; any local licensing.
- Never in scope: remote desktop, screen streaming, OS-level input, arbitrary
  JavaScript in the browser.
