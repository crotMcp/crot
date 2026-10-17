# CROT Native Host

The Native Host is the OS-specific implementation layer below CROT Core. It is
**not a second Core**: it implements Core's platform interfaces
(`ProcessLauncher`, `PrivateFileProtection`, `CommandConfinement`) with stronger OS mechanisms and
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

## Windows L1 / AD-30 (действующий backend)

Срез проверки реализации: `main` `e23b7b9c29c5e3e1758b9ad2703bbd827648426f` (merge PR #27). PR #27 слит, не Draft;
WP-23c **Done**, AD-30 действует, OD-6 и Windows-часть OD-9 закрыты.
Дерево merge совпадает с квалифицированным `f916a6b`; `8fe6ba5` — более
ранний квалификационный источник, не текущий HEAD. На самом `e23b7b9`
подтверждены все 11 заданий: [основной CI 6/6](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180293), [Linux L1 4/4](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180333), [Chromium 1/1](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180363).
Это фиксированная база кода для документационной сверки, не SHA будущего docs PR.

Сервис подключает WindowsLeaseServiceLifecycle и WindowsConfinement из
src/native-host/windows-l1/. Компоненты проверяются до настоящего self_test;
AppContainer создаётся suspended, получает Job и проверенный токен до ResumeThread.
Этот путь не имеет окна post-spawn назначения Job, описанного ниже для старого
неизолированного launcher. Полный recovery — actors/новые ACE/исходные NTFS ID/
loopback/profile — подключён к жизненному циклу сервиса.
Секреты/WAL: owner-only Medium/NWNR; executable components: Medium/NW;
только bounded disposable runtime — Low/NW. Docker LOCAL имеет собственный DACL.

available=false/refusal причины не подменяются legacy fallback:
remote — CONFINEMENT_UNAVAILABLE; post-admission failure — CONFINEMENT_FAILED,
без неизолированного повтора. local full_control и локальное выполнение до
первичного допуска L1 сохраняют прежний контракт. Подготовка, матрица и
остаточные риски: [L1](L1.md). Проверки:
[production](../tests/native-host/windows-l1/production-confinement.test.ts),
[recovery](../tests/native-host/windows-l1/native-lease-recovery.test.ts).

## macOS L1 — WP-23b / AD-31

NativeHost регистрирует `macos-seatbelt`: системный Seatbelt, обязательный self_test и kernel sandbox identity для управления акторами вместо предположения о неразрывной process group. Отдельный guardian завершает акторов при гибели владельца. Это не fallback базового launcher: после admission ошибка даёт `CONFINEMENT_FAILED`, не неизолированный повтор. `full_control` сохраняет обычный launcher.

Границы записи/чтения, host loopback, Docker-медиация, компоненты, hardlink preflight и остаточные риски описаны в [L1](L1.md#macos-l1--seatbelt-wp-23b--ad-31). [Квалификация](design/macos-l1-production.md) отделяет реальные macOS 26 arm64 Node 20/22 испытания от целевой матрицы и упаковки WP-34. Windows AD-30 не изменяется.

## Базовые механизмы вне квалифицированного L1

Следующие Job/PowerShell ACL описания относятся к базовому launcher и
общему PrivateFileProtection, не к AppContainer admission или его downgrade.


| | Windows (Native Host) | Linux / macOS |
|---|---|---|
| Process trees | kill-on-close Job Object per command (koffi FFI, kernel32) | Core process groups (unchanged) |
| Orphaned descendants | terminated (job membership is inherited, no breakaway) | terminated via process group |
| Private files | explicit owner-only ACL (inheritance removed, verified) | Core 0600 / 0700 (unchanged) |

If koffi or the ACL tools are unavailable, the Native Host falls back to the
Core mechanism and reports a note at startup (`native host: ...`).

## Базовый PowerShell owner-only ACL provider

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

## Ограничения базового launcher / общие ограничения

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
