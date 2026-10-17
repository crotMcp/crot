# Сверка документации после merge PR #27

## База и границы проверки

- Проверяемая база реализации — `main` **e23b7b9c29c5e3e1758b9ad2703bbd827648426f**,
  [merge PR #27](https://github.com/mysteriumpersonae/crot-mcp/pull/27), а не старая
  черновая ветка. Родители: `289f500` и `f916a6b`; дерево merge идентично `f916a6b`.
- `289f500` — merge PR #26 с default-load timeout signalling WP-24. Поэтому
  описание «исправлено только в ветке wp-24-load-timeout-and-acceptance» устарело.
  Наличие кода не заменяет ручное подтверждение и итоговую приёмку WP-24.
- На самом merge-коммите: [основной CI 6/6](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180293),
  [Linux L1 4/4](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180333),
  [Chromium 1/1](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180363).
  Ссылки относятся к базе, не к будущему документирующему коммиту.
- `8fe6ba5` и исходный `qualification.json` — сохранённые квалификационные
  доказательства. Их SHA не заменён новым и старый запуск не выдан за новый.
  Отдельная [проверка main](../evidence/windows-l1-production/main-e23b7b9-verification.json)
  содержит 11 job URL и выбранные нативные события, не заменяя полные журналы.
- Код, workflow, package/lock files, security gates, numbered clauses AD-1…30,
  fail-closed и границы v1 не изменены. Обновлена только документация, включая
  устаревшую implementation-заметку после AD-23, не сам контракт решения.

## Исправленные расхождения

| Файл / группа | До | После |
| --- | --- | --- |
| ARCHITECTURE.md | Смешаны WP-23c Done и исторические open; Tray/remote profile/identity/CDP местами Target; WP-31 «not merged» | AD-30 и закрытие OD-6 / Windows OD-9 сохранены; действующие таблицы отражают main; AD-18/19 риски снабжены cross-reference, AD-24…29 явно контекстуализированы как история; implementation WP-31 исправлен без изменения numbered clauses |
| CROT_IMPLEMENTATION_ROADMAP.md | «Verified against 22abf89» как текущая база; критический путь считает слитый WP-29 завершённым, WP-31 ждёт merge, WP-23c снова следующий spike | e23b7b9 — база сверки, старые SHA — история; WP-29 Partial; WP-31 и WP-23c Done; §8.2–8.4 и таблица зависимостей разделяют start/acceptance/deployment; упаковка Windows компонентов ссылается на AD-30/WP-34 |
| STATUS.md | Исторические неуспехи среди текущих статусов и Next; WP-24 под Last completed; open-вопросы WP-31 уже решены кодом | Последний Done — WP-23c; WP-24 — merged/tested, acceptance open; следующий исполнительный WP-29 follow-up с реальными блокерами; старые Windows записи перенесены в отдельный архив, не удалены |
| README.md | Relay/tunnel и OAuth verifier названы будущими; sandbox «не OS isolation» также для готового Windows; remote opt-in «recorded only» | Реализованные WP-28/30/31 отделены от Partial WP-29 и отсутствующего staging/acceptance; объяснены qualified Linux/Windows L1, local full_control/initial unavailability и remote refusal; общая egress-policy не смешана с network on/off |
| docs/L1.md | Действующая инструкция рядом с «ещё не backend», «ротации нет», «OD-6 open» | Текущая инструкция AD-30 с main provenance; прежние компонентные этапы целиком сохранены в архиве; ограничения/остаточные риски остаются действующими |
| docs/NATIVE_HOST.md, docs/SERVICE.md, docs/TRAY.md | Post-spawn Job/fallback и default pipe DACL можно прочитать как характеристику AppContainer L1 | Различены старый базовый launcher, проверяемый suspended AppContainer backend, native private state и Docker LOCAL с явным DACL; service/control pipes не объявлены Docker endpoint |
| docs/RELAY.md | WP-30 Partial; WP-31 описан как будущий | WP-30 Done/merged, WP-31 device-side implemented; WP-29 ограничения, CORS, single-instance и отсутствие live deployment сохранены |
| docs/plan/crot-agent-work-packages.md | Старое имя механизма WP-23c и active/not accepted; WP-32 без WP-27/WP-38 | Текущий WP-23c Done/AD-30, старые этапы явно исторические; WP-32 зависимости согласованы с приоритетным roadmap, а не сокращены |
| docs/design/windows-l1-{spike,stage6a,native-os,zero-license,continuation}.md | Исторические Draft/open/not_implemented легко принять за действующий статус | Единый верхний scope notice ведёт к AD-30/текущей приёмке; содержательные отрицательные результаты, SHA и ограничения сохранены |
| docs/design/windows-l1-curator-appcontainer.md | Квалификация 8fe6ba5 без состояния merge/main | Указаны merge e23b7b9, main CI и отдельный main receipt; исходная восьмикритериальная квалификация и её SHA сохранены |
| docs/design/windows-l1-status-history.md | Разрозненные фрагменты внутри текущего STATUS и L1 | Четыре полных исторических блока сохранены без изменения утверждений; относительные ссылки адаптированы к архиву |

## Почему следующий WP — WP-29 follow-up

Существующее правило roadmap §8.4 сначала выбирает незавершённую
разблокированную работу цепочки B. WP-29 имеет реализованные relay/tunnel
части и merge, но не завершённые критерии: client/device rate/concurrency,
per-source connection/handshake limits, registration rate, deregistration/key
rotation/orphan registration, load/backpressure. WP-28 и OD-3/4/5 уже решены;
для follow-up нет ожидания WP-24. Именно эти задачи блокируют публичный WP-38.
Документационная сверка не выполняет их и не переносит молча в WP-39.

Параллельный ближайший приёмочный шаг — **WP-24**: ручное подтверждение
исправленного timeout-сигнала, C1 partial/unreproduced, окончательное решение
владельца. [Run 5 и follow-up](../acceptance/WP-24-manual-run-5.md), а также runs 1–4 не
обнулены; подтверждённые B4/E5/windows и G5/H не объявлены неуспехом.
Отдельные отложенные пункты не считаются пройденными по факту merge.

| Следующая задача | Зависимости / что мешает засчитать Done |
| --- | --- |
| WP-25 | WP-24, включая открытую итоговую приёмку; собственные dialog/file chooser/background screenshot/debugger/tab-group E2E и ручная browser/OS matrix |
| WP-27 | WP-24 + WP-19 Done; remote explicit tabId, openedBy, per-tab ordering и два реальных агента не подменяются локальной очередью WP-24 |
| WP-26 | WP-24 + **OD-8**; нужны upload/download и настоящие end-to-end AD-23.8 gates, не только defensive rule-set WP-31 |
| WP-23b | WP-21 Done, платформенное решение AD-29 есть; macOS реализация/нативная квалификация отсутствуют, G4 остаётся закрыт |
| WP-38 | WP-28 и WP-29; подготовку можно вести, но до публичного exposure нужны завершение/явное согласование WP-29 blockers, live IdP, pinning, TLS, log-scrubbing и внешний OAuth/tool run |
| WP-32 | **WP-24…27 + WP-30 + WP-31 + WP-38**; WP-30/31 уже Done. Нет основания пропускать browser/staging acceptance; нужны ≥4 remote clients × версии, сквозной CI и macOS/Windows runs, измерение client timeouts |
| WP-35 / WP-34 / WP-33 | WP-35 после WP-24/25/26 и OD-10; WP-34 — сервис, Tray, Linux и Windows components AD-20/30, store IDs и OD-1/10/11; WP-33 — WP-32, RC от WP-34 и WP-38. Подготовка не равна публикации, подписи или review |

## Что подтверждено и что остаётся открытым

- **Реализация Windows L1:** [регистрация](../../src/native-host/native-host.ts),
  [backend](../../src/native-host/windows-l1/confinement.ts),
  [Core decision](../../src/core/platform/confinement.ts).
- **На main, не только в макете:**
  [Node20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180293/job/117449911210) и
  [Node22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39051180293/job/117449911225)
  содержат `CROT-6A-production-windows-confinement` и
  `CROT-6A-full-native-lease-recovery`: 7/7 workspace, 13/13 SD,
  остановка акторов, очистка новых узлов/loopback/profile, Core commands,
  LOCAL Docker 200/403/refusal audit. Проверки:
  [production](../../tests/native-host/windows-l1/production-confinement.test.ts),
  [native recovery](../../tests/native-host/windows-l1/native-lease-recovery.test.ts),
  [platform predicates](../../tests/native-host/windows-l1/components.test.ts).
- **Не расширять квалификацию:** только Server2025 x64 Node20/22. Windows11,
  ARM64, Server2022 и неподготовленный standard-user проверены предикатами
  отказа, не успешными нативными прогонами. Docker LOCAL проверен с
  контролируемым upstream, **не реальным daemon и не всей Desktop/WSL matrix**.
  UNC/reparse/неоднозначные daemon mappings не объявлены поддержанными.
- **Сохранённые ограничения:** одна активная machine-wide ACL-аренда;
  повреждённые/неоднозначные WAL не удаляются; profile intent без доказанного
  владения не усыновляется; network=on сохраняет AD-20.14 residual risk
  неаутентифицированных host endpoints. Unconfined same-user процессы и
  администраторы не являются целью AppContainer boundary.
- **WP-24 автоматические проверки, не ручное принятие:**
  [default-load flags](../../extension/test/commands.test.ts),
  [delayed commit E2E](../../tests-e2e/browser/browser-layout.e2e.test.ts).
  Ручные отчёты остаются отдельно, без добавления выдуманных прогонов.
- **Всё ещё открыто:** WP-29 follow-ups; WP-24 final acceptance; WP-25/26/27,
  OD-8; macOS L1; WorkOS live assumptions и RFC 9207 condition до G4;
  multi-instance routing, CORS и release environment; WP-32/33, signed
  packaging/autostart WP-34, коммерческий backend WP-36 и финальные G3…G7.
  Эти пункты не закрываются зелёным CI WP-23c или этим docs PR.

## Воспроизводимые проверки документационного PR

- `git diff --name-only e23b7b9`: только Markdown и отдельный evidence JSON;
  код/тесты/workflows/package files не менялись.
- `git diff --check`: без whitespace errors; локальные файловые ссылки проверены.
- Сравнение §27 с базой: нормативный текст AD-1…30 не изменён; исключение только
  implementation-status metadata WP-31 после нормативных пунктов AD-23.
- Исходный qualification.json не изменён; четыре перенесённых исторических
  блока совпадают с базой после нормализации только относительных ссылок.
- Локальный `npm run check` завершён с exit 0: 1973 основных +147 extension
  тестов пройдено, 188 платформенных/исследовательских пропусков не выданы
  за локальные Windows native прогоны. Windows evidence выше — именно main CI.
- Проверки самого документирующего коммита фиксируются в PR отдельно; ссылки
  на CI базы не используются как подмена CI нового PR.
