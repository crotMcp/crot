# Исторические статусы Windows L1 до merge PR #27

**Не текущий статус и не инструкция установки.** Следующие фрагменты перенесены
из STATUS.md и docs/L1.md без изменения утверждений на базе e23b7b9. Слова «current», «Next»,
«open», «Draft», старые неуспехи и числа относятся только к указанным этапам.
Относительные ссылки адаптированы к месту архива; результаты и исходные SHA не переписаны.

Текущее решение: [AD-30](../../ARCHITECTURE.md),
[руководство](../L1.md), [действующий STATUS](../../STATUS.md).
PR #27 merged как e23b7b9; WP-23c Done, OD-6 / Windows OD-9 закрыты.
Ни один исторический неуспех не переименован в успех; ограничения и residual risks
остаются в текущем руководстве. AD-27/28 не выбраны production backend.

## История из STATUS.md — ранние этапы

## Архив прежних этапов WP-23c (не текущий статус)

## WP-23c — производственная интеграция открыта; пакет не принят

Актуальная база `eb3c0f9`: CI 11/11; Server2025 x64 Node20/22 подтвердили
on/off, защиту HTTP-токена, очистку loopback и остановку акторов своего SID.
Новая дельта: Windows drive-aware Docker path policy подключена к общим
проверкам bind/npipe/inspect/volume/Swarm. Тест HTTP proxy подтверждает 403,
refusal callback и отсутствие передачи запрещённых запросов daemon.
Это не native pipe/ACL qualification: полный recovery/service lifecycle,
production backend, поставка и Windows Docker transport остаются открытыми.
Ниже сохранены более ранние этапы, не актуальный полный перечень блокеров.

Ранее подтверждённая база `de18eca`: CI **11/11**,
Windows Server 2025 x64, Node20/22: `13/13` SD (cleanup=true), `7/7` CRUD,
`5/5` защищённых подмен, внешний hardlink без записи, реальный CROT-6A
`5+5+канал=EPERM`. Два уровня Node → Node → Node и завершение оставшихся
потомков через Job подтверждены; LOCAL не переписывает каналы CROT/Docker.

Продолжение после `de18eca`: добавлены owner-only append-only WAL с fsync,
нативная исключительная no-share блокировка Windows, цепочка SHA-256,
протокол восстановления с preflight всей транзакции и удержанием идентичностей,
регистрация намерения Job до запуска, отказ при чужих изменениях SD и
пересечении идентичностей параллельных аренд. Ошибки записи/очистки не
объявляются успехом; профиль удаляется последним. Проверяются реальное убийство
процесса-владельца и повторное открытие WAL, а также запрет чтения/записи WAL
готовым AppContainer. Протокольные тесты с подставным адаптером не являются
доказательством восстановления ACL ядром.

Дополнительно реализованы нативные объектные транзакции `lease-acl.ts`:
планирование SD без записи, открытие по GUID тома/file ID/времени создания,
точное сравнение O/G/метки/DACL/control и непередающееся восстановление DACL.
На `4c22e59` (merge `1ec46cc`) оба Windows задания PASS, включая шесть
нативных транзакций и точное восстановление двух SD после убийства владельца;
повторно проходят 13/13 SD, 7/7 rename, 5/5 tamper, CROT-6A и два уровня spawn.
Общий CI **10/11**: browser-e2e неуспешен на browser_select_option; это не
объявлено исправленным. Исправленный 24-byte FILE_ID_DESCRIPTOR не подменяет
доказательство целого service recovery.
Их квалификация отделена от полного восстановления аренды: нет доказательства
очистки осиротевшего профиля/действующих акторов. Захват многоссылочных файлов
этим новым адаптером пока явно отклоняется, без подмены старого hardlink-контроллера.

**Не завершено:** полный нативный адаптер восстановления аренды/осиротевших профилей и
его подключение к запуску/остановке сервиса, production CommandConfinement,
сеть on/off, Docker и полная матрица Windows 11/Server 2022/2025,
x64/ARM64 (где поддерживается), обычный/повышенный пользователь. Windows
sandbox остаётся CONFINEMENT_UNAVAILABLE, PR27 Draft/open; WP-23c не закрыт.
[Восемь критериев](windows-l1-curator-appcontainer.md).

## Исторические проверки до a6eb17d — не текущий выбор механизма

**AD-28: $0 third-party license-fee constraint.** Dokan commercial use is allowed
subject to MIT/LGPL compliance, including a validated replacement/relinking route;
security hash pins are not an automatic LGPL exception. No CROT relicensing.
Latest source75ce0f2 implements effective LPAC access verification and five native
raw-open probes, including literal NT DesiredAccess0 with separate owner control.
The unsupported class46 query at4804e32 is retained as failed prerequisite, not
access denial. Actual results and eight source-pinned criteria:
`docs/design/windows-l1-continuation.md`; license/security decision:
`docs/design/windows-l1-zero-license.md`.
Implementation75ce0f2: full local1732/168 skipped +147 PASS; its CI had
8/9 non-Windows PASS and2/2 Windows FAIL.
Latest unchanged-code validation20808e8 restores all9 non-Windows CI PASS,
including macOS20; both Windows remain FAILED. The earlier75ce0f2 macOS20
concurrent-start failure is retained; root cause is NOT established or fixed.
See20808e8-validation-summary.json for exact code/assertion identity and native proofs.
Both native profiles enter and deny four owner-positive raw opens, but literal
NT0 also denies owner (inconclusive) and NUL RW fails. No data grant or runtime
compatibility is proven. All criteria stay partial/NOT MET. No production backend,
READY bypass or original/global/device ACL
weakening; fresh profile normal cleanup is implemented, abrupt recovery unqualified.

AD-27 source `ca04414` actually builds and mounts the same-backing component on
Windows20/22 and verifies original root/file Medium before actor startup. It
DOES NOT pass filesystem acceptance: Node20 fails pre-JS0xc0000142, Node22 code1.
Canonical ESM Job binding fixes mixed-registry duplicate types; failed nonzero
helper unmount remains owned/reported. Original workspace SDs are never changed.

**New critical native result `0eb1519`: Low unique WRITE_RESTRICTED profile opens
its exact new raw control device with zero access (`control-zero-open`).** The
new self-test refuses READY, unmounts and never launches actor. No sensitive
IOCTL was invoked. Pinned driver only installs DACL from volume SDDL, not its
label, and raw token/event dispatch bypasses filesystem callbacks with ANY_ACCESS.
Never lower device label to make writes pass; no safe mechanism selection exists.
Node22 first-test setup also hit the default10s hook before this test executed;
that is an independent setup failure, not denial evidence.43ff402 fixes composite
fixture ownership/deadlines without changing actor gates. Both runtimes now
FAIL control-zero-open after all13 fixture setups reach ready; no unsafe actor
is launched. Max setup3691ms Node20/6118ms Node22.

Full localc6a1c45 `npm run check`: **1711 Core /168 skipped +147 extension**,
lint/format/types/builds pass. C6a1c45 restores all9 non-Windows CI green,
including all4 Linux L1 jobs; both Windows remain red. Trusted Linux fixture
uses the identical verified immutable Alpine index digest on ECR/Docker Hub,
with bounded fallback and5 portable tests. Docker security assertions unchanged.
Existing native process11/11,stage6a10/10,workspaceRPC7/7 pass on both runtimes;
actual ready Node22 state gate still denies5 reads/5 writes/control endpoint with
working owner controls. Source-pinned eight-criterion report and SHA256 receipts
are in `docs/design/windows-l1-continuation.md` and its evidence directory.
NUL/strong Node20/descendants/shells, safe control/data filesystem, complete
state/Docker, network/matrix/backend remain OPEN. Production none/not_implemented,
remote fail-closed, OD-6/OD-9 OPEN, PR27 Draft/open, no merge. No weaker fallback.

Previous native service-state source `9ced362379876ecf14b3b74eba7c03d8dc5b1b0c` (historical result):
**8 successful checks /2 Windows failures /1 independent Ubuntu24 ECR rate-limit
failure**. Three Linux L1 jobs, Linux/macOS Node20/22 and Chromium pass. Prior
e0cdb06 has all9 non-Windows checks green. Full local9ced362 check:
**1683 Core /167 skipped +147 extension**, lint/format/types/builds passed.

AD-26 actual service-state provider is implemented ate0cdb06. Native testing
found descriptor serialization failure plus managed-service regressions;
9ced362 fixes SACL-vs-LABEL serialization and strengthens AD-24 owned-object
label read-back. No failed encoding is treated as absent policy. Owner-only
DACL + Medium NWNR is installed/read-back before secret bytes, with pinned
no-reparse/single-link validation and retained native cleanup. Fixed legacy
state files are hardened; arbitrary directories/workspace SDs are unchanged.
Service Core/bridge/audit use the same provider. Shim protection failure stops
spawn/truncation. Empty-temp atomic failures preserve old secret/state bytes.

Real CrotService owner startup/control/settings update and5 private descriptor
checks pass on both runtimes. On **Node22**, the ready actor receives EPERM
for all5 actual secret/key/settings/audit reads and all5 writes, actual control
connection is unreachable, host bytes remain unchanged and owner ping works;
the mandatory test passes. On **Node20**, owner controls work but actor startup
still exits0xc0000142 before JS; that test FAILS, never counted as denial.
Criterion4 remains OPEN: Docker/self-approval/external config suite incomplete.

AD-25 BNO launch/read-back remains a component, not a compatibility solution.
Node20 startup, ordinary NUL, strong-token descendants, cmd and WinPS remain
red. Native process11/11, stage6a10/10 and workspace RPC7/7 pass in each Windows
job. No accepted transparent filesystem or production L1 backend exists.

Byte cleanup at0625595 retains failed event/parent closes, partial setup
handles and descriptors until native release succeeds. Fault injection checks
persistent failure, no allocation growth and recovery without double release.
Read-only attach synchronization at59068ab uses only the exact held child
thread. Unsupported/malformed query, count0 or persistent suspension fail before
resume. No process/token/desktop authority is exposed or weakened.

Implemented components include native byte stdio/ProcessLauncher through the
existing Core (`3b91370`, historical 11/11 CI), bounded launch environment,
unique write-only Low token, and AD-24's NEW noninteractive station/desktop,
explicit owned label installation plus exact kernel descriptor read-back.
The fixed helper itself is suspended/Job-contained before resume. No common SID,
interactive desktop, global NUL/device ACL, original workspace SD or runtime
qualification gate is widened. Original PowerShell fix `43f7392` and aligned RPC
regression `01ed8ce` remain intact; their strict 15-second gates are retained.

Published86d8a53/bde77eb/281b559 repair Job/token ownership after failed
configuration/CloseHandle, asynchronous exit cleanup and a host-close/launch
race, with portable fault-injection tests. It is not a transparent filesystem
or an accepted Windows L1 mechanism. Transparent same-backing Medium workspace
writes, complete global write/state/IPC/Docker isolation, production confinement
registration, native ARM64/Windows11/standard-user qualification and OD-6/OD-9
remain OPEN. **Availability stays fail-closed; WP-23c is not ready; PR #27 stays
Draft/open.** Exact commits, failure chronology, source-pinned events and
criterion status: [continuation evidence](windows-l1-continuation.md).


## История из STATUS.md — прежний выбор следующего WP

## Next

**Текущий следующий шаг:** безопасная встроенная Windows граница записи,
включая внешний hardlink, без ослабления критериев. Платформенная зависимость
OD-9 для WP-23b решена AD-29; сам WP-23b не реализован.

**История до a6eb17d — WP-23c restricted-token spike.** Owner authorized
implementation work after the OD-9 proposal; native Windows x64 and ARM64 stay
in the v1 target. Native restricted-token/DACL primitives and a required
architecture-specific CI matrix are being added (workflow publication is
blocked by GitHub Workflows write permission); see
[`docs/design/windows-l1-spike.md`](windows-l1-spike.md).
Stage 2 research-only suspended restricted child creation, pre-resume Job
assignment and actual file/descendant/failure probes passed native Windows
Node 20/22 CI at `a6cdab2e` (all 11 CI checks green). Local check: 1458 core
passed / 110 skipped, 147 extension passed. Common-resource SID grants are
not a complete outside-write/IPC boundary; ARM64 and standard-user acceptance
remain pending. Stage 3 write-restricted/MIC comparisons passed native Windows
Node 20/22 at `14084c6f` (11 CI checks green; local check 1469 core passed /
113 skipped, 147 extension passed). Owner-only reads plus explicit secret
NO_READ_UP work in fixtures, but Low IL blocks ordinary Medium-workspace
writes. No production activation; safe workspace mediation and bypass/IPC
qualification remain required. Stage 4 paired native probes passed at
`418b7d1f` (11 CI green; local check 1470 core / 124 skipped, 147 extension).
The privilege-stripped MIC-only component preserves both normal/hidden Node
spawning, secret NR denial, static-alias denial and own-token raise denial;
the SID-filtered candidate's EPERM failures are retained as rejected behavior.
Full allowed-write/IPC boundaries remain open. Stage 5 real canary memory,
handle and readonly-pipe probes passed Windows Node 20/22 at `15bb9357`
(11 CI green; local check 1470 core / 126 skipped, 147 extension). Low memory
and handle access are denied after working trusted controls; NW-only IPC
exposes canary bytes, explicit NR IPC denies Low reads, Low fixture IPC works.
This does not qualify real CROT IPC provisioning or production L1. Stage 6 adds a bounded explicit filesystem-RPC experiment against an ordinary Medium root. Code `f38d68ad` passes the explicit Node 22/cmd CRUD/negative cases, but real Windows Node 20/22 jobs FAIL: PowerShell and Node 20 descendants remain blockers. Local check: 1509 core / 132 skipped, 147 extension. It is NOT transparent shell/Node filesystem support and does NOT complete stage-6 acceptance. See the spike report. This is not a production L1 backend or a
completed OD-6 decision. macOS and
Windows runtime confinement remains `not_implemented`/fail-closed until the
full boundary and positive remote shell/process acceptance are implemented.
`ARCHITECTURE.md` and WP-25/26/27 are unchanged in this stage.

Stage 6A diagnostic report: [`61d0f87a`](https://github.com/mysteriumpersonae/crot-mcp/commit/61d0f87a395ed1962cdbc4b19c7c482698a992e4) has nine passing non-Windows checks and two failing Windows jobs. Empty PATH fixes direct Node 20 spawning/observed Job cleanup, but cmd loses PATH; fixed PATHEXT restores the WinPS 5.1 version probe. PowerShell exit/redirection remains OPEN. RPC modifies real Medium files, not ordinary fs support; unapproved Low-sibling CRUD succeeds, exposing an unmet global outside-write boundary. See [`docs/design/windows-l1-stage6a.md`](windows-l1-stage6a.md) for pinned evidence, open failures and mechanism comparison. No acceptance or production activation.

**WP-24 — Browser v1 (CDP backend): implemented, merged** (PR #22, `d273473`; run-1 fixes in PR #23; run-2 fixes in PR #24;
see "Last completed"). Real-site manual runs are recorded; acceptance remains
open for default-load timeout signalling, C1 and final acceptance review. Owner's order after
WP-24: WP-23c (проверка достаточности OD-6 после контрпримера), затем WP-23b (OD-9 решён AD-29),
OD-8 (download hand-over, before WP-26), then WP-38 preparation starting
with the open WP-29 items. Critical path: chain B continues WP-32 → WP-33 →
WP-40; WP-32 waits for WP-24…WP-27 and WP-38.

| WP | What | State |
| --- | --- | --- |
| WP-24 | Browser v1: CDP backend, snapshot and references, trusted input, frames, shadow DOM, waiting, history (AD-16) | implemented, PR #22–#25 merged; manual runs 1–5/follow-up recorded; B4/E5/windows and G5/H passed by owner; default-load timeout signalling in `wp-24-load-timeout-and-acceptance`; C1 partial, final acceptance open |
| WP-31 | Remote permission profile and presets (AD-13, AD-19, AD-23) | Done, merged (PR #21, `9ce0574`); code verified at `9ca7b5b`, CI 11/11 green; AD-23 recorded (`69408c3`; point 4 wording `4a654f5`); user docs updated (`99fb2c6`); end-to-end check of the real upload/download gates: WP-26 acceptance; see "Last completed" |
| WP-30 | Device tunnel adapter (AD-22, device side) | Done, merged (PR #20): tunnel, pipeline entry and registration at pairing implemented; OD-5 decided and recorded in ARCHITECTURE.md (`37b3126`), status markers updated (`01f4a20`); open elsewhere: relay-side deregistration, key rotation and orphaned registration (AD-22 open question 3, WP-29), measured client timeouts (WP-32) |
| WP-25, WP-27 | Browser dialogs / file chooser / background screenshots / tab group; per-tab queue for remote, explicit `tabId`, `openedBy` | unblocked by WP-24 |
| WP-26 | Browser upload and download (AD-16 points 11–12) | after WP-24 and OD-8; also provides the end-to-end check of the WP-31 upload/download gate (AD-23 point 8) |
| WP-23b/c | Command confinement L1 на macOS и Windows (Linux готов: WP-23a, AD-20) | AD-29 решил платформы OD-9 и разблокировал WP-23b, который ещё не реализован. WP-23c не принят: a36a701 проходит переименование существовавших узлов, точный SD 13/13 и настоящий CROT-6A 5+5+канал EPERM на Node20/22. Обязательный тест потомка неуспешен; CI 9 успешных/2 Windows неуспешных. Backend/сеть/Docker/аварийная очистка/полная матрица открыты; Windows remote sandbox остаётся CONFINEMENT_UNAVAILABLE. Все три ОС обязательны для v1 |
| WP-35 | Extension publication, submitted early | preparation now; submission after WP-24…WP-26 (`debugger`, `downloads`, `tabGroups`) |
| WP-41, WP-42 | Extensibility invariant tests; workspace image view (post-v1 phase 5; depend on no open contract — WP-42 without downscale, see product-reassessment §8) | can start now with spare capacity; never displace the critical path; WP-43/44/49 wait for OD-16/15/17 ADs |
| OD-15…OD-20, OD-23 | ADs of the expanded product goal (jobs, components, media, edit description, connectors, credentials; release staging) | documentation work, parallel to WP-31; see roadmap §4.2 |

**Expanded product goal (proposal, not implemented).** CROT is to become an
extensible execution environment for local and remote agents with full
media work, video editors and external services. Reassessment, decisions
and order: [`docs/plan/product-reassessment.md`](../plan/product-reassessment.md);
cards WP-41…WP-70: [`docs/plan/extension-work-packages.md`](../plan/extension-work-packages.md);
roadmap §2.7, §3, §4.2 (OD-15…OD-23), §8.5. v1 scope and the critical path
are unchanged; none of phases 5–8 is release-blocking (OD-23, recommended).
Nothing of it is implemented: media work today is only possible through
`shell.execute` (untested; remote on macOS/Windows refused without L1),
and no external service has a CROT integration.


## История из STATUS.md — поздние компонентные продолжения

**Продолжение WP-23c: LOCAL после d7436af.** Обращения к DACL корня
NPFS удалены. Реализована пользовательская DLL совместимости: только префиксы
libuv `\\?\pipe\uv\` и `\\.\pipe\uv\` перенаправляются в
`\\.\pipe\LOCAL\uv\`. Охвачены ANSI и Unicode CreateNamedPipe/CreateFile;
ANSI API фактически используются stdio libuv в Node20/22. Реальные каналы
CROT и Docker не переименовываются; коды ошибок ядра сохраняются.
DLL находится вне workspace с RX для package SID, внедряется до ResumeThread
после проверки токена и Job; потомки получают её до возобновления.
Обязательный тест проверяет два уровня spawn и остановку обоих потомков Job.
Квалификация проводится Windows CI на том же коде, вместе с 13/13 ACL,
7/7 операциями, 5/5 отказами подмены и настоящим CROT-6A.
Аварийное восстановление аренды и производственный CommandConfinement этим
изменением не реализованы. Windows L1 не объявлен доступным; WP-23c не принят.

### WP-23c: разрешённые сетевые режимы (продолжение после 8eb3393)

Добавлены сетевой режим в WAL (старое v1 без поля означает off), точная
проверка трёх capabilities до ResumeThread, владелец loopback только для SID
аренды и обязательный этап удаления сети перед удалением профиля в recovery.
Проверка foreign loopback-конфигурации не заменяет общий список старым снимком.
Windows-тест проверяет настоящий CrotService: секреты/состояние/управляющий
канал, HTTP без токена/с неверным токеном, интернет/LAN/localhost и очистку.
Результат новых Windows-проверок фиксируется только по CI этого изменения;
локальные injected-тесты не доказывают сетевую изоляцию ядра.
Production backend и полное восстановление акторов/профиля пока не подключены.

На исходном сетевом коммите 53d071b Windows20/22 подтвердили network=on:
интернет/LAN/localhost=200, настоящий HTTP CROT без/с неверным токеном=401,
шесть реальных файлов read/write=EPERM, управляющий канал=EPERM, очистка
loopback успешна. Общий CI 9/11: оба off-теста ошибочно требовали EPERM от
сетевого WFP drop. Фактически наблюдались ETIMEDOUT/TIMEOUT и DNS ENOTFOUND;
это не выдаётся за успешный прямой TCP-запрет. Уточнённый гейт исключает DNS
(фиксированный IP), требует положительные owner-контроли и ноль принятых
соединений на контролируемом сервере. Точные EPERM-гейты файлов/IPC неизменны.
Добавлена подготовка удаления только trustee ACE собственного SID с нового
workspace-node; native идентичность/проверка чужого SD используются без пути
в качестве fallback. Полный обход дерева и scope admission этим не подменяются.

На 1ce8931 Windows20 уже подтвердил оба сетевых режима с прямым IP-контролем:
on — интернет/LAN/localhost=200, HTTP=401; off — ноль принятых соединений
контролируемого сервера, внешний TCP=EACCES, localhost/LAN — silent drop.
В обоих режимах 6+6 файлов и реальный control=EPERM; loopback очищен.
Нативный тест нового workspace-node подтвердил удаление собственного
унаследованного SID после восстановления родителя, без изменения чужих ACE.

Добавлен отдельный компонент полного инвентаря акторов: WTS всех сеансов,
отбор того же пользователя, pinned process handle и повторное чтение реального
TokenUser/AppContainerSid перед завершением только собственного package SID.
Требуются два полных пустых прохода; неизвестный SID/отказ запроса/завершения
или неуспешный CloseHandle не считаются отсутствием актора. Нет повышения
привилегий. Перед использованием обязательны durable receipt свежего профиля
и блокировка новых запусков; компонент не подменяет полный LeaseRecoveryNative.
Его Windows-квалификация отдельно проверяет живой контрольный процесс хоста.

83da874: инвентарь/остановка акторов прошёл на Windows Node22 (три прохода,
два пустых; потомки мертвы, host-control жив). Node20 выявил отказ
TerminateProcess; учтена возможность конкуренции с обычной остановкой Job. Общий CI
10/11, не объявлен зелёным. Последующая правка принимает неуспешный запрос
завершения только если ожидание того же pinned handle доказало смерть;
живой либо неоднозначный процесс по-прежнему означает ошибку. Это проверяется
отдельным FFI fault-тестом и повторным Windows-прогоном, не пропуском гейта.
Пустой/усечённый WTS-ответ без живого контроллера теперь отвергается; выход
между инвентарём и чтением токена доказывается wait на том же объекте и требует
повторного полного прохода. Владение свежим профилем дополнительно закреплено
in-memory brand/freeze до сетевых и launch-вызовов; durable receipt этим
не заменена. Полная производственная аренда и Windows backend ещё открыты.

WP-23c, следующий нативный срез: добавлены отдельный долговечный S_OK receipt
профиля, NTFS guards по ID с реальным no-DELETE sharing, полный native recovery
adapter и подключение существующих WAL к startup/shutdown NativeHost/CrotService.
Новый Windows crash-тест убивает владельца живой аренды и запускает настоящий
CrotService для проверки акторов, loopback, новых workspace nodes, исходных SD
и закрытого receipt. Его Windows-квалификация обязательна; production availability
пока не включена. Неоднозначный intent без S_OK receipt не разрешает удалять
профиль. Неподдержанные reparse/case-sensitive/multilink/пересекающиеся аренды
отказывают явно; они не обходят проверку границ.

WP-23c continuation: `365a475` qualified the real service-start recovery path
on Windows Server 2025 / Node 20 and 22: owner death, token-SID actor drain,
13 independent file snapshots plus all plan objects restored by NTFS ID,
new workspace ACE revocation, loopback removal, closed profile receipt and
idempotent reopen. That revision was NOT green overall: the portable receipt
fixture reused an unprepared existing Windows directory, and the new sharing
probe showed that an OpenFileById handle alone is not a rename guard. Follow-up
uses a by-ID anchored, identity-checked current-name data open and provisions
a fresh private fixture directory; both are requalified, not waived.

The LOCAL Docker endpoint now has an owned OVERLAPPED transport (explicit
owner/package DACL, Low label, remote clients refused), the shared policy and
trusted DOCKER_HOST environment. Its native test uses a mock upstream and checks
real AppContainer requests/403/audit, not a real Docker daemon. Production
backend readiness and native bind-path TOCTOU admission are not claimed yet.

## История из docs/L1.md

### Windows: пользовательская прослойка LOCAL (вариант А.2)

Запросы и изменения DACL корня NPFS исключены. Microsoft Detours v4.0.1
(MIT, закреплённые исходники в native/vendor/detours) используется только
для пользовательской совместимости, без драйвера или виртуализации.
DLL перенаправляет исключительно `\\?\pipe\uv\` и `\\.\pipe\uv\`
в `\\.\pipe\LOCAL\uv\`, в ANSI и Unicode CreateNamedPipe/CreateFile.
Каналы service.sock, control.sock, реальные crot-control-* и docker_engine
не перенаправляются: отрицательный результат CROT-6A определяется ядром
на настоящем канале сервиса. GetLastError сохраняется после освобождения
временных строк, поэтому отказ не заменяется искусственным ENOENT.

DLL собирается scripts/build-windows-local-shim.ps1 локальным SDK, находится
в отдельном каталоге среды выполнения вне workspace, с RX для package SID.
Проверенный приостановленный процесс получает DLL после назначения Job и
проверки AppContainer/SID/IL/capabilities. Перехват CreateProcessW передаёт её
потомкам до их возобновления; ошибки внедрения завершают приостановленного
потомка без обычного повторного запуска. Тест включает Node → Node → Node
и остановку обоих оставшихся потомков после выхода прямого процесса.
Изменения ACL внутри workspace для загрузки DLL не требуются.

Прослойка не является границей безопасности: обход перенаправления актором
не добавляет ему прав ядра. Граница — AppContainer + Job + DACL.
Это пока квалификационный путь, а не зарегистрированный production backend.
Аварийное восстановление аренды, сеть/Docker, интеграция CommandConfinement
и полная платформенная матрица остаются обязательными до приёмки WP-23c.

### Windows: журнал аренды и протокол восстановления (ещё не backend)

Компоненты `lease-journal.ts`, `lease-lock.ts`, `lease-recovery.ts` сохраняют
план восстановления до изменения ACL и намерение Job до создания процесса.
Журнал защищается PrivateFileProtection до записи содержимого, находится вне
workspace, не может быть reparse/hardlink и удерживается нативной no-share
блокировкой с read/write DATA access. PID, возраст файла и удаление «старого»
lock-файла не используются. Закрытие дескриптора при аварии освобождает владение.
После fsync на POSIX дополнительно фиксируется родительский каталог; admission
Windows требует проверенного локального NTFS. SHA-256 выявляет повреждения,
но не заменяет DACL. Пустые/обрезанные/повреждённые WAL не игнорируются.
Закрытые журналы сохраняются как tombstones; лимит 64 файла означает безопасный
отказ, а не автоматическое удаление истории. Ротация ещё не реализована.

Нативный адаптер обязан подтвердить свежесть профиля, границы томов/деревьев,
остановку всех акторов, открытие по file ID и времени создания и точное
сравнение O/G/label/DACL/control до восстановления. Проверяются все объекты
до первой записи; возврат snapshot поверх чужих изменений запрещён. Runtime
rename guards удерживаются до остановки акторов. Сканирование новых объектов
ограничено workspace и снимает только SID своей аренды, без обхода temp/cache.
Пересекающиеся аренды пока отказывают (разделение общих ancestor leases не
реализовано). Ошибка блокирует новые запуски и сохраняет журнал для восстановления.

`lease-acl.ts` добавляет низкоуровневые Win32-транзакции: планирование без
записи, сохранение GUID тома/file ID/времени создания, открытие по ID после
переименования, сравнение полных секций SD и непередающееся восстановление
DACL/control. Новый компонент отказывает для многоссылочных файлов: он не
заменяет квалифицированную отдельную защиту hardlink. Нативный тест аварии
охватывает только два дескриптора без действующих акторов/реального профиля.

**Полный нативный адаптер и сервисное подключение пока не реализованы.** Тесты
протокола с подставным адаптером не подтверждают реальную kernel ACL recovery.
Принудительная гибель владельца проверяет сохранность WAL/блокировки, а не
восстановление дерева/профиля. Никакой installation/availability fast-path эти
компоненты не добавляют; Windows remote sandbox остаётся unavailable.

#### Windows: согласованные сетевые режимы, компонент WP-23c

`off`: ноль сетевых capabilities, нет loopback-исключения. `on`: только
InternetClient / InternetClientServer / PrivateNetworkClientServer и временное
loopback-исключение точного package SID аренды. Сетевой выбор записывается в
WAL до настройки; отсутствие поля в старом журнале трактуется как off.
Прямые service/control/Docker pipes не перенаправляются LOCAL-прослойкой.
HTTP-аутентификация и owner-only секреты остаются обязательными в on.
Настройка выполняется штатным CheckNetIsolation из System32 без автоматического
повышения привилегий. Отказ инструмента/самопроверки — ошибка, не скрытый
переход к открытому запуску. Пока это проверяемый компонент, не зарегистрированный
Windows CommandConfinement; available=true не заявляется.

На `1ce8931` Server2025 x64 Node20/22 подтвердил оба режима и очистку loopback.
В off Windows может молча отбрасывать пакеты: тайм-аут не переименовывается
в EPERM. Гейт требует прямой IP без DNS, положительные owner-контроли и ноль
принятых соединений на контролируемом сервере. В on подтверждены интернет,
LAN и localhost; настоящий HTTP CROT возвращает 401 без корректного Bearer,
а секреты (включая http-token), состояние/аудит и настоящий control pipe
сохраняют точный EPERM. Полный CI этого исходного коммита — 11/11.
Отдельный WTS/token inventory-компонент не выдаётся за весь startup recovery.
Windows11/ARM64/неподготовленный стандартный пользователь не получают
available=true на основании проверки Server2025. Пока отсутствует цельный
Windows backend, причина отсутствия L1 остаётся not_implemented; отдельная
диагностика подготовки должна быть подключена до производственного включения.

#### Windows Docker: проверка путей подключена к общей политике

`windows-l1/docker-paths.ts` отделяет синтаксис Windows от POSIX: двоеточия
дисков в Binds сохраняются, bind/npipe (включая inspect), локальные volume
options и Swarm проходят одну проверку границ. Проверяются лексический путь
и результат обязательного доверенного native-resolver; защищённые предки и
потомки запрещены также для read-only. Ключи Docker contexts входят в обязательный список dockerContextPaths и
защищены даже при пересечении с writable root. Неоднозначные UNC/device/Volume-GUID/ADS/short-name и
Docker Desktop/WSL отображения отклоняются, а не считаются именованными томами.
Списки границ фиксируются неизменяемым снимком. Разрешён только точный свой
LOCAL endpoint; посторонние pipes (включая docker_engine/control/service)
не разрешаются этой политикой. Само имя не доказывает владение endpoint.

Это **проверка запросов**, а не квалификация Windows Docker transport: native
resolver с удержанием идентичностей до потребления daemon, ACL собственного
LOCAL pipe, запрет прямого pipe ядром и подключение к CommandConfinement ещё
обязательны. Unix mock-transport подтверждает 403/аудит и отсутствие передачи
запрещённых запросов upstream; он не выдаётся за native Windows Docker test.
WP-23c, OD-6 и Windows part OD-9 остаются открытыми.
