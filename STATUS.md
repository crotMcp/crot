# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## Last completed

**WP-20 — Supervised service, thin stdio shim, local control channel**
(ARCHITECTURE.md §27 AD-17; decides roadmap OD-1). User docs:
[`docs/SERVICE.md`](docs/SERVICE.md).

- **OD-1.** One CROT service per OS user, never a system service. Managed
  mode (`crot-mcp service run`, `crot-mcp --http`) for OS supervisors
  (systemd user unit, LaunchAgent, per-user Task Scheduler task; registration
  is WP-34); on-demand mode: the stdio shim starts the service when it is not
  running and the service stops after its last stdio client. Recorded as
  AD-17 (§24 boundaries unchanged).
- **Service.** Owns Native Host, browser bridge, Core and HTTP. Singleton by
  exclusive endpoint ownership (a losing service exits before touching the
  bridge); the shim endpoint is released last. Several stdio clients now share
  one Core and one browser bridge: no `in_use` in normal use.
- **Shim.** `crot-mcp` on stdio forwards stdio MCP unchanged, holds no Core,
  permissions or policy; one MCP connection and one exposure scope per shim
  (AD-12, AD-15 point 8); no silent reconnect (exit 1 if the service dies).
  One configuration per service (digest check; idle on-demand services step
  aside). The stdio behaviour seen by clients is unchanged (existing E2E pass
  through the shim).
- **Endpoints and control channel.** Owner-only Unix sockets / named pipes in
  the private state directory, separate 256-bit credentials (private files
  behind a `CredentialStore` interface for WP-21), mutual HMAC
  challenge–response, per-direction sequence numbers and HMACs (replay,
  reordering and tampering close the connection). Control channel: `ping`,
  `status`, `shutdown`; no MCP and no tools.
- **Lifecycle.** Graceful shutdown keeps AD-7 (Core drains and records
  in-flight operations before the audit log closes); crash: shims exit,
  stale endpoints are taken over, persisted remote exposure intact and fail
  closed; sleep/wake via clock-jump detection with endpoint re-check;
  `crot_status.service` and `crot-mcp service status` report the state.
- **Sessionless concurrency.** `http.maxConcurrentRequests` (default 32):
  excess 2026-07-28 requests get 503 / `-32000` / `Retry-After: 1` before MCP
  or Core.
- **Core.** Additive only: `crot_status.service` (host-supplied, read-only).
  PermissionEngine, ExecutionGuard, approval broker and tools unchanged.

Tests: `tests/service/channel.test.ts`, `tests/service/service.test.ts`,
`tests/service/shim.test.ts` (multi-client through the built shim, CLI
service commands, crash restart with persisted remote exposure, AD-7 shutdown
audit, another OS user — CI creates a second account on Linux, macOS and
Windows), `tests/adapters/http-modern.test.ts` (concurrency limit); the stdio
and browser-bridge E2E run through the shim; the former "second instance stays
`in_use`" test is replaced by a shared-bridge test with per-connection
exposure.

Previous: **WP-19 — Remote MCP request pipeline per AD-15** (PR #14,
`8169b1f`).

## Next

| WP | What | Why now |
| --- | --- | --- |
| WP-22 | Tray v1 and approval provider on the control channel | chain A; unblocked by WP-20 |
| WP-21 | Secret storage (service, control, HTTP and bridge credentials behind `CredentialStore`), child-process environment allowlist | chain A; unblocked by WP-20 |
| WP-24 | Browser v1: CDP backend, snapshot and references, trusted input, frames, shadow DOM, waiting, history (AD-16) | browser branch; unblocked by WP-18 |
| WP-28 → WP-29 | Identity provider and verifier, then Cloud Relay | relay branch starts right after AD-15 (AD-14 point 6) |
| WP-35 | Extension publication, submitted early | needs the AD-16 permission justification (`debugger`, `downloads`, `tabGroups`) |

## Open questions and follow-ups

| Item | Where it is decided |
| --- | --- |
| Full move of stdio and legacy sessions to MCP SDK v2 (today: v1 + v2 side by side) | follow-up after WP-19 |
| `server/discover` lists only 2026-07-28 (legacy versions are reachable via `initialize`) | follow-up / WP-32 |
| Concurrency limit for the tunnel entry point (loopback has `http.maxConcurrentRequests` since WP-20) | WP-30 |
| Background processes are owned by the service, not by the stdio client that started them (shared by all clients; they outlive that client until the service stops) | follow-up (AD-17 scope) |
| Approval deadlines are not extended across system sleep; sleep detection is a clock-jump heuristic | follow-up / WP-22 |
| All stdio clients of a user share one configuration; an on-demand service inherits the environment of the shim that started it | AD-17 residual risk; revisit with WP-22 / WP-34 |
| Windows named pipes keep Node's default security descriptor (no explicit owner-only DACL) | WP-21 / WP-34 |
| Autostart registration (systemd user unit, LaunchAgent, Task Scheduler) | WP-34 |
| Exposure reset and revocation of remote clients; persistence write failures are only logged | WP-22 |
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
