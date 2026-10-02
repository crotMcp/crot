# CROT

CROT is a universal local AI-agent bridge: an installable local bridge that gives
AI agents controlled or full access to the user's computer and browser through a
standard MCP interface.

**`ARCHITECTURE.md` is the source of truth for the product architecture.** This
README describes the current implementation and how to run it.

## Status

Implemented (ARCHITECTURE.md §16, steps 1–6):

- CROT Core: configuration, workspace, central permission engine, execution guard
- Filesystem capability
- Shell/process capability (foreground commands and managed background processes)
- Audit logging
- Platform layer: Linux, macOS and Windows behaviour behind Core interfaces
- CROT MCP: thin adapter over Core, stdio transport

Not yet implemented: remote (HTTP) MCP transport and MCP authorization, Native
Host, Browser Extension, installer, account/licensing layer.

## Requirements

- Node.js 20 or newer
- Linux, macOS or Windows (all three are covered by CI)

## Quick start

```sh
npm install
npm run build

# Sandbox mode (default): the agent works only inside the workspace.
node dist/bin/crot-mcp.js --workspace /path/to/project

# Full control: the agent gets the OS-level capabilities of the CROT process.
node dist/bin/crot-mcp.js --workspace /path/to/project --mode full-control
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

Clients that only connect to remote MCP servers need the remote transport, which
is a later milestone (ARCHITECTURE.md §16, step 7).

### Command-line options

| Option | Description |
| --- | --- |
| `-c, --config <file>` | JSON configuration file (or `CROT_CONFIG`) |
| `-w, --workspace <dir>` | Workspace root (overrides the config file) |
| `-m, --mode <mode>` | `sandbox` or `full-control` (overrides the config file) |
| `--audit-log <file>` | Append audit events to a JSON-lines file |
| `--no-audit` | Disable audit logging |

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
| `limits.defaultCommandTimeoutMs` | 120 000 | Foreground command timeout |
| `limits.maxCommandTimeoutMs` | 3 600 000 | Maximum timeout a caller may request |
| `limits.maxOutputBytes` | 1 MiB | Output kept per stream (most recent bytes) |
| `limits.maxBackgroundProcesses` | 16 | Concurrently running background processes |
| `audit.sink` | `stderr` | `file`, `stderr` or `none` |
| `audit.path` | — | Audit file (required for `file`) |

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

Enforced capabilities today: `filesystem.read`, `filesystem.write`,
`filesystem.full`, `shell.execute`, `process.manage`. The others (`git.*`,
`docker.use`, `browser.*`, `network.access`) are part of the model and reported
by `crot_status`, and will gate dedicated operations when those are added.

**Sandbox limits.** Sandbox confines CROT's own file operations and the
working directory of commands. It is not OS-level isolation: a command the agent
runs with `shell.execute` has the operating-system permissions of the CROT
process. To prevent command execution, leave `shell.execute` and
`process.manage` out of the capability set (for example, a read-only setup is
`"capabilities": ["filesystem.read"]`).

## Platform support

OS-specific behaviour lives behind Core platform interfaces (`src/core/platform/`),
implemented with portable Node.js APIs by `createNodePlatform()`. The future CROT
Native Host can provide stronger implementations of the same interfaces (for
example Windows Job Objects) without changes to Core or to the permission model.
Platform code performs no authorization.

| Interface | Responsibility | Linux / macOS | Windows |
| --- | --- | --- | --- |
| `PathRules` | path syntax validation and comparison | POSIX paths; case sensitivity probed per workspace (default macOS volumes are case-insensitive, with Unicode normalization) | drive letters and UNC paths, `/` or `\`, always case-insensitive; rejects device names (`CON`, `NUL`, `COM1`…), alternate data streams, `\\?\`/`\\.\` paths, drive-relative paths (`D:x`) and names ending in `.` or space |
| `ProcessLauncher` | command resolution, start, tree termination | PATH lookup; every child leads its own process group, so the whole tree is terminated, including descendants that outlive the command | PATH + PATHEXT lookup; `.cmd`/`.bat` files (`npm`, `npx`, …) run through `cmd.exe` with escaped arguments; tree termination with `taskkill /T` |
| `ShellProvider` | shell scripts | `sh` (default), `bash`, `zsh`, `pwsh` when installed | `cmd` (default), `powershell`, `pwsh`, `bash` when installed; PowerShell scripts are passed as `-EncodedCommand` |
| `EnvironmentPolicy` | child environment | case-sensitive names | case-insensitive names (`PATH` overrides `Path` instead of duplicating it) |
| `PlatformInfo` | reported in `crot_status` and the MCP instructions | OS, architecture, path style, default and available shells | same |

Environment overrides may set a variable to `null` to remove it. A foreground
command owns its process tree: descendants still running when it finishes or
times out are terminated; use `process_start` for long-running processes.

### Known platform limitations

- Windows: without Job Objects, descendants whose parent has already exited
  cannot be terminated; graceful termination of console programs is not
  possible (`taskkill` without `/F` is ignored), so CROT escalates to forced
  termination after a grace period. Arguments passed to `.cmd`/`.bat` files
  follow cmd.exe rules; a batch file that re-expands `%*` unsafely can still
  misinterpret special characters.
- Command output is decoded as UTF-8. Windows console programs using a legacy
  code page may produce garbled non-ASCII output.
- MCP clients started from a desktop launcher (macOS Dock, Linux desktop) may
  pass a minimal `PATH`; set `PATH` explicitly via the client configuration or
  per command.

## Security properties

- Validated inputs: strict zod schemas owned by Core; unknown fields are rejected.
- Path traversal protection: paths are validated against platform rules and
  canonicalized (realpath of the longest existing prefix), so `..`, symlinks and
  junctions cannot leave the workspace unnoticed; comparisons honour the
  filesystem's case sensitivity;
  recursive listing never follows symlinks; entry operations (stat, delete, move)
  act on links, not their targets; the workspace root cannot be deleted or moved;
  FIFOs, sockets and devices are never opened as files.
- Protected paths: the audit log and the configuration file in use cannot be
  modified, deleted or moved through CROT tools in any mode (enforced by the
  PermissionEngine; listed in `crot_status`). A command run with `shell.execute`
  is not restricted by this rule.
- Controlled subprocesses: argv execution without a shell by default; shell
  scripts are a separate, explicit tool; mandatory timeouts for foreground
  commands; process-tree termination; bounded output capture.
- Auditability: every authorized, failed and denied operation is recorded with
  principal, capabilities, paths, outcome and duration. Audit events never
  contain file contents, command output, stdin or environment values.
- No telemetry and no network communication: CROT itself makes no outbound
  connections. The stdio server communicates only with the client that launched it.

## MCP tools

| Tool | Capability |
| --- | --- |
| `crot_status` | — |
| `fs_read_file`, `fs_list_directory`, `fs_stat` | `filesystem.read` |
| `fs_write_file`, `fs_create_directory`, `fs_delete`, `fs_move` | `filesystem.write` |
| `process_exec`, `shell_run` (optional `shell`) | `shell.execute` |
| `process_start` | `process.manage` + `shell.execute` |
| `process_list`, `process_read_output`, `process_stop`, `process_remove` | `process.manage` |

Paths outside the workspace additionally require `filesystem.full`.

## Code layout

```text
src/
  core/                    CROT Core (no dependency on any adapter or client)
    auth/                  Principal / AuthContext
    permissions/           capabilities, policies, PermissionEngine
    workspace/             workspace boundary and path resolution
    config/                configuration schema and loading
    execution/             ExecutionGuard (authorize → execute → audit)
    platform/              PathRules, ProcessLauncher, ShellProvider, EnvironmentPolicy, PlatformInfo
    audit/                 audit events and sinks
    capabilities/
      filesystem/          FileSystemService + input schemas
      process/             ProcessService + input schemas
    crot-core.ts           composition root
  adapters/mcp/            CROT MCP: tool catalogue, server, request → AuthContext
  cli/                     command-line option parsing
  bin/crot-mcp.ts          stdio entry point
tests/                     vitest suites (core, capabilities, MCP adapter, CLI, stdio e2e)
```

Dependency direction: `bin` → `adapters` → `core`. Core never imports the MCP
SDK. A future transport (remote HTTP with MCP authorization) supplies its own
`ContextResolver` that derives the principal from the request's `authInfo`; tools
and Core remain unchanged.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test           # also builds the sources into a temporary directory for the stdio end-to-end test
npm run check      # typecheck + test + build
```

CI runs on Ubuntu, macOS and Windows with Node 20 and 22. Windows-specific
behaviour (cmd quoting, PATHEXT lookup, path rules, environment casing) is also
unit-tested as pure functions on every OS.
