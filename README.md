# CROT

CROT is a universal local AI-agent bridge: an installable local bridge that gives
AI agents controlled or full access to the user's computer and browser through a
standard MCP interface.

**`ARCHITECTURE.md` is the source of truth for the product architecture.** This
README describes the current implementation and how to run it.

## Status

Implemented (ARCHITECTURE.md §16, steps 1–6, the first part of step 7,
steps 10–11 and step 21 — Git read and write):

- CROT Core: configuration, workspace, central permission engine, execution guard
- Filesystem capability
- Shell/process capability (foreground commands and managed background processes)
- Git read capability (`git.read`: status, diff, log, branch, show; see
  [Git (read-only)](#git-read-only))
- Git write capability (`git.write`: add, commit, branch create/rename/delete,
  checkout of a branch or a detached commit; see [Git (write)](#git-write))
- Audit logging
- Platform layer: Linux, macOS and Windows behaviour behind Core interfaces
- CROT MCP: thin adapter over Core, stdio transport
- CROT MCP over Streamable HTTP: **loopback only**, bearer-token authentication
  behind a replaceable verifier (see [HTTP transport](#http-transport))
- Native Host: native OS platform layer behind the same Core interfaces (see
  [`docs/NATIVE_HOST.md`](docs/NATIVE_HOST.md))
- CROT Browser Extension for Chromium browsers (Chrome, Edge, Brave): browser
  tools gated by `browser.read` / `browser.control` (see
  [`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md))

Not yet implemented: Docker operations, Git network operations (fetch, pull, push), remote (non-loopback)
exposure and MCP authorization (OAuth/OIDC), installer, account/licensing layer.
Firefox is not supported.

## Requirements

- Node.js 20 or newer
- Linux, macOS or Windows (all three are covered by CI)
- Git 2.32 or newer on `PATH` for the `git_*` tools

## Quick start

```sh
npm install
npm run build

# Sandbox mode (default): the agent works only inside the workspace.
node dist/bin/crot-mcp.js --workspace /path/to/project

# Full control: the agent gets the OS-level capabilities of the CROT process.
node dist/bin/crot-mcp.js --workspace /path/to/project --mode full-control

# Streamable HTTP on loopback (bearer token required).
node dist/bin/crot-mcp.js --workspace /path/to/project --http

# Register the browser native-messaging host (grants no permissions).
node dist/bin/crot-mcp.js browser install
```

Register it in any MCP client that supports stdio servers, for example:

```json
{
  "mcpServers": {
    "crot": {
      "command": "node",
      "args": ["/path/to/crot-mcp/dist/bin/crot-mcp.js", "--config", "/path/to/crot.config.json"]
    }
  }
}
```

Clients that speak Streamable HTTP can connect to the loopback endpoint (see
[HTTP transport](#http-transport)). Clients that only reach servers on the
internet need remote exposure, which is not part of this version.

**Browser.** To let the agent use Chrome, Edge or Brave, register the host with
`crot-mcp browser install`, set `"browser": { "enabled": true }`, grant
`browser.read` and/or `browser.control`, and load the extension; see
[`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md).

### Command-line options

| Option | Description |
| --- | --- |
| `-c, --config <file>` | JSON configuration file (or `CROT_CONFIG`; default: `<config>/config.json` if it exists) |
| `-w, --workspace <dir>` | Workspace root (overrides the config file) |
| `-m, --mode <mode>` | `sandbox` or `full-control` (overrides the config file) |
| `--audit-log <file>` | Append audit events to a JSON-lines file |
| `--no-audit` | Disable audit logging |
| `--http` | Serve MCP over Streamable HTTP instead of stdio |
| `--http-host <host>` | HTTP bind address; loopback only (default `127.0.0.1`) |
| `--http-port <port>` | HTTP port (default `7337`; `0` picks a free port) |

Command: `crot-mcp browser install` registers the browser native-messaging host
for the current user (see [`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md)).
It grants no permissions.

### Configuration

See [`examples/crot.config.example.json`](examples/crot.config.example.json).
Relative paths in a config file are resolved against the file's directory, `~`
is expanded, and a UTF-8 byte-order mark is accepted. On Windows, paths in JSON
can use forward slashes (`"C:/Users/me/project"`) or escaped backslashes. CROT
has no built-in project paths; the workspace is always chosen by the user.
Prefer absolute paths on the command line: MCP clients may start CROT in any
directory (CROT warns when a relative path is resolved).

| Key | Default | Meaning |
| --- | --- | --- |
| `workspace.root` | required | Workspace directory |
| `workspace.name` | directory name | Display name |
| `permissions.mode` | `sandbox` | `sandbox` or `full_control` |
| `permissions.capabilities` | mode defaults | Explicit capability set |
| `limits.maxReadBytes` | 10 MiB | Maximum bytes per file read |
| `limits.defaultCommandTimeoutMs` | 120 000 | Foreground command timeout (also Git commands) |
| `limits.maxCommandTimeoutMs` | 3 600 000 | Maximum timeout a caller may request |
| `limits.maxOutputBytes` | 1 MiB | Output kept per stream (most recent bytes); Git output beyond it is reported as `truncated` |
| `limits.maxBackgroundProcesses` | 16 | Concurrently running background processes |
| `audit.sink` | `stderr` | `file`, `stderr` or `none` |
| `audit.path` | `<logs>/audit.jsonl` | Audit file for the `file` sink (see [Default locations](#default-locations)) |
| `environment.path` | `auto` | `PATH` for commands: `auto`, `login-shell` or `inherited` (see [Startup PATH](#startup-path)) |
| `http.enabled` | `false` | Serve over Streamable HTTP instead of stdio |
| `http.host` | `127.0.0.1` | Bind address; only loopback (`127.0.0.0/8`, `::1`, `localhost`) is accepted |
| `http.port` | `7337` | TCP port (`0`: any free port) |
| `http.auth.mode` | `local-token` | Authentication method (the only one in this version) |
| `http.auth.tokenFile` | `<state>/http-token` | Bearer token file, created on first start |
| `http.allowedOrigins` | `[]` | Browser origins allowed; requests with any other `Origin` are rejected |
| `http.maxRequestBytes` | 4 MiB | Maximum request body |
| `http.maxSessions` | 16 | Concurrent MCP sessions |
| `http.sessionIdleTimeoutMs` | 1 800 000 | Idle sessions are closed after this time |
| `browser.enabled` | `false` | Start the browser bridge for the CROT Browser Extension; grants nothing |

### Default locations

CROT uses the operating system's conventional per-user directories, but only
where no explicit path is given; explicit paths (`--config`, `CROT_CONFIG`,
`--audit-log`, `audit.path`) work exactly as before. The workspace is never
defaulted.

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| config | `$XDG_CONFIG_HOME/crot` (`~/.config/crot`) | `~/Library/Application Support/CROT` | `%APPDATA%\CROT` |
| state | `$XDG_STATE_HOME/crot` (`~/.local/state/crot`) | `~/Library/Application Support/CROT/State` | `%LOCALAPPDATA%\CROT` |
| logs | `<state>/logs` | `~/Library/Logs/CROT` | `%LOCALAPPDATA%\CROT\Logs` |

- If neither `--config` nor `CROT_CONFIG` is given and `<config>/config.json`
  exists, it is loaded (command-line flags still override it) and protected
  like any other configuration file.
- `"audit": { "sink": "file" }` without a `path` writes to `<logs>/audit.jsonl`.
- The HTTP token file defaults to `<state>/http-token`.
- The directories are reported in `crot_status` (`platform.directories`).

## HTTP transport

`--http` (or `http.enabled: true`) serves the same CROT MCP server over the MCP
Streamable HTTP transport of the official SDK (`StreamableHTTPServerTransport`)
at `http://127.0.0.1:7337/mcp`. HTTP is only another adapter: every session gets
its own MCP server instance created by the same `createCrotMcpServer`, bound to
the same `CrotCore`, so tools, Core services, the PermissionEngine and audit are
identical to stdio. There is no HTTP-specific filesystem, process or permission
logic.

**Authentication.** Every request needs `Authorization: Bearer <token>`, also on
loopback. With `local-token`, CROT creates a random 256-bit token in the token
file on first start (`0600` in a `0700` directory on POSIX; an owner-only ACL
set by the Native Host on Windows) and logs only its location and a
fingerprint, never the token. Local clients read the token from that file.
Tokens are compared in constant time.
The token file is added to Core's protected paths, so CROT tools cannot modify
it.

Authentication happens behind a replaceable `AccessTokenVerifier`
(`src/adapters/http/auth.ts`), shape-compatible with the SDK's OAuth token
verifier. It only establishes the principal; authorization stays with the
PermissionEngine. A future OAuth/OIDC resource-server verifier (user/device
identity, accounts) replaces the provisional token without changes to the HTTP
server, the MCP tools, Core or the PermissionEngine.

**Principal.** HTTP requests run as
`{ id: "local-token:<fingerprint>", kind: "remote", transport: "http", authMethod: "local-token", client }`,
recorded in every audit event; stdio requests remain
`{ id: "local-user", kind: "local", transport: "stdio" }`. Credentials never
reach Core or the audit log.

**Request pipeline.** Checked in order, before anything reaches the MCP server
or Core:

| Check | Rejection |
| --- | --- |
| `Host` is a loopback name on the bound port (DNS rebinding) | 403 |
| path is `/mcp` | 404 |
| `Origin`, if present, is in `http.allowedOrigins` (empty by default) | 403 |
| method is `POST`, `GET` or `DELETE` | 405 |
| valid bearer credential | 401 with `WWW-Authenticate: Bearer` |
| body ≤ `http.maxRequestBytes` | 413 |
| body is JSON | 400 (`-32700`) |
| session: a new one only via `initialize`; existing ones only for the principal that opened them | 400 / 404 |
| session count ≤ `http.maxSessions` | 503 |

Rejections are JSON-RPC error objects without internal details or stack traces;
unexpected failures return a generic `500 Internal error`. Core errors (for
example `PERMISSION_DENIED`) are returned as MCP tool errors exactly as on
stdio.

**Lifecycle.** One shutdown path for both transports: on a shutdown signal the
HTTP server stops accepting connections, closes all sessions and open
connections, then `core.shutdown()` terminates processes, drains and flushes the
audit log. Idle sessions are closed after `http.sessionIdleTimeoutMs`.

**Limitations (honest status).**

- Loopback only. Binding any other address is refused; remote exposure needs
  TLS and a real authorization server, which are future milestones.
- The local token is a provisional, static, shared credential: no expiry,
  rotation or per-device identity. Anyone who can read the token file can act
  as the HTTP principal. Delete the file to rotate it (restart required).
- No TLS: traffic is plaintext on the loopback interface.
- In `full_control` mode an agent can read the token file (writes are blocked
  by the protected paths); in sandbox mode the token file is outside the
  workspace unless configured otherwise.
- HTTP-level rejections (401, 403, ...) are logged to stderr, not to the audit
  log, which records Core operations only.
- On Windows the token file is restricted to the CROT user with an owner-only
  ACL by the Native Host; administrators and the file owner can still change
  it (see [`docs/NATIVE_HOST.md`](docs/NATIVE_HOST.md)).

## Permission model

There is one permission model, enforced by one `PermissionEngine`. Every Core
operation passes through the `ExecutionGuard`: validate input → resolve paths →
authorize → execute → audit.

Rules:

1. The operation's capability must be granted.
2. Any path or working directory outside the workspace also requires
   `filesystem.full`, which cannot be granted in sandbox mode.

| Mode | Default capabilities | Scope |
| --- | --- | --- |
| `sandbox` | `filesystem.read`, `filesystem.write`, `shell.execute`, `process.manage`, `git.read`, `git.write` | Workspace only |
| `full_control` | all capabilities | Unrestricted |

The rules are the same for every transport and principal.

Enforced capabilities today: `filesystem.read`, `filesystem.write`,
`filesystem.full`, `shell.execute`, `process.manage`, `git.read`, `git.write`,
`browser.read`, `browser.control`. The others (`docker.use`,
`network.access`) are part of the model and reported by `crot_status`, and will
gate dedicated operations when those are added.

**Browser capabilities.** The sandbox defaults do not include `browser.*`;
`full_control` grants them. An explicit `capabilities` list replaces the mode
defaults, so to add browser access in sandbox mode list the sandbox defaults
plus `browser.read` (and `browser.control` if the agent may act in the
browser). The extension and its bridge never authorize anything themselves
(see [`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md)).

**Sandbox limits.** Sandbox confines CROT's own file operations and the
working directory of commands. It is not OS-level isolation: a command the agent
runs with `shell.execute` has the operating-system permissions of the CROT
process. To prevent command execution, leave `shell.execute` and
`process.manage` out of the capability set (for example, a read-only setup is
`"capabilities": ["filesystem.read", "git.read"]`; `git.read` never runs
repository-controlled programs, see below).

## Git (read-only)

`git_status`, `git_diff`, `git_log`, `git_branch` and `git_show` are Core
operations of the `GitService`, gated by `git.read` and run through the
ExecutionGuard like every other operation. The design is recorded in
ARCHITECTURE.md §27 (AD-1): a `git.read` operation stays a read and never runs
a program chosen by the repository or its configuration.

- **Repository discovery without Git.** Core finds the repository from `cwd`
  upwards (`.git` directory or `.git` file, `commondir` for linked worktrees).
  The worktree, Git directory and common directory are paths of the operation:
  in sandbox mode they must be inside the workspace (a workspace nested inside
  a repository whose `.git` is outside it is denied); `full_control` reads any
  repository. Bare repositories are not supported.
- **Git from `PATH` only.** Git is resolved without searching the working
  directory or relative `PATH` entries, so a `git.exe` / `git.bat` placed in a
  repository is never run (Windows searches the working directory first for
  ordinary commands). Git 2.32 or newer is required.
- **Configuration check.** System and global Git configuration is not loaded
  (only line-ending and display settings are carried over). Repository
  configuration may only contain keys from an allowlist of settings that cannot
  start programs; any other key (`core.fsmonitor`, `core.pager`,
  `diff.external`, `filter.*`, `alias.*`, `include.path`, …) fails the
  operation with `UNSAFE_REPOSITORY` before Git reads the repository. The error
  names the keys, never their values.
- **Hardened invocation.** Every command runs with explicit `--git-dir` /
  `--work-tree`, `--no-pager`, no external diff or textconv, `core.fsmonitor`
  off, no signature verification, no submodule recursion, no network protocols,
  no optional lock writes and without inherited `GIT_*` variables. Revisions
  cannot be options (a leading `-` is refused) and paths are literal pathspecs
  inside the worktree.
- **No race with CROT writes.** A `git.read` operation and a CROT filesystem
  write (write, create directory, delete, move) into the same Git directory
  never run at the same time. Writes into `.git` remain allowed under
  `filesystem.write`.
- **Results.** Structured status entries, commits and branches; diffs and
  `show` output as text with a `truncated` flag beyond `limits.maxOutputBytes`.
  Errors: `INVALID_INPUT` (bad arguments, paths outside the worktree),
  `PERMISSION_DENIED`, `UNSAFE_REPOSITORY`, `NOT_FOUND` (no repository, no Git),
  `OPERATION_FAILED` (Git failure, e.g. an unknown revision), `TIMEOUT`.

Limits: commands run through `shell.execute` / `process.manage` or other
programs are not serialized with `git.read`; Git itself and its built-in
behaviour are trusted like every other program on `PATH`.

## Git (write)

`git_add`, `git_commit`, `git_branch_create`, `git_branch_rename`,
`git_branch_delete` and `git_checkout` are Core operations of the same
`GitService`, gated by `git.write` (independent of `git.read`) and run through
the ExecutionGuard. The design is recorded in ARCHITECTURE.md §27 (AD-2):
`git.write` changes only the repository's index, refs, objects and worktree and
never runs a program supplied by the repository, its configuration or the
agent.

- **Same checks as `git.read`.** Repository discovery without Git, Git from
  `PATH` only, the repository-configuration allowlist (`UNSAFE_REPOSITORY`
  before anything is changed) and the sandbox/`full_control` path rules apply
  unchanged. CROT's protected paths (audit log, configuration) are also
  protected against `git.write`: a repository whose worktree or Git directory
  contains one is refused with `PERMISSION_DENIED`.
- **No hooks, editors, signing or maintenance.** Every write command runs with
  `core.hooksPath` pointing to the null device, `--no-verify` for commits,
  signing off (`--no-gpg-sign`, `commit.gpgSign=false`), editors set to `:`,
  automatic `gc` / maintenance off, plus the `git.read` hardening (no fsmonitor,
  no external diff/textconv, no submodule recursion, no network protocols).
- **Identity is data.** `user.name` and `user.email` from global/system
  configuration are passed with `-c` as plain values (repository values win);
  with `user.useConfigOnly` Git never guesses an identity. Nothing else from
  global/system configuration is loaded, except the line-ending settings
  (`core.autocrlf`, `core.eol`, `core.safecrlf`): together with repository
  settings and `.gitattributes` they apply to `git_add` and `git_checkout` as in
  your own Git (e.g. CRLF in the worktree with Git for Windows' default
  `core.autocrlf=true`).
- **Only non-destructive operations.**
  - `git_add`: literal paths inside the worktree, or `all: true` for the whole
    worktree; never `--force` (ignored files stay unstaged), never paths inside
    `.git`; a symlink is staged as a link, never as its target.
  - `git_commit`: a message (no editor, no template); `allowEmpty` optional. No
    amend, no fixup, no signing.
  - `git_branch_create` (optional start point, no tracking),
    `git_branch_rename` (refuses an existing target), `git_branch_delete`
    (`-d` only: Git refuses unmerged branches and the current branch).
  - `git_checkout`: `branch` (an existing local branch) or `detach` (an
    explicitly requested commit). Uses `git switch` without `--force`, so local
    changes are never overwritten and paths are never checked out.
  - Not available: push, fetch, pull, amend, force, `-D`, reset, checkout of
    paths, any network operation.
- **Serialized.** A `git.write` operation holds the repository's Git
  directories exclusively: it never runs at the same time as another
  `git.write`, a `git.read` or a CROT filesystem write into the same Git
  directory.
- **Results and audit.** Staged paths, the new commit id, branch and HEAD
  state. The audit record contains the branch names and paths, but for commits
  only the message length and SHA-256 digest, never the message.

Limits: as for `git.read`. Running `git_commit` while a merge is in progress
concludes that merge (Git's own behaviour).

## Platform support

OS-specific behaviour lives behind Core platform interfaces (`src/core/platform/`),
implemented with portable Node.js APIs by `createNodePlatform()`. On Windows the
CROT Native Host ([`docs/NATIVE_HOST.md`](docs/NATIVE_HOST.md)) replaces
`ProcessLauncher` and `PrivateFileProtection` with stronger implementations
(kill-on-close Job Objects, owner-only ACLs) without changes to Core or to the
permission model. Platform code performs no authorization.

| Interface | Responsibility | Linux / macOS | Windows |
| --- | --- | --- | --- |
| `PathRules` | path syntax validation and comparison | POSIX paths; case sensitivity probed per workspace (default macOS volumes are case-insensitive, with Unicode normalization) | drive letters and UNC paths, `/` or `\`, always case-insensitive; rejects device names (`CON`, `NUL`, `COM1`…), alternate data streams, `\\?\`/`\\.\` paths, drive-relative paths (`D:x`) and names ending in `.` or space |
| `ProcessLauncher` | command resolution, start, tree termination | PATH lookup; every child leads its own process group, so the whole tree is terminated, including descendants that outlive the command | PATH + PATHEXT lookup; `.cmd`/`.bat` files (`npm`, `npx`, …) run through `cmd.exe` with escaped arguments; tree termination with `taskkill /T` |
| `ShellProvider` | shell scripts | `sh` (default), `bash`, `zsh`, `pwsh` when installed | `cmd` (default), `powershell`, `pwsh`, `bash` when installed; PowerShell scripts are passed as `-EncodedCommand` |
| `EnvironmentPolicy` | child environment | case-sensitive names | case-insensitive names (`PATH` overrides `Path` instead of duplicating it) |
| `EncodingSupport` | decoding of command output | UTF-8 | UTF-8; output that is not valid UTF-8 is decoded with the console (OEM) code page, detected from the registry; `cmd` scripts run in a `cmd.exe` started after the console is switched to UTF-8 (`chcp 65001`), so built-ins such as `echo` and `dir` write UTF-8 (see [Output encoding](#output-encoding)); PowerShell writes UTF-8 |
| startup `PATH` | `PATH` for commands and shell detection | login shell `PATH` for desktop-launched clients, plus standard directories (see below) | inherited |
| `PlatformDirectories` | default config/state/log locations | XDG (Linux), `~/Library` (macOS) | `%APPDATA%`, `%LOCALAPPDATA%` |
| `PrivateFileProtection` | audit log, HTTP token file, browser bridge token file | created `0600` in `0700` directories; existing files checked | owner-only ACL set by the Native Host (inheritance removed, verified); Core fallback: inherited ACLs |
| `PlatformInfo` | reported in `crot_status` and the MCP instructions | OS, architecture, path style, shells, encodings, process-control guarantees, PATH source, directories | same |

`ProcessLauncher.resolveCommand` also has a PATH-only mode
(`searchCurrentDirectory: false`): the working directory and relative `PATH`
entries are not searched and relative command paths are refused. `git.read`
always uses it; `process_exec`, `shell_run` and `process_start` keep the
platform's usual lookup.

Environment overrides may set a variable to `null` to remove it. A foreground
command owns its process tree: descendants still running when it finishes or
times out are terminated; use `process_start` for long-running processes.

### Output encoding

Command output is captured as bytes (the `maxOutputBytes` limit applies to
bytes) and decoded when it is returned. Results report the encoding per
stream, e.g. `"encoding": { "stdout": { "name": "cp850", "lossy": false } }`;
`lossy: true` means bytes could not be decoded or the text contains U+FFFD
replacement characters, so corruption is never silent. Characters are never
split: a character cut by truncation is skipped, and an incomplete character
at the end of a background process's output is held back until it is complete.

`process_exec`, `shell_run` and `process_start` accept `encoding`: `auto`
(default), `utf-8`, `utf-16le`, `oem` / `ansi` (Windows code pages), `cpNNN`
or a WHATWG label such as `windows-1252` or `shift_jis`. Standard input is
always sent as UTF-8.

Windows `cmd` scripts: cmd.exe converts the output of its built-in commands
(`echo`, `dir`, `set`, `type`, …) to bytes itself. When output is redirected, a
`chcp 65001` run by the same cmd.exe switches the console code page for
programs started afterwards but not for that cmd.exe's own built-ins, which keep
writing the OEM code page (`€` and `日本` become `?`). CROT's `cmd` shell therefore
switches the console in an outer `cmd.exe` and runs the script in a second
`cmd.exe` started afterwards. The script is passed through an environment
variable, so the outer `cmd.exe` never parses it, and it is parsed exactly like
`cmd /d /s /c "<script>"`.

### Startup PATH

MCP clients started from a desktop launcher (macOS Dock/Finder, Linux
application menus) pass a minimal `PATH` (on macOS `/usr/bin:/bin:/usr/sbin:/sbin`),
so tools installed with Homebrew, nvm, pyenv, cargo and similar are missing.
With `environment.path: "auto"` (default), when CROT was not started from a
shell (`SHLVL` is unset) on macOS or Linux, it runs the user's login shell
(`$SHELL -l -i -c`, stdin closed, 5 s timeout) once at startup and uses its
`PATH`; only `PATH` is imported. Existing standard directories that are still
missing (`/opt/homebrew/bin` on macOS, `/usr/local/bin`, `/usr/bin`, ...) are
appended. `login-shell` always does this; `inherited` uses the `PATH` CROT was
started with, unchanged. Supported login shells: sh, bash, zsh, dash, ksh,
mksh, yash and fish; if the shell fails or times out, CROT keeps the inherited
`PATH` and logs why. The result is reported in `crot_status`
(`platform.startupPath`). Windows uses the inherited environment.

### Shutdown

The stdio server shuts down gracefully when the client closes stdin or stdout;
both the stdio and the HTTP server shut down on the platform's shutdown signals:
`SIGINT`, `SIGTERM` and `SIGHUP` (POSIX
terminal hang-up); on Windows also `SIGBREAK` (Ctrl+Break) and `SIGHUP` (console
window closed). Shutdown closes the transport (for HTTP: stops listening, closes
every session and connection), stops accepting commands, terminates every process tree
CROT started (background processes, running foreground commands and Git
commands; graceful
first on POSIX, forced immediately on Windows, where graceful termination of
console programs is not possible), waits for operations in flight to write
their audit records, and flushes the audit log and standard streams. It must
finish within 5 s; a second signal, an error during shutdown or the deadline
forces the exit. On every exit path, including fatal errors, a synchronous
exit hook force-kills any process tree that is still running.

### Known platform limitations

- Windows process trees: Core terminates trees with `taskkill /T`, which
  follows parent-child links. Descendants whose parent has already exited
  cannot be found, and if a client hard-kills CROT itself (`TerminateProcess`),
  the processes it started keep running. Graceful termination of console
  programs is not possible, so `process_stop` escalates to forced termination
  after a grace period. `crot_status` reports these guarantees in
  `platform.processControl` (`orphanedDescendants: false`,
  `gracefulTermination: false`).
- Arguments passed to `.cmd`/`.bat` files follow cmd.exe rules; a batch file
  that re-expands `%*` unsafely can still misinterpret special characters.
  `cmd` scripts run with the UTF-8 console code page; a batch file that relies
  on legacy-encoded non-ASCII text should be run with `process_exec`, which
  keeps the default console code page.
- Built-in output of batch files run with `process_exec` stays in the OEM code
  page, as does `cmd` script output when the `cmd.exe` path contains `!`, `%`,
  `^` or `"` (CROT then uses a single `cmd.exe`). It is decoded as OEM and
  reported as such.
- One encoding per stream: `auto` decodes each stream as a whole. A `cmd`
  script whose built-ins write UTF-8 but which also runs a program that writes
  the OEM or ANSI code page produces output that is not valid UTF-8; it is
  decoded with the OEM code page and reported as such (never as UTF-8), so the
  UTF-8 parts are misdecoded. Choose `encoding` explicitly (`utf-8` flags the
  foreign bytes with `lossy: true`) or make the program write UTF-8.
- `auto` decoding falls back to the OEM code page on Windows. Programs that
  write the ANSI code page instead (for example some Python versions when
  output is redirected) need `encoding: "ansi"`; non-UTF-8 output that happens
  to be valid UTF-8 is decoded as UTF-8.
- Windows private files (audit log, token files) are restricted with owner-only
  ACLs by the Native Host; administrators and the file owner can still change
  them, and if the ACL tools are unavailable the Native Host falls back to the
  Core mechanism and reports it at startup. Owner-only modes (`0600`/`0700`)
  are applied on POSIX only.
- The startup `PATH` heuristic relies on `SHLVL`; set `environment.path` to
  `login-shell` or `inherited` to choose explicitly. Windows `PATH` changes made
  after the client started (for example by an installer) are not picked up.

### Not yet implemented

The Native Host already provides Windows kill-on-close Job Objects and
owner-only ACLs (see [`docs/NATIVE_HOST.md`](docs/NATIVE_HOST.md), including
its limitations). Not yet implemented:

- Graceful termination of Windows console programs (`GenerateConsoleCtrlEvent`);
  graceful termination requests escalate to forced termination.
- OS-level sandboxing of commands (Core's sandbox confines paths and working
  directories, not what a command does).
- Credential provisioning for the HTTP transport (device identity/registration
  verifier, token rotation) and running CROT as a supervised service.

## Security properties

- Validated inputs: strict zod schemas owned by Core; unknown fields are rejected.
- Path traversal protection: paths are validated against platform rules and
  canonicalized (realpath of the longest existing prefix), so `..`, symlinks and
  junctions cannot leave the workspace unnoticed; comparisons honour the
  filesystem's case sensitivity;
  recursive listing never follows symlinks; entry operations (stat, delete, move)
  act on links, not their targets; the workspace root cannot be deleted or moved;
  FIFOs, sockets and devices are never opened as files.
- Protected paths: the audit log, the configuration file in use, the HTTP
  token file and (when `browser.enabled`) the browser bridge token file cannot be
  modified, deleted or moved through CROT tools in any mode (enforced by the
  PermissionEngine; listed in `crot_status`). A command run with `shell.execute`
  is not restricted by this rule. Protection from other local users is
  separate: on POSIX the audit log is created with mode `0600` (and an existing
  file readable by others is reported as a warning); on Windows the Native Host
  restricts it with an owner-only ACL and `crot_status` reports the inspected
  result (`audit.protection`).
- Controlled subprocesses: argv execution without a shell by default; shell
  scripts are a separate, explicit tool; mandatory timeouts for foreground
  commands; process-tree termination; bounded output capture.
- Read-only Git: `git.read` never runs programs chosen by repository contents
  or repository configuration (ARCHITECTURE.md §27, AD-1).
- Git writes without repository programs: `git.write` never runs hooks,
  editors, signing programs or any other repository-supplied program, and has
  no network operations (ARCHITECTURE.md §27, AD-2).
- Auditability: every authorized, failed and denied operation is recorded with
  principal (including transport and authentication method), capabilities,
  paths, outcome and duration. Audit events never
  contain file contents, command output, stdin, environment values or credentials.
  Browser operations record only URL origins, tab ids, truncated selectors and
  typed text length — never page content, screenshots, typed text or full URLs.
- No telemetry and no network communication: CROT itself makes no outbound
  connections. The stdio server communicates only with the client that launched
  it; the HTTP server listens on loopback only and requires authentication.
  The browser bridge uses local IPC only (Unix socket or named pipe,
  token-authenticated); browser tools do make the browser load the pages the
  agent asks for.

## MCP tools

| Tool | Capability |
| --- | --- |
| `crot_status` | — |
| `fs_read_file`, `fs_list_directory`, `fs_stat` | `filesystem.read` |
| `fs_write_file`, `fs_create_directory`, `fs_delete`, `fs_move` | `filesystem.write` |
| `process_exec`, `shell_run` (optional `shell`) | `shell.execute` |
| `process_start` | `process.manage` + `shell.execute` |
| `process_list`, `process_read_output`, `process_stop`, `process_remove` | `process.manage` |
| `git_status`, `git_diff`, `git_log`, `git_branch`, `git_show` | `git.read` |
| `git_add`, `git_commit`, `git_branch_create`, `git_branch_rename`, `git_branch_delete`, `git_checkout` | `git.write` |
| `browser_status`, `browser_tabs_list`, `browser_page_read`, `browser_screenshot` | `browser.read` |
| `browser_tab_open`, `browser_navigate`, `browser_tab_activate`, `browser_tab_close`, `browser_click`, `browser_type` | `browser.control` |

Paths outside the workspace additionally require `filesystem.full` (for Git:
the repository's worktree and Git directories). The tool
set is identical on stdio and HTTP. Browser tools need a connected extension
(see [`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md)).

## Code layout

```text
src/
  core/                    CROT Core (no dependency on any adapter or client)
    auth/                  Principal / AuthContext
    permissions/           capabilities, policies, PermissionEngine
    workspace/             workspace boundary and path resolution
    config/                configuration schema and loading
    execution/             ExecutionGuard (authorize → execute → audit)
    platform/              PathRules, ProcessLauncher, ShellProvider, EnvironmentPolicy, EncodingSupport,
                           startup PATH, PlatformDirectories, PrivateFileProtection, PlatformInfo
    audit/                 audit events and sinks
    capabilities/
      filesystem/          FileSystemService + input schemas
      process/             ProcessService + input schemas
      git/                 GitService (git.read, git.write), repository discovery, configuration policy,
                           output parsers, Git metadata lock, input schemas
      browser/             BrowserService, input/result schemas, BrowserConnection
    crot-core.ts           composition root
  adapters/mcp/            CROT MCP: tool catalogue, server, request → AuthContext
  adapters/http/           Streamable HTTP transport: request pipeline, sessions,
                           AccessTokenVerifier seam, local token, AuthInfo → Principal
  browser-bridge/          browser bridge: protocol, endpoint, server, relay
  native-host/             Native Host platform layer (see docs/NATIVE_HOST.md)
  cli/                     command-line option parsing, host shutdown lifecycle,
                           browser*.ts (`crot-mcp browser install`)
  bin/crot-mcp.ts          entry point (stdio or --http)
  bin/crot-browser-relay.ts  native-messaging relay started by the browser
extension/                 CROT Browser Extension (MV3 sources and tests)
tests/                     vitest suites (core, capabilities, MCP and HTTP adapters, CLI, stdio e2e,
                           browser-bridge)
```

Dependency direction: `bin` → `adapters` → `core`. Core never imports the MCP
SDK. The HTTP adapter supplies its own `ContextResolver` that derives the
principal from the request's verified `authInfo`; tools and Core are unchanged.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test           # also builds the sources into a temporary directory for the stdio end-to-end test
npm run lint       # ESLint
npm run format     # Prettier (npm run format:check only checks)
npm run check      # the local gate: lint, format:check, typecheck, typecheck:extension,
                   # build, build:extension, test, test:extension

npm run typecheck:extension
npm run build:extension   # compiles the extension into extension/dist
npm run test:extension

npm run test:e2e:browser  # real Chromium E2E; separate from npm test and npm run check (docs/BROWSER_E2E.md)
```

CI runs `lint`, `format:check`, `typecheck`, `typecheck:extension`, `build`,
`build:extension`, `test` and `test:extension` on Ubuntu, macOS and Windows with
Node 20 and 22.
Windows-specific behaviour (cmd quoting, PATHEXT lookup, PATH-only lookup, path
rules, environment casing) is also unit-tested as pure functions on every OS.
The Git tests create repositories with the `git` on `PATH` and need Git 2.32 or
newer.
