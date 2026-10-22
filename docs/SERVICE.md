# CROT service, stdio shim and control channel

> Current delivery clarification: service autostart generators invoke exact Node + JS entrypoint. Platform registration is separately qualified; GUI installer/runtime bundling remains incomplete. See INSTALL.

Since WP-20 (ARCHITECTURE.md §27 AD-17) every OS user has **one CROT
service**: one long-running `crot-mcp` process that owns Core, the Native
Host, the browser bridge and the loopback HTTP server (later also the device
tunnel). MCP clients reach it in two ways:

- **stdio** — the MCP client starts `crot-mcp [options]` as usual. That process
  is now a **thin shim**: it connects to the service (starting it when it is
  not running) and carries the stdio MCP traffic to it unchanged. It contains
  no Core, no permissions and no policy.
- **Streamable HTTP** — `crot-mcp --http` runs the service itself, in the
  foreground; stdio shims of the same user attach to that service too.

Several MCP clients can therefore use CROT at the same time, and the browser
bridge has exactly one owner: `BROWSER_BRIDGE_IN_USE` no longer occurs in
normal use.

```text
MCP client A ── stdio ──► crot-mcp (shim) ─┐
MCP client B ── stdio ──► crot-mcp (shim) ─┤ shim endpoint (authenticated)
                                           ▼
                         CROT service (one per user)
          Core · PermissionEngine · ExecutionGuard · audit · Native Host
          browser bridge ◄── CROT Browser Extension (relay)
          HTTP on loopback ◄── HTTP MCP clients
                                           ▲
crot-mcp service status|stop ──────────────┘ control endpoint (authenticated)
CROT tray (WP-22, docs/TRAY.md) ──────────┘ same endpoint: approvals, device controls
```

## Commands

| Command | What it does |
| --- | --- |
| `crot-mcp [options]` | stdio shim: connects to (or starts) the service; for MCP clients |
| `crot-mcp --http [options]` | runs the service in the foreground with HTTP (managed) |
| `crot-mcp service run [options]` | runs the service in the foreground (managed); for OS supervisors |
| `crot-mcp service status` | state of the running service; exit status 0 = running, 3 = not running |
| `crot-mcp service stop` | graceful shutdown through the control channel; waits until it has stopped |

`[options]` are the usual serve options (`--config`, `--workspace`, `--mode`,
`--audit-log`, `--no-audit`, `--http*`).

## Lifecycle

**On demand (default).** When a shim finds no running service it starts one:
a detached `crot-mcp service run --on-demand` with the shim's own arguments
and environment, output to `<state>/service.log`. Concurrent shims serialise
the start with a lock (`<state>/service-start.lock`, kept fresh while held, so
a slow start never looks abandoned); if several services start anyway, the
exclusive endpoint lets only one of them run and the others exit before
touching the browser bridge. A socket file left by a crashed service is taken
over under a separate lock; an abandoned lock is broken by one process only. The startup messages of the service (the
banner) are shown on every shim's stderr. An on-demand service stops about
1 s after its last stdio client has gone (30 s if no client ever connects).

**Managed.** `crot-mcp service run` and `crot-mcp --http` keep running without
clients. They are meant for OS supervisors that start CROT at login and
restart it after a crash (the installer will set this up, WP-34), for example:

- Linux — a systemd user unit (`~/.config/systemd/user/crot.service`):

  ```ini
  [Unit]
  Description=CROT service

  [Service]
  ExecStart=/usr/bin/node /path/to/crot-mcp/dist/bin/crot-mcp.js service run --config /path/to/crot.json
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```

  `systemctl --user enable --now crot`.
- macOS — a LaunchAgent (`~/Library/LaunchAgents/com.crot.service.plist`) with
  `ProgramArguments` = node, `crot-mcp.js`, `service`, `run`, `--config`, …,
  `RunAtLoad` and `KeepAlive` = `{ SuccessfulExit: false }`.
- Windows — a Task Scheduler task "At log on" for the user running
  `node crot-mcp.js service run --config …`, with "If the task fails, restart
  every 1 minute".

The service always runs **as the user** (never as a system service): the
endpoint protection, the browser bridge and the credential files all assume
the user's account.

**Configuration.** All stdio clients of a user share the service, so they must
use the same configuration (configuration file and flags; HTTP settings do not
matter). A shim with a different configuration (or CROT version) is refused
with an explanation while the service is in use. An on-demand service that has
no clients is replaced instead: it stops and the shim starts one with its
configuration. To switch a managed service, stop it (`crot-mcp service stop`)
or change its unit.

**Shutdown.** On `crot-mcp service stop`, `SIGINT`/`SIGTERM`/`SIGHUP` (Windows
also `SIGBREAK`) or the idle timeout, the service stops in this order: no new
connections; the control endpoint; every shim is told `bye` (its client sees
the server exit) and its MCP connection is closed; HTTP stops; Core terminates
every process tree it started, waits for operations in flight to write their
audit records and closes the audit log (AD-7); the browser bridge and the
Native Host close; the shim endpoint is released last. The 5 s deadline and
the emergency process-tree kill are unchanged.

A shim stops when its client closes stdin or stdout, or on a shutdown signal,
exactly as `crot-mcp` did before (stderr: `shutting down (stdin closed)` and so
on); this ends only that client's connection.

**Crash.** If the service dies, every shim exits with status 1
(`lost the connection to the CROT service`) instead of reconnecting silently:
a new connection would be a new, clean exposure scope. The MCP client restarts
the server as after any crash and the next shim starts a new service (a
managed service is restarted by its supervisor). Stale socket files are
detected and taken over. The persisted remote exposure state
(`<state>/remote-exposure.json`) is untouched by restarts and still fails
closed when it cannot be read (AD-15 point 8).

**Sleep and wake.** Node has no portable power-event API; the service checks
every 5 s whether the wall clock jumped much further than expected (more than
15 s), which happens after system sleep or a clock change. It then logs the
resume, counts it in the status and re-checks its endpoints; a missing POSIX
socket file is re-created, an endpoint taken over by another process stops the
service. The same endpoint check runs every 5 s. Approval timeouts are not
adjusted for the time asleep.

**Health.** `crot-mcp service status` (control channel) and `crot_status`
(`service`: state, pid, start time, uptime, `on-demand`/`managed`, connected
stdio and control clients, endpoint kind, HTTP URL and sessionless load,
detected resumes).

## Endpoints and credentials

Both endpoints live in the user's private state directory (Linux
`$XDG_STATE_HOME/crot`, macOS `~/Library/Application Support/CROT/State`,
Windows `%LOCALAPPDATA%\CROT`):

| | POSIX | Windows |
| --- | --- | --- |
| shim endpoint | Unix socket `<state>/service.sock` (0600) | named pipe `\\.\pipe\crot-service-<digest>` |
| control endpoint | Unix socket `<state>/control.sock` (0600) | named pipe `\\.\pipe\crot-control-<digest>` |
| credentials | CROT secret store: Keychain or Secret Service entries, or `<state>/service-token`, `<state>/control-token` (file fallback, 0600) | DPAPI-encrypted files in `<state>\secrets\` (file fallback: owner-only ACL) |

- The state directory is created `0700` (owner-only ACL on Windows); the
  sockets are `0600`, so other OS users cannot connect at all. On Windows the
  pipe names are derived from the secret credentials and Node's default pipe
  security does not let other users open a pipe for writing.
- Independently of the OS protection every connection must authenticate:
  challenge–response with HMAC-SHA-256 over fresh nonces from both sides
  (mutual: the client also checks that the endpoint knows the credential), then
  every message carries a per-direction sequence number and an HMAC with a
  per-connection key. A peer without the credential, with a wrong one, or
  replaying a recorded handshake or message is rejected and disconnected; the
  credential itself never crosses the channel.
- The two endpoints have separate 256-bit credentials and channel labels: the
  shim credential does not open the control channel.
- Credentials are created by the service only, never passed in arguments or
  environment variables, never logged, audited or given to Core, the browser or
  child processes. They are kept in the CROT secret store (WP-21,
  ARCHITECTURE.md §27 AD-18): the OS secret store, or owner-only files where
  none is usable; `crot-mcp secrets status` shows which. Secret files and the
  DPAPI directory are denied to every CROT tool in every mode; the store
  marker `secrets.json` and `service.log` are protected paths (no CROT tool
  can modify them). The shim and the control client read the credentials
  through the same store. `crot-mcp secrets rotate --all` (with the service
  stopped) replaces them. A command started by CROT runs as the user and is
  not confined at the OS level until WP-23, so it could still use the OS
  secret store itself.

### Secret store and migration

- `secrets.store`: `auto` (default; OS secret store if a round trip works at
  first start, otherwise owner-only files with the reason recorded), `os`
  (required: the service does not start without it) or `file`. The choice is
  recorded in `<state>/secrets.json` and kept; it changes only when the
  configuration asks for another backend.
- Backends: macOS Keychain (`/usr/bin/security`, login keychain, service
  `crot-mcp:<state key>`), Windows DPAPI for the current user, Linux Secret
  Service through `secret-tool` (only with a session bus). Values are passed
  on stdin, never in arguments or environment variables.
- Migration (service start, under a lock): every secret is copied, read back
  and compared before the marker is switched and the old copy is deleted. A
  failure rolls back and changes nothing; plaintext files of earlier versions
  that hold a different value, or cannot be deleted, stop the service with a
  message naming the file.

## Control channel

The control channel is for the user's own tools: `crot-mcp service
status|stop` and the CROT tray ([`TRAY.md`](TRAY.md), WP-22, ARCHITECTURE.md
§27 AD-19). It carries **no MCP and no tools**; anything other than a known
control request with valid parameters closes the connection. It makes no
permission decision and cannot reach Core's tools. It is not an authorization
mechanism: its credential only shows that the peer runs as the same OS user
(who can stop the service anyway); it creates no principal, grant or scope.

| Request | What it does |
| --- | --- |
| `ping`, `status`, `shutdown` | WP-20 |
| `overview` | service, mode, workspace, preset and its source, remote mode, full-control opt-in (recorded and in effect, with the reason when it does not apply), the remote profile (WP-31), remote clients, agents, browser, trays, L1/CDP availability, pairing (environment, state, device id, account, canonical URI; never a token) |
| `approvals.subscribe` / `approvals.unsubscribe` | the connection becomes (stops being) an approval UI; subscribe returns the pending requests, then events `approval.requested`, `approval.resolved`, `state.changed` follow |
| `approvals.decide { requestId, decision, subjectDigest }` | approve (with the presented digest) or reject one request that was presented to this connection |
| `preset.set { value }` | `require-approval`, `autonomous-browser` or `off` (ARCHITECTURE.md §27 AD-23 point 5; `off` applies to local principals only, remote principals then get `require-approval`); refused unless CROT is idle |
| `remote.setMode { enabled }`, `remote.setFullControl { enabled }` | device switches; full control (AD-23 point 6): turning it on needs a paired device, readable settings and an idle Core, and applies only to remote principals of that pairing |
| `remote.resetExposure`, `remote.revokeClient` `{ accountId, deviceId, clientId }` | one remote client |
| `remote.regrantClient` `{ accountId, deviceId, clientId }` | re-grant a revoked client (WP-28): audited first, written before it takes effect; tokens issued before or in the second of the re-grant are refused |
| `pairing.start` | start pairing (WP-28, [`IDENTITY.md`](IDENTITY.md)): returns the sign-in URL; refused without an identity environment or while paired |
| `pairing.cancel` | cancel a pairing waiting for the sign-in |
| `device.unpair` | unpair: no token accepted, remote requests in flight end, device key removed, the full-control opt-in turned off (WP-31); also resets an unusable binding |

- The service's approval provider `tray` is registered with the broker while
  at least one connection is subscribed; the decisions stay in the broker and
  the PermissionEngine, checked against the request and the digest.
- A preset or full-control change switches the service to a new Core with
  the new profiles (AD-23 point 10), only while no operation is in flight,
  no approval is pending and no background process runs; otherwise it is
  refused with the reason and nothing changes. If the new Core cannot be
  built, the previous settings and the previous Core stay. The exposure
  state and the browser bridge are carried over; MCP connections stay
  connected.
- Turning full control on installs the new Core first and records the
  opt-in afterwards, together with the device id and account of the pairing
  (if that write fails it is in effect until the service stops and off after
  a restart, and the tray says so); turning it off records the narrower
  value first. At startup it is restored only when the settings are readable
  and the device is paired with a usable binding whose device id and account
  match; otherwise no full control applies (AD-23 points 6 and 11).
- Device state lives in the state directory as owner-only, protected files:
  `service-settings.json` (preset, remote mode, full-control opt-in with the
  device id and account it was given for) and `remote-clients.json`
  (identifiers, first/last seen, revocation time). Unreadable or malformed
  state fails closed. Every change is audited as a `control` record; changes
  that widen access are refused when the audit record cannot be written.
- `crot-mcp service status` and `crot_status` show `controls` (preset and
  source, remote mode, full-control opt-in as recorded and
  `remoteFullControlEffective` — whether the running Core applies it —,
  number of approval UIs); `crot_status` also shows `remote`, the effective
  remote profile (mode, capabilities, preset, full control and the
  restrictions).
- Until L1 (WP-23) any process of the user can read the control credential
  and use these requests, or write the state files directly (AD-19 residual
  risk D); see TRAY.md, Security.

## Concurrency

- Each shim connection is one MCP connection with its own MCP server and its
  own exposure scope (AD-12, AD-15 point 8): untrusted content read by one
  client never marks another client's session as exposed.
- Sessionless HTTP requests (2026-07-28) are limited to
  `http.maxConcurrentRequests` (default 32) in flight; more are refused with
  HTTP 503, JSON-RPC `-32000` "Too many concurrent requests" and
  `Retry-After: 1`, before any MCP or Core work (not audited). Legacy sessions
  stay limited by `http.maxSessions`.
- Background processes belong to the service: every connected client sees and
  can stop them (as the processes of one user), and they keep running when the
  client that started them disconnects, until the service stops.

## Limitations

- The shim forwards the client's stdio as is; the service decides everything.
  A shim never reconnects, so a service restart ends the client's MCP
  connection.
- All stdio clients of a user share one configuration (see above); per-client
  workspaces need separate OS users for now.
- The service has one process environment: that of its supervisor (managed)
  or of the shim that started it (on demand). Commands of every client run
  with it, including variables set in one MCP client's configuration (`env`).
  The CROT configuration itself never depends on it: the configuration file,
  `CROT_CONFIG`, the flags and every path are resolved before the
  configuration digest is taken, and a different state directory
  (`XDG_STATE_HOME`, `LOCALAPPDATA`) is a different service. A client whose
  `PATH`, shell (`SHELL`, `ComSpec`, `PATHEXT`) or home directory differs from
  the service's gets a note on stderr when it connects (only digests of the
  values are compared). For identical environments in every client, run the
  service managed. Commands do not get this environment as a whole: they get
  an allowlist of it plus `environment.allow` (WP-21; see the README, Security
  properties), so API keys of one client's configuration are not passed to
  commands unless allowed.
- The working directory is not inherited in effect: the service resolves the
  configuration first and then changes to the home directory; tools always
  run in an explicit directory.
- Sleep detection is a heuristic (clock-jump based); approval deadlines are not
  extended across sleep.
- Windows service/control pipes keep Node's default security descriptor,
  plus credential authentication; the real AppContainer denial is tested.
  This does not describe the AD-30 Docker LOCAL endpoint, which has an explicit
  owner+lease-SID DACL. Qualified Windows L1 also adds native Medium/NWNR state
  protection and startup/shutdown WAL recovery; see [L1](L1.md).
