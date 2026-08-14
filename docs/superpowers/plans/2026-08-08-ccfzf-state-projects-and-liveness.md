# Агрегатор ccfzf: список проектов в `--state` и живость по транскрипту

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** научить `ccfzf --state` отдавать список проектов и перестать считать
живой сессию, чей транскрипт не менялся по существу неделю.

**Architecture:** обе правки — внутри python-блока агрегатора. Список проектов
собирается уже готовой `project_rows()` над уже собранными `dirs` и `live`.
Живость: эвристическая ветка `fresh` внутри `running_sessions()` выносится в
отдельную функцию со швами для тестов и начинает судить о возрасте кандидата по
последней записи с `timestamp`, а не по `os.path.getmtime`.

**Tech Stack:** Python 3.12 (стандартная библиотека), bash-обёртка, свои тесты
без зависимостей (`tests/harness.py` вырезает python-блок из скрипта).

## Global Constraints

- **Рабочий каталог — `~/projects/shell/ccfzf`.** Это отдельный git-репозиторий.
  Пикер (`~/projects/js/ccfzf-picker`) здесь не трогается вовсе.
- **Репозиторий сейчас на ветке `feat/windows-file-focus-stamp`.** Перед началом
  проверить `git status` и завести свою ветку от актуальной точки.
- **Только стандартная библиотека.** Зависимостей у агрегатора нет и не заводим.
- **Тесты запускаются поштучно:** `python3 tests/<файл>.py`. Раннера нет.
- **Питон живёт heredoc-ом внутри bash-скрипта** (`read -r -d '' PY <<'PYEOF'` …
  `PYEOF`). Тесты достают его через `tests/harness.py`; менять метки нельзя.
- **`--state` вызывается раз в секунду**, пока окно пикера показано. Ничего, что
  читает диск пропорционально числу сессий, в него добавлять нельзя.
- **Комментарии в этом репозитории объясняют «почему», а не «что».** Держаться
  того же тона: соседние функции — образец.
- **Формат сообщений коммитов — Conventional Commits** (`feat:`, `fix:`,
  `test:`, `refactor:`): по ним `git-cliff` собирает CHANGELOG в релизном
  workflow.

---

## Файловая карта

| Файл | Что с ним |
|---|---|
| `ccfzf` | новая `last_message_at()`, новая `fresh_ids()`, константа `FRESH_MAX_AGE`, `projects` в режиме `state`, `datetime` в импортах |
| `tests/test_liveness.py` | тесты `last_message_at` и `fresh_ids` |
| `tests/test_state_projects.py` | новый файл: `projects` в ответе `state` |
| `tests/test_agent_of.py` | четыре проверки, портированные из пикера |

---

## Task 1: `last_message_at()` — возраст транскрипта по содержимому

**Files:**
- Modify: `ccfzf` (импорты, строка 117; новая функция после `tail_facts`, строка 463)
- Test: `tests/test_liveness.py`

**Interfaces:**
- Consumes: `TAIL` (константа, `ccfzf:133`)
- Produces: `last_message_at(path) -> float` — epoch-секунды последней записи с
  `timestamp` в хвосте файла; `0.0`, если такой записи нет или файл не читается.

- [ ] **Шаг 1: написать падающие тесты**

Дописать в `tests/test_liveness.py` перед строкой `TESTS = [...]`:

```python
def _jsonl(d, name, records):
    path = os.path.join(d, name)
    with open(path, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    return path


def test_last_message_at_reads_the_newest_stamped_record():
    with tempfile.TemporaryDirectory() as d:
        path = _jsonl(d, "a.jsonl", [
            {"type": "user", "timestamp": "2026-08-05T19:00:00.000Z"},
            {"type": "assistant", "timestamp": "2026-08-05T19:51:00.000Z"},
        ])
        assert CC["last_message_at"](path) == 1786045860.0, CC["last_message_at"](path)


def test_last_message_at_ignores_service_records_without_a_stamp():
    # Ровно тот случай, ради которого функция и появилась: в хвосте живого
    # файла лежат last-prompt / custom-title / mode, у них времени нет, а
    # mtime Claude Code им обновляет спустя дни после разговора.
    with tempfile.TemporaryDirectory() as d:
        path = _jsonl(d, "a.jsonl", [
            {"type": "assistant", "timestamp": "2026-08-01T20:11:00.000Z"},
            {"type": "last-prompt", "lastPrompt": "..."},
            {"type": "custom-title", "customTitle": "obsidian"},
            {"type": "mode", "mode": "default"},
        ])
        assert CC["last_message_at"](path) == 1785960660.0, CC["last_message_at"](path)


def test_last_message_at_gives_zero_when_nothing_is_stamped():
    with tempfile.TemporaryDirectory() as d:
        path = _jsonl(d, "a.jsonl", [{"type": "mode", "mode": "default"}])
        assert CC["last_message_at"](path) == 0.0


def test_last_message_at_survives_junk_and_a_missing_file():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "a.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not json\n")
            fh.write(json.dumps({"type": "user", "timestamp": "не время"}) + "\n")
            fh.write(json.dumps({"type": "user", "timestamp": 123}) + "\n")
        assert CC["last_message_at"](path) == 0.0
    assert CC["last_message_at"]("/nonexistent-file-for-tests.jsonl") == 0.0
```

Отметки в тестах — UTC: `2026-08-05T19:51:00.000Z` → `1786045860.0`,
`2026-08-01T20:11:00.000Z` → `1785960660.0`. Проверить арифметику можно так:

```bash
python3 -c "import datetime; print(datetime.datetime.fromisoformat('2026-08-05T19:51:00.000+00:00').timestamp())"
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Run: `python3 tests/test_liveness.py`
Expected: четыре строки `FAIL … KeyError: 'last_message_at'` — функции ещё нет.
(Раннер ловит только `AssertionError`, поэтому `KeyError` вылетит наружу и
уронит прогон целиком. Это тоже «падает» — годится.)

- [ ] **Шаг 3: добавить `datetime` в импорты**

`ccfzf:117`, было:

```python
import glob, json, os, re, subprocess, sys, time
```

стало:

```python
import datetime, glob, json, os, re, subprocess, sys, time
```

- [ ] **Шаг 4: написать функцию**

В `ccfzf`, сразу после `tail_facts()` (заканчивается на строке 463 `return "", ""`)
и перед блоком `UUID = r"..."`:

```python
def last_message_at(path):
    """Когда в транскрипте последний раз появилась запись с временем.

    mtime для этого не годится, и это не мелочь. В хвосте живого файла лежат
    служебные записи без `timestamp` — last-prompt, custom-title, mode,
    pr-link, — и Claude Code переписывает их спустя дни после последнего
    разговора. Замерено 2026-08-08: два файла выглядели на 26 и 44 минуты при
    содержимом трёх- и семидневной давности, и обе сессии числились живыми.

    Читается тот же хвост, что у tail_facts, и по той же причине: полный проход
    по истории в сотни мегабайт стоил бы дороже всего списка. Хвост без единой
    записи с временем даёт 0 — «возраст неизвестен», и вызывающий обязан
    считать такой файл непригодным, а не свежим.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - TAIL))
            lines = fh.read().split(b"\n")
    except OSError:
        return 0.0
    for raw in reversed(lines):
        try:
            o = json.loads(raw)  # обрезанная первая строка хвоста отсеется здесь
        except Exception:
            continue
        ts = o.get("timestamp") if isinstance(o, dict) else None
        if not isinstance(ts, str):
            continue
        try:
            # `Z` разбирает и сам fromisoformat начиная с 3.11, но замена
            # оставляет функцию годной и на более старом питоне: агрегатор
            # запускается на чужой машине через ssh, и версию там никто не
            # выбирал.
            return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
    return 0.0
```

- [ ] **Шаг 5: убедиться, что тесты проходят**

Run: `python3 tests/test_liveness.py`
Expected: все тесты `ok`, строка `N/N passed`.

- [ ] **Шаг 6: коммит**

```bash
git add ccfzf tests/test_liveness.py
git commit -m "feat: transcript age is read from its last stamped record"
```

---

## Task 2: `fresh_ids()` — эвристика перестаёт верить mtime

**Files:**
- Modify: `ccfzf` (константа рядом с `HOOK_LIVE_TTL`, строка 160; новая функция
  перед `running_sessions()`, строка 847; тело ветки `fresh`, строки 916–927)
- Test: `tests/test_liveness.py`

**Interfaces:**
- Consumes: `last_message_at(path)` из Task 1; `PROJECTS_DIR`, `mangle(cwd)`
- Produces: `fresh_ids(cwds, live, now, files_in=None, age_of=None) -> None` —
  добавляет id в переданное множество `live` на месте, ничего не возвращает.
  `cwds` — список каталогов (по одному вхождению на безымянный процесс, повторы
  значимы). `files_in(cwd) -> [path]` и `age_of(path) -> float` — швы для
  тестов, ровно как `ids_in=` у соседней `reattribute`.

- [ ] **Шаг 1: написать падающие тесты**

Дописать в `tests/test_liveness.py`:

```python
def test_fresh_ids_takes_the_newest_transcript_by_content():
    # Файл со свежим mtime, но старым содержимым, проигрывает файлу, чьё
    # содержимое новее. Сортировка идёт по содержимому, mtime не спрашивается.
    now = time.time()
    live = set()
    ages = {"/p/" + UUID_A + ".jsonl": now - 60, "/p/" + UUID_B + ".jsonl": now - 600}
    CC["fresh_ids"](["/p"], live, now,
                    files_in=lambda cwd: sorted(ages), age_of=ages.get)
    assert live == {UUID_A}, live


def test_fresh_ids_gives_each_process_its_own_file():
    now = time.time()
    live = set()
    ages = {"/p/" + UUID_A + ".jsonl": now - 60, "/p/" + UUID_B + ".jsonl": now - 600}
    CC["fresh_ids"](["/p", "/p"], live, now,
                    files_in=lambda cwd: sorted(ages), age_of=ages.get)
    assert live == {UUID_A, UUID_B}, live


def test_fresh_ids_drops_a_candidate_whose_content_is_stale():
    # Тот самый случай 2026-08-08: mtime 26 минут, последнее сообщение неделю
    # назад. По mtime сессия считалась живой, по содержимому — нет.
    now = time.time()
    live = set()
    ages = {"/p/" + UUID_A + ".jsonl": now - 7 * 86400}
    CC["fresh_ids"](["/p"], live, now,
                    files_in=lambda cwd: sorted(ages), age_of=ages.get)
    assert live == set(), live


def test_fresh_ids_drops_a_file_with_no_stamped_record_at_all():
    # last_message_at отдаёт 0 — «возраст неизвестен». Ноль старше любой
    # отсечки, и такой файл живым не назначается.
    now = time.time()
    live = set()
    CC["fresh_ids"](["/p"], live, now,
                    files_in=lambda cwd: ["/p/" + UUID_A + ".jsonl"],
                    age_of=lambda path: 0.0)
    assert live == set(), live


def test_fresh_ids_does_not_take_a_file_someone_already_owns():
    now = time.time()
    live = {UUID_A}
    ages = {"/p/" + UUID_A + ".jsonl": now - 60, "/p/" + UUID_B + ".jsonl": now - 120}
    CC["fresh_ids"](["/p"], live, now,
                    files_in=lambda cwd: sorted(ages), age_of=ages.get)
    assert live == {UUID_A, UUID_B}, live
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Run: `python3 tests/test_liveness.py`
Expected: прогон падает на `KeyError: 'fresh_ids'`.

- [ ] **Шаг 3: завести константу вместо числа в теле**

В `ccfzf`, после блока `HOOK_LIVE_TTL = 120` (строка 160):

```python
# Сколько может молчать транскрипт, чтобы процесс без имени сессии в argv всё
# ещё считался его хозяином. Это не про возраст сессии, а про правдоподобие
# догадки: свежий запуск пишет сейчас, а не сутки назад.
FRESH_MAX_AGE = 2 * 3600
```

- [ ] **Шаг 4: вынести ветку в функцию**

В `ccfzf`, перед `def running_sessions():` (строка 847):

```python
def fresh_ids(cwds, live, now, files_in=None, age_of=None):
    """K процессов в одном каталоге забирают K новейших транскриптов этого каталога.

    Последняя и самая слабая из трёх догадок о том, какую сессию пишет процесс:
    у него нет в argv ни `--session-id`, ни `--resume`, и опознать его нечем,
    кроме рабочего каталога. Так выглядит обычный `claude` без аргументов — то
    есть большинство.

    Возраст кандидата берётся у содержимого (`last_message_at`), а не у mtime.
    Причина — в самой last_message_at: mtime обновляют служебные записи, и по
    нему неделю не открывавшийся файл выглядит получасовым. По той же причине
    и сортировка идёт по содержимому: иначе «новейшим» оказался бы файл, чей
    mtime переписали последним.

    Швы `files_in` / `age_of` — для тестов, как `ids_in=` у reattribute:
    настоящие /proc и ~/.claude/projects в тесте не подделать.
    """
    files_in = files_in or (lambda cwd: glob.glob(
        os.path.join(PROJECTS_DIR, mangle(cwd), "*.jsonl")))
    age_of = age_of or last_message_at
    cutoff = now - FRESH_MAX_AGE
    for cwd, k in Counter(cwds).items():
        # Пара (возраст, путь), а не просто возраст: у двух файлов с одинаковым
        # временем порядок иначе зависел бы от того, что вернул glob.
        candidates = sorted(((age_of(f), f) for f in files_in(cwd)), reverse=True)
        for age, f in candidates:
            if k <= 0 or age < cutoff:
                break
            sid = os.path.basename(f)[:-6]
            if sid not in live:
                live.add(sid)
                k -= 1
```

- [ ] **Шаг 5: позвать её из `running_sessions()`**

В `ccfzf` заменить строки 916–927:

```python
    now = time.time()
    cutoff = now - 2 * 3600  # a fresh start writes now, not a day ago
    for cwd, k in Counter(fresh).items():
        files = sorted(glob.glob(os.path.join(PROJECTS_DIR, mangle(cwd), "*.jsonl")),
                       key=os.path.getmtime, reverse=True)
        for f in files:
            if k <= 0 or os.path.getmtime(f) < cutoff:
                break
            sid = os.path.basename(f)[:-6]
            if sid not in live:
                live.add(sid)
                k -= 1
```

на:

```python
    now = time.time()
    fresh_ids(fresh, live, now)
```

Заодно поправить хвост docstring самой `running_sessions()` (строки 859–860):

```
    - neither: a fresh start writes to the newest jsonl of its cwd directory,
      so K processes in one cwd claim the K newest files there.
```

→

```
    - neither: a fresh start writes to the newest jsonl of its cwd directory,
      so K processes in one cwd claim the K newest files there. Newest by
      content, not by mtime — see fresh_ids.
```

- [ ] **Шаг 6: убедиться, что тесты проходят**

Run: `python3 tests/test_liveness.py`
Expected: все `ok`, включая прежние тесты про `reattribute` — они не менялись.

- [ ] **Шаг 7: проверить на живых данных**

```bash
./ccfzf --state | python3 -c "
import json, sys
o = json.load(sys.stdin)
for s in o['sessions']:
    if s['live']:
        print(s['id'][:8], s['pid'], s['age'], s['cwd'])
"
pgrep -a claude
```

Ожидание: строк с `live` стало меньше, и каждая оставшаяся с `pid: 0` имеет
разговор моложе двух часов. Сессии `f83f46c1` (cup-dashboard) и `0624d3a3`
(obsidian-agent-workspace), если они ещё в списке, живыми больше не считаются.

- [ ] **Шаг 8: коммит**

```bash
git add ccfzf tests/test_liveness.py
git commit -m "fix: a silent transcript no longer keeps its session alive"
```

---

## Task 3: `projects` в ответе `--state`

**Files:**
- Modify: `ccfzf` (режим `state`, строки 1219–1261)
- Create: `tests/test_state_projects.py`

**Interfaces:**
- Consumes: `project_rows(dirs, live, marks)` (`ccfzf:978`) — отдаёт список
  словарей с ключами `path`, `name`, `mark`, `n`, `live`, `mtime`.
- Produces: в JSON на stdout появляется ключ `projects` — список словарей
  `{path: str, name: str, mark: bool, sessions: int, live: int, mtime: float}`.

- [ ] **Шаг 1: написать падающий тест**

Создать `tests/test_state_projects.py`:

```python
"""Проекты в ответе --state. Запуск: python3 tests/test_state_projects.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness

CC = harness.load()


def test_project_rows_shape_is_what_state_promises():
    # Ответ --state собирается проекцией project_rows, и имена полей в нём
    # свои: `sessions` вместо `n`. Тест сторожит саму проекцию — если у
    # project_rows переименуют ключ, здесь станет KeyError, а не тихо пустое
    # поле у читателя на другой машине.
    dirs = [{"dir": "/d/-p-one", "cwd": "/p/one",
             "files": [("/d/-p-one/a.jsonl", 1000.0)]}]
    rows = CC["project_rows"](dirs, set(), {})
    got = [{"path": r["path"], "name": r["name"], "mark": r["mark"],
            "sessions": r["n"], "live": r["live"], "mtime": r["mtime"]}
           for r in rows]
    assert got == [{"path": "/p/one", "name": "one", "mark": False,
                    "sessions": 1, "live": 0, "mtime": 1000.0}], got


def test_a_marked_project_without_sessions_is_still_listed():
    # Ради этого случая поле и добавляется: проект, где ни разу не запускали
    # claude, приходит только из marks, и по cwd сессий его не восстановить.
    rows = CC["project_rows"]([], set(), {"/p/empty": "empty"})
    assert [r["path"] for r in rows] == ["/p/empty"], rows
    assert rows[0]["n"] == 0 and rows[0]["live"] == 0, rows


def test_live_sessions_are_counted_per_project():
    sid = "aaaaaaaa-1111-2222-3333-444444444444"
    dirs = [{"dir": "/d/-p-one", "cwd": "/p/one",
             "files": [("/d/-p-one/%s.jsonl" % sid, 1000.0)]}]
    rows = CC["project_rows"](dirs, {sid}, {})
    assert rows[0]["live"] == 1, rows


if __name__ == "__main__":
    fails = 0
    names = [n for n in globals() if n.startswith("test_")]
    for name in sorted(names):
        try:
            globals()[name]()
            print("ok   " + name)
        except AssertionError as e:
            fails += 1
            print("FAIL " + name + ": " + str(e))
    print("%d/%d passed" % (len(names) - fails, len(names)))
    sys.exit(1 if fails else 0)
```

- [ ] **Шаг 2: убедиться, что тест проходит уже сейчас**

Run: `python3 tests/test_state_projects.py`
Expected: все три `ok`.

Это не ошибка плана: `project_rows` уже написана и работает, тест сторожит форму
проекции, которую добавляет следующий шаг. Проверка того, что поле правда
доехало до stdout, — в шаге 4, на живом ответе: подделать `scan_dirs()` и
`running_sessions()` в тесте нечем, они ходят в `~/.claude/projects` и `/proc`.

- [ ] **Шаг 3: добавить поле в ответ**

В `ccfzf`, режим `state`. Найти финальный `json.dump` (строки 1258–1261):

```python
    json.dump({"generated": now, "sessions": sessions,
               "windowHost": window_host, "windowPid": window_pid},
              sys.stdout, ensure_ascii=False)
```

заменить на:

```python
    # Проекты — то же, что видит режим `projects`, только без раскраски. Читателю
    # они нужны, чтобы начать новую сессию там, где сессий ещё не было: по cwd
    # приехавших сессий такой проект не восстановить, он приходит из marks.
    #
    # Даром: dirs и live уже собраны выше, project_rows — арифметика над ними.
    # `age` не отдаётся намеренно: возраст в строке считает читатель, и вторая
    # его форма разошлась бы с колонкой при первом же расхождении форматов.
    json.dump({"generated": now, "sessions": sessions,
               "projects": [{"path": r["path"], "name": r["name"], "mark": r["mark"],
                             "sessions": r["n"], "live": r["live"], "mtime": r["mtime"]}
                            for r in project_rows(dirs, live, marks)],
               "windowHost": window_host, "windowPid": window_pid},
              sys.stdout, ensure_ascii=False)
```

- [ ] **Шаг 4: проверить на живом ответе**

```bash
./ccfzf --state | python3 -c "
import json, sys
o = json.load(sys.stdin)
p = o['projects']
print('проектов:', len(p))
print('без сессий:', sum(1 for r in p if r['sessions'] == 0))
print(json.dumps(p[0], ensure_ascii=False))
"
```

Ожидание: `projects` непуст, у каждой записи шесть полей, есть хотя бы один
проект с `sessions: 0` (иначе поле не решает задачу, ради которой добавлено).

Заодно посмотреть, насколько вырос ответ — он ходит по ssh раз в секунду:

```bash
./ccfzf --state | wc -c
```

- [ ] **Шаг 5: коммит**

```bash
git add ccfzf tests/test_state_projects.py
git commit -m "feat: --state carries the project list, not just sessions"
```

---

## Task 4: забрать проверки `agent_of`, которые жили у пикера

**Files:**
- Modify: `tests/test_agent_of.py`

**Interfaces:**
- Consumes: `_write(d, sid, suffix, obj)`, `_agent_of(d, sid)`, `NOW`, `UUID_A`
  — всё уже есть в файле (строки 11–27).
- Produces: ничего наружу; после этой задачи `~/projects/js/ccfzf-picker/scripts/check-agent-of.py`
  можно удалять, и это делает план пикера.

Пикер держит свой `scripts/check-agent-of.py` — более ранний двойник этого
файла, вырезающий тот же python-блок. Четыре его проверки здесь не повторены, и
среди них главная: «`updated` берётся из `state.json`, а не из статуслайна» —
та самая ошибка, ради которой скрипт и писался.

- [ ] **Шаг 1: написать падающие тесты**

Дописать в `tests/test_agent_of.py` перед блоком `if __name__ == "__main__":`:

```python
def test_agent_of_does_not_let_the_statusline_move_last_activity():
    # Сессия спит шесть часов, но её терминал открыт, и статуслайн по таймеру
    # переписывает status.json каждые несколько секунд. `updated` обязан
    # остаться тем, что в state.json: через max() у любой живой сессии
    # «последняя активность» вечно оказывалась секундной давности.
    idle = NOW - 6 * 3600
    with tempfile.TemporaryDirectory() as d:
        _write(d, UUID_A, ".state.json", {"state": "idle", "updated": idle})
        _write(d, UUID_A, ".status.json",
               {"costUsd": 3, "contextPct": 40, "updated": NOW})
        got = _agent_of(d, UUID_A)
        assert got["updated"] == idle, got["updated"]
        # Деньги и проценты, наоборот, у статуслайна: он пишется чаще.
        assert got["costUsd"] == 3, got["costUsd"]
        assert got["contextPct"] == 40, got["contextPct"]


def test_agent_of_falls_back_to_the_statusline_without_a_state_file():
    # Старая сессия, поднятая до появления хука: других отметок времени нет.
    with tempfile.TemporaryDirectory() as d:
        _write(d, UUID_A, ".status.json", {"costUsd": 1, "updated": NOW})
        assert _agent_of(d, UUID_A)["updated"] == NOW


def test_agent_of_falls_back_to_the_statusline_on_a_spoiled_stamp():
    with tempfile.TemporaryDirectory() as d:
        _write(d, UUID_A, ".state.json", {"state": "idle", "updated": "nope"})
        _write(d, UUID_A, ".status.json", {"updated": NOW})
        assert _agent_of(d, UUID_A)["updated"] == NOW


def test_agent_of_returns_nothing_when_the_hook_never_ran():
    with tempfile.TemporaryDirectory() as d:
        assert _agent_of(d, UUID_A) is None
```

- [ ] **Шаг 2: прогнать**

Run: `python3 tests/test_agent_of.py`
Expected: все `ok`. Если какая-то из четырёх падает — это настоящая регрессия в
`agent_of`, а не ошибка теста: скрипт пикера гонял их зелёными. Чинить `ccfzf`.

- [ ] **Шаг 3: коммит**

```bash
git add tests/test_agent_of.py
git commit -m "test: agent_of keeps last activity away from the statusline"
```

---

## Task 5: приёмка

- [ ] прогнать все тесты репозитория:

```bash
for t in tests/test_*.py; do echo "== $t"; python3 "$t" || break; done
```

- [ ] `./ccfzf` без аргументов открывает список проектов и работает как прежде
      (эвристика живости трогала общий путь, а не только `--state`)
- [ ] `./ccfzf --dump` переписывает оба дампа, `~/.ccfzf.projects.json` не пуст
- [ ] `./ccfzf --state` отдаёт `sessions` и `projects`, разбирается `json.load`
- [ ] сверить `live` из `--state` с `pgrep -a claude` и с временем последнего
      сообщения в каждом транскрипте — мёртвых среди живых нет
- [ ] `git log --oneline` — четыре коммита с префиксами Conventional Commits

## Technical Details

**Форма отметки в транскрипте.** `"timestamp": "2026-08-07T19:32:49.876Z"` —
ISO 8601, UTC, миллисекунды. Служебные записи (`last-prompt`, `custom-title`,
`mode`, `pr-link`, `agent-name`) поля не имеют вовсе — на этом и держится
различение «файл переписали» и «в файле говорили».

**Почему хвост, а не весь файл.** `TAIL = 256 * 1024`. Записи с `timestamp`
идут вперемешку со служебными на всём протяжении файла, и в последних 256 КБ
их всегда несколько — если разговор вообще был. Файл, где в хвосте нет ни
одной, — это либо чистая служебная концовка длиной в четверть мегабайта (не
встречается), либо файл без разговора вовсе; оба случая честно дают `0`.

**Кто ещё зовёт `running_sessions()`.** Режимы `projects`, `dump`, `state` и
интерактивный список. Правка живости видна во всех — это и правильно: счётчик
живых у проекта врал ровно так же.

## Post-Completion

**Внешние следствия**

- Пикер (`~/projects/js/ccfzf-picker`) начнёт получать `projects` в ответе. До
  своей правки он это поле игнорирует — `validateState` проверяет только
  перечисленные поля сессий, лишние не мешают. Ломаться нечему.
- windows-mqtt читает `~/.ccfzf.sessions.json`, а не `--state`; формат дампа не
  менялся.
- После этого плана можно удалять `scripts/check-agent-of.py` и `vendor/ccfzf`
  в репозитории пикера — см. второй план.

**Ручная проверка**

- Открыть пикер и убедиться, что список живых сессий совпадает с тем, что
  реально работает на экране: до правки в нём было семь строк при пяти окнах.
