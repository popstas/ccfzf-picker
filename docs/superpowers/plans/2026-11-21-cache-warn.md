# Мигание кнопки окна перед остыванием кеша — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** за `cacheWarnMinutes` минут до конца кеша промпта кнопка окна WezTerm
мигает жёлтой полосой; 0 выключает, фокус снимает.

**Architecture:** пикер собирает набор `{warnMin, sessions:[{id, cacheAt}]}` на
каждый трекер и шлёт его, когда тот меняется, плюс раз в 5 минут. Шлёт той же
развилкой http/MQTT, что Mark seen. Служба windows11-manager заменяет свой набор
полученным, сама отсчитывает сроки по `cacheAt` и мигает полосой поверх вида
`planTaskbar`.

**Tech Stack:** windows11-manager — Node ESM, vitest. ccfzf-picker — фронтенд
UMD-модулями в `frontend-src/` (`node --test` через `npm test`), Rust/Tauri 2
(`cargo test`).

**Spec:** `docs/superpowers/specs/2026-11-21-cache-warn-design.md` в ccfzf-picker.
Для справки: `docs/superpowers/specs/2026-11-12-cache-timer-design.md` и правило
про таймер кеша в `docs/rules/list-rows.md`.

## Global Constraints

- Два репозитория, ветка `feat/cache-warn` в каждом. Пикер уже в worktree
  `~/projects/js/ccfzf-picker-cache-warn`. Для windows11-manager тоже нужен
  worktree, `~/projects/js/windows11-manager-cache-warn`: рабочие каталоги делят
  другие сессии, и смена ветки там увела бы чужие коммиты.
- Порядок: сначала windows11-manager (задачи 1–2, PR смержен), потом пикер.
  `test/manager-routes.test.js` пикера читает `../windows11-manager/src/http-server.js`
  основного checkout. Пока там нет `/claude-wt/cache-warn`, сторож красный, и
  это ожидаемо.
- Видимые человеку строки — по-английски; комментарии, названия тестов и
  `assert`-сообщения — по-русски (CLAUDE.md, «Язык»).
- Цвет литералом в стилях не писать: полей с цветом в задаче нет, но правило
  `test/theme.test.js` действует.
- Срок кеша: `CACHE_TTL_SEC = 3600`, запас `CACHE_SAFETY_SEC = 5` — те же
  значения, что в `frontend-src/session-glyph.js`.
- Мигание: фаза «вкл» — `TBPF.paused`, значение 100; период переключения
  `BLINK_MS = 750`.
- Признак нового хода: `agentState !== 'idle' && agentUpdated > cacheAt + 30`
  (`NEW_TURN_MARGIN_SEC = 30`).
- `cacheWarnMinutes`: целое 0…59, умолчание 10, 0 — выключено.
- Повтор набора: `CACHE_WARN_HEARTBEAT_MS = 5 * 60 * 1000`.
- Имена: http `POST /claude-wt/cache-warn`, команда `claude-cache-warn`,
  MQTT-хвост `/claude-cache-warn`, команда Tauri `cache_warn_send`.

## Review Focus

1. **Опоздавший набор.** Скрытый пикер прислал набор через 8 минут после
   порога, кеш ещё жив — мигание начинается на ближайшем тике службы, а не
   ждёт следующего порога. Тест — задача 1, `cacheWarnDue`.
2. **Ответ в последние минуты.** Человек ответил на 55-й минуте: сессия
   `active`, потом `review` с `updated` новее `cacheAt + 30`. Новый набор ещё не
   пришёл — мигание гаснет само и не зажигается на старом `cacheAt`. Тест —
   задача 1.
3. **Повтор того же набора после фокуса.** Пикер шлёт набор раз в 5 минут. Тот
   же `(id, cacheAt)` после снятия фокусом гореть снова не должен. Тест —
   задача 2.
4. **0 в настройке.** `cacheWarnMinutes: 0` не превращается в умолчание при
   нормализации, форма принимает 0. Пикер шлёт `warnMin: 0` с пустым списком,
   и уже мигающая кнопка гаснет. Тесты — задачи 1, 3 и 4.
5. **Конец мигания возвращает вид.** У `question` после мигания остаётся жёлтая
   22%, у `shell` — зелёная 2%, а не пустая кнопка. Тест — задача 1,
   `blinkBar`; задача 2, конец мигания.

---

### Task 1: windows11-manager — чистые правила мигания

**Files:**
- Modify: `src/claude-wt/taskbar-helpers.js`
- Test: `src/claude-wt/taskbar-helpers.test.js`

**Interfaces:**
- Produces:
  - `cacheWarnDue(warn, warnSec, nowSec, agent) → boolean`. `warn = {cacheAt}`,
    `agent = {agentState, agentUpdated} | null`.
  - `blinkBar(look, on) → {state, value}`. `look` — вид из `applied` или `null`.
  - `cacheWarnKey(sessionId, cacheAt) → string`, ключ снятия: `` `${id}:${cacheAt}` ``.
  - `parseCacheWarn(body) → {warnSec, warns: Map<sessionId, {cacheAt}>}`.
    Принимает строку JSON или объект. Кривое тело → `{warnSec: 0, warns: new Map()}`.
  - Константы `CACHE_TTL_SEC`, `CACHE_SAFETY_SEC`, `NEW_TURN_MARGIN_SEC`, `BLINK_MS`.

- [ ] **Step 1: Write the failing tests** в `taskbar-helpers.test.js`:

```js
describe('cacheWarnDue', () => {
  const at = 1_000_000, warnSec = 600, end = at + 3595;
  const waiting = { agentState: 'review', agentUpdated: at };
  it('мигает от порога до конца кеша', () => {
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 601, waiting)).toBe(false);
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 600, waiting)).toBe(true);
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 1, waiting)).toBe(true);
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end, waiting)).toBe(false);
  });
  it('опоздавший набор мигает сразу, если кеш жив', () => {
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 120, waiting)).toBe(true);
  });
  it('0 — выключено', () => {
    expect(cacheWarnDue({ cacheAt: at }, 0, end - 60, waiting)).toBe(false);
  });
  it('работающая сессия и новый ход не мигают', () => {
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 60, { agentState: 'active', agentUpdated: at })).toBe(false);
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 60, { agentState: 'review', agentUpdated: at + 31 })).toBe(false);
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 60, { agentState: 'question', agentUpdated: at + 31 })).toBe(false);
  });
  it('уведомление idle двигает updated без вызова API — мигание держится', () => {
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 60, { agentState: 'idle', agentUpdated: at + 60 })).toBe(true);
  });
  it('нет окна у сессии — не мигает', () => {
    expect(cacheWarnDue({ cacheAt: at }, warnSec, end - 60, null)).toBe(false);
  });
});

describe('blinkBar', () => {
  it('вкл — жёлтая полная', () => {
    expect(blinkBar({ state: 'paused', value: 22, flash: true }, true)).toEqual({ state: 'paused', value: 100 });
  });
  it('выкл — полоса прежнего вида', () => {
    expect(blinkBar({ state: 'paused', value: 22, flash: true }, false)).toEqual({ state: 'paused', value: 22 });
    expect(blinkBar({ state: 'normal', value: 2, flash: false }, false)).toEqual({ state: 'normal', value: 2 });
    expect(blinkBar(null, false)).toEqual({ state: 'none', value: 0 });
  });
});

describe('parseCacheWarn', () => {
  it('минуты → секунды, набор по id', () => {
    const r = parseCacheWarn('{"warnMin":10,"sessions":[{"id":"a","cacheAt":5}]}');
    expect(r.warnSec).toBe(600);
    expect([...r.warns]).toEqual([['a', { cacheAt: 5 }]]);
  });
  it('кривое тело и записи без cacheAt отбрасываются', () => {
    expect(parseCacheWarn('{').warnSec).toBe(0);
    expect([...parseCacheWarn({ warnMin: 10, sessions: [{ id: 'a' }, { cacheAt: 5 }] }).warns]).toEqual([]);
  });
  it('warnMin вне 0…59 — выключено', () => {
    expect(parseCacheWarn({ warnMin: 60, sessions: [] }).warnSec).toBe(0);
    expect(parseCacheWarn({ warnMin: -1, sessions: [] }).warnSec).toBe(0);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/claude-wt/taskbar-helpers.test.js`. Ожидание: FAIL, функции не экспортированы.
- [ ] **Step 3:** реализовать четыре функции и константы в `taskbar-helpers.js`, добавить их в `export`. В doc-комментарии — таблица фаз из спеки.
- [ ] **Step 4:** тот же запуск. Ожидание: PASS. Затем `npm test` — весь набор зелёный.
- [ ] **Step 5: Commit** `feat(taskbar): правила мигания перед остыванием кеша`.

### Task 2: windows11-manager — мигание в службе, команда и маршрут

**Files:**
- Modify: `src/mqtt/taskbar.js`, `src/commands/build.js` (рядом с `claude-session-seen`), `src/http-server.js` (`ROUTES`)
- Test: `src/mqtt/taskbar.test.js`; тест маршрутов http-server, если есть (`grep -l routeToCommand src/*.test.js`)

**Interfaces:**
- Consumes: всё из задачи 1.
- Produces: `startTaskbarState(...)` возвращает ещё `cacheWarn(body)`.
  Новые параметры: `blinkMs = BLINK_MS`, `nowSec = () => Math.floor(Date.now()/1000)`
  (для тестов). Команда роутера `claude-cache-warn(payload)` → `{ok: true, count}`.
  `ROUTES['/claude-wt/cache-warn'] = 'claude-cache-warn'`.

Поведение (тесты по нему):
- `cacheWarn(body)` заменяет набор целиком (`parseCacheWarn`) и сразу зовёт `tick()`.
- `tick()` запоминает `sessionId → {hwnd, agent}` у окон WezTerm и считает
  мигающие `cacheWarnDue(...)` без снятых ключей. Есть такие — заводит таймер
  `blinkMs` (один). Нет — снимает таймер и возвращает полосу
  `blinkBar(applied.get(hwnd), false)` окнам, которые мигали.
- Кадр мигания: `fg = winMan.getActiveWindowId()`. Мигающее окно, которое
  впереди, получает ключ `cacheWarnKey` в снятые, ему возвращается полоса.
  Остальным — `setTaskbarProgress(hwnd, TBPF[bar.state], bar.value)` по
  `blinkBar(applied.get(hwnd), phase)`. `flashWindow` кадр не трогает.
- `dismiss(sessionId)` («Mark seen») снимает и мигание: ключ текущего `cacheAt` этой сессии.
- Снятые ключи, которых нет в наборе, выбрасываются при каждой замене набора, чтобы
  карта не росла всю жизнь.
- `stop()` снимает и таймер мигания.

- [ ] **Step 1: Write the failing tests** в `taskbar.test.js` (заглушки `winMan`, `setIntervalFn` — по образцу соседних тестов):
  - `cacheWarn: окно на пороге получает paused 100, через кадр — свою полосу`;
  - `cacheWarn: окно впереди снимает мигание, и тот же набор повтором его не зажигает`;
  - `cacheWarn: warnMin 0 гасит уже мигающее окно и возвращает вид question (paused 22)`;
  - `cacheWarn: Mark seen снимает мигание`;
  - `cacheWarn: без мигающих таймер мигания не заведён, stop() его снимает`.
- [ ] **Step 2:** `npx vitest run src/mqtt/taskbar.test.js`. Ожидание: FAIL.
- [ ] **Step 3:** реализовать в `taskbar.js`; команду в `build.js` (`taskbar?.cacheWarn(payload)`, в журнал — число сессий, без id); строку в `ROUTES`. В шапке `taskbar.js` — абзац о слое мигания.
- [ ] **Step 4:** `npm test` — зелёный.
- [ ] **Step 5: Commit** `feat(taskbar): мигание жёлтым перед остыванием кеша, команда claude-cache-warn`. Push, PR, мерж после ревью. Без мержа задача 5 пикера красная.

### Task 3: пикер — настройка `cacheWarnMinutes`

**Files:**
- Modify: `frontend-src/config-shape.js` (`DEFAULTS`, нормализация), `frontend-src/settings-form.js` (поле во вкладке `context`, проверка), `docs/settings.md`
- Test: `test/config-shape.test.js`, `test/settings-form.test.js`

**Interfaces:**
- Produces: нормализованный конфиг несёт `cacheWarnMinutes: number` (целое 0…59).

- [ ] **Step 1: Write the failing tests:**
  - `cacheWarnMinutes: умолчание 10`: `normalize({}).cacheWarnMinutes === 10`;
  - `cacheWarnMinutes: 0 сохраняется — это «выключено»`: `normalize({cacheWarnMinutes: 0}).cacheWarnMinutes === 0`;
  - `cacheWarnMinutes: 60, -1, 'x', 2.5 → умолчание`;
  - в форме: поле `cacheWarnMinutes` есть во вкладке `context`, `0` проходит проверку, `60` — нет.
  Имя нормализующей функции взять из соседних тестов `config-shape.test.js`.
- [ ] **Step 2:** `npm test`. Ожидание: FAIL на новых.
- [ ] **Step 3:** своя проверка «целое ≥ 0 и ≤ 59». `positive()` не годится: он превращает 0 в умолчание. Поле:
  `{ id: 'cacheWarnMinutes', label: 'Blink the taskbar button before the cache expires, minutes', type: 'number', default: 10, hint: '0 turns it off. WezTerm windows on machines running windows11-manager.' }`;
  проверка `validNumber('cacheWarnMinutes', 0, 59, 'must be from 0 to 59')`, плюс целое — по образцу соседних проверок. Строка в `docs/settings.md`.
- [ ] **Step 4:** `npm test` — зелёный.
- [ ] **Step 5: Commit** `feat(settings): cacheWarnMinutes — за сколько минут мигать перед остыванием кеша`.

### Task 4: пикер — набор и отправитель (чистый модуль)

**Files:**
- Create: `frontend-src/cache-warn.js` (UMD как соседи, `window.CacheWarn`)
- Modify: `scripts/prepare-frontend.js` (список файлов), `sessions.html` (`<script src="cache-warn.js">` рядом с `session-windows.js`)
- Test: `test/cache-warn.test.js`; `test/frontend-load.test.js`, если он сверяет список

**Interfaces:**
- Consumes: `SessionWindows.unreadTargets(row, state) → [{base, http}]`; строки `SessionList.buildSessionList(...)` с полями `id`, `agentState`, `agentCacheAt`, `sessionWindows`.
- Produces:
  - `cacheWarnSets(rows, state, warnMin) → Map<key, {target: {base, http}, body: {warnMin, sessions: [{id, cacheAt}]}}>`.
    `key = target.base + '|' + target.http`. В набор цели — строки с
    `agentCacheAt > 0`, `agentState !== 'active'` и окном у этой цели;
    дубли карточек по `id` схлопнуты, сессии отсортированы по `id`. При
    `warnMin === 0` — пустая карта: погасить уже мигающее — дело отправителя
    (правило «пропавшая цель» ниже).
  - `createCacheWarnSender({ send, nowMs = Date.now, heartbeatMs = 300000 }) → { update(sets) }`.
    `send(target, body)` отдаёт Promise. `update` шлёт цели, чьё `JSON.stringify(body)`
    изменилось или чей прошлый успешный отправ старше `heartbeatMs`. Цели,
    пропавшей из `sets`, один раз уходит пустой список с тем же `warnMin`.
    Отказ `send` не запоминается как отправленное: следующий `update` повторит.

- [ ] **Step 1: Write the failing tests** (`test/cache-warn.test.js`):
  - `в набор не идут работающие, сессии без cacheAt и без окна`;
  - `две карточки одной сессии — одна запись`;
  - `сессия с окнами на двух машинах попадает в набор обеих`;
  - `тот же набор второй раз не уходит, через 5 минут уходит повтором`;
  - `пропавшая цель получает пустой список один раз`;
  - `warnMin 0 отправляет пустой список целям, которым слали раньше`;
  - `отказ send — следующий update шлёт снова`.
- [ ] **Step 2:** `npm test`. Ожидание: FAIL.
- [ ] **Step 3:** реализовать модуль, вписать в `prepare-frontend.js` и `sessions.html`.
- [ ] **Step 4:** `npm test` — зелёный.
- [ ] **Step 5: Commit** `feat(list): набор сессий для мигания перед остыванием кеша`.

### Task 5: пикер — транспорт и подключение в странице

**Files:**
- Modify: `src-tauri/src/manager_http.rs` (`ROUTES` → `[_; 7]`, `pub fn cache_warn(endpoint, body: &str)`), `src-tauri/src/mqtt.rs` (`CACHE_WARN_TOPIC = "/claude-cache-warn"`, `pub fn cache_warn(broker, base, body: &str)`), `src-tauri/src/main.rs` (команда `cache_warn_send`, регистрация в `invoke_handler`), `sessions.html` (`applyState`)
- Test: юнит-тесты в `manager_http.rs` (таблица `route_for`, кривой адрес у новой функции); `test/manager-routes.test.js` без правок

**Interfaces:**
- Consumes: `createCacheWarnSender`, `cacheWarnSets` (задача 4); `Target` и `transport_for` в `main.rs`.
- Produces: `#[tauri::command] async fn cache_warn_send(target: Target, body: serde_json::Value) -> Result<(), String>`.
  Одна цель на вызов, транспорт — `transport_for(&target.http)`. Для MQTT — `resolve_base`, как у `unread_bases`.
  Нет брокера — та же ошибка, что у `ask_session_trackers`.

- [ ] **Step 1: Write the failing tests:** в `manager_http.rs` — `assert_eq!(route_for("/claude-cache-warn"), Some("/claude-wt/cache-warn"))` и строка в тесте «кривой адрес у каждой публичной функции» для `cache_warn`.
- [ ] **Step 2:** `cd src-tauri && cargo test manager_http`. Ожидание: FAIL.
- [ ] **Step 3:** реализовать Rust. В `sessions.html`:
  - один `const cacheWarn = window.CacheWarn.createCacheWarnSender({ send: (target, body) => invoke('cache_warn_send', { target, body }) })`;
  - в конце `applyState`, после `lastState = state`, — `if (managerReachable()) cacheWarn.update(window.CacheWarn.cacheWarnSets(rows, state, CONFIG.cacheWarnMinutes))`.
    `rows` — `window.SessionList.buildSessionList({ sessions: state.sessions, seen, state, configHost: CONFIG.windowHost })`: нужны все сессии, а не прошедшие отсевы `regroup`.
  - Отказ — `.catch((e) => { error = String(e); render(); })`, как у `markSeenNow`.
- [ ] **Step 4:** `npm test` (при смерженной задаче 2 сторож маршрутов зелёный) и `cd src-tauri && cargo test` — зелёные.
- [ ] **Step 5: Commit** `feat(tray): набор мигания уходит трекерам по http/MQTT`.

### Task 6: правила и документы

**Files:**
- Modify: `docs/rules/list-rows.md` (правило рядом с таймером кеша), `CLAUDE.md` (счёт правил в указателе: Строки списка 15 → 16),
  `~/.claude/skills/claude-wt/mqtt-топики.md` (новый топик `claude-cache-warn` и тело)

- [ ] **Step 1:** правило «**Мигает служба, решает пикер**»: почему набор целиком, почему сроки считает служба, почему `idle` не новый ход, что при `backgroundRefresh: false`, почему только WezTerm.
- [ ] **Step 2:** `npm test` — зелёный (тесты на счёт правил, если есть).
- [ ] **Step 3: Commit** `docs(rules): мигание перед остыванием кеша`. Push, PR.

### Task 7: деплой на Windows

Мак пропущен: недоступен с конца октября. popstas-pc не трогать.

- [ ] **Step 1:** windows11-manager после мержа PR задачи 2: из `~/projects/js/windows11-manager` — `./data/scripts/deploy-pc.sh --no-build`. Правка только в node, перезапуск трея перезапустит службу. Ждать строку `== готово`: код выхода 0 ещё ничего не значит.
- [ ] **Step 2:** пикер: `BRANCH=feat/cache-warn ./data/scripts/deploy-win.sh` в фоне (около 3,5 мин), после пуша. Скрипт лежит в `data/` основного каталога, в worktree его нет.
- [ ] **Step 3: живая проверка без часа ожидания.** В настройках пикера на nb поставить `cacheWarnMinutes: 59`, скрыть пикер. Кнопка окна ждущей сессии с таймером мигает жёлтым в пределах тика службы (2,5 с) после прихода набора. Клик по окну снимает мигание, и через 5 минут повтора оно не возвращается. `0` в настройках гасит мигание. Вернуть 10.
- [ ] **Step 4:** сказать Стасу, что выкачено, что проверено глазами, и какой коммит, если он лёг после запуска скрипта, на машине отсутствует.
