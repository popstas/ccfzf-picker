# CLI `claude-wt`, шаги 2–6 (переезд команд сессий) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** команды скриптов `session-find`, `session-rename`, `session-close`, `head-mark`, `head-adopt`, `session-spawn` живут внутри `claude-wt`; старые `.mjs` в скиллах становятся тонкими обёртками и проходят свои прежние тесты; скиллы зовут CLI.

**Architecture:** две фазы. (1) В ccfzf — один PR: каждая команда переносится в `cli/lib/commands/` со **своим прежним выводом и кодами** (`--json`-объект = объект, который печатал старый скрипт), общие куски (`lineage`, разбор аргументов, `claude agents`) — в `cli/lib/`. Старые скрипты не трогаются, пока PR не смержен и `~/bin/claude-wt` не обновлён. (2) В `~/.claude/skills` (локальный git) — по одной обёртке за коммит: скрипт зовёт `claude-wt <команда> <те же аргументы>`, тесты `~/.claude/skills/test/` проходят без правок; затем SKILL.md переписываются на прямой вызов CLI.

**Tech Stack:** Node ≥ 18, ESM, без зависимостей; тесты ccfzf — `node --test tests/cli/*.test.mjs` (каталог целиком на Node 24 не работает); тесты скиллов — `node --test ~/.claude/skills/test/*.test.mjs` с `harness.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-22-claude-wt-cli-design.md` (этот репозиторий) — раздел «Команды», шаги 2–6. План шага 1 — `docs/superpowers/plans/2026-11-22-claude-wt-cli-step1.md`.

## Global Constraints

- **Совместимость вывода — закон шага.** Команда CLI печатает тот же JSON (те же ключи и значения), что старый скрипт, и выходит с тем же кодом (`find`: 0 найдено / 2 нет / 1 ошибка; `rename`, `close`: 0/1; `spawn`: 0/1/3). Старый вывод был многострочным (`JSON.stringify(o, null, 2)`); CLI печатает одной строкой — читатели разбирают JSON, это допустимо, а больше ничего не меняется.
- **Аргументы — те же**: `claude-wt session find --session-id <id> [--timeout s] [--interval s] | --name <n> | --list [--cwd c]`; `claude-wt session rename --session-id <id> --to <name> | --cancel [--settings f]`; `claude-wt session close --session-id <id> [--force] [--kill] [--wait s]`; `claude-wt head mark`; `claude-wt head adopt [--release] <name|id>...`; `claude-wt session spawn <все флаги spawn.mjs>`.
- Проверки прав не ослабляются: метка head для `spawn`/`close`/`adopt`, «not your child» у `close`, запрет `bypassPermissions` детям, `--fork` только с поддерживающим `claude-wt-new`, отказ повторять после таймаута `spawn`.
- ccfzf **публичный**: при переносе вычистить имена машин и репозиториев (`spawn.mjs`, `find.mjs` их называют), имена клиентских проектов из фикстур (`harness.mjs` по умолчанию `cwd: '/p/ExpertizeMe'` — в ccfzf брать вымышленный). Сверка — `~/projects/js/ccfzf-picker/data/private-patterns.txt`.
- Основной каталог ccfzf — живой `~/bin/ccfzf` и теперь `~/bin/claude-wt`: worktree, ветку там не переключать.
- Тесты CLI и скиллов не ходят на живой порт менеджера (`:9722`) и не трогают настоящие `~/.ccfzf`, `~/.claude` — подмена `HOME`, как в `harness.mjs`.
- Обёртка ищет CLI в `WT_CLI_BIN`, иначе `claude-wt` из `PATH`. Имя не с `CLAUDE_`/`CCFZF_`: `harness.mjs` такие переменные вычищает.
- Видимые строки — английские, комментарии и названия тестов — русские.

## Review Focus

1. **Старый вывод отличается в мелочи** (ключ `next` у rename, `hint` у find, `prevHead` у adopt) — вызывающие (`telegram-delegate/delegate.mjs`, SKILL.md head-session) читают их по имени. Тест: на каждую команду — снимок JSON старого скрипта на той же фикстуре против CLI (Task 2–6).
2. **`claude-wt` в `PATH` старее обёртки** (обёртку закоммитили, а `install.sh` после мержа не прогнали) — обёртка обязана упасть внятно: `claude-wt: unknown command "session find" — update ccfzf and run hooks/install.sh`, код 1, а не молча. Тест — Task 7.
3. **`CLAUDE_CODE_SESSION_ID`/`CLAUDE_PID` пробрасываются через обёртку** — без них `head mark` и `spawn` не найдут себя. Тест — Task 7 (тесты скиллов это ловят: harness кладёт обе).
4. **Незакоммиченные чужие правки в `~/.claude/skills`** (сейчас `session-spawn/spawn.mjs`, `test/spawn.test.mjs`, SKILL.md нескольких скиллов) — обёртку `spawn` нельзя класть поверх: Task 8 начинается с `git status` и ждёт, пока владелец закоммитит.
5. **Таймаут `spawn` после переезда** — правило «не повторять, искать по выданному sessionId» обязано сохраниться в CLI (код 3, `sessionId` в выводе). Тест — Task 6.

---

## Фаза 1 — ccfzf (`~/projects/shell/ccfzf`, worktree, ветка `feat/claude-wt-cli-sessions`)

### Task 1: Общие куски

**Files:**
- Create: `cli/lib/lineage.mjs` (перенос `~/.claude/skills/head-session/lineage.mjs`: `ancestors`, `sessionCwd`), `cli/lib/args.mjs` (разбор `--k v` / `--flag` как в старых скриптах, позиционные — отдельно)
- Modify: `cli/lib/own.mjs` — `descendants` поверх `lineage` (без второй копии обхода)
- Test: `tests/cli/lineage.test.mjs`, `tests/cli/args.test.mjs`

**Interfaces:**
- Produces: `ancestors(id, childrenDir) -> string[]`, `sessionCwd(id, {headsDir, childrenDir, sessionsDir}) -> string|null`, `parseLegacyArgs(argv) -> {flags: object, positional: string[]}`.

- [ ] Тесты: петля в цепочке `headId` останавливается; `sessionCwd` — метка, затем запись ребёнка, затем реестр; `--k v`, `--flag`, `--k --next` (значение не съедает следующий флаг).
- [ ] FAIL → перенос → зелёные (весь `tests/cli/`) → коммит `refactor(cli): lineage и разбор аргументов скриптов`.

### Task 2: `head mark`

**Files:** Create `cli/lib/commands/head-mark.mjs`; Test `tests/cli/head-mark.test.mjs` (перенос `~/.claude/skills/test/head-mark.test.mjs` на фикстуры ccfzf).

- [ ] Тесты старого файла + снимок вывода против `head-mark.mjs` на той же фикстуре (RF 1).
- [ ] FAIL → перенос → зелёные → коммит `feat(cli): head mark`.

### Task 3: `session find`

**Files:** Create `cli/lib/commands/session-find.mjs`; Test `tests/cli/session-find.test.mjs` (у старого скрипта тестов нет — завести: `--session-id` найден/не найден с `childRecord`, `--timeout 0`, `--name` с `duplicateName`, `--list --cwd`, поля `windowHost/monitor/zone/slot` из файла трекера).

- [ ] Тесты + снимок против `find.mjs` → FAIL → перенос → зелёные → коммит `feat(cli): session find`.

### Task 4: `session rename`

**Files:** Create `cli/lib/commands/session-rename.mjs`; Test `tests/cli/session-rename.test.mjs` (тестов у старого нет — завести: `--to`, `--cancel`, многострочное имя — отказ, `--settings`, ключ `next` в ответе).

- [ ] Тесты + снимок → FAIL → перенос → зелёные → коммит `feat(cli): session rename`.

### Task 5: `session close` и `head adopt`

**Files:** Create `cli/lib/commands/session-close.mjs`, `cli/lib/commands/head-adopt.mjs`; Test — перенос `test/close.test.mjs`, `test/head-adopt.test.mjs`.

- [ ] Тесты старых файлов + снимки (у adopt — `refused`, `prevHead`, `--release` только привязанных; у close — `not your child`, `child is busy` без `--force`, `pid does not match`) → FAIL → перенос → зелёные → коммит `feat(cli): session close и head adopt`.

### Task 6: `session spawn`

**Files:** Create `cli/lib/commands/session-spawn.mjs`; Test — перенос `test/spawn.test.mjs` (**с той версии, что закоммичена в `~/.claude/skills` на момент старта задачи**; незакоммиченные чужие правки там не брать, см. RF 4).

**Interfaces:** Consumes `managerUrl`-логику из `cli/lib/manager.mjs` шага 1 (`managerFor`) — свести с выбором трекера `spawn.mjs` (самый свежий с `http`, `--machine`, `--url`), а не держать второй копией.

- [ ] Тесты старого файла + снимок `--dry-run` (тело запроса, `intro`, `taskFile`, `fork`) против `spawn.mjs`; таймаут — код 3 и `sessionId` (RF 5) → FAIL → перенос → зелёные.
- [ ] Вычистить приватное из перенесённого текста (вступление ребёнку, сообщения об ошибках) — сканер чист.
- [ ] Коммит `feat(cli): session spawn`.

### Task 6a: README, `--help`, PR

- [ ] `--help` и README ccfzf: группы `session` и `head`, ссылка «вывод совместим со скриптами скиллов».
- [ ] PR в main ccfzf, не мержить (Стас). После мержа — `git merge --ff-only` в основном клоне, `hooks/install.sh`, `claude-wt session find --list` из живой сессии.

## Фаза 2 — `~/.claude/skills` (локальный git, после мержа фазы 1)

### Task 7: Обёртки `find`, `rename`, `close`, `head-mark`, `head-adopt`

**Files:** Modify `session-find/find.mjs`, `session-rename/rename.mjs`, `session-close/close.mjs`, `head-session/head-mark.mjs`, `head-session/head-adopt.mjs`; `head-session/lineage.mjs` — оставить (его импортирует `spawn.mjs` до Task 8).

**Interfaces:** обёртка — `runCli(['session','find'], process.argv.slice(2))`: `spawnSync(process.env.WT_CLI_BIN || 'claude-wt', [...], {stdio: 'inherit', env: process.env})`, выход кодом ребёнка; `ENOENT` или «unknown command» — код 1 с текстом RF 2. Общий кусок — `~/.claude/skills/lib/run-cli.mjs` (создать; в `.gitignore` репо скиллов добавить `!/lib/`).

- [ ] Перед каждым файлом — `git status` в `~/.claude/skills`: файл грязный у другой сессии — не трогать, сказать head.
- [ ] По одному скрипту за коммит: обёртка → `node --test test/*.test.mjs` (тесты не меняются) → коммит `<скилл>: обёртка над claude-wt`.
- [ ] Тест RF 2: `WT_CLI_BIN` на скрипт, печатающий «unknown command», — обёртка выходит 1 с подсказкой.

### Task 8: Обёртка `spawn`

- [ ] Ждать, пока `session-spawn/spawn.mjs` и `test/spawn.test.mjs` чисты в `git status` (RF 4); если правки владельца новее перенесённого в Task 6 — сначала перенести их в CLI отдельным PR ccfzf.
- [ ] Обёртка → тесты `spawn.test.mjs` и `telegram-delegate.test.mjs` (он зовёт spawn) зелёные → коммит.
- [ ] `head-session/lineage.mjs` больше никто не импортирует — удалить отдельным коммитом.

### Task 9: SKILL.md на прямой вызов CLI

- [ ] `session-find`, `session-rename`, `session-close`, `session-spawn`, `head-session`: команды в примерах — `claude-wt …`; обёртки остаются для старых вызовов (`telegram-delegate`, памяти и планы с путями `.mjs`). Удалять ли обёртки потом — решение Стаса.
- [ ] Живая проверка из head: `claude-wt session spawn` тестового ребёнка → `session find --timeout 45` → `session rename` → `session close` (закрытие — только с подтверждения Стаса по этой сессии, правило head-session; спросить перед проверкой).

## Отложено до решения Стаса

- **`session open <session>`** (открыть свою сессию, когда окна нет; дорога `/claude-wt/session-open`, правило «не повторять»). Спека выносит его отдельным шагом, а `focus` по решению Стаса окон не открывает — значит, вопрос, **может ли агент открыть окно своей сессии без спроса**, открыт. Не делать, пока он не ответил.
- Удалять ли обёртки в скиллах после переезда.
