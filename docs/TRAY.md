# CROT tray (WP-22)

> Current delivery clarification: tray code is implemented; standalone tray packaging/autostart is not implied by service autostart. See USER_GUIDE for actual buttons and exposure-gated meaning of Ask for every action.

The tray is the first approval UI for CROT and the place for the device-side
controls (ARCHITECTURE.md §27 AD-19). It is a separate Electron application
and a client of the service's authenticated control channel
([`SERVICE.md`](SERVICE.md), AD-17). Workspace operations now use a separate
ordinary MCP client (see [AD-39/AD-40](CONTROL_CENTER_ARCHITECTURE.md)). The owner
channel additionally has strictly validated product administration for projects,
agent policies, connectors, external MCP lifecycle, tasks and audit; effectful
integration actions still pass through Core. It exposes no arbitrary tool executor. The tray has no direct access to Core and no
approval authority of its own.
The service holds the approval provider and checks every decision.

```text
CROT service ── control endpoint (authenticated, owner-only) ──► tray main process
  approval provider "tray"                                        │ fixed preload API
  device settings, remote clients                                  ▼
                                                                renderer (sandboxed page, text only)
```

## Running it

```sh
npm run build
npm run tray                      # electron dist/tray/main.js
npx electron dist/tray/main.js --state-dir=<state directory>
```

- The tray connects to the service of the same OS user and state directory
  (default: the OS-conventional state directory, see SERVICE.md) and retries
  every 2 seconds while no service runs. One tray per state directory.
- It shows a tray icon (green: running; blue: remote mode on; orange:
  approvals waiting; grey: not connected) and a window. The window opens on
  every new approval request; closing it hides it. Where the desktop has no
  system tray, the window is shown instead.
- Electron is a development dependency for now: packaging, signing and
  autostart of the tray are WP-34.

## Approvals

- While at least one tray is subscribed, the service registers the approval
  provider `tray`; without a tray every gated operation is denied at once
  (`unavailable`), and when the last tray disconnects pending requests are
  cancelled. Timeouts and dismissal deny.
- The window shows each request as plain text in Core's order and with
  Core's labels (`docs/design/approval-gates.md` §6.3): control, bidi and
  zero-width characters are shown as `[U+XXXX]`, tabs as `[TAB]`, line feeds
  as `↵`; nothing is shortened (long values show their length). Remote
  agents, `full_control`, paths outside the workspace and values supplied by
  a web page (tab URL, title) get banners and marks; the client name is
  marked as self-reported.
- **Approve** and **Reject** apply to one request. The main process sends the
  request id with the subject digest it presented; the page never sees the
  digest. There is no "always allow" and no batch decision. Several trays may
  be open; the first decision wins.

## Device controls

| Control | Effect | Stored in |
| --- | --- | --- |
| Approval preset | *Ask for every action* (`require-approval`, default), *Autonomous browser* (`autonomous-browser`: browser control without repeated approval; local file uploads, shell, filesystem write, Git write, network and Docker Compose stay gated) or *Off* (`off`: local agents only; remote agents then get *Ask for every action*). ARCHITECTURE.md §27 AD-23 point 5. Applied by switching to a new Core, only while CROT is idle (no operation in flight, no pending approval, no running background process); otherwise refused with the reason; if the new Core cannot be built nothing changes. | `<state>/service-settings.json` |
| Remote mode | Off by default. While off, the relay entry point refuses every request before MCP or Core work and the device tunnel is closed (WP-30). | `<state>/service-settings.json` |
| Remote full-control opt-in | Off by default (AD-23 point 6). Can be turned on only while this device is paired, the device settings are readable and CROT is idle. It applies only to remote agents of this pairing (its device id and account): they work in `full_control`, each of their shell commands needs your approval, and their shell and process operations run only where command confinement L1 is available. Local agents and other devices are not affected. It is kept across restarts for the same pairing; unpairing (or pairing again) turns it off. An opt-in recorded before WP-31, or one for another pairing, does not apply and is shown with the reason. | `<state>/service-settings.json` (with the device id and account it was given for) |
| Reset exposure | For one remote client (account, device, client): its persisted untrusted-content exposure becomes clean. | `<state>/remote-exposure.json` |
| Revoke | For one remote client: persisted; resets its exposure, aborts its requests in flight, closes its sessions; later requests are refused. A revoked client shows **Re-grant** (WP-28): audited first; tokens issued before the re-grant stay refused, so the client signs in again. | `<state>/remote-clients.json` |
| Pair / unpair this device | WP-28, [`IDENTITY.md`](IDENTITY.md): **Pair this device** opens the sign-in of the identity environment in the default browser; the section shows the environment, the paired account, the device id and the device's address for MCP clients (`https://<relay>/d/<deviceId>/mcp`). **Cancel pairing** while waiting; **Unpair this device** ends remote access at once. Without an identity environment (this build pins none) pairing shows why it is not available. | `<state>/device-binding.json`; device key in the secret store (`device-key`) |

- All these files are owner-only and protected paths (no CROT tool can write
  them). If one cannot be read, the most restrictive value applies
  (preset `require-approval`, remote mode off, no remote full control, every
  remote request refused) and the tray shows the error.
- Every change is audited (`kind: "control"` records in the audit log).
  Changes that widen access (a less restrictive preset, remote mode on,
  full-control opt-in on, exposure reset) are refused if their audit record
  cannot be written; changes that narrow access are applied even then.
- The status section shows the service, mode, workspace, connected agents,
  the browser connection, command confinement L1 with its reason code (Linux:
  WP-23a, [`L1.md`](L1.md); qualified Windows: WP-23c Done, AD-30 (Server2025 x64 Node20/22;
  preparation/self_test required); macOS: unavailable pending WP-23b,
  so remote shell/process are refused where L1 is unavailable), and
  unavailable-component reasons. WP-24 CDP is implemented on main; its final
  manual acceptance is still open, not a missing backend.
- The profile lines (WP-31) show the effective preset and where it comes
  from (chosen on this device, the configuration, or unreadable device
  settings), the remote profile (mode, untrusted-content protection,
  capabilities) with each restriction, and remote full control: *off*, *ON
  for device … only*, *ON … (not saved: off after a restart)*, or *recorded
  in the device settings but NOT in effect* with the reason. A recorded
  opt-in that the running Core does not apply is never shown as on.

## Security

- Main process: reads the control credential through the CROT secret store,
  like `crot-mcp service status`; the credential never reaches the page.
- Window: context isolation, Chromium sandbox, no Node integration, no
  webview; the page is served from memory on `crot-tray://app/` with a strict
  content security policy (no inline script, no network, no images);
  navigation, redirects, new windows and every permission request are denied.
  The page builds the view with `textContent` only.
- The preload exposes `onView`, `ready`, `decide` and `action`. The main
  process accepts IPC only from its own window on `crot-tray://app/`,
  validates every argument and maps actions to a fixed list of control
  requests.
- **Residual risk (AD-19, accepted until L1/WP-23; closed for workspace-mode
  commands on Linux by WP-23a):** any process of the same
  OS user — including an unconfined command started by CROT — can read the
  control credential and act like the tray (approve its own pending request,
  change the preset, turn remote mode on), or write the protected state
  files directly (AD-19 residual risk D). A stored full-control opt-in still
  applies only to the pairing it names (AD-23 point 6), which limits a forged
  opt-in to what the user could enable but does not prevent it. The tray is a
  UI, not a security boundary against the same user.

## Tests

- `tests/tray/view-model.test.ts` — presentation rules.
- `tests/tray/profile-lines.test.ts` — the preset, remote profile and
  full-control lines (WP-31).
- `tests/tray/controller.test.ts` — against a real service: decisions carry
  the presented digest; reconnect after a service restart.
- `tests/tray/smoke.test.ts` — starts the built Electron tray with
  `--smoke-test=<report>` against a service with a pending request, checks
  what the page renders and that nothing was decided. On Linux without
  `DISPLAY` it runs under `xvfb-run` (CI installs Xvfb); where Electron
  cannot start it is skipped with the reason, except on CI (`CI=true`).
- `tests/service/tray-control.test.ts`, `tests/service/control-center.test.ts`
  — the provider and the device controls in the service, including the
  negative cases (MCP tools, the shim channel and remote clients cannot
  approve or change device state); `tests/service/full-control-grant.test.ts`
  — the full-control opt-in across real service restarts, unpairing and
  pairing again (WP-31).
