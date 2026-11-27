# Автокомпакт простаивающих сессий — план реализации (пикер, часть 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** пикер раз в минуту находит idle-сессии с большим контекстом, чей кэш промпта доживает 58-ю минуту, и шлёт им `/compact` через `claude-wt session compact` на машине агрегатора; плюс настройки, пункт меню `Auto-compact: on/off` и журнал.

**Architecture:** решение «кому слать» — чистая функция в новом модуле `src-tauri/src/auto_compact.rs` (состояние → шаги, память «уже обработано в этот простой» по ключу `(id, cacheAt)`), её гоняет отдельный поток раз в 60 с, независимый от бэкоффа поллера, со свежим опросом `Poller::fresh_state`. Вызовы по ssh (`claude-wt session compact`, `ccfzf --auto-compact`) живут рядом с `set_comment` в `state_source.rs`. Фронтенд: ключ `autoCompact` в `config-shape.js`, страница в `settings-form.js` (рисует её общий код `settings.html`), пункт меню в `session-actions.js` + ветка в `runAction` в `sessions.html`.

**Tech Stack:** Rust (Tauri 2, serde_json), vanilla JS UMD-модули, `node --test` через `npm test`, `cargo test`.

**Spec:** нота проекта в вольте `Notes/2026/11/claude-wt автокомпакт и usage в пикере.md`, «Часть 1. Автокомпакт» (клиентская половина). Контракт с ccfzf — от coord 27.11 (ниже).

## Global Constraints

- Видимое человеку (подписи настроек, пункт меню) — по-английски; комментарии, названия тестов, `assert`-сообщения — по-русски. Строки журнала — по-английски, как соседние `ccfzf_log!`.
- Умолчания: `autoCompact.enabled: false`, `autoCompact.threshold: 16` (проценты контекста), `autoCompact.after: 58` (минуты простоя).
- Условие отправки, всё сразу: `live`, `agent.state` ∈ {`idle`, `review`}, `agent.contextPct ≥ threshold`, `after·60 ≤ now − agent.cacheAt < 3600`, `session.autoCompact !== false`, среди `windows[]` (или `window`) есть окно на машине пикера (`norm_host(host) == norm_host(windowHost)`, как в `place_order.rs`) и это WezTerm (`app` содержит `wezterm`), ключ `(id, cacheAt)` ещё не обработан.
- Контракт ccfzf: флаг — `ccfzf --auto-compact <id> on|off`; в `--state` поле `autoCompact: false` на верхнем уровне сессии только когда выключено. Отправка — `claude-wt session compact <id> --min-idle <after> --json`, одна строка JSON `{code, result, reason?, error?}`, выход 0 ok / 1 отказ / 2 не найдено / 3 исход неизвестен (не повторять); `reason` — slug (`not-idle`, `question`, `min-idle`, `disabled`, `no-window`, `not-wezterm`, `input-busy`).
- Удалённая команда идёт через интерактивный шелл (`exec $SHELL -ic '…'`), без `;` (CLAUDE.md). id проверяется `looks_like_session_id` до ssh.
- Журнал: каждая отправка и каждый пропуск с причиной — строка `ccfzf_log!`, не чаще раза за простой (ключ `(id, cacheAt)`) на сессию. Тихие «не кандидат» (не idle, мало контекста, не то время, флаг выключен) не пишутся.
- Границы: в `sessions.html` трогается только ветка `runAction` для пункта меню; `settings.html` не трогается вовсе (страницы рисует `PAGES`); `session-groups.js` не трогается. Бамп `vendor/ccfzf` не делается.
- Местный источник (`Source::Local`) не отправляет: `claude-wt` живёт на машине агрегатора; такие сессии — пропуск с причиной `local source`.
- Порядок проверок: сначала тихие фильтры (живость, состояние, контекст, окно времени, флаг, ключ), и только потом причины пропуска — `Skip` бывает лишь у сессии, которую иначе отправили бы.
- Ключ «простой обработан» ставится по исходу, а не по плану: код 0, код 3, ненулевой выход без JSON и любой отказ, кроме `min-idle`, `ssh`, `state`. Отказы `min-idle`, `ssh` и `state` повторяются на следующем такте (`RETRIED`), но в журнал идут один раз за простой.
- Верхняя граница `< 3600` перепроверяется перед каждой отправкой: отправки идут подряд и каждая может держать поток десятки секунд.
- В репо — без имён машин и домашних путей (`test/no-private-data.test.js`, в worktree нужен `data/private-patterns.txt`): в тестах хосты `remote-host`, `this-host`, `other-host`.

## Review Focus

- Пикер перезапущен посреди простоя — память пуста, сессия получит второй `/compact`? Нет: после сжатия `cacheAt` пропадает (граница `compact_boundary` в ccfzf), условие не сходится; а до ответа команды — `--min-idle` на той стороне. Тест: состояние без `cacheAt` → не кандидат.
- Опрос упал, `fresh_state` откатился на снимок восьмиминутной давности — `cacheAt` в нём старый. Шаг всё равно уходит, но команда сверяет простой сама (`--min-idle`); у пикера тест: снимок с `cacheAt` старше часа → не кандидат.
- `windowHost` пуст в конфиге — каждая сессия была бы «нет окна» каждый час. Тест: пустой `windowHost` → пропуск с причиной `windowHost is not set`, по разу на ключ.
- Сессия чужой машины (`window.host` = `other-host`) — пропуск `window is on other-host`, а не отправка.
- Порог/минуты в конфиге строкой, дробью или мусором — Rust и `config-shape.js` берут одно и то же умолчание. Тест в обоих.

---

### Task 1: Решение «кому слать» — `auto_compact.rs`

**Files:**
- Create: `src-tauri/src/auto_compact.rs`
- Modify: `src-tauri/src/main.rs` (строка `mod auto_compact;`)

**Interfaces:**
- Produces:
  - `pub struct Settings { pub enabled: bool, pub threshold: i64, pub after: i64 }`
  - `pub fn settings_from(config: &serde_json::Value) -> Settings` — читает `config.autoCompact`; `threshold` — целое 1…100, иначе 16; `after` — целое 1…59, иначе 58; `enabled` — только `true` включает.
  - `pub enum Step { Send { source: String, id: String, cache_at: i64, name: String, context: i64, idle_min: i64 }, Skip { id: String, name: String, reason: String } }`
  - `#[derive(Default)] pub struct Memory` с `pub fn plan(&mut self, state: &serde_json::Value, s: &Settings, window_host: &str, now: i64) -> Vec<Step>` — на `Skip` ключ `(id, cacheAt)` ставится сразу, на `Send` — нет; `pub fn settle(&mut self, id: &str, cache_at: i64)` ставит его по исходу; `pub fn note_once(&mut self, id: &str, cache_at: i64, what: &str) -> bool` — «эту строку журнала за этот простой ещё не писали»; записи с `now − cacheAt ≥ 3600` чистятся.
  - `pub fn skip_line(name, id, reason) -> String`, `pub fn sent_line(...)` — тексты журнала (`auto-compact: …`).
  - `name` — `title` сессии, иначе первые 8 знаков id.

- [ ] **Step 1: Тесты (в `auto_compact.rs`, `mod tests`)** — фабрика `session(json!{…})` с умолчаниями `live: true, agent: {state: "idle", contextPct: 20, cacheAt: now−58·60}, window: {host: "this-host", app: "wezterm-gui.exe"}, source: "remote-host"`, `now = 1_800_000_000`:
  - `podkhodyashchaya_sessiya_poluchaet_compact` → один `Send { context: 20, idle_min: 58, source: "remote-host" }`;
  - `review_tozhe_prostoy` (state `review`) → `Send`; `active`, `question`, `waiting` → пусто;
  - `malo_konteksta_molchit` (contextPct 15 при пороге 16) → пусто; ровно 16 → `Send`;
  - `granitsy_prostoya`: 57 мин 59 с → пусто; 58:00 → `Send`; 59:59 → `Send`; 60:00 → пусто;
  - `bez_cacheAt_ne_kandidat` (после `/compact` метки нет) → пусто;
  - `vyklyuchennyy_flag_molchit` (`autoCompact: false`) → пусто;
  - `odin_raz_za_prostoy`: `plan` → `Send`, `settle`, второй `plan` → пусто; тот же id с новым `cacheAt` → снова `Send`; без `settle` второй `plan` → снова `Send` (повтор после `min-idle`);
  - `tikhie_filtry_ran_she_propuska`: окно `WindowsTerminal.exe` и contextPct 5 → пусто;
  - `okno_ishchetsya_v_windows`: `window` чужой машины, а в `windows[]` есть WezTerm этой (регистр хоста другой) → `Send`;
  - `propusk_tozhe_odin_raz`: окно `WindowsTerminal.exe` → `Skip { reason: "Windows Terminal, not WezTerm" }`, второй вызов → пусто;
  - `net_okna` (`window: null`) → `Skip "no window"`; `window.host: "other-host"` → `Skip "window is on other-host"`; `windowHost == ""` → `Skip "windowHost is not set"`;
  - `mestnyy_istochnik` (`source: "local"`) → `Skip "local source"`;
  - `ne_zhivaya` (`live: false`) → пусто;
  - `nastroyki_s_musorom_berut_umolchaniya`: `{threshold: "x", after: 75}` → 16/58; `{threshold: 30, after: 50, enabled: true}` → как есть; отсутствие ключа → `enabled: false`;
  - `pamyat_chistitsya`: после `plan` с `now + 3600` внутренний размер памяти 0 (метод `#[cfg(test)] fn len()`).
- [ ] **Step 2:** `cd src-tauri && cargo test auto_compact` — FAIL (нет модуля).
- [ ] **Step 3:** реализовать модуль; `mod auto_compact;` в `main.rs`.
- [ ] **Step 4:** `cargo test auto_compact` — PASS.
- [ ] **Step 5:** коммит `feat(auto-compact): decide which idle sessions get /compact`.

### Task 2: Вызовы по ssh и поток таймера

**Files:**
- Modify: `src-tauri/src/state_source.rs` (рядом с `set_comment`)
- Modify: `src-tauri/src/poller.rs:524` (`fresh_state`)
- Modify: `src-tauri/src/auto_compact.rs`
- Modify: `src-tauri/src/main.rs` (setup, команда `set_auto_compact`, вызов `fresh_state` у раскладки группы)

**Interfaces:**
- Consumes: `Memory::plan`, `settings_from`, `Step` (Task 1).
- Produces:
  - `pub fn compact_remote(id: &str, min_idle: i64) -> String` (state_source) → `exec $SHELL -ic 'claude-wt session compact <id> --min-idle <n> --json'`.
  - `pub fn run_compact(source: &Source, id: &str, min_idle: i64) -> Result<(Option<i32>, String), String>` — `Err` для `Local` и для кривого id; иначе код выхода и stdout.
  - `pub fn auto_compact_args(source, id, on) -> Vec<String>` и `pub fn set_auto_compact(source: &Source, id: &str, on: bool) -> Result<(), String>` — `ccfzf --auto-compact <id> on|off`, как `comment_args`/`set_comment`.
  - `pub struct Outcome { pub settled: bool, pub what: String, pub line: String }` и `pub fn outcome(name: &str, id: &str, code: Option<i32>, output: &str, detail: &str) -> Outcome` (auto_compact) — разбирает последнюю строку stdout, начинающуюся с `{`: код 0 → `auto-compact: sent /compact to …`, settled; код 3 → `… outcome unknown …`, settled; `reason` из `RETRIED` (`min-idle`, `ssh`, `state`) → не settled; прочий отказ → `auto-compact: <name> (<id8>) refused: <reason> <error>`, settled; нет JSON → код и хвост stdout, settled.
  - `Poller::fresh_state(&self, what: &str)` — `what` идёт в строку отката вместо зашитого «the group layout».
  - `pub fn start(app: tauri::AppHandle)` (auto_compact) — поток: каждые 60 с `load_config` → `settings_from`; выключено — ничего не делает; включено — `fresh_state("auto-compact")`, `plan(now)`, для `Skip` — `skip_line`, для `Send` — перепроверка `now − cacheAt < 3600` по свежим часам, `run_compact`, `outcome`; settled → `settle`; строка журнала — через `note_once` (ключ — `what`). Память — локальная переменная потока.
  - Tauri-команда `async fn set_auto_compact(source: String, id: String, on: bool) -> Result<(), String>` (`spawn_blocking`, как `set_comment`), зарегистрирована в `invoke_handler`.

- [ ] **Step 1: Тесты:**
  - state_source: `compact_remote_idyot_cherez_interaktivnyy_shell` — строка равна `exec $SHELL -ic 'claude-wt session compact b5a54ce3-a022-4c9a-aa91-e306d75bdc76 --min-idle 58 --json'` и не содержит `;`;
  - state_source: `auto_compact_args_kak_u_kommentariya` — ssh: `["ccfzf","--auto-compact",id,"off"]`, local: `["--auto-compact",id,"on"]`;
  - state_source: `run_compact_ne_hodit_s_krivym_id` и `…_s_mestnym_istochnikom` → `Err`;
  - auto_compact: `outcome` — `(Some(0), "{\"code\":0,\"result\":\"sent\"}")` содержит `sent /compact`; `(Some(1), "noise\n{\"code\":1,\"reason\":\"input-busy\",\"error\":\"field not empty\"}")` содержит `refused: input-busy field not empty`; `(Some(3), …)` содержит `outcome unknown`; `(Some(255), "")` содержит `exit 255`; settled у всех, кроме отказа с `reason: min-idle`.
- [ ] **Step 2:** `cargo test` — новые FAIL.
- [ ] **Step 3:** реализовать; `auto_compact::start(app.handle().clone())` в setup после `app.manage(poller::Poller::start(…))`; вызов `fresh_state` в раскладке группы — `fresh_state("the group layout")`.
- [ ] **Step 4:** `cargo test` — всё PASS.
- [ ] **Step 5:** коммит `feat(auto-compact): minute timer sends /compact over ssh`.

### Task 3: Настройки `autoCompact`

**Files:**
- Modify: `frontend-src/config-shape.js` (DEFAULTS, `normalizeAutoCompact`, `normalizeConfig`)
- Modify: `frontend-src/settings-form.js` (страница после `context`, `validate`)
- Modify: `config.example.yml` (секция после `contextLevels`)
- Test: `test/config-shape.test.js`, `test/settings-form.test.js`

**Interfaces:**
- Produces: `normalizeConfig(raw).autoCompact = { enabled: boolean, threshold: number, after: number }` — те же правила, что `settings_from` в Rust.
- Страница `{ id: 'autocompact', title: 'Auto-compact', fields: [ {id:'autoCompact.enabled', label:'Compact idle sessions before the prompt cache expires', type:'bool', default:false, hint:'Sends /compact to an idle session in a WezTerm window on this machine once per idle, so the compaction reads a warm cache. Turn it off for one session with Auto-compact in the ^K menu.'}, {id:'autoCompact.threshold', label:'Context used at least, %', type:'number', default:16}, {id:'autoCompact.after', label:'Idle for, minutes', type:'number', default:58, hint:'From 1 to 59: after an hour the cache is gone and compacting saves nothing.'} ] }`.

- [ ] **Step 1: Тесты:** config-shape — умолчание `{enabled:false, threshold:16, after:58}`; `{enabled:true, threshold:30, after:50}` проходит; `threshold: 0`, `101`, `"x"`, `16.5` → 16; `after: 0`, `60`, `58.5` → 58; `enabled: "yes"` → false. settings-form — `validate` ругается на `autoCompact.threshold` вне 1…100 и на дробь, на `autoCompact.after` вне 1…59 и на дробь; патч из формы с `enabled: true` даёт `{autoCompact: {enabled: true}}`.
- [ ] **Step 2:** `npm test` — новые FAIL.
- [ ] **Step 3:** реализовать; секция в `config.example.yml` закомментирована по образцу соседей, с умолчаниями.
- [ ] **Step 4:** `npm test` — PASS (включая сторожей, которые сверяют поля формы с config-shape).
- [ ] **Step 5:** коммит `feat(settings): autoCompact enabled, threshold and idle minutes`.

### Task 4: Пункт меню `Auto-compact: on/off`

**Files:**
- Modify: `frontend-src/session-list.js:397` (поле строки `autoCompact`)
- Modify: `frontend-src/session-actions.js` (после пункта `comment`)
- Modify: `sessions.html` (`runAction`: ветка `auto-compact` и функция `toggleAutoCompact(row)` рядом с `saveComment`)
- Test: `test/session-actions.test.js`, `test/session-list.test.js`

**Interfaces:**
- Consumes: команда `set_auto_compact` (Task 2), `cfg.autoCompact.enabled` (Task 3).
- Produces: строка списка несёт `autoCompact: boolean` (`s.autoCompact !== false`); пункт `{ id: 'auto-compact', label: row.autoCompact ? 'Auto-compact: on' : 'Auto-compact: off' }` — только при `cfg.autoCompact.enabled`, у живой строки с `id`, не `winLocal` (та же причина, что у комментария: местный `--auto-compact` на Windows никто не разберёт).

- [ ] **Step 1: Тесты:** session-list — `autoCompact: false` из состояния → `false`, отсутствие → `true`. session-actions — пункт есть с `Auto-compact: on` / `Auto-compact: off`; нет при выключенном режиме, у неживой строки, у строки без id, у своей строки на Windows.
- [ ] **Step 2:** `npm test` — FAIL.
- [ ] **Step 3:** реализовать; `toggleAutoCompact` переворачивает `row.autoCompact`, рисует, зовёт `invoke('set_auto_compact', {source: row.source || CONFIG.sshHost, id: row.id, on})`, на ошибке возвращает прежнее и кладёт `error`.
- [ ] **Step 4:** `npm test` — PASS.
- [ ] **Step 5:** коммит `feat(picker): Auto-compact on/off in the session menu`.

### Task 5: Правило в docs и сухой прогон

**Files:**
- Modify: `docs/rules/state-sources.md` (новое правило), `CLAUDE.md` (счёт в указателе 10 → 11)

- [ ] **Step 1:** правило: зачем таймер свой, а не такт поллера (бэкофф до 8 мин против окна в 2 мин); ключ «один раз за простой» — `(id, cacheAt)` в памяти потока, ставится по исходу, `min-idle` повторяется; почему перезапуск не удваивает (`cacheAt` пропадает после сжатия, `--min-idle`); часы пикера против часов агента — пикер, спешащий на 2+ минуты, окно пропустит молча; что пишется в журнал.
- [ ] **Step 2:** сухой прогон по живому `ccfzf --state` без отправки: `#[ignore]`-тест `dry_run_from_env` читает путь из `AUTO_COMPACT_STATE` (дамп в scratchpad, в репо не кладётся) и печатает шаги `plan()` при `windowHost` из `AUTO_COMPACT_HOST`; сверить глазами с `agent.cacheAt`/`contextPct` живых сессий.
- [ ] **Step 3:** `npm test`, `cd src-tauri && cargo test` — PASS; rebase на свежий master; пуш; PR в master.
- [ ] **Step 4:** коммит `docs(rules): auto-compact timer`.

### Task 6: Деплой (только по команде coord)

- Что: пикер на Windows-цель — `BRANCH=feat/autocompact ./data/scripts/deploy-win.sh` (в фоне). Мак пропущен, недоступен. ccfzf (команда `session compact`, `--auto-compact`) выкатывает свой исполнитель на машину агрегатора раньше пикера.
- Включить `autoCompact.enabled: true` в живом конфиге Windows-цели (`~/.config/ccfzf-picker/config.yaml`: бэкап, правка, `cmp`) — решение head.
- Проверка: `tasklist` — новый PID `ccfzf-picker.exe` в Console; штамп сборки в трее — свежий; меню `^K` живой сессии показывает `Auto-compact: on`, переключение даёт `autoCompact: false` в `ccfzf --state` и обратно; журнал пикера через ≤1 мин после 58-й минуты простоя подходящей сессии — строка `auto-compact: sent /compact …` или `skipped … <причина>`; карточка после сжатия без оранжевой точки (это часть ccfzf-хуков).
- После проверки — мерж по команде coord, на Windows-цели `git checkout master && git pull --ff-only`.
