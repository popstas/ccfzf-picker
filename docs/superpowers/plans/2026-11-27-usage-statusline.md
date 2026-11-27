# Usage в статуслайне, выключатели блоков, дети в дереве типа — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** части 2, 3 и 5 дизайна «автокомпакт и usage в пикере». Нужно три вещи: выключатели сортировки и подсказки в статуслайне, блок usage лимитов Claude слева в статуслайне, группировка по типу проекта по корню дерева head.

**Architecture:** данные о лимитах качает Rust (`claude_usage.rs`, свой поток, `curl` через `proc::hidden_command`, раз в 60 с) и шлёт событием `claude-usage`. Страница форматирует их чистым модулем `frontend-src/claude-usage.js` и перерисовывает блок по своему минутному таймеру. Выключатели и URL лежат в `config.yaml` и приезжают через `config-changed`. Часть 5 переиспользует связывание родителей из `session-tree.js`.

**Tech Stack:** Tauri 2 (Rust), ванильный JS (UMD-шим, `node --test`), YAML-конфиг.

**Spec:** нота `Notes/2026/11/claude-wt автокомпакт и usage в пикере.md` в вольте home, части 2, 3, 5. Задание coord co-autocompact, 27.11.2026.

## Global Constraints

- Видимое человеку — по-английски, комментарии и тесты — по-русски (CLAUDE.md, «Язык»).
- Цвета только токенами `theme.css`, сырых цветов в `<style>` нет (`test/theme.test.js`).
- Имена машин и реальный URL usage в репозиторий не попадают (`test/no-private-data.test.js`). В примерах — `https://example.com/claude-usage.json`.
- Новых крейтов нет: `ureq` собран без TLS, качает системный `curl` (на Windows 10+ — `System32\curl.exe`).
- Соседний исполнитель compact-ui правит `main.rs`/poller, секцию autoCompact в `settings.html` и меню `^K`. Мои правки там локальные: в `main.rs` только `mod`, запуск потока и две команды в `generate_handler!`.
- Новый файл фронтенда — в `scripts/prepare-frontend.js` и тегом `<script>` (сторож `test/frontend-load.test.js`).
- Формулы — как в `llm-usage-update-image`: `deviation_days_text`, `remaining_text`, `FRESH_DATA_MINUTES = 5.2`.

## Решения билдера

- **Хранение выключателей.** Ключи `statusline.sortControl` и `statusline.menuHint` (bool, умолчание `true`) и `claudeUsageUrl` (строка, пусто — блока нет) лежат в `config.yaml`, на новой вкладке настроек `Statusline`. Нота говорит про `ui-changed`, но смысл требования — «на месте, без перезапуска». `config-changed` это даёт, и при этом не трогается восьмипольный `ui.json` (вопрос 1 к coord, вариант a).
- **Порог устаревания** — 5,2 мин, как у скрипта. `left` и offset считаются от текущего времени, а не от `updated_at` (вопрос 2, вариант a).
- **Серость сильнее красного.** На устаревших данных offset не красный: у старых данных тревога не к месту.
- **Журнал.** Строка пишется на переходе: первая ошибка, смена текста ошибки, восстановление, смена URL. Не каждую минуту: в кольце всего 1000 строк.

## Review Focus

1. Битый или не тот JSON (HTML-страница 200, пустое тело): ошибка, прошлое значение остаётся, блок серый. Тест — в Task 3.
2. `resetsAtUnix` у 5h отсутствует или `null` (окно не начато): без offset и с `not started`, без `NaN`. Тест — в Task 2.
3. Нулевой offset печатается как `+0m`, `-0m` или `-0.0d`: должен быть `0m` и `0.0d`. Тест — в Task 2.
4. URL очищен в настройках: блок пропадает сразу, по `config-changed` и толчку `claude_usage_refresh`, а не через минуту со старым значением. Тест — в Task 3, логика `UsageState::on_url`.
5. Ребёнок, чей head не в `open` (секция `nowindow`, закрыт): группируется по своему типу. Тест — в Task 4.

---

### Task 1: выключатели сортировки и подсказки (часть 2)

**Files:**
- Modify: `frontend-src/config-shape.js` (DEFAULTS и `normalizeConfig`: `statusline: { sortControl: true, menuHint: true }`, `claudeUsageUrl: ''`)
- Modify: `frontend-src/settings-form.js` (новая страница `statusline` после `context`)
- Modify: `sessions.html` (CSS `[hidden]`, `paintStatusline()`, `#menu-hint` → `flex: 0 1 auto`)
- Modify: `config.example.yml`, `README.md` (ключи)
- Test: `test/config-shape.test.js`, `test/settings-form.test.js`

**Interfaces:**
- Produces: `CONFIG.statusline.sortControl: boolean`, `CONFIG.statusline.menuHint: boolean`, `CONFIG.claudeUsageUrl: string` (обрезанный, пустой — нет блока). Страница настроек `{ id: 'statusline', title: 'Statusline', fields: [statusline.sortControl (bool, default true), statusline.menuHint (bool, default true), claudeUsageUrl (text)] }`.

- [ ] Тест config-shape: `normalizeConfig({})` даёт `statusline` `{sortControl:true, menuHint:true}` и `claudeUsageUrl === ''`. `{statusline:{menuHint:false}}` даёт `menuHint false`, `sortControl true`. Нестроковый `claudeUsageUrl` даёт `''`, `'  u  '` даёт `'u'`.
- [ ] Тест settings-form: страница `statusline` есть, у двух bool `default: true`, `configToFields({})` показывает обе галки включёнными.
- [ ] Прогон, падение. Реализация. Прогон `npm test`, зелёный (кроме известного `vendor/ccfzf/tests/cli/waiting.test.mjs`).
- [ ] `sessions.html`: `paintStatusline()` ставит `sortControl.hidden = !CONFIG.statusline.sortControl` и то же для `menuHint`. Зовётся на старте после загрузки CONFIG и в обработчике `config-changed`. CSS: `#statusline [hidden] { display: none; }`, иначе `display:flex` у `#sort-control` перебивает атрибут.
- [ ] Коммит `feat(picker): statusline sort and menu hint can be hidden`.

### Task 2: чистый модуль форматирования usage (часть 3, фронт)

**Files:**
- Create: `frontend-src/claude-usage.js` (UMD, `root.ClaudeUsage`)
- Test: `test/claude-usage.test.js`

**Interfaces:**
- Produces: `usageView(data, nowSec, { failed }) → null | { stale: boolean, fiveHour: { pct, offset, offsetHot, left }, week: { pct, offset } }`. `null` — данных нет вовсе. `offset` — уже текст (`-117m`, `+1.4d`, `0m`) или `''`. `usageHtml(view) → string`: `5h: 43% <span class="usage-off hot">+20m</span> 54m left | week: 87% +1.4d`, экранированный. Константы `FRESH_DATA_MINUTES = 5.2`, `HOT_MINUTES = 15`.

- [ ] Тесты (значения из ноты и скрипта):
  - `fiveHour {usedPercent:43, resetsAtUnix: now+54*60}` даёт offset `-117m`, left `54m left`;
  - week `{usedPercent:87, resetsAtUnix: now+X}` даёт `+N.Nd` по формуле `(used − elapsed)/(100/7)`; фикстура: осталось 3,5 дня, used 60 → elapsed 50 → `+0.7d`;
  - offset 5h `+16m` → `offsetHot: true`, `+15m` → `false` (строго больше);
  - `seconds ≤ 0` → `reset due`; 100 мин → `1.7h left`; `resetsAtUnix` нет → `not started` без offset;
  - нулевой offset → `0m`, `0.0d`, без знака;
  - `updated_at` ISO на 6 мин раньше now → `stale: true`; на 5 мин → `false`; `failed: true` → `stale: true`;
  - `usedPercent` `"55"`/`120`/`-3` → clamp `int` в 0..100;
  - `usageHtml` при `stale` не ставит класс `hot`.
- [ ] Прогон, падение, реализация, прогон, зелёный.
- [ ] Коммит `feat(picker): format Claude usage for the statusline`.

### Task 3: Rust-источник usage и блок в статуслайне (часть 3)

**Files:**
- Create: `src-tauri/src/claude_usage.rs`
- Modify: `src-tauri/src/main.rs`: `mod claude_usage;`, `claude_usage::spawn(app.handle().clone())` в `setup`, команды `claude_usage::claude_usage`, `claude_usage::claude_usage_refresh` в `generate_handler!`
- Modify: `sessions.html`: `<span id="usage-block">` после `#menu-hint`, слушатель `claude-usage`, минутный таймер, перерисовка на `picker-shown`; `scripts/prepare-frontend.js`, `<script src="claude-usage.js">`
- Test: модульные тесты в `claude_usage.rs`; `test/frontend-load.test.js` проверяет сам

**Interfaces:**
- Produces: событие `claude-usage` с payload `UsageSnapshot { url: String, data: Option<serde_json::Value>, failed: bool }` (serde camelCase). Команда `claude_usage() -> UsageSnapshot` (то, что уже известно, — на гонку с подпиской). Команда `claude_usage_refresh()` — толкнуть поток сейчас (страница зовёт на `config-changed`).
- Внутри: `parse_usage(body: &str) -> Result<Value, String>` (объект с `fiveHour` или `weekly`, иначе Err); `UsageState::on_url(&mut self, url) -> Option<String>` (смена URL сбрасывает data, пустой URL даёт снимок без данных); `UsageState::on_fetch(&mut self, Result<Value,String>) -> Option<String>` (строка журнала только на переходе); `config_url(config: &Value) -> String`.

- [ ] Тесты Rust:
  - `parse_usage` на теле с `fiveHour` → Ok; `"<html>"`, `""`, `{}` → Err;
  - `on_fetch(Err)` после Ok оставляет data, `failed=true`, возвращает строку; вторая такая же Err → `None`; Ok после Err → строка «recovered» и `failed=false`;
  - `on_url("")` после данных → `data None`;
  - `config_url` обрезает пробелы, не-строка → `""`.
- [ ] Реализация: поток `loop { recv_timeout(60 s) от канала толчков; url = config_url(load_config()); on_url; если непусто — curl; on_fetch; emit }`. `curl -q -fsSL --max-time 20 --proto =http,https -- <url>` через `proc::hidden_command`. Строки журнала через `log::write`, английские, с префиксом `claude usage:`.
- [ ] Страница: `claudeUsage = snapshot`; `paintUsage()` = `ClaudeUsage.usageView(snapshot.data, Date.now()/1000, {failed})`; `null` или пустой url → `hidden`. CSS: `#usage-block { flex: 0 0 auto; white-space: nowrap }`, `.stale { color: var(--fg-dimmer) }`, `.usage-off.hot { color: var(--danger) }`. Клик по блоку `stopPropagation` — без побочных действий.
- [ ] `cargo test` и `npm test` зелёные. Локальная проверка вида: `node scripts/prepare-frontend.js`, страница со стабом `__TAURI__` на сборочной машине (не localhost: браузер смотрит с другого хоста), скриншот статуслайна в трёх состояниях: свежие, устаревшие, hot.
- [ ] `config.example.yml` и README: `claudeUsageUrl` и формат строки. Правило в `docs/rules/` (state-sources.md: источник usage) со счётом в указателе CLAUDE.md.
- [ ] Коммит `feat(picker): Claude usage in the statusline`.

### Task 4: тип группы — по корню дерева head (часть 5)

**Files:**
- Modify: `frontend-src/session-tree.js`: вынести связывание в `linkParents(rows) → { nodes }`, где у узла есть `row, cards, parent`; экспорт `rootRowOf(rows) → Map<row, row>` (карточка → строка корня)
- Modify: `frontend-src/session-groups.js:364` `typeGroups`: тип строки — `projectType` её корня по `rootRowOf(open)`
- Test: `test/session-tree.test.js`, `test/session-groups.test.js`

**Interfaces:**
- Consumes: правила родства `nestSegment`: `headId`, затем `head` против `title`/`windowTitle`, разрыв циклов.
- Produces: `SessionTree.rootRowOf(rows: Row[]) → Map<Row, Row>`.

- [ ] Тесты:
  - `tg-gate-head` (home) и ребёнок `co-tg-gate` (work, `headId` → head) → оба в `type:home`, у ребёнка `projectType` остаётся `work`;
  - внук `work` под ребёнком `other` под корнем `home` → все в `home`;
  - родство по имени (`head: 'tg-gate-head'` без `headId`) → тот же итог;
  - head нет в `open` → ребёнок в своём типе;
  - корень без типа → всё дерево в `untyped`;
  - цикл A↔B — разрыв там же, где у nestByHead: B под A, оба в типе A;
  - две карточки одной сессии → обе в типе корня;
  - `nestByHead` на прежних фикстурах не меняется (существующие тесты зелёные).
- [ ] Прогон, падение, реализация, зелёный. `session-groups.js` берёт `SessionTree` лениво при вызове (`require` в node, `globalThis` в браузере): в sessions.html он грузится раньше `session-tree.js`, а settings.html `session-tree.js` не грузит вовсе.
- [ ] Правило в `docs/rules/layouts.md` (блок типов) — одной строкой к существующему абзацу.
- [ ] Коммит `feat(picker): children group under their head's project type`.

### Task 5: PR

- [ ] `git fetch && git rebase origin/master` (и на мержнутое compact-ui, если оно уже в master). `npm test`, `cd src-tauri && cargo test`.
- [ ] Шаблоны приватного: `node --test test/no-private-data.test.js` из основного каталога против файлов ветки. Как именно — прогнать тест с `data/private-patterns.txt` основного каталога по диффу.
- [ ] Пуш `feat/usage-statusline`, PR в master, отчёт coord.

### Task 6: Деплой (только по команде coord)

- Что: пикер, `BRANCH=feat/usage-statusline ./data/scripts/deploy-win.sh` из основного каталога (у worktree нет `data/`) на Windows-цель (имя — в скрипте). Мак пропущен, недоступен.
- Живой конфиг Windows-цели `~/.config/ccfzf-picker/config.yaml` (Windows: `%USERPROFILE%`): прописать `claudeUsageUrl`. Бэкап `.bak-<дата>-usage`, сверка `cmp`.
- Проверка:
  - процесс поднят свежий: `tasklist`, PID ≠ прежнему;
  - штамп сборки в трее новый;
  - в статуслайне есть блок `5h: … | week: …`;
  - выключение галки Sort в настройках прячет `⇅` без перезапуска;
  - в журнале (вкладка Log) нет строк `claude usage:` с ошибкой;
  - при `groupByProjectType` `co-tg-gate` стоит в секции `home` под своим head.
- Затем по порядку claude-wt: проверка, мерж, на Windows-цели `git checkout master && git pull --ff-only`.
