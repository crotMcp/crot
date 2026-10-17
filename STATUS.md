# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## WP-23c — Done

Квалификация `8fe6ba5`: [CI 11/11](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39042379906), Windows Server 2025 x64, Node 20/22.

Производственный windows-appcontainer, оба сетевых режима, LOCAL Docker,
целый CrotService recovery; 7/7 workspace, 13/13 ACL, 5/5 tamper,
Node → Node → Node, настоящий CROT-6A/HTTP-token. OD-6 и Windows OD-9
закрыты AD-30. Все 8 критериев — в design-документе; поставка, ограничения
матрицы и остаточный риск AD-20.14 — docs/L1.md.

## Архив прежних этапов WP-23c (не текущий статус)

## WP-23c — производственная интеграция открыта; пакет не принят

Актуальная база `eb3c0f9`: CI 11/11; Server2025 x64 Node20/22 подтвердили
on/off, защиту HTTP-токена, очистку loopback и остановку акторов своего SID.
Новая дельта: Windows drive-aware Docker path policy подключена к общим
проверкам bind/npipe/inspect/volume/Swarm. Тест HTTP proxy подтверждает 403,
refusal callback и отсутствие передачи запрещённых запросов daemon.
Это не native pipe/ACL qualification: полный recovery/service lifecycle,
production backend, поставка и Windows Docker transport остаются открытыми.
Ниже сохранены более ранние этапы, не актуальный полный перечень блокеров.

Ранее подтверждённая база `de18eca`: CI **11/11**,
Windows Server 2025 x64, Node20/22: `13/13` SD (cleanup=true), `7/7` CRUD,
`5/5` защищённых подмен, внешний hardlink без записи, реальный CROT-6A
`5+5+канал=EPERM`. Два уровня Node → Node → Node и завершение оставшихся
потомков через Job подтверждены; LOCAL не переписывает каналы CROT/Docker.

Продолжение после `de18eca`: добавлены owner-only append-only WAL с fsync,
нативная исключительная no-share блокировка Windows, цепочка SHA-256,
протокол восстановления с preflight всей транзакции и удержанием идентичностей,
регистрация намерения Job до запуска, отказ при чужих изменениях SD и
пересечении идентичностей параллельных аренд. Ошибки записи/очистки не
объявляются успехом; профиль удаляется последним. Проверяются реальное убийство
процесса-владельца и повторное открытие WAL, а также запрет чтения/записи WAL
готовым AppContainer. Протокольные тесты с подставным адаптером не являются
доказательством восстановления ACL ядром.

Дополнительно реализованы нативные объектные транзакции `lease-acl.ts`:
планирование SD без записи, открытие по GUID тома/file ID/времени создания,
точное сравнение O/G/метки/DACL/control и непередающееся восстановление DACL.
На `4c22e59` (merge `1ec46cc`) оба Windows задания PASS, включая шесть
нативных транзакций и точное восстановление двух SD после убийства владельца;
повторно проходят 13/13 SD, 7/7 rename, 5/5 tamper, CROT-6A и два уровня spawn.
Общий CI **10/11**: browser-e2e неуспешен на browser_select_option; это не
объявлено исправленным. Исправленный 24-byte FILE_ID_DESCRIPTOR не подменяет
доказательство целого service recovery.
Их квалификация отделена от полного восстановления аренды: нет доказательства
очистки осиротевшего профиля/действующих акторов. Захват многоссылочных файлов
этим новым адаптером пока явно отклоняется, без подмены старого hardlink-контроллера.

**Не завершено:** полный нативный адаптер восстановления аренды/осиротевших профилей и
его подключение к запуску/остановке сервиса, production CommandConfinement,
сеть on/off, Docker и полная матрица Windows 11/Server 2022/2025,
x64/ARM64 (где поддерживается), обычный/повышенный пользователь. Windows
sandbox остаётся CONFINEMENT_UNAVAILABLE, PR27 Draft/open; WP-23c не закрыт.
[Восемь критериев](docs/design/windows-l1-curator-appcontainer.md).

## Исторические проверки до a6eb17d — не текущий выбор механизма

**AD-28: $0 third-party license-fee constraint.** Dokan commercial use is allowed
subject to MIT/LGPL compliance, including a validated replacement/relinking route;
security hash pins are not an automatic LGPL exception. No CROT relicensing.
Latest source75ce0f2 implements effective LPAC access verification and five native
raw-open probes, including literal NT DesiredAccess0 with separate owner control.
The unsupported class46 query at4804e32 is retained as failed prerequisite, not
access denial. Actual results and eight source-pinned criteria:
`docs/design/windows-l1-continuation.md`; license/security decision:
`docs/design/windows-l1-zero-license.md`.
Implementation75ce0f2: full local1732/168 skipped +147 PASS; its CI had
8/9 non-Windows PASS and2/2 Windows FAIL.
Latest unchanged-code validation20808e8 restores all9 non-Windows CI PASS,
including macOS20; both Windows remain FAILED. The earlier75ce0f2 macOS20
concurrent-start failure is retained; root cause is NOT established or fixed.
See20808e8-validation-summary.json for exact code/assertion identity and native proofs.
Both native profiles enter and deny four owner-positive raw opens, but literal
NT0 also denies owner (inconclusive) and NUL RW fails. No data grant or runtime
compatibility is proven. All criteria stay partial/NOT MET. No production backend,
READY bypass or original/global/device ACL
weakening; fresh profile normal cleanup is implemented, abrupt recovery unqualified.

AD-27 source `ca04414` actually builds and mounts the same-backing component on
Windows20/22 and verifies original root/file Medium before actor startup. It
DOES NOT pass filesystem acceptance: Node20 fails pre-JS0xc0000142, Node22 code1.
Canonical ESM Job binding fixes mixed-registry duplicate types; failed nonzero
helper unmount remains owned/reported. Original workspace SDs are never changed.

**New critical native result `0eb1519`: Low unique WRITE_RESTRICTED profile opens
its exact new raw control device with zero access (`control-zero-open`).** The
new self-test refuses READY, unmounts and never launches actor. No sensitive
IOCTL was invoked. Pinned driver only installs DACL from volume SDDL, not its
label, and raw token/event dispatch bypasses filesystem callbacks with ANY_ACCESS.
Never lower device label to make writes pass; no safe mechanism selection exists.
Node22 first-test setup also hit the default10s hook before this test executed;
that is an independent setup failure, not denial evidence.43ff402 fixes composite
fixture ownership/deadlines without changing actor gates. Both runtimes now
FAIL control-zero-open after all13 fixture setups reach ready; no unsafe actor
is launched. Max setup3691ms Node20/6118ms Node22.

Full localc6a1c45 `npm run check`: **1711 Core /168 skipped +147 extension**,
lint/format/types/builds pass. C6a1c45 restores all9 non-Windows CI green,
including all4 Linux L1 jobs; both Windows remain red. Trusted Linux fixture
uses the identical verified immutable Alpine index digest on ECR/Docker Hub,
with bounded fallback and5 portable tests. Docker security assertions unchanged.
Existing native process11/11,stage6a10/10,workspaceRPC7/7 pass on both runtimes;
actual ready Node22 state gate still denies5 reads/5 writes/control endpoint with
working owner controls. Source-pinned eight-criterion report and SHA256 receipts
are in `docs/design/windows-l1-continuation.md` and its evidence directory.
NUL/strong Node20/descendants/shells, safe control/data filesystem, complete
state/Docker, network/matrix/backend remain OPEN. Production none/not_implemented,
remote fail-closed, OD-6/OD-9 OPEN, PR27 Draft/open, no merge. No weaker fallback.

Previous native service-state source `9ced362379876ecf14b3b74eba7c03d8dc5b1b0c` (historical result):
**8 successful checks /2 Windows failures /1 independent Ubuntu24 ECR rate-limit
failure**. Three Linux L1 jobs, Linux/macOS Node20/22 and Chromium pass. Prior
e0cdb06 has all9 non-Windows checks green. Full local9ced362 check:
**1683 Core /167 skipped +147 extension**, lint/format/types/builds passed.

AD-26 actual service-state provider is implemented ate0cdb06. Native testing
found descriptor serialization failure plus managed-service regressions;
9ced362 fixes SACL-vs-LABEL serialization and strengthens AD-24 owned-object
label read-back. No failed encoding is treated as absent policy. Owner-only
DACL + Medium NWNR is installed/read-back before secret bytes, with pinned
no-reparse/single-link validation and retained native cleanup. Fixed legacy
state files are hardened; arbitrary directories/workspace SDs are unchanged.
Service Core/bridge/audit use the same provider. Shim protection failure stops
spawn/truncation. Empty-temp atomic failures preserve old secret/state bytes.

Real CrotService owner startup/control/settings update and5 private descriptor
checks pass on both runtimes. On **Node22**, the ready actor receives EPERM
for all5 actual secret/key/settings/audit reads and all5 writes, actual control
connection is unreachable, host bytes remain unchanged and owner ping works;
the mandatory test passes. On **Node20**, owner controls work but actor startup
still exits0xc0000142 before JS; that test FAILS, never counted as denial.
Criterion4 remains OPEN: Docker/self-approval/external config suite incomplete.

AD-25 BNO launch/read-back remains a component, not a compatibility solution.
Node20 startup, ordinary NUL, strong-token descendants, cmd and WinPS remain
red. Native process11/11, stage6a10/10 and workspace RPC7/7 pass in each Windows
job. No accepted transparent filesystem or production L1 backend exists.

Byte cleanup at0625595 retains failed event/parent closes, partial setup
handles and descriptors until native release succeeds. Fault injection checks
persistent failure, no allocation growth and recovery without double release.
Read-only attach synchronization at59068ab uses only the exact held child
thread. Unsupported/malformed query, count0 or persistent suspension fail before
resume. No process/token/desktop authority is exposed or weakened.

Implemented components include native byte stdio/ProcessLauncher through the
existing Core (`3b91370`, historical 11/11 CI), bounded launch environment,
unique write-only Low token, and AD-24's NEW noninteractive station/desktop,
explicit owned label installation plus exact kernel descriptor read-back.
The fixed helper itself is suspended/Job-contained before resume. No common SID,
interactive desktop, global NUL/device ACL, original workspace SD or runtime
qualification gate is widened. Original PowerShell fix `43f7392` and aligned RPC
regression `01ed8ce` remain intact; their strict 15-second gates are retained.

Published86d8a53/bde77eb/281b559 repair Job/token ownership after failed
configuration/CloseHandle, asynchronous exit cleanup and a host-close/launch
race, with portable fault-injection tests. It is not a transparent filesystem
or an accepted Windows L1 mechanism. Transparent same-backing Medium workspace
writes, complete global write/state/IPC/Docker isolation, production confinement
registration, native ARM64/Windows11/standard-user qualification and OD-6/OD-9
remain OPEN. **Availability stays fail-closed; WP-23c is not ready; PR #27 stays
Draft/open.** Exact commits, failure chronology, source-pinned events and
criterion status: [continuation evidence](docs/design/windows-l1-continuation.md).

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

**Текущий следующий шаг:** безопасная встроенная Windows граница записи,
включая внешний hardlink, без ослабления критериев. Платформенная зависимость
OD-9 для WP-23b решена AD-29; сам WP-23b не реализован.

**История до a6eb17d — WP-23c restricted-token spike.** Owner authorized
implementation work after the OD-9 proposal; native Windows x64 and ARM64 stay
in the v1 target. Native restricted-token/DACL primitives and a required
architecture-specific CI matrix are being added (workflow publication is
blocked by GitHub Workflows write permission); see
[`docs/design/windows-l1-spike.md`](docs/design/windows-l1-spike.md).
Stage 2 research-only suspended restricted child creation, pre-resume Job
assignment and actual file/descendant/failure probes passed native Windows
Node 20/22 CI at `a6cdab2e` (all 11 CI checks green). Local check: 1458 core
passed / 110 skipped, 147 extension passed. Common-resource SID grants are
not a complete outside-write/IPC boundary; ARM64 and standard-user acceptance
remain pending. Stage 3 write-restricted/MIC comparisons passed native Windows
Node 20/22 at `14084c6f` (11 CI checks green; local check 1469 core passed /
113 skipped, 147 extension passed). Owner-only reads plus explicit secret
NO_READ_UP work in fixtures, but Low IL blocks ordinary Medium-workspace
writes. No production activation; safe workspace mediation and bypass/IPC
qualification remain required. Stage 4 paired native probes passed at
`418b7d1f` (11 CI green; local check 1470 core / 124 skipped, 147 extension).
The privilege-stripped MIC-only component preserves both normal/hidden Node
spawning, secret NR denial, static-alias denial and own-token raise denial;
the SID-filtered candidate's EPERM failures are retained as rejected behavior.
Full allowed-write/IPC boundaries remain open. Stage 5 real canary memory,
handle and readonly-pipe probes passed Windows Node 20/22 at `15bb9357`
(11 CI green; local check 1470 core / 126 skipped, 147 extension). Low memory
and handle access are denied after working trusted controls; NW-only IPC
exposes canary bytes, explicit NR IPC denies Low reads, Low fixture IPC works.
This does not qualify real CROT IPC provisioning or production L1. Stage 6 adds a bounded explicit filesystem-RPC experiment against an ordinary Medium root. Code `f38d68ad` passes the explicit Node 22/cmd CRUD/negative cases, but real Windows Node 20/22 jobs FAIL: PowerShell and Node 20 descendants remain blockers. Local check: 1509 core / 132 skipped, 147 extension. It is NOT transparent shell/Node filesystem support and does NOT complete stage-6 acceptance. See the spike report. This is not a production L1 backend or a
completed OD-6 decision. macOS and
Windows runtime confinement remains `not_implemented`/fail-closed until the
full boundary and positive remote shell/process acceptance are implemented.
`ARCHITECTURE.md` and WP-25/26/27 are unchanged in this stage.

Stage 6A diagnostic report: [`61d0f87a`](https://github.com/mysteriumpersonae/crot-mcp/commit/61d0f87a395ed1962cdbc4b19c7c482698a992e4) has nine passing non-Windows checks and two failing Windows jobs. Empty PATH fixes direct Node 20 spawning/observed Job cleanup, but cmd loses PATH; fixed PATHEXT restores the WinPS 5.1 version probe. PowerShell exit/redirection remains OPEN. RPC modifies real Medium files, not ordinary fs support; unapproved Low-sibling CRUD succeeds, exposing an unmet global outside-write boundary. See [`docs/design/windows-l1-stage6a.md`](docs/design/windows-l1-stage6a.md) for pinned evidence, open failures and mechanism comparison. No acceptance or production activation.

**WP-24 — Browser v1 (CDP backend): implemented, merged** (PR #22, `d273473`; run-1 fixes in PR #23; run-2 fixes in PR #24;
see "Last completed"). Real-site manual runs are recorded; acceptance remains
open for default-load timeout signalling, C1 and final acceptance review. Owner's order after
WP-24: WP-23c (проверка достаточности OD-6 после контрпримера), затем WP-23b (OD-9 решён AD-29),
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
| WP-23b/c | Command confinement L1 на macOS и Windows (Linux готов: WP-23a, AD-20) | AD-29 решил платформы OD-9 и разблокировал WP-23b, который ещё не реализован. WP-23c не принят: a36a701 проходит переименование существовавших узлов, точный SD 13/13 и настоящий CROT-6A 5+5+канал EPERM на Node20/22. Обязательный тест потомка неуспешен; CI 9 успешных/2 Windows неуспешных. Backend/сеть/Docker/аварийная очистка/полная матрица открыты; Windows remote sandbox остаётся CONFINEMENT_UNAVAILABLE. Все три ОС обязательны для v1 |
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
| Матрица платформ macOS/Windows и браузеров v1 | ОС решены AD-29, реализация/нативная квалификация обязательны; браузерная часть OD-9 ещё открыта. WP-23b не блокируется отсутствием платформенного решения |
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

**Продолжение WP-23c: LOCAL после d7436af.** Обращения к DACL корня
NPFS удалены. Реализована пользовательская DLL совместимости: только префиксы
libuv `\\?\pipe\uv\` и `\\.\pipe\uv\` перенаправляются в
`\\.\pipe\LOCAL\uv\`. Охвачены ANSI и Unicode CreateNamedPipe/CreateFile;
ANSI API фактически используются stdio libuv в Node20/22. Реальные каналы
CROT и Docker не переименовываются; коды ошибок ядра сохраняются.
DLL находится вне workspace с RX для package SID, внедряется до ResumeThread
после проверки токена и Job; потомки получают её до возобновления.
Обязательный тест проверяет два уровня spawn и остановку обоих потомков Job.
Квалификация проводится Windows CI на том же коде, вместе с 13/13 ACL,
7/7 операциями, 5/5 отказами подмены и настоящим CROT-6A.
Аварийное восстановление аренды и производственный CommandConfinement этим
изменением не реализованы. Windows L1 не объявлен доступным; WP-23c не принят.

### WP-23c: разрешённые сетевые режимы (продолжение после 8eb3393)

Добавлены сетевой режим в WAL (старое v1 без поля означает off), точная
проверка трёх capabilities до ResumeThread, владелец loopback только для SID
аренды и обязательный этап удаления сети перед удалением профиля в recovery.
Проверка foreign loopback-конфигурации не заменяет общий список старым снимком.
Windows-тест проверяет настоящий CrotService: секреты/состояние/управляющий
канал, HTTP без токена/с неверным токеном, интернет/LAN/localhost и очистку.
Результат новых Windows-проверок фиксируется только по CI этого изменения;
локальные injected-тесты не доказывают сетевую изоляцию ядра.
Production backend и полное восстановление акторов/профиля пока не подключены.

На исходном сетевом коммите 53d071b Windows20/22 подтвердили network=on:
интернет/LAN/localhost=200, настоящий HTTP CROT без/с неверным токеном=401,
шесть реальных файлов read/write=EPERM, управляющий канал=EPERM, очистка
loopback успешна. Общий CI 9/11: оба off-теста ошибочно требовали EPERM от
сетевого WFP drop. Фактически наблюдались ETIMEDOUT/TIMEOUT и DNS ENOTFOUND;
это не выдаётся за успешный прямой TCP-запрет. Уточнённый гейт исключает DNS
(фиксированный IP), требует положительные owner-контроли и ноль принятых
соединений на контролируемом сервере. Точные EPERM-гейты файлов/IPC неизменны.
Добавлена подготовка удаления только trustee ACE собственного SID с нового
workspace-node; native идентичность/проверка чужого SD используются без пути
в качестве fallback. Полный обход дерева и scope admission этим не подменяются.

На 1ce8931 Windows20 уже подтвердил оба сетевых режима с прямым IP-контролем:
on — интернет/LAN/localhost=200, HTTP=401; off — ноль принятых соединений
контролируемого сервера, внешний TCP=EACCES, localhost/LAN — silent drop.
В обоих режимах 6+6 файлов и реальный control=EPERM; loopback очищен.
Нативный тест нового workspace-node подтвердил удаление собственного
унаследованного SID после восстановления родителя, без изменения чужих ACE.

Добавлен отдельный компонент полного инвентаря акторов: WTS всех сеансов,
отбор того же пользователя, pinned process handle и повторное чтение реального
TokenUser/AppContainerSid перед завершением только собственного package SID.
Требуются два полных пустых прохода; неизвестный SID/отказ запроса/завершения
или неуспешный CloseHandle не считаются отсутствием актора. Нет повышения
привилегий. Перед использованием обязательны durable receipt свежего профиля
и блокировка новых запусков; компонент не подменяет полный LeaseRecoveryNative.
Его Windows-квалификация отдельно проверяет живой контрольный процесс хоста.

83da874: инвентарь/остановка акторов прошёл на Windows Node22 (три прохода,
два пустых; потомки мертвы, host-control жив). Node20 выявил отказ
TerminateProcess; учтена возможность конкуренции с обычной остановкой Job. Общий CI
10/11, не объявлен зелёным. Последующая правка принимает неуспешный запрос
завершения только если ожидание того же pinned handle доказало смерть;
живой либо неоднозначный процесс по-прежнему означает ошибку. Это проверяется
отдельным FFI fault-тестом и повторным Windows-прогоном, не пропуском гейта.
Пустой/усечённый WTS-ответ без живого контроллера теперь отвергается; выход
между инвентарём и чтением токена доказывается wait на том же объекте и требует
повторного полного прохода. Владение свежим профилем дополнительно закреплено
in-memory brand/freeze до сетевых и launch-вызовов; durable receipt этим
не заменена. Полная производственная аренда и Windows backend ещё открыты.

WP-23c, следующий нативный срез: добавлены отдельный долговечный S_OK receipt
профиля, NTFS guards по ID с реальным no-DELETE sharing, полный native recovery
adapter и подключение существующих WAL к startup/shutdown NativeHost/CrotService.
Новый Windows crash-тест убивает владельца живой аренды и запускает настоящий
CrotService для проверки акторов, loopback, новых workspace nodes, исходных SD
и закрытого receipt. Его Windows-квалификация обязательна; production availability
пока не включена. Неоднозначный intent без S_OK receipt не разрешает удалять
профиль. Неподдержанные reparse/case-sensitive/multilink/пересекающиеся аренды
отказывают явно; они не обходят проверку границ.

WP-23c continuation: `365a475` qualified the real service-start recovery path
on Windows Server 2025 / Node 20 and 22: owner death, token-SID actor drain,
13 independent file snapshots plus all plan objects restored by NTFS ID,
new workspace ACE revocation, loopback removal, closed profile receipt and
idempotent reopen. That revision was NOT green overall: the portable receipt
fixture reused an unprepared existing Windows directory, and the new sharing
probe showed that an OpenFileById handle alone is not a rename guard. Follow-up
uses a by-ID anchored, identity-checked current-name data open and provisions
a fresh private fixture directory; both are requalified, not waived.

The LOCAL Docker endpoint now has an owned OVERLAPPED transport (explicit
owner/package DACL, Low label, remote clients refused), the shared policy and
trusted DOCKER_HOST environment. Its native test uses a mock upstream and checks
real AppContainer requests/403/audit, not a real Docker daemon. Production
backend readiness and native bind-path TOCTOU admission are not claimed yet.
