# CROT Native Host

The Native Host is the OS-specific implementation layer below CROT Core. It is
**not a second Core**: it implements Core's platform interfaces
(`ProcessLauncher`, `PrivateFileProtection`) with stronger OS mechanisms and
hands the resulting `Platform` to `CrotCore`. See ARCHITECTURE.md (unchanged).

## Boundary

```
adapter (stdio MCP / Streamable HTTP MCP / future native messaging)
  -> CrotCore (PermissionEngine, ExecutionGuard, audit, validation)
    -> Platform interfaces   <- NativeHost.platform
```

- The PermissionEngine stays the single authorization authority. The Native
  Host performs no authorization and has no request API; it is only reached
  through platform methods that Core calls after authorization.
- No second process policy: commands, cwd, environment, timeouts and limits
  are decided by the Core ProcessService. The Native Host only replaces how a
  process tree is contained and terminated.
- A future browser-extension / native-messaging adapter must go through
  CrotCore like every other adapter. It is not part of this milestone.
- No network traffic, no telemetry. Logs never contain token values.

## Lifecycle

`NativeHost.start()` -> `CrotCore.create(config, { platform: native.platform })`
-> serve -> shutdown: transport -> `core.shutdown()` -> `native.close()` -> flush.
Emergency exit: `core.terminateProcessesSync()` then `native.closeSync()`.
The CLI lifecycle (`installLifecycle`) is the only shutdown authority. After
close, the launcher rejects new processes; `close`/`closeSync` are idempotent.

## Mechanisms

| | Windows (Native Host) | Linux / macOS |
|---|---|---|
| Process trees | kill-on-close Job Object per command (koffi FFI, kernel32) | Core process groups (unchanged) |
| Orphaned descendants | terminated (job membership is inherited, no breakaway) | terminated via process group |
| Private files | explicit owner-only ACL (inheritance removed, verified) | Core 0600 / 0700 (unchanged) |

If koffi or the ACL tools are unavailable, the Native Host falls back to the
Core mechanism and reports a note at startup (`native host: ...`).

## Windows owner-only ACLs

- The CROT user's SID is read once at startup with `whoami.exe /user` and
  validated.
- Restriction and inspection run one fixed, module-free Windows PowerShell 5.1
  script that uses only .NET security classes (`FileSecurity`,
  `DirectorySecurity`). It is passed with `-EncodedCommand`; the target path,
  mode and SID are passed through environment variables, never interpolated
  into the script. `PSModulePath` is removed from its environment.
- Restrict: the DACL is replaced by a protected DACL (inheritance removed)
  whose only rule is full control for the CROT user; for directories the rule
  is inherited by files and subdirectories created inside. The ACL is then
  read back and must be protected and owner-only, otherwise the operation
  fails.
- Tools are run by absolute path from `%SystemRoot%\System32`, without a
  shell, with bounded output and a timeout. All paths are strictly validated
  (absolute drive or UNC paths only, no control or reserved characters).
- No file mode is reported on Windows: chmod/0600 is not equivalent and is not
  pretended.

## Limitations

- Assignment race: Node.js cannot spawn a process suspended, so a command is
  assigned to its job right after spawn. A grandchild started in that window,
  or a command that exits before assignment, is not contained; it falls back
  to Core taskkill tree termination and is counted as `uncontainedLaunches`.
- No graceful Ctrl-Break: graceful termination requests escalate to forced
  termination (`gracefulTermination: false`).
- Node.js (libuv) on Windows places every non-detached child process in its
  own kill-on-close job held by the parent, so such a child already dies with
  its Node.js parent, independently of CROT. Children started with
  `detached: true` survive their parent but remain in CROT's Job Object and
  are terminated with the tree.
- Administrators and the file owner can still change ACLs; protection is
  against other non-admin local users.
- Depends on `whoami.exe` and Windows PowerShell 5.1 in
  `%SystemRoot%\System32`.
- Only directories CROT creates are restricted; an existing parent directory
  is left as it is (files inside are restricted individually).
- The audit-log status shown at startup is inspected before the first event
  restricts a pre-existing file.
- Linux `PR_SET_PDEATHSIG` is not used: if CROT is killed with SIGKILL,
  process groups are not cleaned up by the kernel.
- 32-bit Windows is unsupported (Core fallback).
