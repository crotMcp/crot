# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## Last completed

**WP-21 — Secret storage and child-process environment allowlist**
(ARCHITECTURE.md §27 AD-18). User docs: README (Security properties,
`crot-mcp secrets`), [`docs/SERVICE.md`](docs/SERVICE.md).

- **Boundary (AD-18 point 1, variant A).** Closes secret leaks through CROT
  itself: structured tools, child environment, Core data and `crot_status`,
  audit, logs, browser, outbound requests. OS-level protection against
  unconfined children stays with L1 (WP-23); `full_control` is unconfined by
  definition. Permission system and WP-20 boundaries unchanged.
- **Secret store.** Service, control, HTTP and bridge credentials behind one
  `SecretStore`: macOS Keychain (`security`), Windows DPAPI (current user,
  through the existing FFI), Linux Secret Service (`secret-tool`), documented
  owner-only file fallback. `secrets.store: auto|os|file`; the choice is
  recorded per state directory in `secrets.json` and followed by every
  reader (shim, control client, relay, CLI). No new npm dependency.
- **Migration.** Copy, read back, compare, switch the marker, then delete;
  failures roll back; conflicting or undeletable plaintext files stop the
  service with a clear message; never an insecure fallback.
  `http.auth.tokenFile` is imported once; `http.auth.storage: "token-file"`
  is the explicit legacy mode (warning at start).
- **CLI.** `crot-mcp secrets status | show http-token | rotate <name>|--all`
  (rotation refused while the service runs).
- **Secret paths.** Denied to every capability in every mode (PermissionEngine)
  and protected from writes; `docker.use` refuses mounts containing them.
- **Child environment.** `shell.execute` / `process.manage` children get an
  allowlist of the CROT environment plus `environment.allow`; overrides set
  literals or remove, never copy a withheld variable; `crot_status`
  reports `childEnvironment` (names and counts only). Git starts from the same
  base and keeps its rules; Docker unchanged.

Tests: `tests/service/secrets/` (store, migration and rollback, OS backends:
real temp keychain on macOS, DPAPI on Windows, `secret-tool` where available,
fake tools elsewhere; DPAPI FFI against a mock library),
`tests/cli/secrets.test.ts`, `tests/core/secret-paths.test.ts`,
`tests/capabilities/child-environment.test.ts`, Docker mount test, service
tests for migration, token-file mode and status.

Previous: **WP-20 — Supervised service, thin stdio shim, local control
channel** (PR #16, `92cce3b`; AD-17, [`docs/SERVICE.md`](docs/SERVICE.md)).

## Next

| WP | What | Why now |
| --- | --- | --- |
| WP-22 | Tray v1 and approval provider on the control channel | chain A; unblocked by WP-20 |
| WP-23a/b/c | Command confinement L1 (Linux, macOS, Windows); also protects the OS secret store from children | unblocked by WP-21 |
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
| All stdio clients of a user share one configuration and one process environment (supervisor's or starting shim's; differing PATH/shell/home is reported to the client; commands get only the allowlisted part since WP-21) | AD-17 residual risk; WP-34 |
| Windows named pipes keep Node's default security descriptor (no explicit owner-only DACL) | WP-34 |
| Unconfined children can use the OS secret store (or the file fallback) as the same user | AD-18 residual risk; WP-23a/b/c |
| `secrets.store: "auto"` keeps the file fallback once chosen; switching needs `"os"` | AD-18 residual risk |
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
