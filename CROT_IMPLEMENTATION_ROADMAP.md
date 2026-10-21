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
> **История ранних сверок (не текущий HEAD):** `main` at `22abf89` (2026-10-08: WP-23a merged in
> PR #6 `e1d1f61`, followed by the CI test fixes PR #9 `4df63c6`, PR #11
> `2b803eb` and PR #7 `22abf89`). First verification: `8169b1f` (WP-19).
> Docs-only changes since: PR #12 `74352c2` (this audit) and PR #14
> `ff571c2` (AD-21; OD-2, OD-3 decided); historical code status claims held at
> `ff571c2`.
> Merged since: WP-28 (PR #16 `4d574f0`), WP-29 (`515fcb9`, Partial) and
> WP-30 (PR #20; `main` `63a7d63`).
> WP-31: Done, merged (PR #21, `main` `9ce0574`; ARCHITECTURE.md §27
> AD-23).
> WP-24: implemented, merged (PR #22, `main` `d273473`);
> manual runs 1 and 2 on real sites done by the owner, their findings fixed in
> PR #23 and PR #24 (merged; `docs/acceptance/WP-24-manual-run-1.md`,
> `docs/acceptance/WP-24-manual-run-2.md`). Run 3 is recorded in
> `docs/acceptance/WP-24-manual-run-3.md`: 16 pass, 4 partial, 2 fail;
> run-3 fixes merged in PR #25 (`32334aa`). Runs 4 and 5/follow-up recorded:
> B4/E5/windows and G5/H passed; C1 partial. Default-load timeout signalling
> merged in PR #26 (`289f500`). WP-24 engineering gate is now closed; see
> `docs/acceptance/WP-24-final-engineering-gate.md`. WP-27 is implemented in
> its separate PR; full branded-browser release qualification stays open.
> Status claims below were checked against the repository tree, the source
> files named, the CI workflows and the merged history, not taken from earlier
> plans.

## macOS L1 — WP-23b / AD-31

PR #30 слит в `main` как `e072e61` (проверенная база ветки WP-25).
Производственный `macos-seatbelt`, **WP-23b: Done**, принят куратором.
`0590c31` — прежняя база ветки macOS, `e23b7b9` — исторический merge Windows
PR #27; ни один из них не выдаётся за текущий main. Приёмка пакета не означает
готовность всего продукта.

Нативная квалификация и точные SHA/CI/ограничения:
[отчёт macOS L1](docs/design/macos-l1-production.md).
macOS-решение OD-9 закрыто AD-31; целевая матрица и фактически проверенные
macOS 26.6.2 arm64 / Node 20/22 различаются. Другие Apple-shipped комбинации
не выдаются за пройденные CI; подписанная поставка WP-34, расширенная
кроссплатформенная/ручная приёмка и продуктовые gates остаются открытыми.

## Историческая база документационной сверки Windows

Исторический Windows-срез реализации: `e23b7b9c29c5e3e1758b9ad2703bbd827648426f` (merge PR #27). PR #27 слит, не Draft;
WP-23c **Done**, AD-30 действует, OD-6 и Windows-часть OD-9 закрыты.
Дерево merge совпадает с квалифицированным `f916a6b`; `8fe6ba5` — более
ранний квалификационный источник, не текущий HEAD. На самом `e23b7b9`
подтверждены все 11 заданий: [основной CI 6/6](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180293), [Linux L1 4/4](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180333), [Chromium 1/1](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180363).
Это фиксированная база кода для документационной сверки, не SHA будущего docs PR.

**Как читать статусы.** «Реализовано» означает наличие кода; «проверено» —
конкретный тест/CI на указанном SHA; «ручная приёмка» — отдельная запись владельца;
«Done» требует критериев пакета, не одного merge. «Запланировано» и
«не подтверждено» не означают доступность. Ни merge PR #27, ни зелёный CI
не означают готовность всего CROT к коммерческому релизу.

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
5. Housekeeping (done; `docs/plan/crot-implementation-plan.md` is removed,
   the cards in `docs/plan/` point here for order and status): repoint `AGENTS.md` and `ARCHITECTURE.md` header references from
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

**WP-23c — Done**, merge PR #27 `e23b7b9`; AD-30. Windows qualification,
not whole-product acceptance: see docs/L1.md and the eight-criterion evidence.
**WP-24 — Done, engineering gate closed**, including PR #26 and recorded owner runs; see `docs/acceptance/WP-24-final-engineering-gate.md`.
**WP-26 — Done, merged PR #32** (`386bf3b`), native Core file contour qualified on all three OS × Node 20/22.
**WP-27 — Done, merged PR #33** (`ca6280a`); evidence in `docs/design/browser-wp27.md`.

**WP-29 — Done in this PR**, not merged. Criterion evidence and reproduction:
[`docs/design/relay-wp29-completion.md`](docs/design/relay-wp29-completion.md).

**Historical component state before this completion:**

**WP-29 — Cloud Relay v1, relay side** (§27 AD-22), merged into `main`
(`515fcb9`); that original merge was **Partial**, completed by this PR. The device
side is **WP-30**, Done and merged (PR #20). WP-31 is Done and merged
(PR #21, `9ce0574`). WP-24 (Browser v1 CDP backend) is implemented and merged
(PR #22, `d273473`; run-1 fixes in PR #23, run-2 fixes in PR #24); its engineering acceptance is closed by the criterion-level gate. Before that:

**WP-28 — Identity and device binding** (§27 AD-21), merged in crot-mcp
PR #16 (`4d574f0`); details in `STATUS.md` and `docs/IDENTITY.md`. The
previous one:

**WP-23a — Linux command confinement L1** (§27 AD-20, decides the Linux part
of OD-9 and OD-14), merged in PR #6 (`e1d1f61`). In the tree:

- `src/native-host/linux-l1/`: the sandbox behind the Native Host's
  `ProcessLauncher` (`sandbox.ts`, `bwrap-args.ts`, `layout.ts`,
  `storage.ts`: read-only host, hidden CROT-protected paths, writable
  workspace, private temp and home layer, network `on`/`off`, one sandbox per
  Core), component and policy verification (`components.ts`, `host.ts`), the
  mediated Docker endpoint on every transport (`docker-endpoint.ts`,
  `docker-policy.ts`, `http-framing.ts`) and `detail` notes (`notes.ts`);
  `src/core/platform/confinement.ts`: `CONFINEMENT_UNAVAILABLE` /
  `CONFINEMENT_FAILED`, reason codes; macOS follows AD-31; qualified Windows follows AD-30.
- `scripts/l1-install.sh`, `scripts/l1-host-exec.py`: CROT-owned
  `crot-bwrap` / `crot-l1-init` and the AppArmor policy (ABI 3.0 / 4.0,
  stacked payload transition, host exec `ix` rules of the AD-20 point 3
  amendment) for source checkouts and CI; packaging on user machines is
  WP-34.
- `crot_status.confinement` and the tray's L1 row report availability,
  reason and `detail`.
- Tests: `tests/native-host/linux-l1/`, `tests/core/confinement.test.ts`;
  the real mechanism (escape cases, both network modes, development
  workflows, Docker/Compose, installed browser over CDP) runs in CI on Ubuntu
  22.04/24.04 x86_64/arm64 with `CROT_L1_REQUIRED=1`. User docs:
  `docs/L1.md`.

Before: **WP-22 — Tray v1 and approval provider** (PR #2, `4639392`;
AD-19, decides OD-7), **WP-21 — Secret storage and child-process environment
allowlist** (PR #1, `881663b`; AD-18), **WP-20 — Supervised service, thin
stdio shim, local control channel** (mcp-crot PR #16, `92cce3b`; AD-17, decides
OD-1). In the tree for WP-20:

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

Previous: **WP-19 — Remote MCP request pipeline per AD-15**, merged in
mcp-crot PR #14 (`8169b1f`). Verified in the tree:

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
| CROT secrets in the OS secret store (owner-only file fallback), child-process environment allowlist | `src/service/secrets`, `src/core/platform/child-environment.ts` | AD-18 |
| Tray v1 (Electron, control-channel client) and service-side approval provider `tray`; preset switching while idle; remote mode, client list, exposure reset, revocation | `src/tray`, `src/service/control-center.ts`, `docs/TRAY.md` | AD-19 |
| Identity and device binding on the device: OAuth access-token verifier (AD-21 points 2–4), device id and Ed25519 device credential, pairing from the tray (PKCE, loopback redirect), unpair, re-grant of revoked clients; development environment only | `src/identity`, `src/service/device-binding.ts`, `src/service/identity.ts`, `docs/IDENTITY.md` | AD-21 |
| Command confinement L1 on Linux (Ubuntu 22.04/24.04, x86_64/arm64) | `src/native-host/linux-l1`, `src/core/platform/confinement.ts`, `scripts/l1-install.sh`, `docs/L1.md`, `.github/workflows/l1.yml` | AD-20 |
| `git.read`, `git.write` | `src/core/capabilities/git` | AD-1, AD-2 |
| `docker.use` (ps, logs, compose up/down) | `src/core/capabilities/docker` | AD-3 |
| `network.access` host policy for CROT's own requests | `src/core/capabilities/network` | AD-4 |
| Approval-gate mechanism (broker, rules, subject digest, gated guard path, tab/origin/`connectionId` binding, expected-subject check) | `src/core/approvals`, bridge, extension; `docs/design/approval-gates.md` | AD-5…AD-11 |
| Untrusted-content exposure and the `untrusted-content` rule | `src/core/approvals/exposure.ts` | AD-12 |
| Remote request pipeline (sessionless + legacy, principal kinds, exposure scopes, persisted remote exposure) | see §2.1 | AD-15 |
| Browser bridge, `crot-browser-relay`, MV3 extension, `browser install`; 22 browser tools, CDP/ref/trusted input (WP-24 engineering accepted; WP-27 implemented) | `src/browser-bridge`, `extension/`, `src/cli/browser-install.ts` | §7 |
| Real-browser E2E (Linux, Chrome for Testing, Xvfb) | `tests-e2e/browser`, `.github/workflows/browser-e2e.yml` | — |
| Lint/format/typecheck/test gate `npm run check`; CI on Ubuntu, macOS, Windows × Node 20, 22, L1 on Ubuntu 22.04/24.04 x86_64/arm64, real Chromium | `.github/workflows/ci.yml`, `.github/workflows/l1.yml` | — |
| Contracts: remote request contract, browser contract v1 | ARCHITECTURE.md §27 | AD-15, AD-16 |

### 2.3 Partially implemented

| Area | What exists | Gap to v1 |
| --- | --- | --- |
| Browser | 22 tools; allowlisted chrome.debugger CDP, snapshot/document-bound refs, trusted input, frames/OOPIF, open shadow DOM, waits/history and local per-tab queue; WP-24 code/tests incl. PR #26 | WP-25 headed/branded qualification and broader release matrix; WP-24/26 engineering accepted, WP-27 merged PR #33 |
| User confirmations | Mechanism complete; product provider `tray` in the service, CROT tray on the control channel (WP-22, AD-19) | Same-user processes can act like the tray (AD-19 residual risk): closed for confined Linux WP-23a and qualified Windows WP-23c/AD-30 children; closed for admitted macOS children by AD-31; open in local `full_control` and for unrelated host processes; tray packaging/autostart (WP-34) |
| Identity | Device side complete (WP-28, AD-21): OAuth verifier, device id and credential, pairing, unpair, re-grant; tested against an emulated AuthKit environment | No staging/production identity environment (WP-38, WP-39) and no live WorkOS environment exercised yet; provider-side revocation from the tray now uses AccountService (WP-36; live WorkOS unqualified); RFC 9207 open condition before G4 |
| Relay entry point and device tunnel | HTTP pipeline accepts a `relay` entry point; Cloud Relay v1 with the relay side of the AD-22 tunnel, device registration, PRM, token/entitlement admission and outcomes (WP-29, [`docs/RELAY.md`](docs/RELAY.md)); device side complete with registration at pairing (WP-30 **Done**, merged in PR #20; [`docs/DEVICE_TUNNEL.md`](docs/DEVICE_TUNNEL.md)) | WP-29 now covers signed deregistration and recoverable registration rollback; re-pair rotates id/key (AD-21); client timeouts of the OD-5 margin measured in WP-32; not deployed (WP-38, WP-39); single relay instance (AD-22 open question 8); real cloud-only entitlement admission implemented (WP-36 / AD-34); bounded client/device/source admission and load/backpressure tests implemented by WP-29 |
| Remote exposure lifecycle | Persisted, fail-closed; per-client reset, revocation and re-grant in the tray, audited, fail closed (WP-22, AD-19; re-grant WP-28) | Best-effort server-only provider revocation implemented (WP-36; provider-side revocation reaches the device within the AD-21 point 4 bound) |
| Process lifecycle | One per-user service (on demand from the shim, or managed by an OS supervisor), shim, control channel (WP-20, AD-17) | No autostart registration / supervisor files (WP-34); background processes are owned by the service, not by the client that started them (follow-up) |
| Child-process environment | Allowlist for `shell.execute` / `process.manage` plus `environment.allow`; overrides cannot copy withheld variables; Docker and Git keep their rules (WP-21, AD-18) | — |
| Secrets | OS secret store (Keychain, DPAPI, Secret Service) with owner-only file fallback; verified migration; denied to all CROT tools (WP-21, AD-18) | Unconfined commands can still use the OS store as the user (AD-18 residual risk): closed for Linux WP-23a and qualified Windows WP-23c (AD-30) workspace mode; closed for admitted macOS (WP-23b/AD-31); open in `full_control` |
| Command confinement L1 | Linux WP-23a (AD-20); Windows WP-23c **Done** (AD-30, Server2025 x64 Node20/22, explicit host/component preparation) | macOS WP-23b Done (AD-31; per-host self_test and recorded CI scope); packaging/signing WP-34 |
| Cross-OS browser validation | Linux E2E only | macOS / Windows browser chain unverified end to end (WP-25, WP-40) |

### 2.4 Missing or not accepted for v1 (do not confuse with merged code)

remaining platform qualification beyond AD-30/31 evidence; WP-25 branded-browser manual qualification and remaining release gates
(including OD-8); WP-29 completion is recorded in this PR;
live staging/production identity and relay environments WP-38/39; real remote
acceptance WP-32; independent security review WP-33; signed installers, updates,
autostart and extension publication WP-34/35; live commercial operation (WP-36
implementation is complete; provider/merchant qualification WP-39); final privacy/security/legal docs WP-37
and release process WP-40. Existing Linux/qualified Windows/macOS L1 (AD-20/30/31), WP-24 CDP,
WP-28 device identity, WP-30 tunnel and WP-31 profiles are not missing code.
None of them proves the remaining live deployment/manual/release gates.

### 2.5 Historical discrepancies from the earlier audit

The D1…D14 rows retain the earlier source snapshot/resolutions, not current
main facts. Current state is §2.1–2.4; post-merge corrections are recorded in
[the e23b7b9 documentation audit](docs/design/post-merge-e23b7b9-doc-audit.md).

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
| D10 | Audit at `22abf89`: §2.1 named WP-20 as the last completed WP, §2.4 still listed the service, tray, secret storage and Linux L1 as missing, §6.1 showed WP-23a "In review" although PR #6 is merged | §2.1–§2.4, §3, §6.1, §6.4 updated to the merged state |
| D11 | `STATUS.md` listed WP-23b/c under "Next" as startable, but OD-9 (macOS/Windows part) is undecided and blocks them (§4.2, §8.4 rule 1) | `STATUS.md` and §8.4 show WP-23b/c as blocked by OD-9; OD-9 for macOS/Windows is the first step of that branch |
| D12 | §8.2 did not name the browser chain into the security review: WP-24 → WP-25/WP-26 → WP-35 (store IDs) → WP-34 (release-candidate build) → WP-33 | Added to §8.2 as the second near-critical chain |
| D13 | §7 item 3, `docs/TRAY.md` and `README.md` described L1 as not available at all | Updated: Linux workspace mode is confined (WP-23a); macOS, Windows and `full_control` remain open |

No contradiction was found that requires changing an accepted AD.

### 2.6 Historical audit notes and current follow-ups

Original observations N1/N2 below are retained as historical audit evidence, not current macOS status. AD-30/31 now supply Windows/macOS production decisions; WP-23b is implemented in the recorded qualification scope. macOS uses Apple Seatbelt plus the Node/Koffi runtime; installer packaging/signing remains WP-34. N3 and the release follow-ups remain open; this reconciliation does not replace architectural decisions.

| # | Observation | Owner |
| --- | --- | --- |
| N1 | AD-18 and AD-19 (scope, residual risks, AD-19 point 10) still say "until L1 (WP-23)" / "L1 not available until WP-23". Since AD-20 / WP-23a the tray and `crot_status` report the real L1 state, and the residual risks are closed for confined Linux and qualified Windows children (AD-20/30). Original AD texts are preserved, with explicit current-scope cross-references | Windows current-scope cross-reference supplied by AD-30 and this docs reconciliation; macOS WP-23b still open |
| N2 | Windows installer-shipped components are now known: owner-provisioned DLL/Node/manifest in AD-30. Source/CI delivery works; packaging/signing is WP-34. macOS shipping details await WP-23b | WP-34 explicitly depends on Windows WP-23c components, in addition to Linux WP-23a; no speculative macOS packaging decision |
| N3 | WP-28 card scope lists "provider-side revocation"; AD-21 point 4 makes it best effort and forbids a provider client secret on devices, so the device cannot call the provider. WP-28 ships a hook reporting "not available"; the AD-21 point 4 (a) bound holds without it. WP-38 now supplies a tested pinned release-artifact builder that ignores `CROT_IDENTITY_DEV_ENVIRONMENT`; plain development builds remain unpinned. Live staging/production identity approval and shipping only selected pinned artifacts remain release gates (AD-21 point 5) | WP-36 implemented provider-side session revocation through the account service (AD-34; live provider qualification remains WP-39); WP-38/WP-39 pin the environment and WP-34 ships only pinned builds — release-gate item before G4 |
| N4 | §6.2 forbade "work on … other post-v1 items" for every card. The expanded product goal (§2.7) schedules post-v1 milestones (phases 5–8) that may run in parallel; §6.2 now allows them only as their own WPs, after their OD/AD, without changing or blocking any release-blocking WP | this roadmap (§6.2 amended explicitly) |

### 2.7 Expanded product goal (reassessment)

The product goal grows from remote access to an extensible execution
environment for local and remote agents: full media work (inspection to
render and verification), video editors and applications, and external
services (YouTube, ElevenLabs, TikTok, Canva, other APIs). The
reassessment ([`docs/plan/product-reassessment.md`](docs/plan/product-reassessment.md),
evidence in [`docs/design/extensibility-audit.md`](docs/design/extensibility-audit.md))
finds that no rewrite of Core, MCP, relay, identity or permissions is
needed; it adds open decisions OD-15…OD-23 (§4.2), phases 5–8 (§3) and
WP-41…WP-70 (§6.1; cards in
[`docs/plan/extension-work-packages.md`](docs/plan/extension-work-packages.md)).
What changed in this roadmap and why:

- **v1 scope unchanged** (recommended OD-23 (a)): phases 5–8 are post-v1
  milestones (v1.1 media, v1.2 integrations, v1.3+ editors/applications)
  and are not release-blocking.
- **Priority raised, scope unchanged:** WP-24…WP-27 (browser workflows and
  the browser path of publishing) and the OD-9 → WP-23b/c chain (remote
  media on macOS/Windows needs L1 there, OD-17).
- **New inputs to OD-4:** message size ≥ largest tool result; media data
  never through the relay; long work as jobs (OD-15). *Addressed by
  ARCHITECTURE.md §27 AD-22 (32 MiB per response, no media through the
  relay, room for jobs without defining them).*
- **New input to WP-31:** every new capability needs a remote default
  (met by WP-31: `REMOTE_DEFAULT_CAPABILITIES` and its guard test, AD-23
  point 4).
- **§6.2 and §11 amended explicitly** (N4; §11 notes) — nothing removed
  silently.

---

## 3. Phase and work-package overview

| Phase | Purpose | WPs |
| --- | --- | --- |
| 0 Contracts | Decide before code | WP-17, WP-18 — **Done** |
| 1 Local foundation | Supervised product on one machine | WP-19, WP-20, WP-21, WP-22 **Done**, WP-19b (optional) |
| 2 Confinement | L1 on all three OS | WP-23a **Done**; WP-23b **Done** (AD-31; recorded qualification); WP-23c **Done** (AD-30, OD-6 / Windows OD-9 closed) |
| 2B Browser v1 | AD-16 contract | WP-24, WP-25, WP-26, WP-27 |
| 3 Remote | Identity → relay → tunnel → profile → acceptance → review | WP-28, WP-29, WP-30, WP-31, WP-38, WP-32, WP-33 |
| 4 Commercial | Ship and operate | WP-34, WP-35, WP-36, WP-37, WP-39, WP-40 |
| 5 Extension foundation (post-v1; WP-41/42 now, the rest after their ADs) | Invariant tests, image view, components, jobs, connections, connector runtime | WP-41…WP-48 (OD-15, OD-16, OD-19, OD-20) |
| 6 Media (milestone v1.1) | Inspect, audio, speech, edit description, render, QC, presets, acceptance | WP-49…WP-57 (OD-17, OD-18) |
| 7 Integrations (milestone v1.2) | ElevenLabs, YouTube, TikTok, Canva, acceptance | WP-58…WP-64 |
| 8 Editors and applications (v1.3+) | Editor spike, interchange, MLT, bridge, application control | WP-65…WP-70 (OD-21, OD-22) |

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
| AD-22 | Relay–device tunnel v1 (WP-29/WP-30 preparation; decides OD-4, OD-5, §26 Q13): one outbound WebSocket per device (`crot-tunnel.v<N>`), challenge-signed with the WP-28 device key after registration at pairing; multiplexed unmodified HTTP exchanges with credit-based flow control; limits 4 MiB request / 32 MiB response; exchange deadline 15 min; explicit cancellation and outcomes (`not_executed` / `unknown`), no relay retries; relay never executes |
| AD-21 | Remote identity (WP-28 preparation; decides OD-2, OD-3): WorkOS AuthKit as managed authorization server (CIMD, DCR, PKCE S256, path-wildcard resource indicator `https://<relay-host>/d/*`, MFA required, access tokens ≤ 5 min); claims `iss`, `aud` (= canonical device URI, carries the device id), `sub` (= principal id and `accountId`, must equal the paired account), `client_id` (= `clientId`), `exp`/`iat`/`nbf`; nothing else is an authority; revocation is device state plus a bounded token age (≤ 15 min after `iat`), no per-request introspection, the relay never replaces the device's check; canonical device URI `https://<relay-host>/d/<deviceId>/mcp`, PRM path-inserted at the relay; RFC 9207 is an open condition before Gate G4 |
| AD-20 | Linux L1 (WP-23a): Ubuntu 22.04/24.04 LTS on x86_64/arm64; CROT-owned bubblewrap and AppArmor policy, version-matched, packaged and loaded by WP-34, never by the service; payload entered only through the stacked Ubuntu/bwrap-style transition `&crot-l1-<v>//&crot-l1-payload-<v>` (probe evidence), ABI 3.0 on 22.04 and ABI 4.0 with userns rules on 24.04, no nested user namespaces (24.04: profile; 22.04: `--disable-userns`); host read view minus CROT-protected paths; writes to workspace, private temp and a private home layer (CROT-private caches); network `on` (host namespace, localhost works) or `off`; mediated Docker endpoint on every transport; one sandbox per Core; remote-only refusal; stable reason codes; host-local services reachable over the host network are a documented residual risk reported in `detail` (decides OD-14) |

### 4.2 Still open

Only genuinely unresolved questions are listed. "AD" means the answer changes
a boundary and must be recorded in ARCHITECTURE.md §27 before code.

| ID | Question | Why it matters | Blocks | Decide by |
| --- | --- | --- | --- | --- |
| OD-1 | **Decided in ARCHITECTURE.md §27 AD-17 (WP-20):** per-user service, never a system service; managed by a systemd user unit / LaunchAgent / per-user Task Scheduler logon task (registered by WP-34) or started on demand by the stdio shim, which fails with a clear error only when the service cannot be started or runs another configuration | — | (WP-34 registers autostart) | Decided |
| OD-2 | Concrete identity provider and the token claims carrying `clientId` and device id (AD-15 open item) | Verifier, PRM metadata, relay token check, DCR/CIMD support | WP-28, WP-29, WP-38 | **Decided by ARCHITECTURE.md §27 AD-21:** WorkOS AuthKit as the managed authorization server; `sub` → principal id and `accountId`, the device id in the provider-signed `aud` (the canonical device URI), `client_id` → `clientId`; revocation decided on the device (local state, bounded token age). Open condition: RFC 9207 (`iss` in authorization responses) not provided yet — met before Gate G4 or accepted by a separate AD |
| OD-3 | Exact device resource URI form and PRM location (AD-15 open item) | Token audience, client configuration UX, relay routing | WP-29, WP-30, WP-28 tests | **Decided by ARCHITECTURE.md §27 AD-21 points 5 and 6:** `https://<relay-host>/d/<deviceId>/mcp` (resource, MCP endpoint, RFC 8707 `resource`, only accepted `aud`); PRM at `https://<relay-host>/.well-known/oauth-protected-resource/d/<deviceId>/mcp`, served by the relay |
| OD-4 | **Decided by ARCHITECTURE.md §27 AD-22:** relay–device tunnel wire protocol within the AD-15 shape (framing, multiplexing, flow control, keep-alive, versioning) | A long-lived contract between independently deployed relay and installed devices; version skew after release | WP-29, WP-30, WP-34 (updates) | Start of WP-29 — **AD required** (new boundary) |
| OD-5 | **Decided by ARCHITECTURE.md §27 AD-22 points 12–13:** §26 Q13: relay/tunnel timeouts for gated requests (approval up to 300 s) and bounded browser waits; behaviour towards clients with shorter timeouts. The device-side margin (a request ends 5 s before the exchange deadline) is recorded in AD-22 by commit `37b3126` (WP-30, PR #20); measured client timeouts are WP-32 | Remote multi-step tasks with approvals must not fail silently | WP-29, WP-30, WP-32 | Before WP-30 is merged — **met** |
| OD-6 | Windows L1 | **Decided: AD-30**, AppContainer + Job + DACL, durable lease / LOCAL Docker | WP-34: упаковка/подпись | **Closed (WP-23c)** |
| OD-7 | How a preset / remote-profile change is applied by the service (reload vs restart) | Policy immutability (AD-5, AD-10) vs usability | WP-22, WP-31 | **Decided by AD-19 point 5 (WP-22):** device state in `service-settings.json`; a new Core with the new policy, only while Core is idle; WP-31 adds the `autonomous-browser` rule set and the remote profile on the same mechanism |
| OD-8 | Response-bound single-use ownership capability and controlled staging: AD-33; selected before implementation | Exact response capability, production staging and real approval E2E; native Linux/macOS/Windows Core file-contour qualification explicit | — | **Decided: AD-33; implemented in WP-26** |
| OD-9 | Матрица v1 | Windows **Closed: AD-30**, Server2025 x64 Node20/22; неквалифицированные конфигурации unavailable. Linux AD-20; macOS **Closed: AD-31** (target matrix separate from CI coverage); browser **Closed: AD-32**, Chrome/Edge/Brave Chromium ≥120 (manual qualification tracked separately) | WP-23b, WP-34, WP-37 | Windows/macOS/browser decisions closed; qualification limits retained |
| OD-10 | **Decided — AD-35:** native-host `allowed_origins` is generated only from the reviewed release catalog for Chrome Web Store, Edge Add-ons and deterministic local/RC builds; runtime/user/page/agent input can never add an ID. Current channels share manifest-key ID `bllcepanlhojbddfbbpegmnokpaakool`; a store reassignment requires a reviewed release change. Store/signing credentials remain operator secrets | Exactly the published release identities and nothing else | WP-34, WP-35 | **Decided** |
| OD-11 | **Decided — AD-34:** protocol-major compatibility; ≥12-month tunnel support; 4426 update required; configurable version admission, never local authorization | Implement WP-36; retain control/bridge handshakes | WP-34, WP-36, WP-39 | Decided |
| OD-12 | **Decided — AD-34:** no device telemetry by default; explicit local export only; allowlisted relay/account metadata logs | Privacy/legal publication remains WP-37 | WP-36, WP-37, WP-39 | Decided |
| OD-13 | **Decided — AD-34:** Free offline; Trial 14d/2, Pro 5, Team 20; active remote admission only; BillingProvider + Stripe signed webhooks | Legal entity/jurisdiction/residency remain operational/legal gates, not fabricated values | WP-36, WP-37, WP-39 | Decided |
| OD-14 | ARCHITECTURE.md §26 question 15: host endpoints that give code execution to a local caller without a CROT credential (Docker on TCP without TLS, an SSH server on this host accepting the user's keys, debugging ports of the user's processes, unauthenticated notebook/IDE servers, container engines that put containers in the host network without the CROT container profile), reachable because network `on` shares the host network (AD-20 point 8) | Through such an endpoint a confined command can run unconfined code and reach CROT's state; options (a) host configuration outside L1, documented and reported, or (b) mediated localhost replacing AD-20 point 8 `on` | WP-23a (security acceptance), WP-31, WP-33, WP-37 | **Decided by ARCHITECTURE.md §27 AD-20 point 14:** option (a) — documented residual risk of the host-network model, best-effort notes in the confinement `detail`, never a refusal; network `on` stays the host network |

Open decisions of the expanded product goal (§2.7; briefs with options,
trade-offs and recommendations in `docs/plan/product-reassessment.md` §5;
ARCHITECTURE.md §26 questions 16–24). None blocks a v1 WP.

| ID | Question | Why it matters | Blocks | Decide by |
| --- | --- | --- | --- | --- |
| OD-15 | Long-running jobs and artifacts (start/status/cancel/result, persistence, retention, Core activity) | renders, transcription, uploads outlive a request; relay requests stay short | WP-44 and every job-based WP | AD before WP-44; input to OD-4 |
| OD-16 | Optional components: declaration, detection, versions, model paths, provisioning | clear "missing tool" reporting for local and remote agents | WP-43, WP-49…WP-51, WP-67, WP-68 (WP-65 research only informs it) | AD (or AD addendum) before WP-43 |
| OD-17 | Media capability: names, fixed operations, placement (confined vs in-service), exposure sources, remote defaults | security of media parsers; remote use on macOS/Windows | WP-49…WP-57 | AD before WP-49 |
| OD-18 | Edit description format and renderer; interchange exports | deterministic, verifiable editing | WP-52…WP-56, WP-66, WP-67 | AD after a short spike, before WP-52 |
| OD-19 | Service integration contract: connector manifests, generic tools, per-connection grants, publish gates; relation to §18 gateway | new APIs without Core/relay changes | WP-46, WP-47, WP-58, WP-59, WP-61, WP-63, WP-64 (spikes WP-60/62 inform it) | AD before WP-46 |
| OD-20 | Credentials of external services (device vault, cloud broker, user-owned apps, browser session); OAuth app ownership | user tokens outside the agent; confidential-client services | WP-45, WP-48, WP-58, WP-59, WP-61, WP-63 (spikes WP-60/62 inform it) | AD before WP-45 |
| OD-21 | Application bridges inside editors | editor-native features | WP-68 | AD after WP-65 stage 2 |
| OD-22 | Scoped desktop application control (reassesses "never in scope: OS-level input", §11) | GUI-only applications | WP-70 | AD after WP-69; not for v1 |
| OD-23 | Release staging: is any of phases 5–8 release-blocking for v1? | v1 schedule | — | product decision now (recommended: no) |

Implementation choices that are **not** architectural but have release impact
(the implementing WP decides and documents them): tray UI technology (WP-22: Electron, AD-19 point 1),
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
| WP-34 | Scope adds supply-chain integrity, version skew, uninstall/upgrade; deps add WP-23a, WP-23b (AD-31 runtime), WP-23c (AD-30 component delivery), WP-35 | D4, D7 |
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
| WP-21 | 1 | Secret storage, child-process environment allowlist | WP-20 | M | yes | with WP-22 | **Done** (AD-18) |
| WP-22 | 1 | Tray v1 and approval provider | WP-20 | L | yes | with WP-21 | **Done** (AD-19) |
| WP-23a | 2 | L1 Linux | WP-21, AD-20 (OD-9 Linux part and OD-14 decided) | M | yes | with 23b/c | **Done** (AD-20; PR #6, `e1d1f61`) |
| WP-23b | 2 | L1 macOS | WP-21, OD-9 | M | yes | with 23a/c | **Done** — AD-31; production Seatbelt, Keychain boundary, guardian, Docker; native Node20/22 evidence and limits in macOS report |
| WP-23c | 2 | L1 Windows: AppContainer + Job | WP-21, OD-9 | L | yes | with 23a/b | **Done** — AD-30; production Core, whole-lease recovery, LOCAL Docker; все 8 критериев, CI 11/11 |
| WP-24 | 2B | Browser: CDP backend, snapshot/refs, trusted input, frames, shadow DOM, waits, history | WP-18 | L | yes | now | **Merged** (PR #22–#25): implemented incl. out-of-process frames and element/frame-origin approval subjects; manual runs 1–5/follow-up recorded; B4/E5/windows and G5/H passed by owner; default-load timeout signalling merged in PR #26 (`289f500`); C1 demo mismatch retained as a limitation; **Done**, final engineering gate recorded |
| WP-25 | 2B | Browser: dialogs, file chooser, background screenshots, debugger lifecycle, tab group | WP-24 (engineering gate closed) | M | yes | with 26, 27 | Implemented; automated qualification in docs/design/browser-wp25.md; headed/manual matrix acceptance open |
| WP-26 | 2B | Browser: upload and download | WP-24, OD-8 | M | yes | with 25, 27 | **Done, merged PR #32**; native Linux/macOS/Windows Core file contour (AD-33) |
| WP-27 | 2B | Browser: per-tab queue, explicit `tabId` for remote, `openedBy` | WP-24 | S–M | yes | with 25, 26 | **Done, merged PR #33**; FIFO/remote/ownership unit and real Chromium E2E |
| WP-28 | 3 | Identity and device binding | WP-17, OD-2 (decided: AD-21); WP-21 (device key storage) and WP-22 (pairing UI) for final steps | L | yes | starts now | **Done** (AD-21; crot-mcp PR #16, `4d574f0`) |
| WP-29 | 3 | Cloud Relay v1 | WP-28, OD-3/4/5 decided | XL | yes | with phase 1/2/2B | **Done in this PR**, not merged: configurable client/device/source/account limits, fresh signed deregistration, orphan-safe pairing compensation and real socket load/backpressure. Evidence: `docs/design/relay-wp29-completion.md` |
| WP-30 | 3 | Device tunnel adapter | WP-20, WP-28, WP-29, OD-5 (decided: AD-22) | M–L | yes | — | **Done** (PR #20, merged): outbound `crot-tunnel.v1` with the WP-28 device credential, pinned relay host, refusals and reconnect; streams enter the unchanged relay entry point (tokens, ExecutionGuard, PermissionEngine, approvals, audit); multiplexing, streaming, cancellation, deadlines, loss without replay; registration at pairing (AD-22 point 4); OD-5 recorded in AD-22 points 12–13 (`37b3126`) and the §2.4/§19/§22/§25 status markers updated (`01f4a20`). WP-29 adds signed deregistration and recoverable pairing compensation; measured client timeouts (WP-32) |
| WP-31 | 3 | Remote permission profile and presets | WP-22, WP-23a, WP-30, OD-7, AD-23 (WP-23b/c not a prerequisite: AD-23 point 7) | M | yes | — | **Done, merged** (PR #21, `9ce0574`; code verified at `9ca7b5b`, CI 11/11 green): AD-23 recorded (`69408c3`; point 4 wording `4a654f5`); remote defaults only for `REMOTE_DEFAULT_CAPABILITIES`, with a guard test; the end-to-end check of the real upload/download gates is WP-26 acceptance (AD-23 point 8), not claimed by WP-31 |
| WP-38 | 3 | Staging cloud environment | WP-29, WP-28 | M | yes | with WP-30/31 | **Partial**: repository delivery implemented (`docs/STAGING.md`); public/live staging pending |
| WP-32 | 3 | Remote E2E acceptance suite and client compatibility | WP-24…WP-27, WP-30, WP-31, WP-38 | L | yes | — | **Partial**: automatic TLS/SDK/project/Chromium/L1 suite implemented; ≥4 external-client compatibility runs pending |
| WP-33 | 3 | External security review and fixes | WP-32, WP-34 (release-candidate build), WP-38 | M (+fix time) | yes | with WP-37 | Not started |
| WP-34 | 4 | Installers, signing, updates, autostart, supply chain | WP-20, WP-22, WP-23a, WP-23b (AD-31 runtime), WP-23c (AD-30 component delivery) (L1 components, AD-20 point 3), WP-35 (IDs), OD-1, OD-10, OD-11 | L | yes | with phase 3 | Not started |
| WP-35 | 4 | Extension publication | WP-24, WP-25, WP-26 (prep: now) | M | yes | early | Not started |
| WP-36 | 4 | Accounts, plans, billing, entitlements, device management | WP-28, WP-29, OD-13 | M–L | yes | with phase 3 | Done |
| WP-37 | 4 | Documentation, privacy/security docs, legal | content from all WPs; final after WP-33 | M | yes | ongoing | Not started |
| WP-39 | 4 | Production cloud and operational readiness | WP-38, WP-36, OD-12 | L | yes | with WP-33 | Not started |
| WP-40 | 4 | Release candidate, beta and GA release | all RB WPs | M | yes | — | Not started |
| WP-41 | 5 | Extensibility invariant tests | — | S | no | now | Not started |
| WP-42 | 5 | Workspace image view | — | S | no | now | Not started |
| WP-43 | 5 | Component availability and diagnostics | OD-16 | S–M | no | with phase 3 | Not started |
| WP-44 | 5 | Jobs and artifacts | OD-15 | M | no | with phase 3 | Not started |
| WP-45 | 5 | Connections and credential vault | OD-20, WP-21 | M | no | with phase 3 | Not started |
| WP-46 | 5 | Connector runtime: requests | OD-19, WP-45 | M | no | — | Not started |
| WP-47 | 5 | Connector runtime: files and async | WP-46, WP-44 | M | no | — | Not started |
| WP-48 | 5 | OAuth connections | WP-45, OD-20 | M | no | with WP-46 | Not started |
| WP-49 | 6 | Media inspect and frames | OD-17, WP-43, WP-42, WP-44 | M | no | — | Not started |
| WP-50 | 6 | Audio analysis and processing | WP-49, WP-44 | M | no | with WP-51 | Not started |
| WP-51 | 6 | Speech to text and subtitles | WP-49, WP-44, WP-43, OD-16 | M | no | with WP-50 | Not started |
| WP-52 | 6 | Edit description v1 | OD-18, OD-17 | S–M | no | with WP-50/51 | Not started |
| WP-53 | 6 | Render core | WP-52, WP-44, WP-49 | L | no | — | Not started |
| WP-54 | 6 | Render composition | WP-53, WP-50, WP-51 | M–L | no | with WP-55 | Not started |
| WP-55 | 6 | Render QC and verification | WP-53, WP-50 | M | no | with WP-54 | Not started |
| WP-56 | 6 | Delivery presets | WP-53 | S | no | with WP-54/55 | Not started |
| WP-57 | 6 | Media acceptance suite | WP-49…WP-56 | M | no | — | Not started |
| WP-58 | 7 | ElevenLabs connector | WP-45, WP-46, WP-47, WP-44 | M | no | with WP-59 | Not started |
| WP-59 | 7 | YouTube connector | WP-47, WP-48 (+ Google app setup) | M–L | no | with WP-58 | Not started |
| WP-60 | 7 | TikTok spike (research) | — | S | no | now | Not started |
| WP-61 | 7 | TikTok connector (conditional) | WP-60, WP-47, OD-20 | M | no | — | Not started |
| WP-62 | 7 | Canva spike (research) | — | S | no | now | Not started |
| WP-63 | 7 | Canva connector (conditional) | WP-62, WP-47, WP-48 | M | no | — | Not started |
| WP-64 | 7 | Integration acceptance suite | WP-57, WP-58, WP-59, WP-24…WP-27 | M | no | — | Not started |
| WP-65 | 8 | Editor integration spike (research; stage 1 now, stage 2 after WP-52) | — (stage 1); WP-52 (stage 2) | M | no | stage 1 now | Not started |
| WP-66 | 8 | Interchange export (OTIO, FCPXML, EDL, MLT) | WP-52, WP-65 stage 1 | M | no | with WP-67 | Not started |
| WP-67 | 8 | MLT project adapter (Kdenlive, Shotcut) | WP-65 stage 1, WP-66, WP-43 | M | no | — | Not started |
| WP-68 | 8 | Application bridge (first editor) | OD-21 (after WP-65 stage 2) | L | no | — | Not started |
| WP-69 | 8 | Desktop application control spike (research) | — | M | no | now | Not started |
| WP-70 | 8 | Application control v1 (conditional) | OD-22, WP-69 | L | no | — | Not started |

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
  *Amended (§2.6 N4):* WPs of phases 5–8 (§3) are allowed as their own WPs
  after their OD/AD; they never change or block a release-blocking WP, and
  the external MCP gateway itself stays post-v1.

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

**Status: Done** (ARCHITECTURE.md §27 AD-18). Boundary: leaks through CROT
itself are closed; OS-level protection of the store against unconfined
children is L1 (WP-23).

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

**Status: Done** (ARCHITECTURE.md §27 AD-19; [`docs/TRAY.md`](docs/TRAY.md)).
Electron tray as a control-channel client; service-side provider `tray`;
preset applied through a new Core while idle (decides OD-7); remote mode off
by default; remote full-control opt-in recorded only (enforcement: WP-31);
per-client exposure reset and revocation, fail closed (re-grant: WP-28);
pairing and L1/CDP status shown as not available. Residual risk until L1:
same-user processes can use the control credential. Docker and browser
approvals use the same provider path; their end-to-end runs through the tray
need Docker and the extension (covered at Core level and by WP-33).

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
AppContainer + Job Object, **Done**, AD-30).

**Актуально: WP-23c Done (AD-30)**; квалификация ниже.

**Архив до production-интеграции (не текущий статус):**

`0f9a998`/`bd96740`: обычные существовавшие файлы и каталоги workspace проходят
запись/переименование; восстановление по проверенному исходному NTFS ID без
подстановки старого пути. На Node20/22 **13/13 SD**, cleanup=true. `5d4791d`
сохраняет эффективные no-DELETE-share guards корня/предков/защищённых объектов
и внешних hardlink; пять owner-rename проверок получают Win32=32.
`1f015ff`: только отвергнутый Low WRITE_RESTRICTED spike переведён в явный opt-in
по разрешению куратора. AppContainer/WinPS/RPC/native-process/CROT-6A обязательны.
`394c1e8`/`a36a701`: выбранный компонент NativeProcessLauncher проверяет токен до
ResumeThread; бинарные 1 МиБ stdin/stdout +256 КиБ stderr, Unicode argv и exit=23
подтверждены. Настоящий CROT-6A: 5 чтений +5 записей +канал=EPERM, состояние
неизменно, владелец после проверки аутентифицирован.
На `a36a701` локальный check=0: 1767 Core +147 extension, 172 skipped;
CI: 9 успешных/2 Windows неуспешных из-за обязательного теста detached-потомка
(синхронный spawn не возвращает готовность). Backend CommandConfinement ещё
не зарегистрирован; сеть/Docker/аварийная очистка/полная матрица открыты.
Windows sandbox остаётся CONFINEMENT_UNAVAILABLE. macOS `fd4fd47` сохранён;
WP-23b архитектурно разблокирован, но не реализован; все три ОС обязательны.
[Восемь критериев](docs/design/windows-l1-curator-appcontainer.md);
полные новые доказательства: `docs/evidence/windows-l1-internal-rename/`.

**Исторические результаты до a6eb17d, не текущий выбор механизма:** WP-23a **Done** (ARCHITECTURE.md §27 AD-20; PR #6, `e1d1f61`;
[`docs/L1.md`](docs/L1.md)). WP-23b is not implemented. WP-23c's native restricted-token/DACL spike is
in progress following owner authorization to proceed with engineering work;
see [`docs/design/windows-l1-spike.md`](docs/design/windows-l1-spike.md).
Stage 2 native suspended restricted child probes with pre-resume Job assignment
and child/descendant/failure tests passed Windows Node 20/22 at `a6cdab2e`
(all 11 CI checks green). The common-resource SID candidate still lacks full
outside-write/IPC and positive developer-read boundaries; ARM64 and
standard-user qualification remain open. Stage 3 write-restricted/MIC
comparisons passed native Windows Node 20/22 at `14084c6f` (11 CI green):
permitted owner-only reads plus labelled-secret denial work in fixtures, but
ordinary Medium-workspace writes fail at Low IL. Safe workspace mediation and
bypass/IPC qualification remain required; production is not enabled. Stage 4
paired probes passed at `418b7d1f` (11 CI green): privilege-stripped MIC-only
restores tested normal/hidden Node descendants while retaining NR/alias and
token-raise denials. SID-filtered spawn EPERM remains rejected behavior, not a
product limitation. Full allowed-write/IPC boundaries remain open. Stage 5 native memory/handle
and readonly-IPC probes passed at `15bb9357` (Windows Node 20/22, 11 CI green):
trusted controls read real artificial canaries, Low memory/handle access is
denied, NR pipe denial contrasts with ordinary-pipe exposure and working Low
IPC. Real CROT IPC provisioning and complete production L1 remain open. Stage 6 adds a bounded explicit workspace-RPC experiment: native Node 22/cmd file/negative cases pass at `f38d68ad`, but Windows jobs FAIL on PowerShell and Node 20 descendants. Not transparent native filesystem support or stage-6 acceptance; see the spike report. OD-9/OD-6 remain open for the
production boundary; this research primitive
neither enables L1 nor completes Windows remote shell/process acceptance.

**Historical continuation before a6eb17d (partial, not accepted):** production WinPS shell
preparation at `43f7392` explicitly imports the system Utility manifest from
`$PSHOME`. Shared-launch ordinary Low redirection completes in its unchanged
15-second deadline and reaches Medium denial; a real Core regression checks
file content/stdout/stderr/exit. All 11 CI checks pass at latest qualified source `01ed8ce` after aligning the
legacy RPC gate with this production helper. The intervening `ec11e2e` rerun
failure is retained as raw-startup evidence.
Bare direct WinPS discovery still times out. Same-backing Medium writes,
global outside-Low denial, native stdio transport and the Windows confinement
backend remain missing; OD-6/OD-9 stay open and availability stays fail-closed.
See [continuation and full criterion status](docs/design/windows-l1-continuation.md).

**Historical pin — not overwritten:** Stage 6A diagnostic report: [`61d0f87a`](https://github.com/mysteriumpersonae/crot-mcp/commit/61d0f87a395ed1962cdbc4b19c7c482698a992e4) has nine passing non-Windows checks and two failing Windows jobs. Empty PATH fixes direct Node 20 spawning/observed Job cleanup, but cmd loses PATH; fixed PATHEXT restores the WinPS 5.1 version probe. PowerShell exit/redirection remains OPEN. RPC modifies real Medium files, not ordinary fs support; unapproved Low-sibling CRUD succeeds, exposing an unmet global outside-write boundary. See [`docs/design/windows-l1-stage6a.md`](docs/design/windows-l1-stage6a.md) for pinned evidence, open failures and mechanism comparison. No acceptance or production activation.

**Действующая общая карточка L1 (конец исторического блока).**

**WP-23b — Done (AD-31).** Производственный backend `macos-seatbelt`,
private HOME/cache, проверяемая kernel identity с ACK до caller code, guardian
на смерть владельца, CROT/Keychain/HTTP boundary и медиируемый Unix Docker.
[Нативные критерии и ограничения](docs/design/macos-l1-production.md).
Целевая матрица AD-29 не подменяется фактически проверенной CI-комбинацией.


- **Objective:** children of `shell.execute` and `process.manage` in
  workspace mode run under the fixed AD-13 point 4 profile.
- **Why:** a remote shell without confinement can read CROT's tokens and
  approve its own requests.
- **Dependencies:** WP-21; OD-9. Windows OD-6 / OD-9 part are closed by AD-30;
  macOS platform decision AD-29 and production mechanism AD-31 are accepted; WP-23b Done with recorded CI scope.
- **WP-23a (Linux):** normative boundary is ARCHITECTURE.md §27 AD-20, which
  decides the Linux part of OD-9 (Ubuntu 22.04/24.04 LTS, x86_64/arm64) and
  makes this card concrete for Linux: CROT-owned bubblewrap and AppArmor
  policy with the stacked payload transition and per-release ABI of AD-20
  point 3 (installed for source checkouts and CI by the WP-23a helper, on user
  machines by WP-34); Docker from the confined shell through the mediated
  Docker endpoint on every transport (no direct daemon access); writes to the
  workspace, the private temp and the private home layer (the CROT-private
  caches); network `on` in the host namespace (localhost services work) or
  `off`; the development baseline of AD-20 point 1 is part of the acceptance
  (including Docker/Compose with a TCP daemon, a localhost service and
  background processes); CI runs the real mechanism on Ubuntu 22.04 and 24.04.
  Host-local services reachable over the host network with network `on` are
  a documented residual risk (AD-20 point 14, OD-14), reported in `detail`
  where detectable and never refused.
- **Scope:** profile enforcement through the Platform / Native Host layer;
  `crot_status` reports L1 availability and reason; refusal of remote
  `shell`/`process` operations where the mechanism is unavailable on a
  specific machine.
- **Constraints:** one fixed Core-defined profile; network on/off only; local full
  control mode remains unconfined (§6; remote L1 requirement AD-23 unchanged); no change to `git.*`/`docker.use`
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
- **Status:** merged (PR #22, `d273473`; run-1 fixes PR #23); run-2 fixes in PR #24. The listed CDP implementation is covered by automated tests; the recorded
  manual runs are separate evidence, not final acceptance. See `tests-e2e/browser/browser-v1.e2e.test.ts`,
  `docs/BROWSER_E2E.md`. Manual run 1 (owner; four real sites) found input to
  background tabs, hidden-text waits and missing post-conditions; fixed in the
  PR (`docs/acceptance/WP-24-manual-run-1.md`). Manual run 2 found false
  `obscured` on scrolled pages and frames, false stale refs in same-process
  frames, missing `selector` + `frameRef` and 30 s dialog blocks; fixed in
  PR #24 (`docs/acceptance/WP-24-manual-run-2.md`, merged `a101008`). Run 3 is
  recorded in `docs/acceptance/WP-24-manual-run-3.md`; own pseudo-element
  ancestry and blocked-poll wait interruption are addressed in
  PR #25 (merged `32334aa`). Runs 4 and 5/follow-up recorded in
  `docs/acceptance/WP-24-manual-run-4.md` and `WP-24-manual-run-5.md`:
  B4/E5/windows and G5/H passed; C1 partial. Local Chromium reproduces
  missing default-load loadTimedOut before commit; fixed in
  PR #26 (`289f500`, already on main) without weakening page restrictions.
  **Done:** criterion-level engineering gate closed in
  `docs/acceptance/WP-24-final-engineering-gate.md`. No additional mandatory
  owner-only criterion exists in this card; historical observations are preserved.
- **RB:** yes. **Parallel:** now, with phase 1 and 3.

#### WP-25 — Dialogs, file chooser, background screenshots, debugger lifecycle, CROT tab group

- **Dependencies:** WP-24 (Done). **Scope:** AD-16 points 3 (lifecycle, availability
  in `browser_status`), 4 (tab group), 9, 13; `browser_dialog_handle`,
  `BROWSER_DIALOG_OPEN`; `tabGroups` permission.
- **Acceptance / tests:** E2E for `alert`, `confirm`, `prompt`,
  `beforeunload`, dialog timeout; file chooser interception; background
  screenshot without focus change; debugger detach → stale refs and
  re-attach; manual check of the debugger notice in headed Chrome, Edge and
  Brave on Linux, macOS, Windows; enterprise-policy-blocked debugger reported,
  no fallback.
- **Implementation status:** implemented; automated qualification in
  `docs/design/browser-wp25.md`. Final manual acceptance remains open for the
  headed Chrome/Edge/Brave × Linux/macOS/Windows infobar matrix; WP-24 owner
  acceptance is still open. OD-9 browser decision is closed by AD-32, not
  inferred from CI. Enterprise-policy denial is simulated in the E2E witness;
  it is not real managed-host qualification. Not a commercial-release claim.
- **RB:** yes. **Parallel:** with WP-26, WP-27.

#### WP-26 — File upload and download

**Status: Done in PR #32 (not merged); OD-8: Decided by AD-33.**
Production implementation, security limits and exact verification matrix:
[`browser-wp26-transfer-review.md`](docs/design/browser-wp26-transfer-review.md).
Native Core file-contour qualification: Linux, macOS and Windows on Node 20/22
through the existing six `ci.yml` jobs (`npm test`, no OS skips for the browser
file integration tests). Linux uses descriptor-relative publication, macOS
uses native *at syscalls, Windows uses pinned non-reparse handles, owner-only
DACL/MIC and handle-relative atomic rename. Real Chromium E2E remains Linux;
the separate WP-24 gate is now closed by recorded evidence; the full branded-browser/OS release matrix remains open.

- **Dependencies:** WP-24 (Done); OD-8 (**Decided: AD-33**). **Scope:** AD-16 points 11, 12;
  `browser_file_upload` (`browser.control` + `filesystem.read`),
  `browser_download` (`browser.control` + `filesystem.write`); `downloads`
  permission.
- **Acceptance / tests:** E2E upload of a workspace video fixture into a form;
  denial of a path outside the workspace in sandbox mode; download into the
  workspace, atomic appearance, refused overwrite; unrelated downloads never
  touched; dangerous/interrupted downloads leave nothing. In
  `autonomous-browser`, real `browser_file_upload` and `browser_download`
  execution paths must require approval; add end-to-end tests for both actual
  operations. This is the required cross-cutting verification of AD-23 point 8.
- **RB:** yes. **Parallel:** with WP-25, WP-27.

#### WP-27 — Multi-agent safety

- **Dependencies:** WP-24 (Done; WP-19 Done). **Scope:** AD-16 points 4, 8, 14:
  bounded per-tab FIFO after the approval gate (`RESOURCE_BUSY`), mirrored in
  the extension; `tabId` required for `kind: "remote"`; `openedBy`.
- **Acceptance / tests:** two concurrent agents on separate and shared tabs do
  not interfere (E2E); `INVALID_INPUT` for a remote principal without
  `tabId`; binding checked at queue front.
- **Status: Done in this PR**, not merged. Production Core/extension FIFO,
  remote validation and scope-relative ownership are implemented; qualification
  and limits: `docs/design/browser-wp27.md`.
- **RB:** yes. **Parallel:** with WP-25, WP-26.

### 6.6 Phase 3 — Remote access

#### WP-28 — Identity and device binding

- **Objective:** a user account and a paired device; remote tokens verified
  locally; revocation ends access.
- **Dependencies:** WP-17; OD-2 and OD-3 (decided by ARCHITECTURE.md §27
  AD-21, normative for this card). Device key storage needs WP-21; pairing
  UI needs WP-22.
- **Scope:** the provider of AD-21 point 1 (WorkOS AuthKit) configured for a
  development/test environment; device identity (the `deviceId` of AD-21
  point 5) and credential; pairing from the tray, which records the paired
  account; OAuth verifier behind `AccessTokenVerifier` with the claim model
  and verification order of AD-21 points 2 and 3 (JWKS from the issuer,
  `iss`, `aud` = canonical device URI, `exp`/`iat`/`nbf`, `sub` = paired
  account, `client_id`, revocation per point 4); remote principal fields
  populated; re-grant of a revoked client and provider-side revocation.
- **Constraints:** Core depends on no IdP (§15); token contents never grant
  capabilities (AD-15 p.4); credentials never reach Core/audit.
- **Acceptance:** a paired device verifies tokens; the device column of the
  AD-21 point 8 scenarios holds (token for another device or resource, wrong
  issuer, wrong device claim, expired, forged `clientId`); local token
  rejected on the relay entry point; revoked grant fails within the bound of
  AD-21 point 4; unpaired/revoked device cannot open a tunnel.
- **Tests:** verifier unit tests with real signed JWTs and JWKS rotation;
  AD-15 C8 items "token for another device", "local token on tunnel".
- **RB:** yes. **Parallel:** starts now, alongside phase 1.

#### WP-29 — Cloud Relay v1

**Status: Done in this PR**, not merged. Configurable admission limits,
fresh device-key deregistration, recoverable pairing compensation and real
socket load/backpressure complete the remaining scope. Evidence and limits:
[`docs/design/relay-wp29-completion.md`](docs/design/relay-wp29-completion.md).

- **Objective:** public HTTPS endpoint per device that admits authorized
  requests and streams them to the device's tunnel and back.
- **Dependencies:** WP-28 (token facts), OD-3 (decided: AD-21 points 5–7),
  OD-4 and OD-5 (decided: ARCHITECTURE.md §27 AD-22).
- **Scope:** AD-15 p.10 exactly: TLS; PRM and 401 `WWW-Authenticate`; token
  and entitlement check (hook for WP-36); routing by device id; unchanged
  forwarding of headers and bodies; streaming; size/rate limits; offline and
  remote-off refusal; device-credential-authenticated outbound tunnel; no
  payload logging; no MCP implementation or session state. Tunnel per
  AD-22: device registration endpoint (point 4), WebSocket carrier and
  handshake (points 2–3), framing, streams, mapping, flow control (points
  5–8), liveness/draining and versioning (points 9–10), limits 4 MiB /
  32 MiB and the 15 min exchange deadline (points 11–12), outcomes and
  validation (points 13–14); relay side of AD-22 constraint T1.
  Operational requirement: load-balancer idle timeout ≥ the exchange
  deadline; routing between relay instances is internal (AD-22 open
  question 8).
- **Acceptance:** an SDK client reaches a test device with each supported
  protocol version, including streamed responses and a gated request waiting
  for approval; payloads never appear in relay logs (log inspection test);
  identity headers injected by clients/relay are ignored by the device;
  every relay-generated refusal carries the AD-22 outcome
  (`not_executed` / `unknown`) and the relay never retries.
- **Tests:** relay integration suite with a test device; load/backpressure and
  reconnect tests; log-scrubbing test; the AD-22 constraint T4 list
  (handshake failures, framing errors, limits, deadline, versioning).
- **RB:** yes. **Parallel:** with phases 1, 2, 2B. Longest branch — start
  early.

#### WP-30 — Device tunnel adapter

**Status: Done** (merged, PR #20;
[`docs/DEVICE_TUNNEL.md`](docs/DEVICE_TUNNEL.md)). Implemented: the outbound
tunnel, the relay entry into the unchanged pipeline, multiplexing,
streaming, cancellation, deadlines, loss without replay and registration at
pairing (AD-22 point 4); OD-5 recorded in AD-22 points 12–13 (`37b3126`);
ARCHITECTURE.md status markers §2.4, §19 item 18, §22 and §25 updated
(`01f4a20`). WP-29 now adds signed deregistration and recoverable pairing
compensation. Measured client timeouts remain WP-32.

- **Objective:** tunnel requests enter the existing HTTP pipeline as
  `transport: "relay"`, `kind: "remote"`.
- **Dependencies:** WP-20, WP-28, WP-29; OD-5 (decided: ARCHITECTURE.md §27
  AD-22 points 12–13).
- **Scope:** AD-15 C4: same pipeline minus loopback Host check, OAuth verifier
  instead of local token; reconnect with backoff; remote mode on/off from the
  tray closes/opens the tunnel; cancellation propagates to pending approvals
  and not-yet-started operations. Per AD-22: device side of points 2–3 and
  5–14; registration at pairing (point 4, a change to the WP-28 pairing
  flow within AD-21); the loopback Host check is replaced by the pinned
  relay host and `/mcp` by `/d/<deviceId>/mcp` (point 7, the only pipeline
  changes); device aborts at deadline − 5 s; `RESET refused` only before
  dispatch. `engines` / built-in WebSocket (Node ≥ 22) with WP-34 (AD-22
  constraint T3).
- **Acceptance:** remote requests run through the unchanged Core pipeline;
  remote off → tunnel closed and no request processed; survives network
  changes and sleep/wake; persisted exposure keyed correctly across
  reconnects; client cancellation cancels a pending approval and prevents a
  not-yet-started operation, while a running operation finishes or times out
  and its result is discarded (AD-22 point 13; interrupting running
  operations is AD-22 open question 6).
- **Tests:** full AD-15 C8 list over a real tunnel; chaos tests (drop, delay,
  relay restart).
- **RB:** yes. **Parallel:** none on the critical path.

#### WP-31 — Remote permission profile and presets

**Status: Done** (PR #21, branch `wp-31-remote-permission-profile`,
awaiting merge; code verified at `9ca7b5b`, CI 11/11 green; ARCHITECTURE.md
§27 AD-23, decides §26 question 25). Implemented and covered by tests: the
remote profile in the one PermissionEngine (AD-23 points 1–4; remote
defaults only for the capabilities in `REMOTE_DEFAULT_CAPABILITIES`, every
current capability except `filesystem.full`, intersected with the configured
grants; a guard test fails for a capability without an explicitly decided
remote default); the presets (point 5); remote full control bound to the
device id and account of its pairing and kept across restarts (point 6);
remote shell/process only with L1, otherwise `CONFINEMENT_UNAVAILABLE`
(point 7); the `autonomous-browser-upload` rule registered and covered by
rule-set tests (point 8); changes only on the control channel and only
while idle (points 9–10); fail closed (point 11); reporting (point 12). The
end-to-end check of the real `browser_file_upload` and `browser_download`
approval gates is part of the WP-26 acceptance (AD-23 point 8) and is not
claimed by WP-31.

- **Objective:** safe remote defaults and the two presets, chosen only by the
  user.
- **Dependencies:** WP-22, WP-23a, WP-30; OD-7 (decided by AD-19). WP-23b/c
  are not prerequisites: where L1 is unavailable, remote shell and process
  operations are refused (AD-23 point 7, AD-20); WP-23b/c stay
  release-blocking (Gate G4).
- **Scope:** AD-13 p.5 (remote defaults to workspace mode, `untrusted-content`
  on; full control only as per-device opt-in); AD-16 p.17 presets via
  `permissions.approvals.untrustedContent`; L1-unavailable refusal for remote
  shell/process; reporting in `crot_status` and tray.
- **Constraints:** only existing matchers (`principalKinds`, `exposed`,
  capabilities, operations); no new mechanism. The open item of AD-19 point
  7 (`principalKinds` exists only in approval rules, so the full-control
  opt-in recorded by WP-22 could not take effect) is decided by AD-23: one
  PermissionEngine resolves exactly one profile per request.
  Presets are applied by the WP-22 mechanism (AD-19 point 5, OD-7).
- **Acceptance / tests:** defaults, opt-in and both presets proven by tests
  for local and remote principals; the `autonomous-browser-upload` rule is
  registered and covered by rule-set tests; preset change impossible via tools,
  pages or relay. The real `browser_file_upload` and `browser_download`
  approval gates must be verified end to end under WP-26; until those operations
  exist, WP-31 records this dependency but does not claim the cross-cutting
  test has passed (AD-23 point 8).
- **RB:** yes.

#### WP-38 — Staging cloud environment (new)

- **Status: Partial — repository deliverables implemented.** TLS container/compose,
  fixed-scope lifecycle and verified health, metadata-only diagnostics, pinned
  release identity artifact and automated TLS acceptance are implemented.
  Public hosting/DNS, live WorkOS/RFC 9207 and external-client acceptance remain
  operational/manual gates. See `docs/STAGING.md` and
  `docs/acceptance/WP-32-acceptance.md`. No $0 test is claimed as public deployment.

- **Objective:** a publicly reachable, production-like relay, IdP tenant and
  account/entitlement service for acceptance and security review.
- **Why:** real remote clients run in the cloud and cannot reach a test relay
  on a developer machine (D6).
- **Dependencies:** WP-28, WP-29; WP-36 hook stubbed until WP-36 lands.
  WP-29 security/load completion is merged in PR #34; no criteria reassigned.
  Environment-pinned artifacts and automatic TLS/log tests are implemented; live
  WorkOS and external OAuth/tool runs remain unverified; RFC 9207 is still an open G4 condition.
- **Scope:** TLS domain, deployment automation, secrets management, metadata-
  only logging, test accounts and devices, teardown/reset.
- **Acceptance:** an external MCP client completes OAuth and calls a tool on a
  test device through staging; logs verified payload-free.
- **RB:** yes (enables WP-32/WP-33). **Parallel:** with WP-30, WP-31.

#### WP-32 — Remote E2E acceptance suite and client compatibility

- **Status: Partial — automatic suite implemented; external compatibility pending.**
  Real SDK OAuth → HTTPS relay → WSS → CrotService → files/Git + real Chromium,
  all three revisions × both presets, control-channel approvals, negative cases,
  log canaries and measured timeout ordering. Installed x64 L1 jobs run the same
  combined scenario with successful confined shell execution mandatory.
  Root TLS/project tests run in the existing six OS/Node jobs. Four external
  clients/live staging are not replaced by emulation. Evidence and manual matrix:
  `docs/acceptance/WP-32-acceptance.md`.

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

- **Status: Done (repository implementation).** Cross-platform per-user autostart plans and CLI, strict Ed25519/SHA-256 transactional update core with automatic health-check rollback, state-preserving version layout, clean-uninstall hooks, release-pinned OD-10 native-host origins, deterministic SBOM/checksums/notices and N3 pinned-identity enforcement are implemented and exercised in the six-OS/Node matrix. OS vendor signing/notarization, package-format publication and signed-RC manual installation remain operator release gates.
- **Objective:** install, update and uninstall CROT on Linux, Windows and
  macOS without a terminal (§10, §24).
- **Dependencies:** WP-20, WP-22, WP-23a (Linux L1 components and AppArmor
  policy, AD-20 point 3: WP-34 packages and signs them, loads the policy on
  install and upgrade, unloads and removes it on removal, and excludes the L1
  private storage from temporary-file cleanup), WP-23c (Windows DLL/Node/manifest
  packaging and signing required by AD-30; qualified source delivery already works),
  WP-35 (store IDs), OD-1,
  OD-10, OD-11.
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

- **Status: Done (repository preparation).** `npm run package:extension` validates the exact AD-16.3 MV3 contour and emits a reproducible ZIP plus SHA-256. Submission-ready permission, privacy and publication texts are in `docs/store/`. Actual developer-account submission, store approval/publication and branded update-path acceptance remain operator gates.
- **Dependencies:** WP-24, WP-25, WP-26 (full permission set). Preparation
  (developer accounts, listing, privacy disclosures, permission justification
  text from AD-16 p.3) can start now.
- **Acceptance:** published in both stores with `debugger`, `downloads`,
  `tabGroups` accepted; store IDs recorded for WP-34 (OD-10); update path via
  store tested against the compatibility policy (OD-11).
- **RB:** yes. **Parallel:** early, alongside phase 3.

#### WP-36 — Accounts, plans, billing, entitlements, device management

- **Status: Done (repository implementation)** — PR #36, AD-34; final-head
  check/Chromium E2E and 11/11 CI are required before Ready for review.
  [API, deployment and acceptance matrix](docs/ACCOUNTS.md). Live WorkOS/Stripe
  and public host/financial/legal qualification remain owner release gates.

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
2. L1 on Linux, macOS, Windows with escape tests (WP-23a/b/c; Linux done WP-23a, qualified Windows done WP-23c/AD-30; macOS implemented WP-23b/AD-31, broader platform qualification remains explicit).
3. Approval provider authenticity: owner-only control channel unreachable from
   confined processes, agents, pages and relay (WP-20, WP-22, WP-23; confined
   Linux/qualified Windows children: done in WP-23a/WP-23c).
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
                │          └─► WP-23c ─┤ (Done AD-30; OD-6 closed)
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

The completed local pieces are WP-20/21/22/23a and now WP-23c (AD-30).
WP-23b implementation is Done under AD-31; wider target-matrix evidence and other G4 conditions remain explicit. On chain B WP-28/30/31
are Done/merged; **WP-29 is Done in this PR**, not merged. The executable next
step is qualified WP-38 staging. WP-32 → WP-33 → WP-40
is the downstream path, not a claim these tasks are unblocked now.
WP-24 engineering acceptance is closed; WP-26 is merged and WP-27 is
merged in PR #33. WP-25 branded-browser qualification and the other
WP-32 dependencies remain separate; green component CI is not a full release. The browser/publication branch is:

```text
C: WP-24 (L) ─► WP-25 (M) / WP-26 (M) ─► WP-35 (M, store IDs) ─► WP-34 (L, RC build) ─► WP-33
```

### 8.3 Classification

| Class | WPs |
| --- | --- |
| Sequential on critical path | Done: WP-20…22, WP-28/30/31. Remaining: WP-38 → WP-32 → WP-33 → WP-40 (browser prerequisites required too) |
| Parallelizable now | WP-25 branded-browser qualification; macOS wider platform qualification (AD-31); WP-38/35 preparation, WP-37 drafting, WP-19b. WP-23c Done |
| Parallel after prerequisites | WP-25 ∥ WP-26 ∥ WP-27 after accepted WP-24 (WP-26 also OD-8); WP-38 public staging after completed WP-29; WP-34/36/39/33 only with their stated prerequisites |
| Release blockers | every WP except WP-19b |
| Optional / non-blocking | WP-19b; §26 Q12 transport matcher; §26 Q14 tab-scope matcher |
| Post-v1 | §11 of this roadmap |
| Post-v1 milestones that may start now | implementation: WP-41, WP-42 (no open contract, see `docs/plan/product-reassessment.md` §8); research only: WP-60, WP-62, WP-65 stage 1, WP-69, OD-18 spike; AD drafting for OD-15…OD-20, OD-23 |

### 8.4 Next-WP selection rule

Проверенная база ветки WP-25: `main` на `e072e61` (merge PR #30).
Предыдущая сверка при разрешении конфликта PR #30 фиксировала `6f98e5d`
(merge PR #29); `0590c31` — более ранний merge PR #28, а `e23b7b9` —
историческая Windows-база аудита. Эти SHA не являются указателями на текущий
HEAD `main`. WP-23b принят куратором и слит по AD-31; AD-30/WP-23c Done
и зависимости следующих работ ниже сохраняются.

1. If any OD that blocks an unblocked WP is undecided, the next task is that
   decision (docs-only PR or first commit of the WP).
2. Otherwise choose, in order: an unblocked WP on chain A or B; then WP-23x;
   then WP-24…WP-27; then phase-4 WPs whose dependencies are done.
3. **Историческая база аудита: `e23b7b9` (merge PR #27); WP-23c Done.**
   Это зафиксированный срез и источник результатов CI, а не указатель на текущий
   HEAD `main`; последующие документационные merge не меняют эту базу доказательств.

По существующему правилу roadmap §8.4 сначала выбирается незавершённая,
разблокированная задача цепочки B после WP-29: **WP-38**, а не WP-32 напрямую.
WP-29 устранил инженерные relay-блокеры; само публичное staging ещё не развёрнуто. Параллельный ближайший
браузерный gate WP-24 закрыт по матрице доказательств; WP-27 слит в PR #33.
Матрица branded/browser UX WP-25 и остальные release-gates остаются отдельными. Это приоритизация существующих задач, не новое архитектурное решение
и не перенос их критериев. WP-23b реализован по AD-31; это не закрывает остальные условия G4.

| Задача | Реальные зависимости | Текущее состояние / открытые блокеры |
| --- | --- | --- |
| WP-29 completion | WP-28 and OD-3/4/5 decided; base `ca6280a` (PR #33) | **Done in this PR**, not merged; limits, signed deregistration/rollback and load/backpressure. Evidence: docs/design/relay-wp29-completion.md |
| WP-24 | WP-18; PR #22–#26 | **Done**, инженерная приёмка по docs/acceptance/WP-24-final-engineering-gate.md; ручные отчёты сохранены |
| WP-25 / WP-27 | WP-24 Done; WP-19 Done | WP-27 **Done, merged PR #33**, unit/Chromium E2E; WP-25 headed/branded qualification остаётся открытой |
| WP-26 | WP-24 и OD-8 | **Done**, merged PR #32; AD-33, native Linux/macOS/Windows Core file contour и реальные AD-23.8 E2E |
| WP-23b | WP-21 Done; платформенное решение OD-9 принято AD-29 | Done: Seatbelt/Keychain, AD-31 и зафиксированная Node20/22 CI-квалификация; более широкая матрица не объявляется проверенной |
| **WP-38 — внешний операционный остаток** | WP-28 и WP-29 Done; WP-36 hook может быть stub | Repo deliverables (TLS deploy/lifecycle, pinned build, automatic payload-free OAuth/tool tests) реализованы; public staging/live WorkOS и внешний OAuth/tool run не подтверждены. RFC 9207 — условие G4 или отдельный принятый AD |
| WP-32 | **WP-24…WP-27, WP-30, WP-31, WP-38** | WP-30/31 Done; automatic SDK/TLS/project/browser/L1 suite и timeout measurements реализованы. Публичный staging и ≥4 реальных remote клиентов × версии остаются открыты; CI не подменяет внешний прогон |
| WP-35 / WP-34 / WP-33 | WP-35: WP-24/25/26, OD-10 store IDs; WP-34: сервис/Tray/L1 и WP-35; WP-33: WP-32 + RC от WP-34 + WP-38 | Возможна подготовка, но publication, подписанная поставка/autostart и независимое security review не объявляются выполненными |

4. **Expanded goal (§2.7).** Post-v1 milestone work never displaces the
   critical path. Capacity beyond chains B and C goes, in order, to: WP-41
   and WP-42; OD-15/OD-16/OD-17 ADs → WP-44, WP-43; OD-19/OD-20 ADs →
   WP-45; research spikes WP-60, WP-62, WP-65 stage 1, WP-69. Research may
   start before an AD; implementation of a contract never does. The full milestone order is
   in `docs/plan/product-reassessment.md` §6.

---

### 8.5 Post-v1 milestone graph (phases 5–8)

Never on the v1 critical path; details and rationale in
`docs/plan/product-reassessment.md` §6.

```text
now:  WP-41, WP-42 (no open contract); research WP-60, WP-62, WP-65 stage 1, WP-69; AD drafts OD-15…OD-20, OD-23
OD-15 ─► WP-44 ─┐
OD-16 ─► WP-43 ─┼─► (OD-17) WP-49 ─┬─► WP-50 ─┐   (WP-49 also needs WP-44)
WP-42 ──────────┘                  └─► WP-51 ─┤
OD-18 ─► WP-52 ─► WP-53 ─┬─► WP-55 ───────────┼─► WP-54, WP-56 ─► WP-57   (v1.1 media)
                         │                    │
OD-20 ─► WP-45 ─┬─► (OD-19) WP-46 ─► WP-47 ─┬─► WP-58 (ElevenLabs)
                └─► WP-48 ──────────────────┴─► WP-59 (YouTube) ─► WP-64  (v1.2; also WP-24…27)
WP-60 ─► WP-61 (if feasible)     WP-62 ─► WP-63 (if feasible)
WP-52 + WP-65 st.1 ─► WP-66 ─► WP-67;  WP-52 ─► WP-65 st.2 ─► OD-21 ─► WP-68;  WP-69 ─► OD-22 ─► WP-70   (v1.3+)
OD-9 ─► WP-23b/c  (also prerequisite of remote media on macOS/Windows, OD-17 (b))
```

## 9. Release gates

Each gate is passed only when all its criteria are objectively met and
recorded in `STATUS.md`.

| Gate | Name | Criteria |
| --- | --- | --- |
| G1 | Architecture/foundation ready | AD-1…AD-16 merged (met); OD-1 (met: AD-17), OD-2 (met: AD-21), OD-9 decided; WP-19 done (met); OD-4 recorded as an AD before WP-29 implementation (met: AD-22) |
| G2 | Local supervised product ready | WP-20, WP-21, WP-22 done: multiple stdio clients via shim; no `in_use`; approvals work end to end in the tray for every capability; secrets not readable by tools/children; CI green on all OS |
| G3 | Browser v1 ready | WP-24…WP-27 done; every AD-16 point 19 test passes in real-Chromium E2E; three real sites recorded; debugger notice checked in Chrome/Edge/Brave on all three OS |
| G4 | Remote chain ready | WP-23a/b/c, WP-28, WP-29, WP-30, WP-31, WP-38 done; AD-15 C8 tests pass over a real tunnel; OD-5 (met: AD-22) and OD-6 decided; AD-21 RFC 9207 condition met or accepted by an AD; relay log-scrubbing verified |
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

Notes of the product reassessment (§2.7), explicit rather than silent:

- *OS-level input:* unchanged for v1. OD-22 reassesses a **scoped
  application control** capability (granted applications only, no screen
  streaming, no remote desktop) after v1; the never-in-scope line above
  stays as written until such an AD exists.
- *External MCP gateway:* stays post-v1; OD-19 (connector contract) is a
  different mechanism and does not open it.
- *MCP Tasks extension:* stays post-v1; long-running work is handled by
  jobs and artifacts (OD-15, WP-44) inside the existing tool contract.
- *Media, editors and applications:* planned as phases 5–8 (§3, §6.1) and
  never release-blocking for v1 (OD-23).


## Архив компонентных продолжений WP-23c

Следующие записи закреплены за исходными SHA; «open/unavailable» описывает
только тот этап. Текущий статус — §6.1, AD-30, итоговая квалификация ниже.

**История до a6eb17d — WP-23c AD-28 continuation:** $0 third-party license fees; Dokan commercial use
permitted under MIT/LGPL obligations, but stock control boundary remains unsafe.
75ce0f2 implements effective LPAC and literal-zero native qualification probes;
source-pinned actual results/8 criteria remain partial/NOT MET, not a backend or acceptance. See `docs/design/windows-l1-zero-license.md`.

WP-23c validation20808e8: unchanged implementation75ce0f2; all9 non-Windows CI PASS, both Windows FAIL. NUL compatibility and all8 acceptance criteria remain partial/NOT MET; earlier macOS20 concurrency failure retained, not claimed fixed.

**WP-23c, вариант А.2 после d7436af:** эксперимент с DACL корня NPFS
исключён. Добавлена пользовательская LOCAL-прослойка только префиксов libuv,
с ANSI/Unicode API, RX-каталогом вне workspace и передачей DLL потомкам до
ResumeThread. Обязательны два уровня spawn/Job, неизменённый реальный CROT-6A
и точное восстановление исходной матрицы ACL. Пакет остаётся незавершённым:
аварийное восстановление аренды, сеть/Docker и производственная регистрация
CommandConfinement пока открыты. Выбор механизма OD-6 не означает приёмку WP.

**WP-23c, долговечный протокол после de18eca:** добавлены WAL-before-mutation,
fsync, no-share lock Windows с автоматическим освобождением после гибели
владельца, строгий replay и последовательность drain → preflight/restore →
снятие новых workspace ACE → удаление профиля → durable closed. Пересекающиеся
аренды отказывают до второй записи ACL. Это компонент с fault-injection и
межпроцессными crash-тестами, не зарегистрированный backend: нативный адаптер
восстановления и сервисная интеграция ещё отсутствуют. Сеть/Docker/матрица
остаются обязательными. Последний ранее подтверждённый CI de18eca — 11/11;
приёмка пакета и available=true не объявляются.

WP-23c: низкоуровневые native ACL transactions добавлены отдельно от полного
LeaseRecoveryNative. Открытие по NTFS ID/creation time, точный DACL/control
readback, отказы при чужой ACL/новом hardlink проверяются самостоятельными
нативными тестами; аварийный тест двух SD не доказывает profile/actor recovery.
Регистрация production/сеть/Docker/полная матрица по-прежнему открыты.

`4c22e59` / проверенный merge `1ec46cc`: Windows Node20/22 PASS (включая
native SD recovery двух объектов после убийства владельца); исходные 13/13 SD,
7/7 CRUD, 5/5 tamper и реальный CROT-6A сохранены. Общий CI 10/11:
browser-e2e select_option неуспешен, остальные десять заданий успешны. Это не
приёмка WP-23c и не устранение непроверенных profile/Job/service recovery.

WP-23c, продолжение после 8eb3393: по подтверждению куратора реализованы
отдельные режимы сети on/off, intent в WAL, exact capability readback,
per-SID loopback lifecycle и обязательный сетевой этап recovery перед
удалением профиля. Новые Windows-тесты включают интернет, LAN, localhost,
настоящий CROT и HTTP-token gate. Полное замыкание native recovery, service
lifecycle, mediated Docker и production registration остаётся открытым до
нативной квалификации; OD-6/OD-9 не объявлены закрытыми только по компонентам.

WP-23c: `1ce8931` — сеть on/off, loopback cleanup, настоящий HTTP-token gate
и cleanup SID нового workspace-node подтверждены Windows20/22; CI 11/11.
`83da874` — отдельный WTS/token inventory-компонент остановки акторов,
не весь LeaseRecoveryNative. Согласование on уже получено; запрос разрешения
повторять не нужно. OD-9 Windows part / OD-6 пока не закрыты: остаются
профильная durable receipt/intent, интегральный native recovery + CrotService,
production CommandConfinement, проверенная поставка и Docker mediation.

Windows Docker continuation: общий request-policy теперь принимает отдельный
Windows host-path adapter (drive-aware Binds, bind/npipe/inspect/volume/Swarm,
обязательный resolver, запрет неоднозначных alias-путей). 403/refusal callback
проверяется через настоящий HTTP proxy с подставным daemon на Unix transport.
Нативный LOCAL endpoint/ACL, daemon path admission и производственная интеграция
не подменяются этим тестом; WP-23c/OD-6/OD-9 Windows остаются открытыми.


## WP-23c — итоговая квалификация

Исторический Windows-срез реализации: `e23b7b9c29c5e3e1758b9ad2703bbd827648426f` (merge PR #27). PR #27 слит, не Draft;
WP-23c **Done**, AD-30 действует, OD-6 и Windows-часть OD-9 закрыты.
Дерево merge совпадает с квалифицированным `f916a6b`; `8fe6ba5` — более
ранний квалификационный источник, не текущий HEAD. На самом `e23b7b9`
подтверждены все 11 заданий: [основной CI 6/6](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180293), [Linux L1 4/4](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180333), [Chromium 1/1](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180363).
Это фиксированная база кода для документационной сверки, не SHA будущего docs PR.

Исторический квалификационный источник (сохранён без подмены SHA):

Квалификация `8fe6ba5`: [CI 11/11](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39042379906), Windows Server 2025 x64, Node 20/22.

Все восемь критериев пройдены. OD-6 и Windows OD-9 закрыты AD-30;
ограничения платформ/Docker, поставка и recovery — docs/L1.md.
