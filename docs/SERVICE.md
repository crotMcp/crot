# CROT service, stdio shim and control channel

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
(later: tray app and its approval provider, WP-22)
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
| credentials | `<state>/service-token`, `<state>/control-token` | same files, owner-only ACL |

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
  child processes. The credential files and `service.log` are protected paths
  (no CROT tool can modify them). As with the HTTP and bridge tokens, an agent
  in `full_control` mode could read them; WP-21 moves them into OS secret
  storage.

## Control channel

The control channel is for the user's own tools: `crot-mcp service
status|stop` today, the tray app and its approval provider later (WP-22). It
carries **no MCP and no tools**; anything other than a known control request
closes the connection. Requests: `ping`, `status`, `shutdown`. It makes no
permission decision and cannot reach Core's tools. It is not an authorization
mechanism: its credential only shows that the peer runs as the same OS user
(who can stop the service anyway); it creates no principal, grant or scope and
changes no mode or rule. When the tray arrives (WP-22) it carries approval
prompts and answers between the approval broker and the tray's
`ApprovalProvider`; the decisions stay in the PermissionEngine and the broker.

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
  service managed. The child-process environment allowlist is WP-21.
- The working directory is not inherited in effect: the service resolves the
  configuration first and then changes to the home directory; tools always
  run in an explicit directory.
- Sleep detection is a heuristic (clock-jump based); approval deadlines are not
  extended across sleep.
- Windows named pipes keep Node's default security descriptor (no explicit
  DACL); access by other users is prevented by that descriptor and by the
  authentication.
