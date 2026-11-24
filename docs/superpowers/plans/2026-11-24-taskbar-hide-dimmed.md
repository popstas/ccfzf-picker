# Погашенные сессии прячут кнопку на панели задач — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** при включённой опции `hideDimmedFromTaskbar` и галке `hide dimmed`
кнопки окон погашенных сессий этой машины убираются с панели задач Windows;
агент прячет и возвращает кнопку своего окна командой `claude-wt window
taskbar`.

**Architecture:** пикер раз в ответ опроса собирает набор погашенных сессий
своей машины и шлёт его менеджеру (как мигание кеша, `cache-warn.js`). Служба
windows11-manager сводит набор с явными отметками CLI и сигналами агента и
зовёт `ITaskbarList::DeleteTab`/`AddTab` по hwnd. Кнопки возвращает служба:
на старте (всем окнам терминалов — замер Task 2: `addTab` на показанной кнопке ничего не меняет), на `stop()`, по протуханию набора, пунктом трея.

**Tech Stack:** C++ N-API аддон (`vendor/node-window-manager`), Node + vitest
(windows11-manager), ванильный JS + `node --test` через `npm test` и Rust/Tauri
(ccfzf-picker), Node `.mjs` + `node --test tests/cli/*.test.mjs` (ccfzf).

**Spec:** `docs/superpowers/specs/2026-11-24-taskbar-hide-dimmed-design.md`
(в ccfzf-picker). Исполнители читают её целиком.

**Репозитории и ветки** — везде `feat/taskbar-hide-dimmed`:
- windows11-manager: `~/projects/js/windows11-manager` (Tasks 1–5)
- ccfzf-picker: `~/projects/js/ccfzf-picker` (Tasks 6–7; ветка уже есть, на ней спека)
- ccfzf: `~/projects/shell/ccfzf` — это живой чекаут, на него
  смотрит `~/bin/claude-wt`; работать в worktree, в `main` — только мержем (Task 8)

## Global Constraints

- Всё видимое человеку — по-английски (подписи, пункт трея, вывод CLI,
  `reason`); комментарии, имена тестов, `assert`/`expect` — по-русски.
- Опция: ключ `hideDimmedFromTaskbar`, умолчание `false`, только строгое `true`.
- Предикат «погашена» — ровно `StaleItems.isStale(row, nowSec, staleSettings(),
  'session', SessionWindows.minimizedHere(row, null, CONFIG.windowHost))`, как у
  `isDimmed` в `regroup()` (`sessions.html` ~2264).
- Сигнал человеку (кнопку не прятать): `agentState === 'question'`, либо
  `agentState === 'review' && !agentSeen`, либо (только в пикере) сессия в
  наборе мигания кеша.
- Протухание набора в службе: `TASKBAR_HIDE_TTL_MS = 20 * 60 * 1000`.
- Отправитель пикера: heartbeat 5 мин, пауза после отказа 60 с — те же
  `CACHE_WARN_HEARTBEAT_MS`/`CACHE_WARN_RETRY_MS`.
- id сессии в маршрутах службы — только UUID (`isSessionUuid`): http без
  авторизации.
- Бюджет опроса windows11-manager (AGENTS.md): без `getWindows()` и номера
  стола в цикле; сеть — только ради окон, которые спрятаны или идут прятаться.
- `;` в удалённых командах не ставить; имена машин в репозиторий пикера не
  класть (`test/no-private-data.test.js`).
- Тесты пикера — только `npm test`; оболочки — `cd src-tauri && cargo test`.
- Мак пропущен — недоступен (решение Стаса 14.11); popstas-pc не трогать.

## Review Focus

- **Служба убита `taskkill` с спрятанными кнопками** → на следующем старте они
  вернулись (Task 4: тест — старт зовёт `addTab` всем окнам терминалов).
- **Пикер выключен/убит, набор не обновляется** → через 20 мин кнопки
  вернулись (Task 4: тест TTL).
- **Explorer перезапущен** → спрятанные снова спрятаны (Task 4: тест смены
  `getTaskbarWindow`).
- **Набранный запрос в строке поиска** → набор не меняется (Task 6: тест —
  набор строится от `toggles.hideStale`, не от `activeFilters`).
- **Вернувшаяся кнопка без значка head и полосы** → после `addTab` иконки и
  полоса поставлены заново (Task 4: тест вызова `onShown`; Task 5: проводка в
  `resync` обоих модулей).

---

### Task 1: аддон — `deleteTab` / `addTab` (windows11-manager)

**Files:**
- Modify: `vendor/node-window-manager/lib/windows.cc` — рядом с
  `setTaskbarProgress` (~455) и регистрация в `exports.Set` (~681-695).
- Modify: `src/windows.js` (~40-100, рядом с `hasTaskbarControl`) и его экспорт.
- Test: тест рядом с существующими тестами `src/windows.js` (если нет —
  `src/windows-tabs.test.js`), аддон подменён объектом.

**Interfaces:**
- Produces (аддон): `deleteTab(hwnd) → boolean`, `addTab(hwnd) → boolean` —
  через `getTaskbarList()` (`ITaskbarList3` наследует `DeleteTab`/`AddTab`),
  `false`, если списка нет или `!IsWindow(hwnd)`.
- Produces (JS): `hasTabControl() → boolean` (`addon?.deleteTab &&
  addon?.addTab`), `deleteTab(id) → boolean`, `addTab(id) → boolean` — `false`
  без аддона, как `setTaskbarProgress`.

- [ ] **Step 1: failing test** «без аддона deleteTab/addTab отвечают false и не
  бросают»; «с аддоном передают hwnd как есть».
- [ ] **Step 2:** `npm test -- windows` — падает.
- [ ] **Step 3:** C++ и обёртки по Interfaces. Комментарий в `.cc`
  по-английски, как у соседей.
- [ ] **Step 4:** `npm test` — зелёное. Сборку аддона проверить нельзя на
  машина сессий — это Task 2.
- [ ] **Step 5: commit** `feat(addon): deleteTab/addTab — кнопка окна на панели задач`.

### Task 2: спайк на nb — что возвращает кнопку

Не код продукта: ответ на «перепрятывать по таймеру или по событию» (спека,
«Перепрятывание»). Результат — абзацем в AGENTS.md windows11-manager.

- [ ] **Step 1:** запушить ветку, `./data/scripts/deploy-pc.sh` (полная
  сборка; как пересобирается аддон — по AGENTS.md, при нужде `--install`).
  Проверить `tasklist`: трей жив, сессия `Console`.
- [ ] **Step 2:** одноразовый скрипт в `%TEMP%`, запуск **через `schtasks /ru
  popstas /it`** (из ssh, session 0, панели задач не видно): найти hwnd окна
  WezTerm и окна wt по заголовку, `deleteTab` обоим, вывод в файл.
- [ ] **Step 3:** глазами на nb (попросить Стаса, если нужно): после каждого
  действия — вернулась ли кнопка: свернуть/развернуть, смена заголовка (новый
  промпт), переход на другой рабочий стол и обратно, смена вкладки в wt,
  перезапуск explorer. Ещё: `addTab` уже показанной кнопке — переезжает ли она
  в конец; `setOverlayIcon`/`setTaskbarProgress` на спрятанной — `true` или
  `false`, вернутся ли они с `addTab`.
- [ ] **Step 4:** записать таблицу итогов в AGENTS.md (раздел про панель
  задач) и решение: если кнопка возвращается сама хоть от чего-то, кроме
  explorer, — `reapplyEveryTick = true` в Task 4, иначе `false`.
- [ ] **Step 5: commit** `docs: что возвращает кнопку после DeleteTab (замер на nb)`.

### Task 3: чистые помощники и хранилище (windows11-manager)

**Files:**
- Create: `src/claude-wt/taskbar-hide-helpers.js`, `src/claude-wt/taskbar-hide-helpers.test.js`
- Create: `src/claude-wt/taskbar-hide-store.js`, `src/claude-wt/taskbar-hide-store.test.js`

**Interfaces:**
- Produces (helpers, без I/O):
  - `parseHideSet(body) → Set<string>` — `body.sessions` массив строк-UUID,
    прочее молча отброшено; не объект — пустой набор.
  - `hasSignal({agentState, agentSeen}) → boolean` — по Global Constraints.
  - `nextExplicit(entry, agentState) → entry | null` — для `mode: 'hide'`:
    `agentState !== 'active'` → `{...entry, sawIdle: true}`; `entry.sawIdle &&
    agentState === 'active'` → `null`; иначе `entry`. `mode: 'show'` — как есть.
  - `wantedHidden({ sessions, set, explicitOf, signalOf }) → Set<hwnd>` —
    `sessions`: `[{id: hwnd, sessionId}]`; окно прячется, если
    `!signalOf(sessionId)` и (`explicitOf(sessionId)?.mode === 'hide'` или
    (нет явной и `set.has(sessionId)`)). `mode: 'show'` — не прячется.
  - `planTabs(hidden, wanted, present, reapply) → { remove: hwnd[], add: hwnd[] }`
    — `remove`: `wanted` минус `hidden` (при `reapply` — весь `wanted`), только
    `present`; `add`: `hidden` минус `wanted`, только `present`. Отсортированы.
- Produces (store): `createTaskbarHideStore({ file, now })` →
  `{ version, get(id) → {mode, hwnd?, sawIdle?} | undefined, set(id, mode |
  null), patch(id, fields), ids() → string[], clearAll() }`. Файл
  `data/session-taskbar.json` (журнала спрятанных hwnd нет — ruling после
  Task 2: старт возвращает кнопки всем окнам терминалов). Разбор терпимый, без прототипа (как
  `session-icons.js`: битый файл — пусто), запись `writeFileAtomic`. Записи без
  окна дольше 30 дней выбрасываются (`KEEP_MS` как у иконок).

- [ ] **Step 1: failing tests**:
  - `parseHideSet({sessions: [UUID, 'x', 5, '__proto__']})` → `Set{UUID}`;
    `parseHideSet(null)` → пустой.
  - `hasSignal`: question → true; review+unseen → true; review+seen → false;
    idle, active, null → false.
  - `nextExplicit`: hide на `active` без `sawIdle` → тот же; hide на `review`
    → `sawIdle: true`; hide с `sawIdle` на `active` → `null`; show на `active` → тот же.
  - `wantedHidden`: в наборе → спрятано; в наборе с сигналом → нет; явная
    hide вне набора → спрятано; явная hide с сигналом → нет; явная show в
    наборе → нет.
  - `planTabs`: закрытое окно не попадает ни в `remove`, ни в `add`; `reapply`
    повторяет уже спрятанные.
  - store: `set`/`get`/`set(id, null)` удаляет; переживает пересоздание из
    файла; битый файл → пусто; `clearAll` очищает и файл.
- [ ] **Step 2:** `npm test -- taskbar-hide` — падает.
- [ ] **Step 3:** реализовать по Interfaces.
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5: commit** `feat(claude-wt): помощники и хранилище прятания кнопок`.

### Task 4: служба прятания (windows11-manager)

**Files:**
- Create: `src/mqtt/taskbar-hide.js`, `src/mqtt/taskbar-hide.test.js`
- Modify: `src/mqtt/window-icons.js` — `resync(hwnds)`; `src/mqtt/taskbar.js` — `resync(hwnds)`.
- Modify: `src/mqtt/service.js` (~82-110, ~162) — завести, связать, остановить.

**Interfaces:**
- Consumes: Task 1 (`winMan.hasTabControl/deleteTab/addTab`), Task 3.
- Produces: `startTaskbarHide({ winMan, log, store, onShown = () => {},
  intervalMs = 3000, ttlMs = TASKBAR_HIDE_TTL_MS, now,
  setIntervalFn, clearIntervalFn })` → `{ tick(), setSet(body) → number,
  statusOf(sessionId) → {applied, reason?}, showAll() → number, stop() }`.
  Без `hasTabControl()` — заглушка с `reason: 'no taskbar tab support'` и
  одной строкой warn.
- Produces: `windowIcons.resync(hwnds)` — пометить значок этих окон
  `UNKNOWN` и сбросить `lastPrint`; `taskbar.resync(hwnds)` — убрать их из
  `applied`, чтобы следующий тик поставил вид заново.

Поведение (по спеке, раздел «Служба»):
- старт: `addTab` всем окнам терминалов (на показанной кнопке это no-op — замер
  Task 2, AGENTS.md), до первого тика;
- тик: окна терминалов (тот же отбор, что `terminalWindows()` в
  `window-icons.js`); если набор пуст/протух, явных отметок нет и спрятанного
  нет — выход без сети; иначе `claudeWtWindowSessions`, затем
  `claudeWtWindowAgents` только для кандидатов → `nextExplicit` (обновить
  store), `hasSignal` → `wantedHidden` → `planTabs` → вызовы; удавшееся —
  в `hidden`; вернувшиеся → `onShown(hwnds)`;
- явная отметка с `hwnd`, которого нет среди окон, — снимается (окно
  закрылось); без `hwnd` — получает его, когда окно сессии появилось;
- смена `getTaskbarWindow()` — все спрятанные снова в `remove`;
- `setSet` заменяет набор и время; набор старше `ttlMs` считается пустым
  (строка лога `taskbar hide: набор протух` один раз);
- `showAll`: `store.clearAll()`, набор пуст, `addTab` всем спрятанным;
- `stop`: таймер, `addTab` всем спрятанным;
- перепрятывание — `planTabs(..., reapply=true)` на тике со сменой
  `getTaskbarWindow()` (замер Task 2: кнопку возвращает лишь перезапуск
  explorer) и страховкой раз в `TASKBAR_REHIDE_MS = 60 * 1000` — на
  незамеренные события (сон, блокировка, мониторы), которые hwnd панели могут
  не сменить;
- лог: `taskbar hide: <hwnd> <sessionId> спрятана|возвращена`.

- [ ] **Step 1: failing tests** (winMan подменён, время — `now`):
  - «старт возвращает кнопки всем окнам терминалов» — `addTab` зовётся для
    каждого окна терминала и ни для какого другого окна;
  - «набор прячет, сигнал возвращает» — сессия в наборе → `deleteTab`;
    тот же hwnd с `agentState: 'question'` → `addTab` и `onShown([hwnd])`;
  - «набор старше 20 минут — кнопки вернулись»;
  - «смена hwnd панели задач — спрятанные спрятаны снова»;
  - «через 60 с без событий спрятанные прячутся снова, раньше — нет»;
  - «явная hide снимается новым ходом»: review → active → `addTab`, запись
    из store ушла; «явная hide переживает свой же ход»: active на первом тике
    → по-прежнему спрятана;
  - «закрытое окно снимает явную отметку»;
  - «showAll и stop возвращают всё»;
  - «пустой набор и нет отметок — сеть не трогается»
    (`claudeWtWindowSessions` не зван).
  - `window-icons.test.js`: `resync([id])` → на следующем тике значок этого
    окна ставится заново. `taskbar.test.js`: `resync([id])` → вид ставится
    заново.
- [ ] **Step 2:** `npm test -- taskbar-hide window-icons taskbar` — падает.
- [ ] **Step 3:** реализовать. В
  `service.js` `onShown: ids => { windowIcons?.resync(ids); taskbar.resync(ids) }`
  (`windowIcons` заводится позже — замыкание, как у `sessionIcons`).
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5: commit** `feat(mqtt): служба прятания кнопок погашенных сессий`.

### Task 5: команды, маршруты, пункт трея (windows11-manager)

**Files:**
- Create: `src/commands/taskbar-hide-commands.js` (+ `.test.js`) — по образцу
  `session-icon-commands.js`.
- Modify: `src/commands/build.js` (~25, ~148) — подмешать команды.
- Modify: `src/http-server.js` `ROUTES` (~20-45).
- Modify: MQTT-подписка — там же, где `claude-cache-warn`
  (`<base>/windows/claude-taskbar-hide`).
- Modify: `src/index.js` — подкоманда `claude-wt taskbar-show-all`: POST на
  `http://127.0.0.1:<httpPort>/claude-wt/taskbar-show-all`, вывод ответа.
- Modify: `tauri-app/src-tauri/src/lib.rs` — пункт `taskbar_show_all`
  «Show all taskbar buttons» рядом с пунктами claude-wt (~1969-1997),
  обработчик `run_node_command(app, &["src/index.js", "claude-wt",
  "taskbar-show-all"], "Show all taskbar buttons")`.
- Modify: `config.example.yaml` не нужен (ключей нет); AGENTS.md — абзац «кто
  возвращает кнопки и почему набор протухает».

**Interfaces:**
- Produces (команды):
  - `claude-taskbar-hide {sessions}` → `{ ok: true, count }` (журнал — только
    при смене `count`, как `claude-cache-warn`);
  - `claude-window-taskbar {id, taskbar: 'hide' | 'show' | null}` → не UUID —
    `{ok: false, reason: 'bad id'}`; иное значение — `{ok: false, reason: 'need
    hide, show or null'}`; иначе `store.set`, `service.tick()`, `{ ok: true,
    id, taskbar, ...service.statusOf(id) }`;
  - `claude-taskbar-show-all {}` → `{ ok: true, shown }`.
- Produces (маршруты): `/claude-wt/taskbar-hide`, `/claude-wt/window-taskbar`,
  `/claude-wt/taskbar-show-all`.

- [ ] **Step 1: failing tests**: три команды по Interfaces (подменённые store
  и сервис); `http-server.test.js` — три маршрута ведут в свои команды.
- [ ] **Step 2:** `npm test` — падает.
- [ ] **Step 3:** реализовать; Rust-пункт трея — `cargo build` в
  `tauri-app/src-tauri` проверяется на nb в Task 9.
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5: commit** `feat: маршруты прятания кнопок и пункт трея Show all taskbar buttons`.
- [ ] **Step 6:** push, PR в windows11-manager (не мержить без слова Стаса).

### Task 6: набор пикера и опция (ccfzf-picker)

**Files:**
- Create: `frontend-src/taskbar-hide.js` (UMD-шим как у `cache-warn.js`),
  `test/taskbar-hide.test.js`.
- Modify: `frontend-src/cache-warn.js` — `createCacheWarnSender` получает
  `emptyOf(body) → body` (умолчание — нынешнее `{warnMin, sessions: []}`).
- Modify: `frontend-src/config-shape.js` (DEFAULTS ~142, normalize ~439),
  `test/config-shape.test.js`.
- Modify: `frontend-src/settings-form.js` — вкладка `stale` (~178-195),
  `test/settings-form.test.js`.
- Modify: `sessions.html` — `<script src="taskbar-hide.js">` рядом с
  `cache-warn.js` (~885); отправитель и вызов рядом с `sendCacheWarn` (~2584-2610).
- Modify: `scripts/prepare-frontend.js`, если список файлов там явный;
  `test/frontend-load.test.js`, если он сверяет список.

**Interfaces:**
- Produces: `TaskbarHide.taskbarHideSets(rows, state, { enabled, configHost,
  isDimmed, warnIds }) → Map<key, {target, body: {sessions: string[]}}>` —
  `enabled === false` → пустая карта; иначе ровно одна цель — трекер своей
  машины (`{base: mqttBase окна своей машины || '', http:
  SessionWindows.httpForHost(state, configHost)}`; нет трекера своей машины —
  пустая карта), `sessions` — id по порядку, без повторов, строк с окном на
  своей машине (`normHost(w.host) === normHost(configHost)`), для которых
  `isDimmed(row)` и нет сигнала (`agentState === 'question'`, `agentState ===
  'review' && !agentSeen`, `warnIds.has(id)`). Пустой список при `enabled` —
  цель всё равно в карте (heartbeat держит службу в курсе).
- Produces: `CONFIG.hideDimmedFromTaskbar: boolean`.
- В `sessions.html`: `enabled = CONFIG.hideDimmedFromTaskbar &&
  toggles.hideStale && staleSettings().enabled === true`; `isDimmed` — тот же,
  что в `regroup()` (вынести в одну функцию страницы, не копировать); `warnIds`
  — id из `cacheWarnSets` того же ответа; строки — те же `rows`
  `buildSessionList`, что у `sendCacheWarn` (строить один раз на оба набора);
  цель без `http` при ненастроенном брокере отбрасывается, как у cache-warn.
- Поле формы: `{ id: 'hideDimmedFromTaskbar', label: 'Hide dimmed sessions
  from the taskbar', type: 'checkbox', default: false, hint: 'Needs "hide
  dimmed" in the status line. Windows, machines running windows11-manager.' }`.

- [ ] **Step 1: failing tests** в `test/taskbar-hide.test.js`:
  - «выключено — пустая карта»;
  - «погашенная сессия своей машины в наборе, чужой машины — нет»;
  - «вопрос, непросмотренный review и мигающая — не в наборе»;
  - «две карточки одной сессии — один id»; «id по порядку»;
  - «включено и прятать нечего — цель с пустым списком»;
  - `createCacheWarnSender` с `emptyOf` шлёт выбывшей цели `emptyOf(body)`
    (в `test/cache-warn.test.js`), без `emptyOf` — прежнее тело;
  - `config-shape`: умолчание `false`, `'yes'` → `false`, `true` → `true`;
  - `settings-form`: поле во вкладке `stale`;
  - «запрос не меняет набор»: в `test/row-contract.test.js` вычитать
    вычисление `enabled` из `sessions.html` (приём `regroupWith`) и проверить,
    что оно не зависит от `query`/`mode`.
- [ ] **Step 2:** `npm test` — падает.
- [ ] **Step 3:** реализовать по Interfaces; отправка — `invoke('taskbar_hide_send',
  { target, body })` (Task 7), `emptyOf: () => ({ sessions: [] })`.
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5: commit** `feat: набор погашенных сессий для панели задач и опция hideDimmedFromTaskbar`.

### Task 7: транспорт и правила (ccfzf-picker)

**Files:**
- Modify: `src-tauri/src/main.rs` — `taskbar_hide_send` по образцу
  `cache_warn_send` (~1237), регистрация в `invoke_handler`.
- Modify: `src-tauri/src/manager_http.rs` — `ROUTES` (~43)
  `("/claude-taskbar-hide", "/claude-wt/taskbar-hide")`, `pub fn
  taskbar_hide(endpoint, body)`, тесты рядом с `cache_warn` (~325, ~388).
- Modify: `src-tauri/src/mqtt.rs` — `TASKBAR_HIDE_TOPIC =
  "/claude-taskbar-hide"`, `pub fn taskbar_hide(broker, base, body)` по образцу
  `cache_warn` (~43, ~315).
- Modify: `test/manager-routes.test.js` — если сверяет маршруты с
  windows11-manager, дописать.
- Modify: `docs/rules/filtering.md` (рядом с `hideStale`), `docs/settings.md`,
  указатель в `CLAUDE.md` (счёт «Фильтры и режимы» +1, «О чём» —
  `hideDimmedFromTaskbar`).

- [ ] **Step 1: failing tests**: `route_for("/claude-taskbar-hide") ==
  Some("/claude-wt/taskbar-hide")`; плохой endpoint → `Err` (как у cache-warn).
- [ ] **Step 2:** `cd src-tauri && cargo test` — падает.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** `cargo test` и `npm test` — зелёное.
- [ ] **Step 5:** правило в `docs/rules/filtering.md`: набор следует за
  галкой, а не за `activeFilters`; только своя машина (два пикера — два
  хозяина); сигнал держит кнопку; кнопки возвращает служба.
- [ ] **Step 6: commit** `feat: транспорт набора панели задач до менеджера`; push, PR.

### Task 8: `claude-wt window taskbar` и скилл (ccfzf)

**Files** (worktree от `main` в `~/projects/shell/ccfzf`):
- Create: `cli/lib/commands/window-taskbar.mjs` по образцу
  `window-icon.mjs`; `tests/cli/window-taskbar.test.mjs` по образцу
  `window-icon.test.mjs`.
- Modify: `cli/claude-wt.mjs` — строка справки и `'window taskbar':
  cmd('window-taskbar')`; `docs/claude-wt.md`; `CHANGELOG.md` не трогать
  (git-cliff).
- Modify: `~/.claude/skills/claude-wt-cli/SKILL.md` — строка команды, когда
  звать, что `show` сильнее пикера, что `hide` снимается новым ходом и
  закрытием окна, повтор безопасен (код 3).

**Interfaces:**
- `claude-wt window taskbar <session> hide|show|auto` → POST
  `/claude-wt/window-taskbar` `{id, taskbar: 'hide'|'show'|null}` (`auto` →
  `null`) на машины окон сессии (`windowHosts`), как `window icon`.
- Вывод: `taskbar hidden|shown|auto for <title> on <host>`; не встало —
  `saved taskbar <mode> for <title>, not applied on <host>: <reason>`; 404 без
  `reason` — `manager has no /claude-wt/window-taskbar (old manager?)`.
- Иной второй аргумент — код 1, `need hide, show or auto`.

- [ ] **Step 1: failing tests**: три режима шлют верное тело; `auto` → `null`;
  плохой режим → код 1; нет окна → код 2; 404 → текст про старый менеджер.
- [ ] **Step 2:** `node --test tests/cli/*.test.mjs` — падает.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** тесты зелёные.
- [ ] **Step 5: commit** `feat(cli): claude-wt window taskbar hide|show|auto`; push, PR.

### Task 9: выкатка и живая проверка

Мак пропущен — недоступен (решение Стаса 14.11). Windows — nb.

- [ ] **Step 1:** windows11-manager первым: `BRANCH=feat/taskbar-hide-dimmed`
  `./data/scripts/deploy-pc.sh` (с пересборкой аддона, см. Task 2). Сверить
  `tasklist` (трей и два node-ребёнка, `ppid` — трей), в логе трея нет warn
  `no taskbar tab support`.
- [ ] **Step 2:** пикер: `BRANCH=feat/taskbar-hide-dimmed
  ./data/scripts/deploy-win.sh` в фоне; штамп сборки в трее — новый. Чужая
  ветка под ревью на nb — сборная `deploy/<a>-<b>`.
- [ ] **Step 3:** ccfzf: CLI на машине сессий живёт из `main` — до мержа проверять
  `node <worktree>/cli/claude-wt.mjs`.
- [ ] **Step 4: живьём на nb** — сценарии из раздела «Выкатка» спеки, каждый
  с итогом да/нет: опция + `hide dimmed` — кнопки погашенных пропали; свернуть
  живое — пропала, развернуть через Alt+Tab — вернулась; запрос в поиске —
  панель не меняется; снять галку — вернулись все; перезапустить трей —
  вернулись, затем спрятались снова, нетронутые кнопки на своих местах;
  `window taskbar <s> show` у погашенной — стоит; `hide`, затем новый промпт —
  вернулась; свёрнутое окно с вопросом агента — вернулось сразу; `Show all
  taskbar buttons` — вернулись все; значок head и полоса на вернувшейся кнопке
  на месте.
- [ ] **Step 5:** в PR каждого репозитория — что проверено живьём, что нет
  (мак), и какие коммиты легли после запуска выкатки.
