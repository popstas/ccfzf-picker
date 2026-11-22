# Задача из вольта после имени сессии — дизайн и план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Дизайн (утверждён Стасом 22.11)

**Зачем.** Видеть в пикере, над какой задачей вольта работает сессия, — и
замечать живые сессии, чья задача уже закрыта.

**Источник связи.** Скилл `sess2task` пишет подпункт `\t- Сессия <имя>` в блок
задачи `tasks.md` вольта. Вольты перечислены в `~/.claude/vaults-config.md`:
секции `## <имя-скилла>` с полями `` - `vault`: `/abs/path` `` и
`` - `tasks`: `tasks.md` ``; секции без `tasks` (например `sync-conflicts`)
пропускаются.

**Что показали данные (22.11).**
- В подпунктах только имя из `/rename`, id нет ни разу (home 11, ExpertizeMe
  28). После имени бывает хвост (`picker-do-head (ccfzf-picker); #78`),
  бывает мусорный префикс (`└referrals-prepare`).
- Одна сессия бывает под несколькими задачами (`housing` — две, слабое имя
  `ExpertizeMe` — три); у задачи бывает две сессии подряд.
- Подпункт не всегда первый в блоке (старый формат).
- Закрытые `[x]` живут в `tasks.md` до недельного отчёта; их больше половины.
- Файлы — 72 и 107 КБ.

**Подходы.**
- **ccfzf читает вольты и отдаёт поле `task` в `--state` — выбран.** Он на той
  же машине, что вольты, и тем же образом уже читает `docs/TODO.md` (`todo_at`,
  файл целиком на каждый `--state`, без кэша).
- Хук пишет задачу в `state.json` — отвергнут: связь меняется в вольте, а не в
  событии агента, и имя сессии меняется после записи.
- Пикер читает вольты сам — отвергнут: пикер живёт на Windows, вольты — на
  машине агрегатора.

**Решено (Стас 22.11).**
- Сопоставление по имени: первое слово после `Сессия `, без ведущих не-букв,
  против `title` строки сессии, точно.
- Несколько задач у сессии: открытая важнее закрытой, среди равных — свежая по
  дате `➕`; остальные — числом `+N`.
- Закрытую задачу показывать с `✓`: живая сессия с закрытой задачей — то, что
  хочется заметить.
- Галка в строке имени, отдельная, можно выключить.

**Отдано исполнителю (мои решения, поправимы).**
- Путь к конфигу вольтов — переменная `CCFZF_VAULTS_CONFIG`, умолчание
  `~/.claude/vaults-config.md`, по образцу `CCFZF_COMMENTS_FILE`. Нет файла —
  поля нет, без ошибки.
- Текст задачи чистится от меток плагина Tasks (`➕ 📅 ✅ ⏳ 🛫` с датой, `⚡`) и
  разметки ссылок (`[[a|b]]` → `b`, `[[a]]` → `a`, `[t](u)` → `t`), режется до
  120 знаков с `…`.
- Подпись вольта — basename каталога `vault` (`home`, `ExpertizeMe`), в
  подсказке строки.

---

## План

**Goal:** у строки сессии в пикере после имени стоит текст её задачи из вольта.

**Architecture:** в ccfzf — разбор конфига вольтов и `tasks.md` в карту
`имя → [задачи]`, один раз на ответ `--state`, и поле `task` у строки сессии.
В пикере — разбор поля, галка `showTask`, подпись после имени. Два репо: сначала
ccfzf (релиз, сабмодуль), потом пикер.

**Tech Stack:** ccfzf — bash со встроенным Python, тесты
`python3 tests/test_*.py`; пикер — ванильный JS, `npm test`.

**Spec:** раздел «Дизайн» выше.

## Global Constraints

- Форма поля: `task: { text: string, done: boolean, vault: string, more?:
  number }`; `more` только при `> 0`; поля `task` нет, если задачи нет.
- Видимые строки по-английски; комментарии, тесты, `assert` — по-русски.
- Пикер обязан жить со старым агрегатором: нет поля — нет подписи.
- **ccfzf — чужая зона прямо сейчас.** В нём работает `.cli-ccfzf` (head
  `picker-do-head`), живой чекаут — `~/projects/shell/ccfzf` (на него смотрит
  `~/bin/ccfzf`). Перед началом спросить head `picker-do-head`, где и когда
  работать; ветку вести отдельно.

## Review Focus

- Имя сессии `ExpertizeMe` под тремя задачами: показана одна, `+2` (тест в
  Task 2).
- Сессия с `/rename` после `sess2task`: старое имя в вольте не совпадает —
  подписи нет, без ошибки (тест в Task 2).
- `vaults-config.md` отсутствует или в секции нет `tasks`: поля нет, `--state`
  не падает (тест в Task 1).
- Задача со ссылками `[[…]]` и датами — в подписи чистый текст (тест в Task 1).
- Подпункт `Сессия` под вложенной задачей (`\t- [ ]`): относится к ней, а не к
  родителю (тест в Task 1).

---

### Task 1 (ccfzf): разбор вольтов

**Files:**
- Modify: `ccfzf` (встроенный Python) — рядом с `read_comments` (около 1534).
- Test: `tests/test_vault_tasks.py` (новый, по образцу `tests/test_comments.py`).

**Interfaces:**
- Produces: `read_vaults_config(path) -> list[dict]` — `[{ "vault": str,
  "tasks": str }]` из секций, где есть оба поля.
- Produces: `parse_vault_tasks(text, vault_label) -> dict[str, list[dict]]` —
  `имя → [{ "text", "done", "added", "vault" }]`, `added` — строка
  `YYYY-MM-DD` из `➕` или `""`.
- Produces: `vault_task_index(config_path) -> dict[str, list[dict]]` — оба
  вместе, файлы читаются один раз; любой сбой чтения — пустая карта.
- Правило принадлежности: подпункт `- Сессия …` относится к ближайшей строке
  выше с чекбоксом (`- [ ]`/`- [x]`) и меньшим отступом.

- [ ] **Step 1: failing tests** — по одному на: две секции и `sync-conflicts`
  без `tasks` → два вольта; имя с хвостом `picker-do-head (ccfzf-picker); #78`
  → ключ `picker-do-head`; `└referrals-prepare` → `referrals-prepare`; `[x]` →
  `done: True`; две сессии под одной задачей → обе в карте; подпункт под
  `\t- [ ]` → текст вложенной задачи; очистка: `- [ ] Сделать [[Note|ящик]] ⚡
  ➕ 2026-11-21 📅 2026-11-25` → `text == "Сделать ящик"`, `added ==
  "2026-11-21"`; 200-знаковая задача → 120 знаков с `…`; нет файла → `{}`.
- [ ] **Step 2:** `python3 tests/test_vault_tasks.py` — падает.
- [ ] **Step 3:** реализовать по Interfaces.
- [ ] **Step 4:** тест зелёный; соседние `tests/test_*.py` тоже.
- [ ] **Step 5: commit** `feat: разбор задач вольтов (sess2task)`.

### Task 2 (ccfzf): поле `task` в `--state`

**Files:**
- Modify: `ccfzf` — переменная `CCFZF_VAULTS_CONFIG` рядом с
  `CCFZF_COMMENTS_FILE` (около 77-81, 3696), аргумент в вызов `py state`
  (около 4409), чтение один раз на ответ (рядом с `read_comments`, около 4049),
  ключ в `sessions.append` рядом с `comment` (около 4173).
- Modify: `README.md` ccfzf — переменная и поле.
- Test: `tests/test_vault_tasks.py`.

**Interfaces:**
- Consumes: `vault_task_index` (Task 1).
- Produces: `pick_task(entries) -> dict | None` — открытые раньше закрытых,
  среди равных — наибольший `added`; `more = len(entries) - 1`, если `> 0`.
  Ключ строки: `**({"task": t} if t else {})`.

- [ ] **Step 1: failing tests**: три задачи у имени (одна закрыта) → выбрана
  свежая открытая, `more == 2`; только закрытая → `done: True`; строка `--state`
  на временном конфиге несёт `task`; имя без задач — ключа нет;
  `CCFZF_VAULTS_CONFIG` на несуществующий файл — `--state` отвечает как раньше.
- [ ] **Step 2:** тесты падают.
- [ ] **Step 3:** реализовать; замерить время `--state` до и после на живых
  вольтах и записать цифры в docstring, как у `project_todo`.
- [ ] **Step 4:** тесты зелёные.
- [ ] **Step 5: commit** `feat: поле task в --state — задача сессии из вольта`;
  релиз ccfzf по его правилам (CHANGELOG, тег).

### Task 3 (пикер): сабмодуль и подпись

**Files:**
- Modify: `vendor/ccfzf` — на релиз из Task 2 (коммит `chore(vendor): ccfzf vX`).
- Modify: `frontend-src/state-shape.js` — проверка необязательного `task` у
  сессии.
- Modify: `frontend-src/session-list.js` — разбор `task` рядом с `comment`
  (около 337): объект с непустым `text` или `null`; текст задачи — в стог
  поиска, как `comment`.
- Modify: `frontend-src/session-glyph.js` — `taskNameHtml(session, show)` рядом
  с `headNameHtml` (около 886).
- Modify: `sessions.html` — вызов после `headNameHtml` в строке имени (около
  1690-1760), галка в `TOGGLE_CHECKS` группы `left` после `showComment`,
  умолчание `{ list: true, statusline: false }`, класс `.task` с цветом
  токеном из `theme.css`.
- Modify: `settings.html` — подпись `task`, умолчание, иконка (уникальная,
  например `⚑`), подсказка `The vault task this session was recorded under
  (sess2task). ✓ — the task is done.`
- Modify: `frontend-src/session-info.js` — строка `Task` в карточке.
- Modify: `docs/rules/list-rows.md` — правило, счёт в указателе CLAUDE.md.
- Test: `test/session-list.test.js`, `test/session-glyph.test.js`,
  `test/row-contract.test.js`, `test/settings-page.test.js`, `test/theme.test.js`
  (сторожа есть, дописывать по их требованию).

**Interfaces:**
- Consumes: поле `task` (Task 2).
- Produces: `taskNameHtml(session, show) -> string` — `''` без задачи или при
  `show === false`; иначе `<span class="task" title="<vault>: <text>">` +
  `✓ ` при `done` + текст + ` +N` при `more`; всё через `escapeHtml`.

- [ ] **Step 1: failing tests**: разбор `task` (объект, мусор, пустой текст →
  `null`); `taskNameHtml` — открытая, закрытая с `✓`, `+2`, экранирование
  `<b>`, выключенная галка; поиск находит сессию по слову задачи.
- [ ] **Step 2:** `npm test` — падает.
- [ ] **Step 3:** реализовать по Interfaces.
- [ ] **Step 4:** `npm test` — зелёное.
- [ ] **Step 5: commit** `feat: задача из вольта после имени сессии`.

### Task 4: выкатка и живая проверка

Мак `mac.popstas.pro` недоступен — пропущен (решение Стаса 14.11). popstas-pc не
трогать.

- [ ] **Step 1:** ccfzf на машине агрегатора — живой чекаут
  `~/projects/shell/ccfzf` на релиз (согласовать с `picker-do-head`: там же
  работает `.cli-ccfzf`). Проверка: `ccfzf --state | jq '.sessions[] |
  select(.task) | {title, task}'` — у сессий из `sess2task` поле есть.
- [ ] **Step 2:** пикер — запушить, `BRANCH=<ветка>
  ./data/scripts/deploy-win.sh` в фоне; `tasklist` и штамп сборки.
- [ ] **Step 3: живьём на nb.** У сессии, записанной `sess2task` под открытой
  задачей, после имени — текст задачи; у записанной под закрытой — `✓`;
  подсказка называет вольт; галка `task` прячет подпись; поиск по слову задачи
  находит сессию.
- [ ] **Step 4:** в PR — что проверено и что нет (мак, местный источник
  Windows без вольтов — подписи там нет, и это верно).
