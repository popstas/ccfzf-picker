# CLI `claude-wt`, шаг 1 (окна и картина) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** агент одной командой `claude-wt` читает картину сессий и окон, поднимает окно своей сессии, раскладывает свою группу head и восстанавливает снимок своих сессий — с честным кодом выхода.

**Architecture:** две части. (A) windows11-manager учится отвечать по существу: `focus` в режиме «только поднять» и с полем `foreground`, `place` с результатом, отказы — `200 {ok:false, reason}`. (B) В репозитории ccfzf — Node-CLI `cli/claude-wt.mjs` поверх `ccfzf --state`, `~/.ccfzf/windows/*.json`, `~/.ccfzf/children/*.json` и http менеджера. (C) Скилл `claude-wt-cli` в `~/.claude/skills`. Команды сессий (шаги 2–6 спеки) — отдельный план после этого.

**Tech Stack:** windows11-manager — Node, vitest (`npm test`). CLI — Node ≥ 18, ESM, без зависимостей, тесты `node --test tests/cli/`. Скилл — markdown.

**Spec:** `docs/superpowers/specs/2026-11-22-claude-wt-cli-design.md` (этот репозиторий, ccfzf-picker). Читать целиком перед началом.

## Global Constraints

- Решения Стаса: агенту без спроса можно `focus` и `layout`; `focus` **только поднимает существующее окно**, нового не открывает; действовать **только над своими сессиями**.
- «Свои» = вызывающая сессия (`CLAUDE_CODE_SESSION_ID`) и её потомки по `~/.ccfzf/children/<id>.json` (`headId` — родитель). Нет переменной — команды действия отказывают, `tree` работает.
- Транспорт — только http менеджера (`http.port` / `http.host` в файле трекера). MQTT не трогать.
- Отказы менеджера — `200 {ok:false, reason}`, не 4xx/5xx: пикер читает только код ответа (`manager_http.rs`), его поведение не должно измениться.
- Коды выхода CLI: `0` сделано (или `pending`), `1` отказ с причиной, `2` не найдено, `3` исход неизвестен (таймаут).
- ccfzf — **публичный** репо: ни имён машин, ни домашних путей, ни клиентских проектов; сверка — `~/projects/js/ccfzf-picker/data/private-patterns.txt`. Основной каталог ccfzf — живой `~/bin/ccfzf`: работать в worktree, ветку там не переключать.
- Мак не трогать (недоступен); файлы `mac*.json` в `~/.ccfzf/windows/` не должны ронять CLI.
- Тесты CLI не ходят на живой порт менеджера — только мок-сервер через `--url` / подменённые каталоги.
- Видимые строки CLI (вывод, ошибки) — английские; комментарии и названия тестов — русские (правило связки).

## Review Focus

1. **Старый менеджер без `raiseOnly`** открыл бы окно на `focus` (его `focusOrRestore` делает restore) — CLI обязан отказать сам, если у сессии в `--state` нет окна (`window == null`), до запроса. Тест — Task B4.
2. **Имя совпадает у двух сессий** (тёзки — частая беда связки) — отказ `1` со списком id, а не первая попавшаяся. Тест — Task B3.
3. **Файл трекера протух** (`generated` старше 15 мин, отвалившийся сетевой диск на Windows) — отказ «tracker stale» с именем файла, а не запрос по старому адресу. Тест — Task B4.
4. **Менеджер не отвечает** (ноутбук спит) — таймаут 5 с, код `3`, `--json` с `error: "timeout"`; повтор агенту безопасен только для `focus`/`layout`, скилл это говорит. Тест — Task B4.
5. **Ответ `200 {"ok":true}` без `foreground`** (менеджер ещё старый, без Task A1) — CLI не выдаёт это за успех подъёма: код `0`, но `foreground: null` и предупреждение в stderr «manager did not report foreground». Тест — Task B4.

---

## Часть A — windows11-manager (`~/projects/js/windows11-manager`, свой worktree, ветка `feat/claude-wt-cli-answers`)

### Task A1: `claude-focus` отвечает по существу и умеет «только поднять»

**Files:**
- Modify: `src/commands/claude-commands.js` (`focus`, `focusOrRestore` ~стр. 152–160, 246–257)
- Test: `src/commands/claude-commands.test.js`

**Interfaces:**
- Produces: тело `/claude-wt/focus` — `{id, raiseOnly?: boolean}`. Ответ обработчика:
  `{ok: true, action: 'focus', foreground: boolean}` |
  `{ok: false, reason: string}` (сессия не найдена — `found.error`; `raiseOnly` и окна нет — `'no window'`) |
  без `raiseOnly` и без окна — как сегодня `{action: 'restore', ...}` (пикер и панель не меняются).

- [ ] **Step 1: Тесты**
  - `'focus raiseOnly без окна — отказ no window и restore не зовётся'`: `chooseAction` даёт `restore`; ждём `{ok:false, reason:'no window'}`, мок `restoreOne`/`winMan.resumeClaudeSession` не вызван.
  - `'focus с окном отдаёт foreground'`: `winMan.focusTerminalWindow` → `true` ⇒ `{ok:true, action:'focus', foreground:true}`; → `false` ⇒ `foreground:false`.
  - `'focus неизвестной сессии — ok:false с причиной'`: `findSession` с `error` ⇒ `{ok:false, reason: <тот же текст>}`.
  - `'focus без raiseOnly без окна — прежний restore'` (сторож обратной совместимости).
- [ ] **Step 2:** `npm test -- claude-commands` — новые FAIL.
- [ ] **Step 3:** Реализация: `focus(payload)` возвращает результат `focusOrRestore` (сегодня теряет его); `focusOrRestore(id, session, terminal, mark, cursor, {raiseOnly})` — при `raiseOnly` и `chooseAction === 'restore'` возвращает отказ, не вызывая `guardOpen`; в ветке focus кладёт результат `focusTerminalWindow` в `foreground`. Остальные вызывающие `focusOrRestore` (`claude-focus-slot`, `session-open`) — без `raiseOnly`, поведение прежнее. `withRefresh` в `build.js` уже пробрасывает результат.
- [ ] **Step 4:** `npm test` — всё зелёное.
- [ ] **Step 5:** Коммит `feat(claude-wt): focus отвечает foreground и умеет только поднять окно`.

### Task A2: `claude-place` отвечает результатом, отброшенное нажатие — отказом

**Files:**
- Modify: `src/commands/claude-commands.js` (`'claude-place'` ~стр. 271–293), `src/commands/build.js:55-57`
- Test: `src/commands/claude-commands.test.js`, тест `build.js` (если есть), иначе там же

**Interfaces:**
- Produces: ответ `claude-place`: `{ok:true, placed: number}` | `{ok:false, reason}` (тело не разобрано — `'bad payload'`; отказ `arrangeClaudeWindows` — его `reason`; исключение — `e.message`). Отброшенное `throttlePress` (`DROPPED`) по http — `{ok:false, reason:'throttled'}`. Поля `foreground` у `place` нет (отступление от спеки, решение плана: `arrangeGroup` подъём окна не проверяет, а CLI для `layout` его не требует).

- [ ] **Step 1: Тесты** — `'place group отдаёт placed'`, `'place с отказом раскладки — ok:false и reason'`, `'place с неразобранным телом — bad payload'`, `'place дважды за секунду — второй throttled'`.
- [ ] **Step 2:** запуск — FAIL.
- [ ] **Step 3:** обработчик возвращает `{ok, placed|reason}` (журнал и `notify` остаются); в `build.js` обёртка поверх `throttlePress` превращает `DROPPED` в отказ — только для возвращаемого значения, `onDrop` прежний.
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5:** Коммит `feat(claude-wt): place отвечает результатом, отброшенное — throttled`.

### Task A3: Выкатка менеджера и живая проверка ответов

- [ ] PR в master windows11-manager, не мержить (мерж — Стас). Перед выкаткой посмотреть ветку на ноутбуке (`git -C <REPO> branch --show-current` по ssh); чужая несмерженная — не катить, сказать head.
- [ ] `BRANCH=feat/claude-wt-cli-answers ./data/scripts/deploy-pc.sh --no-build` (только node). Проверить, что живы ровно по одному `node src/index.js mqtt|claude-wt`.
- [ ] Живые запросы с машины агентов (`curl -s -X POST http://<http.host>:<port>/claude-wt/focus -d '{"id":"<своя сессия с окном>","raiseOnly":true}'`) — ждём `{"ok":true,"action":"focus","foreground":true}`; с id сессии без окна — `{"ok":false,"reason":"no window"}` и **никакого нового окна на экране** (сверить по `~/.ccfzf/windows/<host>.json`, что окон не прибавилось).
- [ ] Пикер: Enter на сессии и Ctrl+Win+F10 работают как раньше.

## Часть B — CLI в ccfzf (`~/projects/shell/ccfzf`, worktree, ветка `feat/claude-wt-cli`)

Структура:

```
cli/claude-wt.mjs        # точка входа: разбор argv, диспетчер команд, коды выхода
cli/lib/out.mjs          # EXIT, emit(): --json / человеческий вывод, stderr
cli/lib/sources.mjs      # ccfzf --state, файлы трекеров, children, claude agents
cli/lib/own.mjs          # кто «свой»: потомки по ~/.ccfzf/children
cli/lib/resolve.mjs      # <session> → id (id, префикс, имя)
cli/lib/manager.mjs      # выбор менеджера по хосту окна, POST с таймаутом
cli/lib/commands/*.mjs   # tree, window-focus, window-layout, snapshot
tests/cli/*.test.mjs     # node --test, моки каталогов через env, мок-сервер
```

Каталоги и бинарь подменяются окружением (как у скриптов скиллов): `CCFZF_BIN` (по умолчанию `ccfzf`), `CCFZF_WINDOWS_DIR` (`~/.ccfzf/windows`), `CCFZF_CHILDREN_DIR` (`~/.ccfzf/children`), `CCFZF_HEADS_DIR` (`~/.ccfzf/heads`), `CLAUDE_BIN` (`claude`).

### Task B1: Каркас CLI, вывод и коды выхода, установка

**Files:**
- Create: `cli/claude-wt.mjs` (shebang `#!/usr/bin/env node`, исполняемый), `cli/lib/out.mjs`
- Modify: `hooks/install.sh` — ставит ещё и `~/bin/claude-wt` → `<клон>/cli/claude-wt.mjs` по тем же правилам (идемпотентно, бэкап отличающегося, отказ из worktree)
- Test: `tests/cli/out.test.mjs`, `tests/test_hooks.py` (раздел установщика)

**Interfaces:**
- Produces: `EXIT = {OK:0, REFUSED:1, NOT_FOUND:2, UNKNOWN:3}`; `emit(result, {json}) -> number` — печатает `result` (JSON одной строкой при `json`, иначе `result.text ?? краткая сводка`), ошибки (`result.error`) — в stderr, возвращает код; `result = {code, error?, ...поля}`.
- CLI: `claude-wt <group> <action> [args] [--json] [--url U] [--machine H]`; без аргументов и `--help` — справка (англ.), код 0; неизвестная команда — код 1.

- [ ] Тесты: `'emit json печатает одну строку и возвращает code'`, `'ошибка уходит в stderr'`, `'неизвестная команда — код 1 и справка'`, установщик кладёт симлинк `~/bin/claude-wt` в подставном HOME.
- [ ] FAIL → реализация → `node --test tests/cli/ && python3 -m pytest -q tests/test_hooks.py` зелёные.
- [ ] Коммит `feat(cli): каркас claude-wt и установка симлинком`.

### Task B2: Источники, «свои» и `tree`

**Files:**
- Create: `cli/lib/sources.mjs`, `cli/lib/own.mjs`, `cli/lib/commands/tree.mjs`
- Test: `tests/cli/own.test.mjs`, `tests/cli/tree.test.mjs` (фикстура `tests/cli/fixtures/state.json` — урезанный `--state` с вымышленными именами и хостами)

**Interfaces:**
- `readState({bin}) -> object` — `ccfzf --state`, разбор JSON; провал — исключение с текстом stderr.
- `readTrackers(dir, now) -> Array<{file, host, http: {host, port}|null, generated, fresh: boolean}>` — `fresh` = `now - generated < 900` (тот же `TRACKER_MAX_AGE_SEC`, что у `spawn.mjs`); битый файл пропускается.
- `descendants(id, childrenDir) -> Set<string>` — все, у кого цепочка `headId` ведёт к `id`; защита от петель как в `lineage.mjs`.
- `ownSet(callerId, childrenDir) -> Set<string>` — `{callerId} ∪ descendants`.
- `tree` → `{code:0, caller, sessions:[{id, title, live, cwd, window:{host,title}|null, own, head: boolean, parent: string|null}], snapshots:[{id, created, host, sessions:[id], own}]}`; `own` у снимка — все его сессии свои.

- [ ] Тесты: `'потомки вглубь и петля не зацикливает'`, `'без CLAUDE_CODE_SESSION_ID tree работает, own везде false'`, `'tree помечает своих и head'`, `'снимок свой только если все сессии свои'`, `'файл мака без http не роняет readTrackers'`.
- [ ] FAIL → реализация → зелёные → коммит `feat(cli): tree — сессии, окна, head и свои`.

### Task B3: Разрешение `<session>`

**Files:**
- Create: `cli/lib/resolve.mjs`
- Test: `tests/cli/resolve.test.mjs`

**Interfaces:**
- `resolveSession(arg, {state, agents}) -> {id} | {error:'not found'} | {error:'ambiguous', candidates:[{id,title}]}` — порядок: точный id; уникальный префикс id (≥ 6 символов); точное имя среди живых (`agents`: `claude agents --json`, поле имени как в `find.mjs`); точный `title` из `state.sessions`. Несколько совпадений на любом шаге — `ambiguous`.

- [ ] Тесты: `'полный id'`, `'префикс id'`, `'короткий префикс (<6) не принимается'`, `'имя живой сессии'`, `'title закрытой сессии'`, `'два тёзки — ambiguous со списком'` (Review Focus 2).
- [ ] FAIL → реализация → зелёные → коммит `feat(cli): разрешение сессии по id, префиксу и имени`.

### Task B4: Клиент менеджера и `window focus`

**Files:**
- Create: `cli/lib/manager.mjs`, `cli/lib/commands/window-focus.mjs`
- Test: `tests/cli/window-focus.test.mjs` (мок-сервер `node:http` на случайном порту)

**Interfaces:**
- `managerFor({host, trackers, url, machine}) -> {url} | {error, code}` — `--url` перебивает всё; иначе трекер с `host === window.host` (или `--machine`); нет трекера/`http` — `{error:'no http manager for <host>', code:1}`; не `fresh` — `{error:'tracker stale: <file>', code:1}`.
- `post(url, path, body, {timeoutMs = 5000}) -> {status, body} | {timeout:true}`.
- `window focus <session>` — порядок: caller есть → resolve → `own` → у сессии есть окно в `--state` (иначе `{code:2, error:'no window'}`, запрос **не** шлётся) → `POST /claude-wt/focus {id, raiseOnly:true}` → разбор: `ok:false` — код 1 с `reason`; `foreground:false` — код 1 `'window did not come to front'`; `foreground` нет — код 0, `foreground:null`, предупреждение в stderr; таймаут — код 3.

- [ ] Тесты: `'чужая сессия — отказ, запроса нет'`, `'без окна — код 2, запроса нет'` (Review Focus 1), `'тело запроса несёт raiseOnly:true'`, `'foreground:false — код 1'`, `'старый менеджер без foreground — код 0 и предупреждение'` (RF 5), `'протухший трекер — отказ с именем файла'` (RF 3), `'таймаут — код 3'` (RF 4), `'ok:false от менеджера — код 1 с его reason'`.
- [ ] FAIL → реализация → зелёные → коммит `feat(cli): window focus — только поднять своё окно`.

### Task B5: `window layout <head>`

**Files:**
- Create: `cli/lib/commands/window-layout.mjs`
- Test: `tests/cli/window-layout.test.mjs`

**Interfaces:**
- Consumes: `resolveSession`, `ownSet`, `descendants`, `managerFor`, `post`.
- `<head>` свой (caller или потомок); группа = `[head, ...потомки с окном в --state]` в порядке `createdAt` записей children; меньше двух окон — `{code:1, error:'nothing to lay out'}` без запроса; машина — по окну head; тело `{mode:'group', groups:[группа], selected: head}` на `/claude-wt/place`; ответ: `ok:false` (включая `throttled`) — код 1; `ok:true` — код 0 с `placed`.

- [ ] Тесты: `'чужой head — отказ'`, `'дети без окна не входят'`, `'одно окно — nothing to lay out без запроса'`, `'тело group с selected=head'`, `'throttled — код 1'`.
- [ ] FAIL → реализация → зелёные → коммит `feat(cli): window layout — раскладка своей группы`.

### Task B6: `snapshot list` и `snapshot restore`

**Files:**
- Create: `cli/lib/commands/snapshot.mjs`
- Test: `tests/cli/snapshot.test.mjs`

**Interfaces:**
- `snapshot list` — снимки из `--state` только с хостов, у которых в трекерах есть `http`; поля как в `tree.snapshots`, свежие сверху.
- `snapshot restore <id|last> [--sessions a,b]` — `last` = самый свежий **свой** снимок среди списка; без `--sessions` снимок обязан быть своим целиком, иначе отказ со списком чужих; с `--sessions` — каждая названная сессия своя и входит в снимок; `POST /claude-wt/snapshot-restore {id, sessionIds}` на менеджер хоста снимка; успех — код 0, `pending:true`, текст `accepted, outcome unknown — see tracker log`.

- [ ] Тесты: `'list без снимков мака'`, `'last — свежий свой'`, `'чужая сессия в снимке — отказ'`, `'--sessions вне снимка — отказ'`, `'успех — pending и код 0'`.
- [ ] FAIL → реализация → зелёные → коммит `feat(cli): snapshot list и restore своих сессий`.

### Task B7: README ccfzf, PR, живая проверка

- [ ] README ccfzf: раздел `claude-wt` — команды, коды выхода, «только свои», `focus` не открывает окон, установка. Сканер private-patterns по ветке — чисто.
- [ ] PR в main ccfzf, не мержить. После мержа (Стас) — `hooks/install.sh` в основном клоне ставит `~/bin/claude-wt`.
- [ ] Вживую (после Task A3 и мержа): из своей сессии — `claude-wt tree --json | jq '.sessions[] | select(.own)'` совпадает с группой в пикере; `claude-wt window focus <свой ребёнок>` поднимает окно на другом столе; на сессии без окна — код 2, новых окон нет; на чужой — код 1; `claude-wt window layout <свой head>` раскладывает как группа; `claude-wt snapshot restore` тестового снимка из своих сессий.

## Часть C — скилл

### Task C1: Скилл `claude-wt-cli`

**Files:**
- Create: `~/.claude/skills/claude-wt-cli/SKILL.md` (локальный git `~/.claude/skills`: снять `claude-wt-cli/` из `.gitignore`-исключений по образцу `session-*/`, закоммитить там)

- [ ] Содержание: когда звать (поднять окно своей сессии, разложить свою группу, восстановить снимок своих, прочитать картину); команды с примерами `--json`; разрешено без спроса — `focus`, `layout` (решение Стаса), `snapshot restore` своих (head — звать по делу, поднимает несколько окон); только свои сессии; `focus` не открывает окно — для открытия пока нет команды, сказать пользователю; коды выхода и `pending`; повтор после кода 3 безопасен для `focus`/`layout`, для `snapshot restore` — нет.
- [ ] Ссылка на скилл из `head-session` (раздел про ребёнка: где стоит окно, раскладка) — одна строка.
- [ ] Коммит в `~/.claude/skills`.

### Task C2: Деплой и проверка (последняя)

- [ ] windows11-manager — `deploy-pc.sh --no-build` на ноутбук (после мержа — с master). Мак пропущен: недоступен.
- [ ] ccfzf — мерж в main = выкатка (`~/bin/ccfzf` смотрит в основной клон); затем `hooks/install.sh`; `claude-wt --help` из новой сессии.
- [ ] Пикер не меняется — выкатывать нечего; проверить, что Enter и Ctrl+Win+F10 в нём работают как раньше.
- [ ] Итог: что проверено вживую, что нет.
