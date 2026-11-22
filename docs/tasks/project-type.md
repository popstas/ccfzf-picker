# Тип проекта: work, home и свои группы — дизайн

> План — ниже, в разделе «План» (появится после утверждения дизайна).

## Зачем

Стас 22.11: проекты делятся на группы — по умолчанию `work` и `home`, но
список не закрыт. Нужно видеть активные сессии сгруппированными по типу
проекта и быстро размечать проекты, у которых типа ещё нет. Сейчас тип живёт
только в дашборде claude-otel (переменная `work_projects`), и связке claude-wt
он неизвестен.

## Цели

- Тип проекта — поле записи в `claudeWt.projects` у windows11-manager.
- Тип доезжает до пикера и у проекта, и у каждой его сессии.
- В активных сессиях — необязательная группировка по типу, вместо деления по
  машинам.
- Быстрый выбор типа из `^K`, в том числе для проекта, которого в
  `claudeWt.projects` ещё нет.
- Начальная разметка — один раз из `work_projects` claude-otel.

## Не цели

- Запасной источник типа без менеджера (Стас 22.11: связка плотнее, без
  менеджера типов нет).
- Синхронизация с дашбордом claude-otel после переноса, метка `project_type` в
  телеметрии — отдельной задачей на потом (Стас 22.11).
- Группировка истории и списка проектов по типу: просили про active sessions.
- Ввод нового имени типа в пикере.

## Анти-цели

- Выключенная галка группировки меняет раскладку — нельзя: без неё список
  обязан быть ровно сегодняшним.
- Быстрый выбор портит `config.yaml` менеджера (комментарии, кодировка,
  соседние ключи) — правка обязана быть точечной, как у `patchProjectIcons`.
- Тип молча теряется на одном из звеньев (`normalizeProjects` выбрасывает
  неизвестные ключи, `read_windows` и `buildWindowsFile` пропускают запись без
  `hotkey`/`icon`) — каждое звено расширяется, и у каждого свой тест.

## Ограничения

- Пикер обязан жить со старым агрегатором и старым менеджером: нет поля — нет
  типа, группировка складывает всё в `untyped`.
- `;` в удалённых командах не ставить; имён машин в репозиторий не класть
  (CLAUDE.md).
- Видимые строки по-английски, комментарии и тесты по-русски.
- Живой конфиг менеджера — `%APPDATA%\windows-mqtt\windows11-manager.config.yaml`
  на Windows-цели; ручная правка — `scp`, бэкап `.bak-<дата>-<суть>`, `cmp` после
  заливки (скилл claude-wt). Менеджер перечитывает конфиг по mtime.
- ccfzf сейчас — зона `.cli-ccfzf` (соседний head (имя — в `data/head-picker-ideas.md`)), windows11-manager —
  зона `.cli-manager` того же head. Работу в них согласовать с
  соседним head.

## Подходы

Источник выбран Стасом, и от него путь один — тот, каким уже едут хоткей и
иконка: конфиг менеджера → файл трекера (`projects[]`) → `read_windows` в ccfzf
→ `merge_project_hotkeys` → `--state` → пикер.

Решалось, где клеить тип к сессии:
- **в ccfzf — выбран.** Он знает `owners_of`: сессию из подкаталога относит к
  проекту-предку. В пикере есть только точное совпадение `cwd`.
- в пикере — отвергнут: второй, худший разбор того же отношения.

Решалось, как пикер просит записать тип:
- **новая команда менеджера `claude-project-type` по http и MQTT — выбран**, по
  образцу `claude-session-unread` (без ответа; результат виден по файлу трекера
  на следующей публикации — `type` входит в `windowsFingerprint`).
- запись в конфиг через CLI трея (`claude-wt config set`) — отвергнут:
  доступен только трею на той же машине, и не создаёт новую запись.

Раскладка (Стас 22.11) — **A, тип вместо машин**: при включённой группировке
живые сессии делятся на секции по типу, машину называет колонка строки.

## Решено Стасом

- Тип в `claudeWt.projects`, без запасного источника (22.11).
- Группировка — тип вместо деления по машинам (22.11).
- claude-otel — один раз перенести `work_projects` в `type: work`, дальше
  дашборд живёт сам (22.11).
- Пункт `^K` у проекта и у сессии; неразмеченный проект менеджер дописывает в
  `claudeWt.projects` сам (предложено head, принято 22.11).
- Без типа — секция `untyped` последней; ключи секций постоянные
  `type:<имя>` (предложено head, принято 22.11).
- Галка группировки — в окне настроек, умолчание «выключено» (предложено
  head, принято 22.11).
- **Неразмеченный проект дописывается в `claudeWt.projects` как есть**
  (вариант C, 22.11), без пометки и без отдельной карты. Цена названа и
  принята: `claudeWt.projects` — ещё и белый список `POST
  /claude-wt/session-new` (запуск агента с `ssh -A`, `rootPass`/`headCwd` в
  `src/claude-wt/session-new-helpers.js`), а http-путь без авторизации; значит,
  любой клиент сети сможет сначала поставить тип каталогу, потом запустить в
  нём агента. Отвергнуты: A — отдельная карта `claudeWt.projectTypes`, B —
  пометка `typeOnly`. Обязательный минимум остаётся: `cwd` — абсолютный путь
  без символов из `UNSAFE` того же `session-new-helpers.js`, иначе отказ.

## Как устроено

**Менеджер (windows11-manager).**
- `normalizeProjects` (`src/claude-wt/project-helpers.js`) сохраняет `type` —
  строка, обрезанная, в нижнем регистре; пустая — нет поля.
- `buildWindowsFile` (`src/claude-wt/windows-file-helpers.js`) везёт `type` в
  `projects[]`; фильтр записи — `hotkey || icon || type`; `type` входит в
  `windowsFingerprint`. `signalPrint` не трогать.
- Команда `claude-project-type`, тело `{ cwd, type }`; `type: null` или `""` —
  снять тип. Запись есть по `cwd` — точечная правка поля `type`
  (`patchConfigScalar`, как `patchProjectIcons`). Записи нет — дописать элемент
  `{ name: <basename cwd>, cwd, type }` в конец `claudeWt.projects` новым
  патчером, сохраняющим остальной текст файла; атомарно (`writeFileAtomic`).
  Секции `claudeWt.projects` нет вовсе — отказ с причиной в логе, файл не
  тронут. http-путь `/claude-wt/project-type` в `ROUTES` (`src/http-server.js`);
  MQTT — топик `<base>/windows/claude-project-type` (роутер даёт сам).
- Форма настроек трея (`formExtras`, `_projects`) показывает `type`.

**Агрегатор (ccfzf).**
- `read_windows`: фильтр записи — `hotkey or icon or type`; `type` едет дальше.
- `merge_project_hotkeys`: к строке проекта клеит `type`. Синтетическую строку
  проекта по-прежнему заводит только хоткей.
- Строка сессии получает `projectCwd` и `projectType` (решение head после
  проверки — `owners_of` знает только закладки `~/.fzf-marks`, а не
  `claudeWt.projects`, и в пикере пути владельца нет: `STATE_DROP` вырезает
  `projects`). `projectCwd` — ближайший предок `cwd` сессии (включая его самого)
  среди записей `projects[]` из файла трекера, по границе сегментов пути;
  нет такого — ближайшая закладка из `owners_of`; нет и её — свой `cwd`.
  `projectType` — `type` записи `projects[]` с этим `cwd`, если есть. Пустые
  поля не пишутся (`state_record`).
- Релиз ccfzf, сабмодуль в пикере.

**Пикер.**
- `state-shape.js`: необязательные `projects[].type`, `sessions[].projectType`
  — строки.
- `buildProjectList` несёт `type`; `session-list.js` — `projectType`.
- Ключ `groupByProjectType: false` в `config-shape.js`, галка в окне настроек
  `Group active sessions by project type`.
- `groupSessions` при `groupByProjectType` делит **живые** сессии не по
  машинам (`activeGroups`), а по типу: группы `type:<имя>` с подписью `<имя>`,
  порядок `work`, `home`, прочие по алфавиту, `type:untyped` (подпись
  `untyped`) последней. Секция `nowindow` (`onlyWindow`), история и zellij — как
  сегодня. Префиксы `/l` и `/r` сохраняют смысл: отбирают сессии своей/чужих
  машин, а внутри результата группировка та же — по типу.
- `buildSections` (решение head после проверки): типовые секции — **один блок
  на месте `live`**. Ключ `type:*` в сохранённом порядке не живёт: блок встаёт
  туда, где в `order` стоит `live`, а внутри блока порядок фиксирован (`work`,
  `home`, прочие по алфавиту, `untyped`). В широкой раскладке весь блок — в
  колонке `live` (`COLUMN_LIVE`); колонка `remote` при группировке пустеет и,
  как сегодня пустая, не рисуется. Якорь `nowindow` (`FOLLOWS` → `live`)
  ставится за последней типовой секцией. Перетаскивание типовой секции
  двигает весь блок, как двигало бы `live`. Свёрнутость — по ключу `type:<имя>`
  в `ui.json` (здесь непостоянство ключа не страшно: свёрнутость не порядок).
  Без этого правила `placeOf`/`applyNarrowOrder` (`picker-sections.js`)
  унесли бы незнакомые ключи в конец — та самая цена, из-за которой
  `remote:<host>` склеили в `remote` (`docs/rules/layouts.md`).
- `^K`: пункт `Type` у строки проекта и у строки сессии, раскрывается в список
  типов: `work`, `home` и все типы, встреченные в `projects[]`, плюс `none` —
  снять тип. Текущий отмечен. Выбор у строки проекта ставит тип её `cwd`; у
  сессии — её `projectCwd`. Просьба уходит **менеджеру своей машины**
  (`CONFIG.windowHost`; решение head после проверки — у строки проекта окна
  нет, и рассылка `unread` по трекерам окна тут не годится), тем же
  транспортом: http менеджера этой машины, иначе MQTT (`manager_http.rs`
  `ROUTES`, `mqtt.rs`, команда в `main.rs`). Без дороги до него пункта нет.
  Оговорка: `projects` ccfzf берёт у одного трекера (первого с непустым
  списком, `read_all_windows`); живой трекер сегодня один, и при втором
  менеджере со своим `claudeWt.projects` тип мог бы записаться не туда, откуда
  читается, — это в PR вопросом, не чинить.

**Начальная разметка.** Один раз, руками исполнителя на выкатке: прочитать
regex `work_projects` из дашборда claude-otel (скилл `claude-otel`), сопоставить
значения метки `project` с проектами `claudeWt.projects` и каталогами сессий,
поставить `type: work` через новую команду (она же допишет недостающие
записи). Остальным тип не ставить — их Стас разметит из `^K`.

## Что оставлено исполнителю

- Имена внутренних функций и патчера YAML.
- Подписи подсказок в окнах настроек.
- Как именно раскрывается список типов в `^K` (вложенное меню или строки
  `Type: work` подряд) — по тому, как в `session-actions.js` уже устроены
  составные пункты.

---

## План

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** тип проекта из `claudeWt.projects` доезжает до пикера, группирует
активные сессии и ставится из `^K`.

**Architecture:** три репо по цепочке хоткея. windows11-manager хранит и пишет
тип, ccfzf клеит его к проектам и сессиям, пикер группирует и просит записать.
Задачи идут по цепочке: каждое звено выкатываемо само, старый получатель новое
поле молча пропускает.

**Tech Stack:** windows11-manager — Node, `npm test` (vitest, тесты рядом с
кодом `src/**/*.test.js`); ccfzf — bash + Python, `python3 tests/test_*.py`;
пикер — ванильный JS (`npm test`) и Rust (`cd src-tauri && cargo test`).

**Spec:** раздел «Дизайн» выше.

## Global Constraints

- Форма данных: `projects[].type: string` (обрезан, нижний регистр, пустой — нет
  поля); `sessions[].projectCwd: string`, `sessions[].projectType: string`.
- Команда менеджера `claude-project-type`, тело `{ cwd: string, type: string |
  null }`; http `/claude-wt/project-type`; MQTT `<base>/windows/claude-project-type`.
- `cwd` в команде — абсолютный путь без символов `UNSAFE`
  (`src/claude-wt/session-new-helpers.js:26`) и без управляющих; иначе отказ,
  файл не тронут.
- Типы `untyped` и `none` зарезервированы: команда их значением `type` не
  принимает (`none` в меню — это `type: null`).
- Ключ пикера `groupByProjectType`, умолчание `false`; подпись `Group active
  sessions by project type`.
- Видимое — по-английски, комментарии/тесты/`assert` — по-русски.
- Зоны: windows11-manager — `.cli-manager`, ccfzf — `.cli-ccfzf` (соседний head, имя — в
  `data/head-picker-ideas.md`). До начала Task 1 и Task 3 согласовать с соседним head,
  работать в своих ветках.

## Review Focus

- Выключенная группировка: раскладка в точности сегодняшняя — сторож на
  `buildSections` без опции (Task 5).
- `config.yaml` менеджера с комментариями и кириллицей: после записи типа
  меняется одна строка (или добавляется один элемент), остальное совпадает
  побайтно (Task 2).
- Старый агрегатор без `projectCwd`: пункта `Type` у сессии нет, у проекта есть
  (Task 6).
- Сохранённый `order` без ключей `type:*` после перетаскивания блока: блок на
  месте `live`, не в конце (Task 5).
- Сессия в подкаталоге проекта (worktree) получает тип проекта-предка (Task 3).

---

### Task 1 (windows11-manager): тип в записи проекта и в файле трекера

**Files:**
- Modify: `src/claude-wt/project-helpers.js` — `normalizeProjects` (59-83).
- Modify: `src/claude-wt/windows-file-helpers.js` — сборка `projects`
  (128-140), `windowsFingerprint` (215-217); устаревший комментарий 117-118.
- Modify: `src/commands/claude-config-commands.js` — `formExtras`/`_projects`
  (40-78) отдают `type`.
- Test: `src/claude-wt/project-helpers.test.js`,
  `src/claude-wt/windows-file-helpers.test.js`,
  `src/commands/claude-config-commands.test.js`.

**Interfaces:**
- Produces: запись `{ name, cwd, hotkey?, icon?, profile?, type? }`; запись
  трекера `{ cwd, name, hotkey?, icon?, type? }`.

- [ ] **Step 1: failing tests**: `type: ' Work '` → `'work'`; `type: ''` — поля
  нет; запись с одним `type` едет в `projects`; смена `type` меняет
  `windowsFingerprint`; `_projects` несёт `type`.
- [ ] **Step 2:** `npm test` — падают.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** `npm test` — зелёные.
- [ ] **Step 5: commit** `feat(claude-wt): тип проекта в claudeWt.projects и файле трекера`.

### Task 2 (windows11-manager): команда `claude-project-type`

**Files:**
- Modify: `src/commands/claude-config-commands.js` — запись типа рядом с
  `patchProjectIcons` (85-100).
- Create или Modify: патчер дописывания элемента списка рядом с
  `src/commands/config-scalar-patch.js` (тот вложенных секций не создаёт).
- Modify: `src/commands/claude-commands.js` — обработчик рядом с
  `'claude-session-unread'` (365).
- Modify: `src/http-server.js` — `ROUTES`: `'/claude-wt/project-type':
  'claude-project-type'`.
- Test: тест патчера, `src/commands/claude-config-commands.test.js`,
  `src/commands/claude-commands.test.js`, `src/http-server.test.js`.

**Interfaces:**
- Produces: `setProjectType({ cwd, type }) → { ok: true, added: boolean } | {
  ok: false, reason: string }`.
- Запись есть — `patchConfigScalar(text, 'claudeWt.projects.<i>', 'type',
  value)`; `type: null` — убрать строку поля. Записи нет — дописать в конец
  `claudeWt.projects` элемент `name: <basename cwd>`, `cwd`, `type` с отступом
  соседей. Секции нет — отказ. Запись — `writeFileAtomic`.

- [ ] **Step 1: failing tests**: правка у существующей записи меняет одну
  строку (исходник с комментариями и кириллицей); снятие типа убирает строку;
  неизвестный `cwd` дописывается, остальное не тронуто; `cwd` с `;` и
  относительный — отказ, файл побайтно прежний; `type: 'untyped'` — отказ; нет
  секции — отказ; `POST /claude-wt/project-type` доходит до команды.
- [ ] **Step 2:** `npm test` — падают.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** `npm test` — зелёные.
- [ ] **Step 5:** `AGENTS.md` менеджера — команда, топик, путь и оговорка про
  белый список `session-new` (решение Стаса C, 22.11).
- [ ] **Step 6: commit** `feat(claude-wt): команда claude-project-type`.

### Task 3 (ccfzf): `type` у проекта, `projectCwd`/`projectType` у сессии

**Files:**
- Modify: `ccfzf` — `read_windows` (проекты 968-997, фильтр 988),
  `merge_project_hotkeys` (3220-3273), вывод строки проекта (4267-4276), строка
  сессии (`sessions.append`, около 4150-4200).
- Modify: `README.md` ccfzf — поля.
- Test: `tests/test_project_type.py` (новый).

**Interfaces:**
- Produces: `project_owner(cwd, projects, marks) -> str` — ближайший предок по
  сегментам пути среди `projects[].cwd`, иначе ближайшая закладка
  (`owners_of`), иначе `cwd`.

- [ ] **Step 1: failing tests**: запись трекера с одним `type` не
  выбрасывается; у строки проекта `type`; сессия в `<проект>/sub/wt` →
  `projectCwd == <проект>` и его `projectType`; `/a/bc` не потомок `/a/b`;
  сессия под закладкой вне проектов → `projectCwd` закладки, без
  `projectType`; синтетическую строку проекта `type` не заводит.
- [ ] **Step 2:** падают.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** зелёные, соседние тоже.
- [ ] **Step 5: commit** `feat: тип проекта и проект-владелец сессии в --state`;
  релиз ccfzf по его правилам.

### Task 4 (пикер): поля и настройка

**Files:**
- Modify: `vendor/ccfzf` — релиз Task 3.
- Modify: `frontend-src/state-shape.js` (`PROJECT_FIELDS`, 90-105, и поля
  сессии), `frontend-src/project-list.js` (`buildProjectList`, 51-100),
  `frontend-src/session-list.js` (`projectCwd`, `projectType` — строка или `''`),
  `frontend-src/config-shape.js` (`groupByProjectType: false`),
  `frontend-src/settings-form.js` (поле `bool`).
- Test: `test/state-shape.test.js`, `test/project-list.test.js`,
  `test/session-list.test.js`, `test/config-shape.test.js`,
  `test/settings-form.test.js`.

- [ ] **Step 1: failing tests**: поле есть — доехало, мусор/нет — пусто;
  умолчание `groupByProjectType === false`.
- [ ] **Step 2–4:** падает → реализовать → `npm test` зелёный.
- [ ] **Step 5: commit** `feat: тип проекта в данных пикера и настройка группировки`.

### Task 5 (пикер): группировка по типу

**Files:**
- Modify: `frontend-src/session-groups.js` — `groupSessions` (233-290),
  `activeGroups` (373-406).
- Modify: `frontend-src/picker-sections.js` — `buildSections` (157+), склейка
  `remote` (183-195), `placeOf`/`applyNarrowOrder`/`applyWideOrder` (около
  406-431), `FOLLOWS`.
- Modify: `sessions.html` — `regroup()` подаёт `CONFIG.groupByProjectType`.
- Modify: `docs/rules/layouts.md` — правило про блок типов; счёт в указателе
  CLAUDE.md.
- Test: `test/session-groups.test.js`, `test/picker-sections.test.js`.

**Interfaces:**
- Produces: группы `{ key: 'type:<имя>', label: '<имя>', typeBlock: true }` —
  только для живых сессий, вместо `live` и `remote:<host>`; порядок `work`,
  `home`, прочие по алфавиту, `type:untyped` (`label: 'untyped'`) последней.

- [ ] **Step 1: failing tests**: без опции — `groupSessions` и `buildSections`
  в точности как сегодня (на существующем фикстуре); с опцией — `host-a`/`work`,
  `host-b`/`work`, без типа → `type:work` (обе машины) и `type:untyped`, групп
  `live`/`remote:*` нет; порядок `work`, `home`, `alpha`, `untyped`; `order`
  `['past', 'live', 'projects']` → блок между `past` и `projects`,
  перетаскивание блока пишет ключ `live`; широкая — все `type:*` в колонке
  `live`; `nowindow` за последней типовой; `/l` — свои по типу, `/r` — чужие.
- [ ] **Step 2–4:** падает → реализовать → `npm test` зелёный.
- [ ] **Step 5: commit** `feat: группировка активных сессий по типу проекта`.

### Task 6 (пикер): `Type` в `^K`

**Files:**
- Modify: `frontend-src/session-actions.js` — `availableActions`, ветка
  проекта (102-117) и сессии (рядом с `unread`, 180).
- Modify: `sessions.html` — `runAction` (около 4020-4047).
- Modify: `src-tauri/src/manager_http.rs` — пара в `ROUTES` (36-44) и `pub fn
  project_type`; `src-tauri/src/mqtt.rs` — публикация (образец
  `open_project`, 423-437); `src-tauri/src/main.rs` — `#[tauri::command]`
  (образец `unread_session_mqtt`, 1227).
- Test: `test/session-actions.test.js`, Rust-тест зеркала `ROUTES`
  (`manager_http.rs`, 308-318).

**Interfaces:**
- Produces: пункты `{ id: 'type:<имя>', label: 'Type: <имя>', checked }` и
  `{ id: 'type:none', label: 'Type: none' }` (или вложенное меню — см. дизайн).
- Цель — `CONFIG.windowHost`, транспорт — http, иначе MQTT. Нет дороги или у
  сессии нет `projectCwd` — пункта нет.

- [ ] **Step 1: failing tests**: у проекта пункт есть, текущий отмечен; у
  сессии без `projectCwd` — нет; без дороги — нет; типы = `work`, `home` ∪
  встреченные; Rust — пара в зеркале `ROUTES`.
- [ ] **Step 2–4:** падает → реализовать → `npm test` и `cargo test` зелёные.
- [ ] **Step 5:** `docs/rules/hotkeys-and-tray.md` — правило про `Type` (куда
  уходит, почему `windowHost`); счёт в указателе CLAUDE.md.
- [ ] **Step 6: commit** `feat: выбор типа проекта из ^K`.

### Task 7: выкатка, начальная разметка, живая проверка

Мак недоступен — пропущен (решение Стаса 14.11). Цели и исключённые машины —
в `data/scripts/` и в скилле claude-wt.

- [ ] **Step 1:** windows11-manager первым — `./data/scripts/deploy-pc.sh
  --no-build` на Windows-цель; `tasklist`, служба поднялась.
- [ ] **Step 2:** ccfzf на машине агрегатора — живой чекаут
  `~/projects/shell/ccfzf` на релиз (согласовать с соседним head).
- [ ] **Step 3:** пикер — `BRANCH=<ветка> ./data/scripts/deploy-win.sh` в фоне;
  штамп сборки.
- [ ] **Step 4: начальная разметка.** Бэкап живого конфига менеджера
  (`.bak-<дата>-project-type`). Прочитать `work_projects` из дашборда
  claude-otel (скилл `claude-otel`, «Work projects»). Каждому значению найти
  `cwd` (запись `claudeWt.projects` по имени, иначе каталог сессии с таким
  `project=`) и послать `claude-project-type` с `type: work`. Сопоставленное и
  несопоставленное — списком Стасу.
- [ ] **Step 5: живьём на Windows-цели.** `ccfzf --state | jq` — у проектов `type`, у
  сессий `projectType`. Галка в настройках включена — живые стоят секциями
  `work` / … / `untyped` на месте `Active`, обе машины вместе; выключена —
  раскладка прежняя. `^K` у неразмеченного проекта → `Type: home` — через пару
  секунд строка в `home`, в конфиге менеджера дописан элемент. `^K` у сессии в
  worktree — тип у проекта-предка. Перетащить блок — после перезапуска там же.
- [ ] **Step 6:** в PR — что проверено и что нет (мак; второй менеджер —
  вопрос из дизайна).
