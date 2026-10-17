# macOS L1 — производственная квалификация WP-23b

## Состояние и происхождение доказательств

**WP-23b: Done (реализация и указанная автоматическая квалификация), AD-31.**
Это не запись о ручной приёмке куратором и не готовность CROT к коммерческому релизу.
База ветки PR #30 — main `0590c31` (PR #28); Windows PR #27 уже слит как
`e23b7b9`. AD-30, WP-23c Done и закрытие OD-6/Windows OD-9 не меняются.

Проверенный кодовый срез: `6be7d2b4ed6b4857ba8a16e7cf94a5181a0cbb11`.
[Нативный CI](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39063295121).
[Машиночитаемые доказательства](../evidence/macos-l1-production/qualification.json)
содержат source head, настоящий checkout SHA PR merge ref, версии ОС/Node,
ссылки на задания, результаты каждого теста и production/crash наблюдения.
Source head и GitHub `GITHUB_SHA` pull_request merge ref не выдаются друг за друга.

Документационный HEAD и итоговые 11/11 проверяются отдельно в
[PR #30](https://github.com/mysteriumpersonae/crot-mcp/pull/30/checks) до снятия Draft.
Эта ссылка движущаяся; pinned native evidence выше остаётся исторически точным.

## Восемь критериев в фактически проверенном срезе

| № | Критерий | Результат и доказательство |
| --- | --- | --- |
| 1 | Производственный механизм и готовность | Пройден: NativeHost регистрирует macos-seatbelt; Apple sandbox-exec + libproc/libsandbox/Koffi; protected canary, внешняя запись, control IPC, workspace/temp и kernel identity проверяются до available=true |
| 2 | Настоящий workspace и инструменты | Пройден: Node/sh/git, цепочка Node → Node → Node; офлайн npm install/test, pip wheel install/import, Cargo build/run, Go build/run; private HOME/temp/cache. Go взят из установленного runner tool cache, если его нет в PATH; это не скачивание и не подмена бинарника |
| 3 | Чтение CROT/Keychain и HTTP | Пройден: реальные 5/5 reads + 5/5 writes запрещены EPERM/EACCES, существующий control.sock запрещён; HTTP без токена 401; существующая тестовая запись Keychain сначала читается владельцем, затем недоступна security CLI в L1. Missing item/ENOENT не засчитываются |
| 4 | Файловые алиасы и runtime | Пройден: внешняя запись/симлинки, новый и заранее существующий внешний hardlink запрещены; multi-name protected secret закрывает admission; внутренние known hardlinks сохраняют запись; Node/CROT/FFI runtime не получает write handles |
| 5 | Потомки и вся аренда | Пройден: обычные/detached/reparented потомки завершаются по kernel identity; graceful handler успевает закончить; UID/GID и повторная raw/source инициализация Seatbelt запрещены. SIGKILL владельца и guardian EPIPE не оставляют живые акторы; чужой процесс и другой Core не затронуты |
| 6 | Оба сетевых режима | Пройден: on/off достигают host localhost; off получает EPERM/EACCES на внешний IP. On разрешает IP сеть профилем. Это не замер доступности всего интернета/LAN и не отдельный network namespace |
| 7 | Docker-медиация | Пройден: существующий прямой Unix endpoint недоступен; свой private endpoint передаёт 200 byte stream mock daemon, запрещённые create/bind запросы дают 403 и confinement.docker_refused; общий a–d фильтр остаётся обязательным. Не реальная матрица daemon/Compose |
| 8 | Core/Service и fail-closed | Пройден: реальный CrotService и Core status; общий overview-контракт использует этот status (shared control-center tests); registered backend ready не ограничивает local full_control. Remote без backend получает UNAVAILABLE; post-admission ошибка — FAILED без неограниченного повтора; startup/shutdown и owner-death guardian квалифицированы |

Тесты: [`tests/native-host/macos-l1/`](../../tests/native-host/macos-l1/).
Полный финальный `npm run check` и 11 CI jobs остаются обязательным PR gate,
а не выводятся из успеха только двух macOS jobs.

## Матрица — не смешивать цель и наблюдения

| Комбинация | Что подтверждено |
| --- | --- |
| macOS 26.6.2 arm64, Node 20.20.2 / 22.23.2 | Реальные CI jobs, production/CROT-6A/Keychain/Docker/сеть/потомки/crash; все нативные тесты этого среза |
| macOS15 arm64/x64, macOS26 x64, macOS27 arm64 | Цель AD-29/31; предикаты и обязательный per-host self_test реализованы. Нативные прогоны отсутствуют: широкой release-квалификации не заявляем |
| macOS27 x64; неизвестные OS/arch; сервис root | Не объявляются поддержанными: components_mismatch. Apple-shipped Intel сочетание macOS27 не выдумывается |

macOS-решение OD-9 закрыто AD-31; браузерная часть, оставшаяся platform/release
квалификация, пакеты/подпись/notarization/autostart WP-34 не закрываются этим решением.
Целевая матрица v1 не урезана до одного CI runner.

## Отрицательные результаты сохранены

| Срез / CI | Наблюдение | Исправление / действующая граница |
| --- | --- | --- |
| ece9e5a / 39057806453 | network-off timeout вместо запрета: широкий local network* разрешал лишнее | bind/inbound только localhost и outbound только remote localhost |
| 96dd100 / 39058271540 | detached posix_spawn обходит прямой setsid syscall-filter | Не PPID/группа, а kernel sandbox identity; direct syscall запрет не объявляется полной защитой |
| b75d2bb / 39058889682; 665f211 / 39059451569 | Неверная библиотека / неверный NO_REPORT flag давали unavailable и -1 kernel ответы | libsandbox.1, NO_REPORT=0x40000000, variadic ABI и отдельный реальный actor ABI test |
| 0d46cf6 / 39060215869 | Blanket __mac_syscall deny ломал AMFI/dyld @rpath, Xcode git не запускался | Обязательный raw sandbox_apply + sandbox_init rejection, без запрета общих AMFI syscall checks |
| 18321fe / 39061390732 | Go установлен в runner tool cache, но не в PATH | Тест использует реальный установленный Go; backend не скачивает инструменты и требует настроенного PATH |
| b46b326 / 39061601256 | Заранее созданный workspace hardlink действительно менял внешний файл | Preflight dev/ino/nlink: неизвестные имена — read-only, multiply named protected secret — unavailable. Негативный тест не ослаблен |
| fde009b / 39062319803 | Unit test ошибочно сравнивал /var с canonical /private/var; production security tests passed | Исправлено ожидание unit test, не политика; чистый native прогон 4308b0e / 39062611495 |

## Эксплуатационные ограничения и остаточные риски

- Seatbelt deprecated; часть native ABI private. Семантика/компоненты или self_test
  изменились — unavailable/FAILED, не запасной неизолированный запуск.
- HOME/cache/temp эфемерны на Core; нет APFS overlay и переноса host credentials.
  Runtime read-only, host Rust toolchains только для чтения. Установка инструментов,
  подписанная поставка и широкая конфигурационная квалификация не подменяются smoke tests.
- Pathname-based Seatbelt дополнен обязательным preflight: protected symlinks
  раскрываются; неизвестная новая protected-цель, multi-name secret, недоступный
  обход или >100000 узлов — fail closed. Это явная консервативная граница
  доступности/производительности, а не пропуск непроверенных узлов.
- Перед сигналом повторно проверяются PID/UID/ruid/birth/profile и заморозка;
  атомарного pidfd на этом backend нет. Администраторы/несвязанные same-user host
  процессы не изолированы. На отказе очистки неоднозначные данные не объявляются удалёнными.
- On и localhost при off используют хостовый стек. Неаутентифицированные TCP/
  localhost исполнители вне Seatbelt остаются риском владельца (AD-20.14);
  CROT HTTP по-прежнему требует секрет. Warning отражён в status.detail.
- Нет заявлений о real Docker daemon/Compose/TLS/SSH integration matrix,
  упаковке WP-34, независимом security review или коммерческом релизе.
- WP-24 acceptance, WP-25/26/27 с OD-8, WP-29 follow-up, public staging WP-38
  и зависимая E2E WP-32 остаются открытыми. Слияние одного L1 PR не закрывает их.
