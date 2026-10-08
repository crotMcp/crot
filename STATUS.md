# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## In review

Nothing. The last audit of `main` (`22abf89`, 2026-10-08) synchronized this
file and `CROT_IMPLEMENTATION_ROADMAP.md` §2, §6.1 and §8 with the merged
state.

## Last completed

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
shim, local control channel** (PR #16, `92cce3b`; AD-17,
[`docs/SERVICE.md`](docs/SERVICE.md)).

## Next

**Recommended next WP: WP-28 — Identity and device binding**
(roadmap §8.4). Critical path: yes — chain A (WP-20…WP-22, WP-23a) is done,
and WP-28 → WP-29 → WP-30 → WP-31 → WP-32 → WP-33 → WP-40 is the longest
remaining chain. Dependencies satisfied: WP-17 (AD-15), WP-21 (device key
storage), WP-22 (pairing UI placeholder), the `AccessTokenVerifier` seam and
`relay` entry point (WP-19). Decide first: **OD-2** (identity provider and
token claims; owner's product choice, against AD-15 point 5) and, with it,
**OD-3** (device resource URI, needed for the audience tests). If OD-2
cannot be decided yet: WP-24.

| WP | What | State |
| --- | --- | --- |
| WP-28 → WP-29 | Identity provider and verifier, then Cloud Relay | recommended next; OD-2 (and OD-3) first; OD-4 is an AD before WP-29 |
| WP-24 | Browser v1: CDP backend, snapshot and references, trusted input, frames, shadow DOM, waiting, history (AD-16) | unblocked (WP-18), no open decision; parallel to WP-28 |
| WP-23b/c | Command confinement L1 on macOS and Windows (Linux done: WP-23a, AD-20) | blocked by the macOS/Windows part of OD-9; WP-23c starts with its spike (OD-6); release-blocking (AD-13), needed before WP-31 |
| WP-35 | Extension publication, submitted early | preparation now; submission after WP-24…WP-26 (`debugger`, `downloads`, `tabGroups`) |

## Open questions and follow-ups

| Item | Where it is decided |
| --- | --- |
| Full move of stdio and legacy sessions to MCP SDK v2 (today: v1 + v2 side by side) | follow-up after WP-19 |
| `server/discover` lists only 2026-07-28 (legacy versions are reachable via `initialize`) | follow-up / WP-32 |
| Concurrency limit for the tunnel entry point (loopback has `http.maxConcurrentRequests` since WP-20) | WP-30 |
| Background processes are owned by the service, not by the stdio client that started them (shared by all clients; they outlive that client until the service stops) | follow-up (AD-17 scope) |
| Approval deadlines are not extended across system sleep; sleep detection is a clock-jump heuristic (not changed by WP-22) | follow-up |
| All stdio clients of a user share one configuration and one process environment (supervisor's or starting shim's; differing PATH/shell/home is reported to the client; commands get only the allowlisted part since WP-21) | AD-17 residual risk; WP-34 |
| Windows named pipes keep Node's default security descriptor (no explicit owner-only DACL) | WP-34 |
| Unconfined children can use the OS secret store (or the file fallback) as the same user | AD-18 residual risk; Linux workspace mode: closed by WP-23a; `full_control`, macOS, Windows: open (WP-23b/c) |
| Host-local services that accept the user's authority without a CROT credential (Docker on TCP without TLS, SSH server on this host accepting the user's keys, debugging/notebook endpoints without authentication, container engines without the CROT container profile) are reachable with network `on` | Accepted residual risk of the host-network model (AD-20 point 14, OD-14 decided); reported in `detail` where detectable; disclosure in WP-37 |
| macOS, Windows and browser parts of the v1 platform matrix | roadmap OD-9 (Linux part decided by AD-20); blocks WP-23b/c and WP-34 |
| Identity provider and token claims (`clientId`, device id); device resource URI | roadmap OD-2, OD-3; first step of WP-28 |
| L1 components on user machines (installing `crot-bwrap`, `crot-l1-init`, the AppArmor policy and host exec rules; `scripts/l1-install.sh` until then) | WP-34 |
| AD-18/AD-19 texts still say "until L1 (WP-23)" although Linux is confined since AD-20 | roadmap §2.6 N1 (not amended silently) |
| `secrets.store: "auto"` keeps the file fallback once chosen; switching needs `"os"` | AD-18 residual risk |
| Autostart registration (systemd user unit, LaunchAgent, Task Scheduler) | WP-34 |
| Re-granting a revoked remote client; revoking tokens or devices at the identity provider | WP-28 |
| Remote full-control opt-in is recorded only; how it takes effect (per-principal profile; `principalKinds` exists only in approval rules) | AD-19 point 7; WP-31 |
| Preset `autonomous-browser` (rule set not implemented yet) | WP-31 |
| Any process of the same OS user can read the control credential and act like the tray | AD-19 residual risk; confined Linux children: closed by WP-23a; macOS, Windows, `full_control` and other processes of the user: open (WP-23b/c) |
| Tray packaging, signing and autostart (Electron is a dev dependency today) | WP-34 |
| Which token claims carry `clientId` and the device id | WP-28 (depends on the identity provider) |
| Exact device resource URI form and PRM location | WP-29 |
| Transport matcher to gate loopback HTTP separately from stdio | ARCHITECTURE.md §26 question 12 (not required for v1) |
| Relay/tunnel timeouts for gated requests and bounded browser waits | §26 question 13, WP-29 / WP-30 |
| Approval policy in general (beyond presets) | §26 question 6 |
| Limit remote agents to tabs they opened | §26 question 14 (opened by AD-16; not required for v1) |
| Input into background tabs on real sites; validation on at least three real sites | WP-24 |
| Debugger notice in headed Chrome/Edge/Brave on all OS; enterprise policies blocking `chrome.debugger` | WP-25 |
| Download hand-over mechanism (staging in the download directory or stream over the bridge) | WP-26 |
| Store acceptance of the `debugger` permission | WP-35 |
| How a preset change is applied by the supervised service (reload or restart) | WP-31 |
