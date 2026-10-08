# CROT tray (WP-22)

The tray is the first approval UI for CROT and the place for the device-side
controls (ARCHITECTURE.md §27 AD-19). It is a separate Electron application
and only a client of the service's authenticated control channel
([`SERVICE.md`](SERVICE.md), AD-17): it has no MCP connection, no tools, no
access to Core or to the state files, and no approval authority of its own.
The service holds the approval provider and checks every decision.

```text
CROT service ── control endpoint (authenticated, owner-only) ──► tray main process
  approval provider "tray"                                        │ fixed preload API (4 functions)
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
| Approval preset | *Ask for every action* (`require-approval`) or *Off*; *Autonomous browser* comes with WP-31. Applied by switching to a new Core, only while CROT is idle (no operation in flight, no pending approval, no running background process); otherwise refused with the reason. | `<state>/service-settings.json` |
| Remote mode | Off by default. While off, the relay entry point refuses every request before MCP or Core work. The relay tunnel itself is WP-30. | `<state>/service-settings.json` |
| Remote full-control opt-in | Off by default. **Recorded and audited only** in WP-22: it changes no permission; WP-31 decides how it takes effect. | `<state>/service-settings.json` |
| Reset exposure | For one remote client (account, device, client): its persisted untrusted-content exposure becomes clean. | `<state>/remote-exposure.json` |
| Revoke | For one remote client: persisted; resets its exposure, aborts its requests in flight, closes its sessions; later requests are refused. Re-granting is WP-28. | `<state>/remote-clients.json` |
| Pair a device | Not available until WP-28 (identity and device binding). | — |

- All three files are owner-only and protected paths (no CROT tool can write
  them). If one cannot be read, the most restrictive value applies
  (preset `require-approval`, remote mode off, every remote request refused)
  and the tray shows the error.
- Every change is audited (`kind: "control"` records in the audit log).
  Changes that widen access (a less restrictive preset, remote mode on,
  full-control opt-in on, exposure reset) are refused if their audit record
  cannot be written; changes that narrow access are applied even then.
- The status section shows the service, mode, workspace, connected agents,
  the browser connection, command confinement L1 with its reason code (Linux:
  WP-23a, [`L1.md`](L1.md); macOS and Windows: not available until WP-23b/c),
  and the components that are not available yet: the CDP browser backend
  (WP-24) and pairing (WP-28).

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
  change the preset, turn remote mode on). The tray is a UI, not a security
  boundary against the same user.

## Tests

- `tests/tray/view-model.test.ts` — presentation rules.
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
  approve or change device state).
