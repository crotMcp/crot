# CROT Run 5 — итоговый отчёт (G5.1–G5.3, H0–H5)

Дата прогона: 2026-10-13 (UTC-времена событий; локальное время = UTC+3)
Среда: CROT 0.1.0, Google Chrome 153.0.0.0, CROT Browser Extension 0.1.0, service PID 928974
Вкладки теста: 706392340 (login), 706392344 (add_remove_elements), 706392349 (w3schools tryit checkbox)

---

## 2. Итоговая таблица статусов

| Пункт | Статус | Комментарий |
|---|---|---|
| G5.1 — защита содержимого browser-инструментов | ✅ | password в snapshot — только `hasValue`, на скриншоте — точки; username читаем |
| G5.2 — refs, click, отсутствие accessible name в browser audit | ✅ | click-и прошли по свежим refs; в audit нет «Add Element» и контента страницы (проверено в G5.3 по интервалу) |
| G5.3 — аудит событий и отсутствие утечек | ✅ (ручная проверка) | 49 новых строк, 0 маркеров, структура полей корректна; ⚠️ helper-скрипт отсутствовал |
| H0 — checkbox/frame baseline | ✅ | Bike = e34 в frame f4, origin frame подтверждён инструментами |
| H1 — запрос виден до решения, побочного эффекта до approve нет | ✅ | запрос одобрен один раз; до approve Delete = 0 |
| H2 — approve исполняет действие ровно один раз | ✅ | 1 approve → ровно 1 новый Delete |
| H3 — reject и повторный запрос | ✅ | 2 reject → PERMISSION_DENIED, страница без изменений; 3 уникальных requestId. В середине теста один запрос истёк (`expired`), шаг повторён по выбору человека |
| H4.1 — browser_set_checked по ref, approve | ✅ | e34/f4, checked:false→true, 1 approve |
| H4.2 — browser_set_checked по selector, reject | ✅ | selector из реальной разметки; PERMISSION_DENIED, Bike остался checked |
| H5 — Autonomous browser после переключения из Ask | ✅ | preset подтверждён crot_status; оба клика мгновенные, без approval |
| H6 — fail-closed при отсутствии Tray UI | ⚠️ Not run | тест не выполнялся в этом прогоне; Tray не отключался специально, задним числом не восстанавливается |

Реальных дефектов продукта (❌) не обнаружено.

---

## 3. Доказательства по H-тестам

### H0 — checkbox/frame baseline
- Инструмент: `browser_tab_open { url: "https://www.w3schools.com/html/tryit.asp?filename=tryhtml_checkbox" }` → tabId 706392349 (18:16:43.419Z).
- `browser_snapshot { tabId: 706392349, includeText: true }`.
- Frames (как вернули инструменты): f3 top (origin https://www.w3schools.com), f4 (parent f3, origin https://www.w3schools.com, restricted:false), плюс динамические about:blank-фреймы (f5–f9).
- Bike: ref **e34**, frameRef **f4**; идентификация по соседнему текстовому узлу «I have a bike» (accessible name у input пустой — разметка w3schools без label). Selector/frameRef не выдумывались.
- Исходное состояние: checked:false. `browser_set_checked { tabId, ref: "e34", checked: false }` → `{ checked:false, changed:false }` (клика не было — уже unchecked).

### H1 — approve
- Предупреждение отправлено до вызова; человек проверил Tray и страницу 3–5 с.
- Инструмент: `browser_click { tabId: 706392344, ref: "e21", timeoutMs: 60000 }` (18:21:21.921Z), ref из свежего snapshot (Delete = 0).
- Состояние до: кнопки e21 Add Element; Delete = 0. Во время ожидания: других browser-control вызовов нет; Delete = 0 подтверждён визуально человеком.
- Решение: approve ровно один раз.
- Полный ответ: `{ tabId: 706392344, url: ".../add_remove_elements/", navigated: false, newTabs: [], activated: true }`.
- Состояние после (snapshot 18:21:40): e21 Add Element + e104 Delete → **Delete = 1**.
- Audit: approval.requestId `853d7b00399b922de0b6033ce2d1fcbe`, status approved, outcome success (L1440 kind=approval, L1441 исполнение). requestedAt/resolvedAt присутствуют в audit (значения не извлекались — сохранены только длины полей).

### H2 — доказательство approve
- Использована запись H1 (клик не повторялся): requestId `853d7b00…` approved → outcome success → ровно один новый Delete. До/после зафиксированы snapshot-ами.

### H3 — reject и повторный запрос
- Исходное: Delete = 1; свежий ref Add Element = e21 (страница не менялась между запросами, ref подтверждался snapshot перед каждым вызовом).
- Вызовы: `browser_click { tabId: 706392344, ref: "e21", timeoutMs: 60000 }` ×3 (18:22:26.404Z, 18:22:36.331Z, 18:23:52.060Z).
- Решения: reject, [истечение без решения], reject.
- Ответы (error): `PERMISSION_DENIED`, `details.operation:"browser.click"`, `details.approval.requestId/status`:
  - `0785e005cf2e942d4981b27822fa39f3` / rejected → outcome denied; Delete = 1.
  - `61187dc912403f8f77bb596cb0f1998f` / **expired** → outcome denied; Delete = 1. ⚠️ зафиксировано, шаг 6–7 повторён по выбору человека.
  - `3ae19f1f7a7a4ab8d8d3c4aeb49673dd` / rejected → outcome denied; Delete = 1.
- Три уникальных requestId → повторная операция создаёт новый запрос, автоконфирмации нет.

### H4.1 — set_checked по ref (approve)
- Preset: require-approval. Свежий snapshot: e34/f4 unchecked.
- Инструмент: `browser_set_checked { tabId: 706392349, ref: "e34", frameRef: "f4", checked: true, timeoutMs: 60000 }` (18:27:05.987Z).
- Проверка в Tray (человек): tabId, target Bike, origin верхней страницы и frame.
- Решение: approve один раз.
- Полный ответ: `{ tabId: 706392349, url: ..., navigated:false, newTabs:[], checked:true, changed:true }`.
- Snapshot (18:27:14): e34/f4 → states { focused:true, checked:true }.
- Audit: approval.requestId `e5d74a87dabd82d3d5d0bc5e65a73cb5`, approved, outcome success (L1451/L1452).
- Примечание: requestId не возвращался в успешном ответе инструмента — получен из audit; в самой сессии подтверждение запроса человеком зафиксировано диалогом.

### H4.2 — set_checked по selector (reject)
- Snapshot подтвердил Bike checked. Разметка подтверждена чтением HTML исходника редактора: `<input type="checkbox" name="vehicle" value="Bike">I have a bike`.
- Инструмент: `browser_set_checked { tabId: 706392349, frameRef: "f4", selector: "input[type=checkbox][value=Bike]", checked: false, timeoutMs: 60000 }` (18:27:48.897Z).
- Решение: reject.
- Ответ: `PERMISSION_DENIED`, details.approval.requestId `0e4c08c90d410325540c9f90c05169f7`, status rejected (audit L1455, outcome denied).
- Snapshot после: e34/f4 → checked:true — состояние не изменилось.

### H5 — Autonomous browser
- Все approval-запросы завершены, зависших вызовов нет.
- Переключение Tray → Autonomous browser (подтверждено человеком).
- `crot_status`: `preset.value = "autonomous-browser"` (source device), `approvalUis = 1`, `untrustedContent: autonomous-browser`.
- Snapshot tabId 706392344: Delete = 1 (e104), Add Element ref e21.
- `browser_click { tabId: 706392344, ref: "e21" }` (18:28:14.001Z) → мгновенно, без approval; snapshot: Delete = 2 (e104, e109).
- `browser_click { tabId: 706392344, ref: "e104" }` (18:28:19.814Z) → мгновенно, без approval; snapshot: Delete = 1 (e109).
- Audit: оба click outcome success без approval-объектов (L1459, L1461); переключение preset — control event 18:28:04.348Z (outcome applied, имя preset не записывается).

---

## 4. Доказательства G5.1–G5.3

### G5.1 — защита содержимого (Run5, блок 1; tabId 706392340)
- `browser_type { tabId: 706392340, ref: "e10", text: <19 симв. маркер username>, clear: true }` → navigated:false.
- `browser_type { tabId: 706392340, ref: "e12", text: <25 симв. маркер password>, clear: true }`.
- Snapshot 1: e10 textbox Username (editable), e12 textbox Password `hasValue:false`.
- Snapshot 2 (после ввода): e10 `value: <маркер username — виден>`, e12 — только `hasValue:true`, значения нет.
- `browser_screenshot { tabId: 706392340, format: "png" }`: username читаем, password — точки, значение нечитаемо.
- `browser_wait { tabId: 706392340, text: <маркер ожидания>, timeoutMs: 1000 }` → `TIMEOUT` (ожидаемо).
- `browser_press_key { tabId: 706392340, ref: "e10", keys: ["Control+A"] }` → navigated:false, newTabs:[].

### G5.3 — audit (интервал: baseline 1413 строк, 2026-10-13T21:11:48+03:00 → 21:30:15+03:00, 49 новых строк)
- stdout проверочных команд: `2026-10-13T21:30:15+03:00` · `1462 audit.jsonl` · `600 [OS user] audit.jsonl`.
- Timestamps новых событий: 18:12:57.130Z – 18:28:20.182Z.
- Число событий: browser.click 9, browser.snapshot 23, browser.set_checked 4, browser.type 2, browser.tab_open 4, browser.wait 1, browser.press_key 1, browser.screenshot 1, browser.page_read 1, filesystem.read_file 1 (denied), control 2 (applied).
- Маркеры (сырые байты + декодированные поля, рекурсивно): CROT_RUN5_TEXT_8B7D / CROT_RUN5_DUMMY_PASS_4F2A / CROT_RUN5_URL_6C9E / CROT_RUN5_WAIT_2D1B — **ни одного вхождения**; также отсутствуют: «Add Element», `tomsmith`, `SuperSecretPassword`, слово «password», `#password`, `Control+A`, все query-маркеры.
- Структура: browser.type → `textLength=19|25`, `clear=true`, текста значения нет; browser.wait → `textLength=19`, поле condition (4 симв., тип условия), строки поиска нет; browser.press_key → `keyCount=1`, списка клавиш нет; origin → только scheme+host (`https://the-internet.herokuapp.com`, `https://www.w3schools.com`), path/query отсутствуют; ref/elementRole/tabId записываются, selector — 32 симв. (допустимо).
- Approval-сопоставление: 3 пары kind=approval → исполнение/отказ (см. requestId-таблицу в разделе 3); approve → success + подтверждённое изменение страницы; reject/expired → outcome denied + PERMISSION_DENIED + неизменённая страница. Одиночных approval-событий без исхода в качестве доказательства не использовалось.
- subjectDigest — 64 hex-символа (хеш), approval subject в открытом виде не записан.

---

## 5. Ограничения и незавершённые проверки

- **crot-run5-audit-check.py отсутствовал** — автоматическая проверка helper-скриптом НЕ выполнялась. Весь аудит-анализ сделан вручную разовыми скриптами в /tmp/opencode; утверждение «helper-проверка пройдена» не делается.
- H6 (fail-closed при отсутствии Tray UI) — **Not run**: не выполнялся в этом прогоне, Tray не отключался, задним числом не восстанавливается.
- requestId в успешных ответах инструментов (H1, H4.1) не возвращался; получен из audit-лога. Если Tray отображал requestId при approve — фиксация возможна только со стороны человека.
- requestedAt/resolvedAt присутствуют в audit (проверены как поля), их конкретные значения не извлекались; срок действия запроса отдельно не подтверждён (конфигурация approvals.timeoutMs = 45000 мс видна в crot_status).
- Проверка Tray-поля «операция/tabId/origin/имя» во время ожидания — визуальная, со стороны человека; программного снимка UI Tray нет.
- Разовый `BROWSER_PAGE_RESTRICTED` при первом browser_tab_open блока G5.2 (успешен со 2-й попытки); разовый `expired`-запрос в H3 (перекрыт повторным reject).
- Проверка содержимого audit выполнялась чтением файла из обычного терминала (вне CROT sandbox), как и предписано процедурой.

## Подтверждённые факты vs ограничения ручной проверки
- Подтверждено (инструментальные ответы + audit + snapshot-ы): маскирование password, refs/click, approval-жизненный цикл (approve/reject/expired/new request), Autonomous-режим, отсутствие утечек маркеров и контента, структура audit-полей, права 600.
- Не подтверждено/недоступно: helper-автопроверка, H6, значения requestedAt/resolvedAt, содержимое UI Tray помимо слов человека, requestId в success-ответах.

Тестовые вкладки и значения полей после проверки не удалялись и не очищались.


---

## Source follow-up: crot-run5-followup.md

## CROT WP-24 Run 5 — follow-up отчёт

Дата: 2026-10-13, локальный часовой пояс UTC+3 (времена инструментов — UTC)
Отчёт составлен после завершения H6 (B1–B7); новые браузерные тесты не запускались.

---

### 1. Среда

- **Код (SHA):** `32334aa18a996204bbb53824e6fae3728ad49ebe`
  (короткий `32334aa`, «Merge pull request #25 from mysteriumpersonae/wp-24-manual-run-3-fixes», коммит 2026-10-13T20:31:01+03:00).
  Источник: `git rev-parse HEAD` в `~/Desktop/crot-mcp` на момент составления отчёта.
  Ограничение: верифицирован HEAD на время отчёта; что весь run 5 прошёл именно на этом коммите, напрямую не доказано.
- **Браузер:** Google Chrome 153.0.0.0, CROT Browser Extension 0.1.0; CROT 0.1.0, mode sandbox; service running (PID 928974).
- **Preset-траектория (все переключения — вручную человеком через Tray, source: device):**
  исходно `autonomous-browser` → `require-approval` (Ask, для H1–H4) → `autonomous-browser` (H5) → `require-approval` (подготовка H6) → `autonomous-browser` (восстановление, B7).
- **approvalUis:** 1 во всех проверках, кроме окна H6 B4–B5, где подтверждено **0** (providers 0); после B6–B7 — снова 1.
- **Audit log:** `$HOME/.local/state/crot/logs/audit.jsonl`, режим `600`, владелец `[OS user]`.
  Проверенный интервал основной части: baseline 1413 строк (`2026-10-13T21:11:48+03:00`) → 1462 строки (конец `2026-10-13T21:30:15+03:00`), т.е. строки 1414–1462 (49 событий, timestamps 18:12:57.130Z–18:28:20.182Z).
  Интервал H6 (дочитан после, только чтение): строки 1463–1478 (16 событий, 18:57:13.146Z–19:05:39.575Z). Итого в файле 1478 строк.

### 2. Первый `BROWSER_PAGE_RESTRICTED` (блок G5.2)

Один `execute`-конверт содержал два вызова; инициатор ошибки — snapshot, а не tab_open (установлено по audit):

- **`browser_tab_open { url: "https://the-internet.herokuapp.com/add_remove_elements/" }`** — audit L1422: `ts 18:15:51.171Z`, outcome **success**, **durationMs 20075**, requestId `3967e93f-d2f1-428c-ae2b-39d71161516e` → создана вкладка **706392343**.
- **`browser_snapshot { tabId: 706392343 }`** — audit L1423: `ts 18:16:11.273Z`, outcome **error**, **durationMs 14**, requestId `16e399d2-3134-43f4-90b6-d16c4f1c955f`. Полный фактический ответ ошибки (полей `details` нет ни в ответе сессии, ни в audit):
  ```json
  {"error": {"code": "BROWSER_PAGE_RESTRICTED", "message": "CROT can only access http: and https: pages."}}
  ```
- **Успешный retry:** тот же `browser_tab_open`, audit L1424: `ts 18:16:15.780Z`, success, durationMs 4990, requestId `e6bca21b-b26a-41de-b883-957f8827f036` → вкладка **706392344** (подтверждена snapshot L1425 и всей последующей работой).
- ⚠️ **Причина не доказана:** audit не фиксирует URL/документ вкладки в момент snapshot (правдоподобно — ещё не закоммиченный about:blank через 14 мс после 20-секундного tab_open, но это гипотеза). Почему первая попытка заняла 20075 ms, а retry 4990 ms — неизвестно.
- ⚠️ **Судьба вкладки 706392343 не проверена:** в audit нет ни одного последующего события с этим tabId и нет `browser.tab_close`; текущее состояние вкладки не проверялось.
- Тот же паттерн воспроизвелся один раз при подготовке H6 (см. §4): L1464/L1465, вкладка 706392352.

### 3. Уточнения run 5

- **Подтверждены ровно ДВЕ пары `kind=approval → результат операции`:**
  1. H1 `browser.click` — audit L1440 (kind=approval, requestId `853d7b00399b922de0b6033ce2d1fcbe`, approved) → L1441 outcome success → Delete 0→1;
  2. H4.1 `browser.set_checked` — L1451 (kind=approval, requestId `e5d74a87dabd82d3d5d0bc5e65a73cb5`, approved) → L1452 outcome success → Bike checked.
- **Прежнее утверждение о «трёх парах» исправлено:** отказные события (H3 click ×3, H4.2 set_checked — L1443/L1445/L1448/L1455) записаны как одиночные события со встроенным объектом `approval` (status rejected/expired, outcome denied, PERMISSION_DENIED) — отдельного `kind=approval`-события у них нет. Их доказательная сила сохраняется, но в счёт «пар» они не идут.
- Сокращённые ответы (например, обёртки execute с t0/t1 или сводки) не назывались полными; полными помечены только фактически возвращённые инструменты целиком объекты.

### 4. H6 — fail-closed без Approval UI (B1–B7)

- **До отключения Tray (B1–B2):** preset `require-approval`, approvalUis 1, service running, browser connected; тестовая вкладка **706392355** (`https://the-internet.herokuapp.com/add_remove_elements/`), Delete = 0, свежий ref Add Element `e111`.
  ⚠️ При открытии вкладки воспроизвелся transient-паттерн §2: L1464 tab_open success 20054 ms → вкладка 706392352; L1465 snapshot error BROWSER_PAGE_RESTRICTED 2 ms; retry L1466 (success, 1155 ms) → рабочая вкладка 706392355. После переключения в Ask — повторный snapshot: Delete = 0, ref `e111` (L1469).
- **Tray завершён (B3–B4, 19:02:15.913Z):** approvalUis **0** (providers 0), preset остался `require-approval`, service running, browser connected — с первой проверки.
- **Единственный запрещённый клик (B5, 19:02:20.287Z → 19:02:20.301Z):**
  - `browser_click { tabId: 706392355, ref: "e111" }`, фактическая длительность **13 ms**;
  - полный ответ: `PERMISSION_DENIED`, message «…the request could not be shown to the user (no approval UI is connected). The operation was not executed…», `details.operation: "browser.click"`, `details.approval.requestId: 57845108dc20a5c5a34fc400bbb5fcc3`, `details.approval.status: "unavailable"`;
  - audit L1470: outcome denied, dur 1 ms, approval reqId/status совпадают;
  - **страница не изменилась:** snapshot 19:02:24 — Delete = 0, `e111` на месте (L1471); browser connected (L1472).
- **Восстановление (B6–B7):** Tray запущен человеком (`npm run tray`, одна копия); approvalUis снова 1 (19:05:09); preset вручную возвращён в `autonomous-browser` (19:05:35, confirmation crot_status); контрольный клик `browser_click { tabId: 706392355, ref: "e111" }` — **459 ms** (audit L1476: success, 447 ms), без approval-запроса → **ровно один новый Delete** (`e113`, Delete = 1, L1477); browser connected.
- Итог: fail-closed подтверждён в обе стороны — без UI действие мгновенно блокируется (`unavailable`), после восстановления Tray/preset исполнение мгновенное.

### 5. Итог и ограничения

- **H6 — ✅** пройден полностью (B1–B7), включая отрицательный тест и восстановление окружения.
- **Transient `BROWSER_PAGE_RESTRICTED` — ⚠️:** повторился дважды (вкладки 706392343 и 706392352, оба раза после ~20-секундного tab_open и с мгновенным (2–14 ms) snapshot-отказом); причина неизвестна (audit не фиксирует состояние документа вкладки), оба раза retry успешен, брошенные вкладки не проверялись.
- **Состояние тестовых вкладок на момент отчёта:** 706392355 — открыта, Delete = 1 (после контрольного клика B7); 706392343/706392352 — не проверялись; вкладки не закрывались и поля не очищались.
- **Прочие ограничения:** requestId в success-ответах инструментов не возвращается (извлекается из audit); requestedAt/resolvedAt в audit присутствуют, но их значения не извлекались; поля Tray-UI при approve проверялись визуально человеком; helper-скрипт `crot-run5-audit-check.py` отсутствовал — аудит-проверки основной части выполнены вручную.
- **Полную приёмку WP-24 этот отчёт не заявляет.** Он фиксирует результаты run 5 (G5.1–G5.3, H0–H6) и открытые пункты: причина transient-ошибки, состояние брошенных вкладок, приёмочные процедуры вне данного прогона.


---

## Developer review / provenance

Sources: owner's crot-run5-report.md and crot-run5-followup.md, retained except
OS username/path redaction. The original "three pairs" claim is corrected by the
follow-up to exactly TWO (H1/H4.1). Abbreviated responses remain source summaries.
The owner, not the developer, inspected the host's audit file and tray UI.
A missing helper does not invalidate equivalent checks of a real new audit interval.
G5/H0–H5 and H6 are reported passed. H6: approvalUis=0, require-approval,
PERMISSION_DENIED/unavailable in 13 ms, Delete=0; restored UI/preset, one click in
459 ms, Delete=1. SHA 32334aa was verified at report time, not proven for every
prior test action. No requestId in a success response is not itself a defect.

The failed operation was SNAPSHOT, not tab_open. Both opens consumed about the
20 s default budget before the snapshot's non-http restriction. The actual
committed documents and fate of the owner's abandoned tabs are unknown.

### Confirmed local mechanism / fix

A real Chromium local fixture holds its first HTTP response headers for 23 s.
Before the fix, default browser_tab_open returned in 20045 ms with tabId and
pending HTTP URL but NO loadTimedOut flag. Immediate snapshot returned the exact
same BROWSER_PAGE_RESTRICTED message; once committed, snapshot worked in the
SAME tab. This proves the mechanism, not why the real site stalled on the PC.
Unit tests also reproduced missing flags for default open and legacy navigate.

The default/legacy load waiter now reports completion vs expiry; loaded() sets
loadTimedOut:true on expiry, as explicit waitUntil/timeoutMs already did. Loading
continues. No access to about:blank/chrome:// is allowed, no retries/replacement
tabs/deletions are introduced and no budget is enlarged. Returned URL can be the
pending destination, not the committed page. Observe the SAME tab with tabs_list;
once its HTTP navigation finishes, take a fresh snapshot. A permanently stalled
or restricted final document still fails normally.

Local checks completed: npm run check exit 0 (core 1411 passed / 99 skipped;
extension 147/147 passed; lint/format/types/builds). Full real-Chromium E2E:
31 passed / 3 skipped. The delayed-commit case now returns loadTimedOut:true
in 20022 ms; restricted snapshot remains enforced and the same tab later works.
Before the fix, the focused E2E and two timeout-flag unit assertions failed.
CI is recorded in the PR after completion, not inferred from local results.
Owner G5/H evidence is not relabelled as a local test.
WP-24 acceptance stays open for manual timeout signalling verification, C1's
partial/unreproduced incident and final owner review. ARCHITECTURE.md and
WP-25/26/27 are unchanged.
