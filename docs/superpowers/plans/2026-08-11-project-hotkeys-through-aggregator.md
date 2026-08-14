# Проектные хоткеи через агрегатор — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Список проектных хоткеев переезжает в единственный источник —
`claudeWt.projects` у windows11-manager — и едет в ccfzf-picker файлом трекера
через `ccfzf --state`; claude-wt уходит из windows-mqtt целиком.

**Architecture:** Демон менеджера кладёт `projects[{cwd,name,hotkey}]` в
`.ccfzf.sessions.claude-wt.json`; `ccfzf --state` клеит `hotkey` к строкам
`projects[]` своего ответа; поллер пикера (Rust) достаёт список из ответа,
регистрирует клавиши на машине, где `windowHost` совпал, кэширует последний
список в `hotkeys.json` и сообщает наверх, какие комбинации заняты.

**Tech Stack:** Node 22 + vitest (windows11-manager, windows-mqtt), python 3.12
без зависимостей (ccfzf), Rust + Tauri 2 и `node --test` через `npm test`
(ccfzf-picker).

## Global Constraints

- **Работа идёт на машине с сессиями** — той, где живут репозитории, хуки
  агента и сам `ccfzf`; с Windows её домашний каталог примонтирован сетевым
  диском, но пути в плане линуксовые.
  Репозитории: `~/projects/js/windows11-manager` (ветка
  `feat/claude-wt-agent-progress`), `~/projects/shell/ccfzf`,
  `~/projects/js/ccfzf-picker` (ветка `windows-mqtt-migrate`),
  `~/projects/js/windows-mqtt` (ветка `feat/session-picker-agent-state`).
- **Язык.** Всё, что видит человек, — по-английски; комментарии, doc-комментарии,
  названия тестов и сообщения в `assert` — по-русски.
- **Тесты пикера — только `npm test`.** `node --test test/` на этих версиях Node
  не работает.
- **`;` в удалённой команде не ставить** — для Windows Terminal это разделитель
  панелей.
- **Правило секретов:** имена машин в репозиторий не возвращать
  (`test/no-private-data.test.js` в пикере это сторожит).
- **Спека:** `docs/superpowers/specs/2026-08-11-project-hotkeys-through-aggregator-design.md`.
- **Финальная сборка Rust для Windows и деплой — на Windows-машине**, не на
  машине с сессиями: `cargo test` на Linux проходит (webkit2gtk-4.1 есть), но
  `#[cfg(windows)]`-ветки windows-mqtt на Linux не компилируются.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `windows11-manager/src/claude-wt/windows-file-helpers.js` | `buildWindowsFile` кладёт `projects`, `windowsFingerprint` их учитывает |
| `windows11-manager/src/claude-wt/index.js` | `publishWindows` передаёт `claudeWtProjects()` в билдер |
| `ccfzf/ccfzf` (python-блок) | `read_windows` пропускает `projects`; новая `merge_project_hotkeys`; `--state` её зовёт |
| `ccfzf-picker/frontend-src/state-shape.js` | `hotkey` — необязательное строковое поле строки проекта |
| `ccfzf-picker/frontend-src/project-list.js` | `hotkey` переносится в строку списка |
| `ccfzf-picker/frontend-src/session-glyph.js` | колонка `hk` гасит незарегистрированный хоткей |
| `ccfzf-picker/src-tauri/src/project_hotkeys.rs` | **новый**: разбор ответа, отпечаток, регистрация, кэш |
| `ccfzf-picker/src-tauri/src/poller.rs` | зовёт `project_hotkeys` на удачном ответе |
| `ccfzf-picker/src-tauri/src/main.rs` | кэш на `setup()`, переприменение в `apply_config`, удаление старой ветки конфига |
| `ccfzf-picker/sessions.html` | подписка на `project-hotkeys`, строка в статуслайне |
| `windows-mqtt/**` | удаление claude-wt целиком |

---

### Task 1: Менеджер публикует хоткеи в файл трекера

**Files:**
- Modify: `~/projects/js/windows11-manager/src/claude-wt/windows-file-helpers.js:32-115`
- Modify: `~/projects/js/windows11-manager/src/claude-wt/index.js:257-278`
- Test: `~/projects/js/windows11-manager/src/claude-wt/windows-file-helpers.test.js`

**Interfaces:**
- Consumes: `claudeWtProjects()` из `src/claude-wt/index.js:42` — массив
  `{name, cwd, hotkey?, profile?}` (нормализован в `project-helpers.js:32`).
- Produces: `buildWindowsFile({windows, slots, host, pid, nowMs, snapshots, projects})`
  кладёт в payload ключ `projects: [{cwd, name, hotkey}]`;
  `windowsFingerprint(windows, snapshots, projects)` третьим аргументом.

- [ ] **Step 1: Написать падающие тесты**

В `src/claude-wt/windows-file-helpers.test.js`, в конец `describe('buildWindowsFile')`:

```js
  // Хоткеи едут читателю на другую машину: единственный их источник — конфиг
  // здесь, а регистрирует клавиши ccfzf-picker там. Записи без хоткея не едут
  // вовсе — читателю они не говорят ничего, а список проектов он и так знает.
  it('publishes only projects that carry a hotkey', () => {
    const out = buildWindowsFile({
      windows: [], slots: {}, host: 'pc', pid: 42, nowMs: 0,
      projects: [
        { name: 'home', cwd: '/p/home', hotkey: 'Ctrl+F11', profile: 'home' },
        { name: 'plain', cwd: '/p/plain', profile: 'work' },
      ],
    });
    expect(out.projects).toEqual([{ cwd: '/p/home', name: 'home', hotkey: 'Ctrl+F11' }]);
  });

  // profile — знание про Windows Terminal на этой машине; читателю оно
  // бесполезно, а лишнее поле в чужом файле рано или поздно кто-нибудь прочтёт.
  it('does not leak the terminal profile to the reader', () => {
    const out = buildWindowsFile({
      windows: [], slots: {}, host: 'pc', pid: 42, nowMs: 0,
      projects: [{ name: 'home', cwd: '/p/home', hotkey: 'Ctrl+F11', profile: 'home' }],
    });
    expect(out.projects[0].profile).toBeUndefined();
  });

  // Ключ на месте всегда — читателю дешевле пустой массив, чем проверка на
  // отсутствие ключа при каждом использовании. То же правило, что у snapshots.
  it('keeps the key even with nothing to publish', () => {
    expect(buildWindowsFile({ host: 'pc', pid: 1, nowMs: 0 }).projects).toEqual([]);
  });
```

В конец `describe('windowsFingerprint')`:

```js
  // Без этого смена хоткея в конфиге доезжала бы до читателя только
  // сердцебиением — до тридцати секунд, — а если расклад окон при этом не
  // менялся, то и вовсе ждала бы чужого движения.
  it('notices a changed hotkey', () => {
    const win = { one: { desktop: 1, title: 'x', focusedAt: 0 } };
    const a = [{ cwd: '/p/home', name: 'home', hotkey: 'Ctrl+F11' }];
    const b = [{ cwd: '/p/home', name: 'home', hotkey: 'Ctrl+F12' }];
    expect(windowsFingerprint(win, [], a)).not.toBe(windowsFingerprint(win, [], b));
  });

  it('notices a project that gained or lost its hotkey', () => {
    const win = { one: { desktop: 1, title: 'x', focusedAt: 0 } };
    const one = [{ cwd: '/p/home', name: 'home', hotkey: 'Ctrl+F11' }];
    expect(windowsFingerprint(win, [], [])).not.toBe(windowsFingerprint(win, [], one));
  });
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/js/windows11-manager && npx vitest run src/claude-wt/windows-file-helpers.test.js`
Expected: FAIL — `out.projects` равен `undefined`, отпечатки совпадают.

- [ ] **Step 3: Реализовать**

В `windows-file-helpers.js` в `buildWindowsFile` добавить параметр и ключ:

```js
function buildWindowsFile({ windows, slots, host, pid, nowMs, snapshots, projects }) {
```

и в возвращаемый объект, следом за `snapshots`:

```js
    // Хоткеи проектов. Единственный их источник — claudeWt.projects здесь;
    // регистрирует клавиши читатель (ccfzf-picker) на своей стороне, и знать
    // про них ему больше неоткуда. Записи без хоткея не едут: список проектов
    // читатель собирает сам, а сказать ему нечего.
    //
    // `profile` не едет намеренно: это знание про Windows Terminal на этой
    // машине, читателю бесполезное.
    projects: (projects ?? [])
      .filter(p => typeof p?.hotkey === 'string' && p.hotkey.trim())
      .map(p => ({
        cwd: typeof p.cwd === 'string' ? p.cwd : '',
        name: typeof p.name === 'string' ? p.name : '',
        hotkey: p.hotkey.trim(),
      })),
```

Там же — третий аргумент отпечатка:

```js
function windowsFingerprint(windows, snapshots, projects) {
```

и перед `return`:

```js
  // Хоткеи входят по содержимому целиком: их мало, а смена клавиши в конфиге
  // обязана доехать до читателя тем же тиком, а не сердцебиением.
  const keys = (projects ?? [])
    .map(p => `${p?.cwd}\u0000${p?.hotkey}`)
    .join('\u0001');
  const tail = `${snaps}${keys ? `\u0002${keys}` : ''}`;
  return tail ? `${win}${tail}` : win;
```

(строку `return snaps ? ... : win;` заменить на две выше.)

В `index.js` в `publishWindows`:

```js
  const payload = buildWindowsFile({
    windows, slots, host: os.hostname(), pid: process.pid, nowMs, snapshots,
    projects: claudeWtProjects(),
  });
  const fingerprint = windowsFingerprint(payload.windows, payload.snapshots, payload.projects);
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/windows11-manager && npx vitest run src/claude-wt/`
Expected: PASS, включая прежние тесты `windowsFingerprint` (у них два аргумента — третий необязателен).

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/windows11-manager
git add src/claude-wt/windows-file-helpers.js src/claude-wt/windows-file-helpers.test.js src/claude-wt/index.js
git commit -m "feat(claude-wt): хоткеи проектов едут в файл трекера"
```

---

### Task 2: ccfzf пропускает projects из файла трекера

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — `read_windows` (около строки 433)
- Test: `~/projects/shell/ccfzf/tests/test_windows_file.py`

**Interfaces:**
- Produces: `read_windows(path, now)` возвращает **пять** значений:
  `(windows, host, pid, snapshots, projects)`, где `projects` — список
  `{"cwd": str, "name": str, "hotkey": str}`.

- [ ] **Step 1: Написать падающие тесты**

В `tests/test_windows_file.py` после `_read` добавить помощник, чтобы шестнадцать
прежних мест распаковки не переписывать:

```python
def _read_projects(obj, now=NOW):
    """Пятое значение read_windows. Отдельным помощником: прежние тесты
    распаковывают четыре, и переписывать их ради нового поля незачем."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "windows.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return CC["read_windows"](path, now)[4]
```

и заменить тело `_read` на срез первых четырёх:

```python
def _read(obj, now=NOW):
    """read_windows принимает путь, поэтому файл каждому тесту пишется свой.
    Отдаёт первые четыре значения: проекты спрашивает _read_projects."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "windows.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return CC["read_windows"](path, now)[:4]
```

Новые тесты в конец файла:

```python
def test_project_hotkeys_reach_the_reader():
    # Единственный источник хоткеев — конфиг windows11-manager, и другого пути
    # к читателю у них нет: пикер про менеджер не знает ничего.
    payload = _payload({"title": "ccfzf", "desktop": 1, "lastSeen": NOW - 5})
    payload["projects"] = [{"cwd": "/p/home", "name": "home", "hotkey": "Ctrl+F11"}]
    assert _read_projects(payload) == [
        {"cwd": "/p/home", "name": "home", "hotkey": "Ctrl+F11"}], _read_projects(payload)


def test_junk_projects_cost_the_field_not_the_list():
    # Правило то же, что у окон и снимков: порченая добавка не стоит списка
    # сессий. Запись без cwd или без хоткея не значит ничего.
    payload = _payload({"title": "ccfzf", "desktop": 1, "lastSeen": NOW - 5})
    payload["projects"] = ["not a dict", {"cwd": "/p/one"}, {"hotkey": "Ctrl+F1"},
                           {"cwd": "/p/two", "hotkey": "Ctrl+F2"}]
    assert _read_projects(payload) == [
        {"cwd": "/p/two", "name": "", "hotkey": "Ctrl+F2"}], _read_projects(payload)


def test_projects_missing_is_empty_list():
    # Старый трекер про хоткеи не знает, и это не ошибка.
    assert _read_projects(_payload({"title": "ccfzf", "desktop": 1, "lastSeen": 0})) == []


def test_stale_file_gives_no_projects_either():
    # Протухший файл гасит хоткеи тем же порогом, что и окна: второго таймера
    # у них нет.
    payload = {"generated": NOW - 10_000, "host": "pc", "pid": 42,
               "windows": {UUID_A: {"title": "ccfzf", "desktop": 1}},
               "projects": [{"cwd": "/p/home", "name": "home", "hotkey": "Ctrl+F11"}]}
    assert _read_projects(payload) == []
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_file.py`
Expected: FAIL — `IndexError: tuple index out of range`.

- [ ] **Step 3: Реализовать**

В `ccfzf`, в `read_windows`: строку `empty = ({}, "", 0, [])` заменить на

```python
    empty = ({}, "", 0, [], [])
```

перед `return out, host, pid, snaps` вставить разбор:

```python
    # Хоткеи проектов. Знать их отсюда неоткуда: список живёт в конфиге
    # windows11-manager, а регистрирует клавиши читатель. Здесь это просто ещё
    # одно поле, и недоверие к нему то же, что к окнам: запись без каталога или
    # без клавиши не значит ничего и выбрасывается молча.
    projects = []
    raw_projects = o.get("projects")
    if isinstance(raw_projects, list):
        for p in raw_projects:
            if not isinstance(p, dict):
                continue
            cwd = p.get("cwd")
            hotkey = p.get("hotkey")
            if not isinstance(cwd, str) or not cwd:
                continue
            if not isinstance(hotkey, str) or not hotkey:
                continue
            projects.append({
                "cwd": cwd,
                "name": p.get("name") if isinstance(p.get("name"), str) else "",
                "hotkey": hotkey,
            })
```

и сам возврат:

```python
    return out, host, pid, snaps, projects
```

В блоке `--state` (около строки 1573) поправить распаковку:

```python
    windows, window_host, window_pid, window_snapshots, window_projects = read_windows(
        sys.argv[3] if len(sys.argv) > 3 else "", now)
```

Доработать документацию функции: в её docstring, к фразе про снимки, дописать
«и с хоткеями проектов то же правило».

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_file.py && python3 tests/test_state_mode.py`
Expected: PASS оба.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_windows_file.py
git commit -m "feat(state): read_windows пропускает хоткеи проектов"
```

---

### Task 3: `--state` клеит хоткеи к строкам проектов

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — новая `merge_project_hotkeys` рядом с `project_rows` (около строки 1191), вызов в блоке `--state` (около строки 1673)
- Test: `~/projects/shell/ccfzf/tests/test_state_projects.py`

**Interfaces:**
- Consumes: `read_windows(...)[4]` из Task 2.
- Produces: `merge_project_hotkeys(rows, projects)` — берёт строки `project_rows`
  и список из файла трекера, возвращает новый список строк, у каждой из которых
  может быть ключ `hotkey`.

- [ ] **Step 1: Написать падающие тесты**

В конец `tests/test_state_projects.py` перед `if __name__`:

```python
def test_hotkey_sticks_to_the_row_it_belongs_to():
    # Клеится по path и только к своей строке: второй список проектов у
    # читателя завёлся бы ровно затем, чтобы разойтись с первым.
    dirs = [{"dir": "/d/-p-one", "cwd": "/p/one",
             "files": [("/d/-p-one/a.jsonl", 1000.0)]}]
    rows = CC["project_rows"](dirs, set(), {})
    out = CC["merge_project_hotkeys"](rows, [{"cwd": "/p/one", "name": "one",
                                              "hotkey": "Ctrl+F11"}])
    assert [r["path"] for r in out] == ["/p/one"], out
    assert out[0]["hotkey"] == "Ctrl+F11", out


def test_project_with_a_hotkey_and_nothing_else_gets_a_row():
    # Ради этого случая всё и делается: у проекта, в котором давно не работали,
    # ни сессий, ни закладки нет — и его хоткей пропал бы именно тогда, когда он
    # и нужен.
    out = CC["merge_project_hotkeys"]([], [{"cwd": "/p/cold", "name": "cold",
                                            "hotkey": "Ctrl+F12"}])
    assert len(out) == 1, out
    assert out[0] == {"path": "/p/cold", "name": "cold", "mark": False,
                      "n": 0, "live": 0, "mtime": 0.0, "hotkey": "Ctrl+F12"}, out


def test_rows_without_a_hotkey_keep_their_shape():
    # Строка без хоткея не должна обзавестись пустым полем: читатель отличает
    # «нет клавиши» от «клавиша пустая» только отсутствием ключа.
    rows = CC["project_rows"]([], set(), {"/p/empty": "empty"})
    out = CC["merge_project_hotkeys"](rows, [])
    assert "hotkey" not in out[0], out


def test_a_hotkey_project_does_not_displace_the_marked_name():
    # Имя закладки человек написал сам; имя из менеджера — служебное, и
    # перебивать им закладку нельзя.
    rows = CC["project_rows"]([], set(), {"/p/one": "МОЙ проект"})
    out = CC["merge_project_hotkeys"](rows, [{"cwd": "/p/one", "name": "one",
                                              "hotkey": "Ctrl+F11"}])
    assert out[0]["name"] == "МОЙ проект", out
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_state_projects.py`
Expected: FAIL — `KeyError: 'merge_project_hotkeys'`.

- [ ] **Step 3: Реализовать**

В `ccfzf` после `project_rows` (после строки `return rows`) добавить:

```python
def merge_project_hotkeys(rows, projects):
    """Приклеить к строкам проектов их хоткеи из файла оконного трекера.

    Единственный источник хоткеев — конфиг windows11-manager: клавиши
    регистрирует читатель (ccfzf-picker), а знать про них ему больше неоткуда.
    Здесь они встречаются со строками, которые собраны из закладок и каталогов
    сессий, — по одному только пути.

    Проекту с хоткеем, у которого нет ни сессий, ни закладки, строка заводится:
    иначе клавиша проекта, в котором давно не работали, пропадала бы из ответа
    ровно тогда, когда она и нужна. Имя такой строке даёт менеджер; у строки,
    которая уже есть, имя не трогается — закладку человек назвал сам.

    Строка без хоткея остаётся без ключа, а не с пустым: у читателя «нет
    клавиши» и «клавиша пустая» — разные вещи.
    """
    by_path = {}
    for p in projects or []:
        cwd = p.get("cwd")
        if isinstance(cwd, str) and cwd:
            by_path.setdefault(cwd, p)

    out = []
    seen = set()
    for r in rows:
        row = dict(r)
        hit = by_path.get(row["path"])
        if hit:
            row["hotkey"] = hit["hotkey"]
        seen.add(row["path"])
        out.append(row)

    for cwd, p in by_path.items():
        if cwd in seen:
            continue
        out.append({"path": cwd, "name": p.get("name") or os.path.basename(cwd) or cwd,
                    "mark": False, "n": 0, "live": 0, "mtime": 0.0,
                    "hotkey": p["hotkey"]})
    return out
```

В блоке `--state` заменить выражение проекции:

```python
               "projects": [{"path": r["path"], "name": r["name"], "mark": r["mark"],
                             "sessions": r["n"], "live": r["live"], "mtime": r["mtime"],
                             **({"hotkey": r["hotkey"]} if r.get("hotkey") else {})}
                            for r in merge_project_hotkeys(
                                project_rows(dirs, live, marks), window_projects)],
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_state_projects.py && python3 tests/test_state_mode.py && python3 tests/test_windows_file.py`
Expected: PASS все три.

- [ ] **Step 5: Проверить на живом ответе**

Run: `cd ~/projects/shell/ccfzf && ./ccfzf --state | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['windowHost']); print([p for p in s['projects'] if p.get('hotkey')])"`
Expected: непустой `windowHost` и хотя бы одна строка с `hotkey` — при условии,
что Task 1 уже выкачен на Windows-машину. Если менеджер ещё не выкачен, список
пуст, и это не отказ: проверку повторить после шага выкатки.

- [ ] **Step 6: Коммит**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_state_projects.py
git commit -m "feat(state): хоткеи клеятся к строкам проектов"
```

---

### Task 4: Пикер показывает хоткей в колонке `hk`

**Files:**
- Modify: `~/projects/js/ccfzf-picker/frontend-src/state-shape.js:20-27`
- Modify: `~/projects/js/ccfzf-picker/frontend-src/project-list.js:22-37`
- Test: `~/projects/js/ccfzf-picker/test/state-shape.test.js`, `test/project-list.test.js`

**Interfaces:**
- Consumes: строку `projects[]` ответа с необязательным `hotkey` (Task 3).
- Produces: строка списка проектов получает поле `hotkey: string` (пустая
  строка, если клавиши нет) — его читает `hotkeyHtml` в
  `frontend-src/session-glyph.js:182`.

- [ ] **Step 1: Написать падающие тесты**

В `test/state-shape.test.js`:

```js
test('строка проекта с хоткеем проходит проверку', () => {
  const state = validState();
  state.projects = [{ path: '/p/one', name: 'one', sessions: 1, live: 0, mtime: 5,
    hotkey: 'Ctrl+F11' }];
  assert.deepEqual(StateShape.validateState(state), []);
});

// Старый агрегатор про хоткеи не знает, и это не ошибка: пикер и агрегатор
// обновляются порознь.
test('строка проекта без хоткея — не ошибка', () => {
  const state = validState();
  state.projects = [{ path: '/p/one', name: 'one', sessions: 1, live: 0, mtime: 5 }];
  assert.deepEqual(StateShape.validateState(state), []);
});

test('хоткей не строкой — ошибка', () => {
  const state = validState();
  state.projects = [{ path: '/p/one', name: 'one', sessions: 1, live: 0, mtime: 5,
    hotkey: 11 }];
  assert.equal(StateShape.validateState(state).length, 1);
});
```

(`validState()` — уже существующий в этом файле помощник; если он называется
иначе, взять тот, которым пользуются соседние тесты `projects`.)

В `test/project-list.test.js`:

```js
test('хоткей переезжает в строку под тем же именем, что читает колонка hk', () => {
  const rows = ProjectList.buildProjectList({
    projects: [{ path: '/p/one', name: 'one', sessions: 0, live: 0, mtime: 0,
      hotkey: 'Ctrl+F11' }],
  });
  assert.equal(rows[0].hotkey, 'Ctrl+F11');
});

// Пустая строка, а не undefined: hotkeyHtml подставляет значение в разметку, и
// «undefined» доехало бы до экрана словом.
test('без хоткея поле пустое, а не отсутствует', () => {
  const rows = ProjectList.buildProjectList({
    projects: [{ path: '/p/one', name: 'one', sessions: 0, live: 0, mtime: 0 }],
  });
  assert.equal(rows[0].hotkey, '');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/js/ccfzf-picker && npm test`
Expected: FAIL — `hotkey` в строке `undefined`, а проверка типа не срабатывает.

- [ ] **Step 3: Реализовать**

В `state-shape.js` после списка `PROJECT_FIELDS` добавить проверку в том же
цикле, где проверяются проекты (рядом с обходом `obj.projects`):

```js
      // Хоткей необязателен: агрегатор без него — это старый агрегатор, а не
      // ошибка. Но если он есть, он обязан быть строкой: число доехало бы до
      // регистрации клавиш и до колонки в списке.
      if (p && p.hotkey !== undefined && typeof p.hotkey !== 'string') {
        out.push(`projects[${i}].hotkey is not a string`);
      }
```

В `project-list.js` в объект строки, следом за `lastActivity`:

```js
        // Под тем же именем, что у сессии: колонку `hk` рисует общая
        // hotkeyHtml, и второе имя для того же смысла ей пришлось бы
        // объяснять. Пустая строка, а не undefined, — та же причина.
        hotkey: typeof p.hotkey === 'string' ? p.hotkey : '',
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/ccfzf-picker && npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add frontend-src/state-shape.js frontend-src/project-list.js test/state-shape.test.js test/project-list.test.js
git commit -m "feat(picker): хоткей проекта доезжает до колонки hk"
```

---

### Task 5: Чистые функции модуля `project_hotkeys`

**Files:**
- Create: `~/projects/js/ccfzf-picker/src-tauri/src/project_hotkeys.rs`
- Modify: `~/projects/js/ccfzf-picker/src-tauri/src/main.rs` — `mod project_hotkeys;` рядом с прочими `mod`

**Interfaces:**
- Produces:
  - `pub struct Project { pub cwd: String, pub hotkey: String }` (`Clone`, `Debug`, `PartialEq`)
  - `pub fn wanted_from_state(state: &serde_json::Value, own_host: &str) -> Option<Vec<Project>>`
  - `pub fn fingerprint(list: &[Project]) -> String`

- [ ] **Step 1: Написать падающие тесты**

Создать `src-tauri/src/project_hotkeys.rs` с одними тестами и заголовком:

```rust
//! Проектные хоткеи: список приезжает ответом агрегатора, а не из конфига.

#[cfg(test)]
mod tests {
    use super::*;

    fn state(host: &str, projects: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "windowHost": host, "projects": projects })
    }

    /// Пустой `windowHost` значит «ответ про окна ничего не знает».
    ///
    /// Различить «менеджер убрал хоткей» и «трекер лежит» больше нечем:
    /// строки `projects` в ответе есть всегда, они собираются из закладок
    /// ccfzf. Спутав эти случаи, пикер снимал бы клавиши на каждую ночь, когда
    /// Windows-машина выключена, — и молча.
    #[test]
    fn a_silent_answer_changes_nothing() {
        let s = state("", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), None);
    }

    /// Чужая машина ничего не регистрирует: клавиши там принадлежат её хозяину.
    #[test]
    fn another_machine_registers_nothing() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one", "hotkey": "Ctrl+F11"}]));
        assert_eq!(wanted_from_state(&s, "other-host"), None);
        assert_eq!(wanted_from_state(&s, ""), None);
    }

    /// Живой трекер с пустым списком — это «хоткеев нет», и он их снимает.
    #[test]
    fn a_live_tracker_with_no_hotkeys_clears_them() {
        let s = state("tracker-host", serde_json::json!([{"path": "/p/one"}]));
        assert_eq!(wanted_from_state(&s, "tracker-host"), Some(vec![]));
    }

    #[test]
    fn hotkeys_arrive_in_the_order_the_answer_gave_them() {
        let s = state("tracker-host", serde_json::json!([
            {"path": "/p/one", "hotkey": "Ctrl+F11"},
            {"path": "/p/two", "hotkey": " Ctrl+F12 "},
            {"path": "", "hotkey": "Ctrl+F9"},
        ]));
        assert_eq!(
            wanted_from_state(&s, "tracker-host"),
            Some(vec![
                Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() },
                Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() },
            ])
        );
    }

    /// Отпечаток нужен затем же, зачем и у состояния: перевешивать клавиши на
    /// каждый секундный опрос — значит снимать и ставить регистрацию в системе
    /// шестьдесят раз в минуту.
    #[test]
    fn the_same_list_has_the_same_fingerprint() {
        let a = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let b = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn a_changed_key_changes_the_fingerprint() {
        let a = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let b = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F12".into() }];
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&[]));
    }
}
```

В `main.rs` рядом с прочими объявлениями модулей добавить `mod project_hotkeys;`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test project_hotkeys`
Expected: FAIL при компиляции — `cannot find function wanted_from_state`.

- [ ] **Step 3: Реализовать**

В начало `project_hotkeys.rs`, до `#[cfg(test)]`:

```rust
/// Проект с хоткеем — ровно то, что читателю нужно от ответа.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    pub cwd: String,
    pub hotkey: String,
}

/// Чего хочет ответ агрегатора.
///
/// `None` — «трогать нечего»: либо ответ про окна ничего не знает (пустой
/// `windowHost`: `read_windows` на той стороне на любой отказ возвращает
/// пустоту целиком), либо окна на чужой машине. Различить «менеджер убрал
/// хоткей» и «трекер лежит» больше нечем: строки `projects` в ответе есть
/// всегда, они собираются из закладок ccfzf.
///
/// `Some(vec![])` — это «хоткеев нет», и он честно снимает регистрации:
/// живой трекер сказал, что в конфиге пусто.
pub fn wanted_from_state(state: &serde_json::Value, own_host: &str) -> Option<Vec<Project>> {
    let host = state.get("windowHost").and_then(|v| v.as_str()).unwrap_or("");
    let own = own_host.trim();
    if host.is_empty() || own.is_empty() || host != own {
        return None;
    }
    let mut out = Vec::new();
    for row in state
        .get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(cwd), Some(hotkey)) = (
            row.get("path").and_then(|v| v.as_str()),
            row.get("hotkey").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if cwd.is_empty() || hotkey.trim().is_empty() {
            continue;
        }
        out.push(Project {
            cwd: cwd.to_string(),
            hotkey: hotkey.trim().to_string(),
        });
    }
    Some(out)
}

/// Отпечаток списка: то же ли это, что уже висит.
///
/// Считается по паре «каталог + клавиша» и по порядку: порядок решает, кому
/// достанется дважды названная комбинация, и его смена — настоящее изменение.
pub fn fingerprint(list: &[Project]) -> String {
    list.iter()
        .map(|p| format!("{}\u{0}{}", p.cwd, p.hotkey))
        .collect::<Vec<_>>()
        .join("\u{1}")
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test project_hotkeys`
Expected: PASS, шесть тестов.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add src-tauri/src/project_hotkeys.rs src-tauri/src/main.rs
git commit -m "feat(picker): разбор проектных хоткеев из ответа агрегатора"
```

---

### Task 6: Регистрация, снятие, кэш и разрешение столкновений

**Files:**
- Modify: `~/projects/js/ccfzf-picker/src-tauri/src/project_hotkeys.rs`
- Modify: `~/projects/js/ccfzf-picker/src-tauri/src/main.rs:661-692` (`load_json`/`save_json` → `pub(crate)`), `:507-549` (`apply_config`), `:765-791` (удалить `register_project_hotkeys`), `:808-954` (`setup`)
- Modify: `~/projects/js/ccfzf-picker/src-tauri/src/poller.rs:139-150`

**Interfaces:**
- Consumes: `Project`, `wanted_from_state`, `fingerprint` (Task 5); `load_json`,
  `save_json`, `picker_hotkey` из `main.rs`.
- Produces:
  - `pub struct Registered(pub std::sync::Mutex<RegisteredState>)` — состояние Tauri
  - `pub fn plan(wanted: &[Project], reserved: Option<&Shortcut>) -> (Vec<(Project, Shortcut)>, Vec<String>)`
  - `pub fn apply(app: &tauri::AppHandle, wanted: Vec<Project>)`
  - `pub fn apply_from_state(app: &tauri::AppHandle, state: &serde_json::Value)`
  - `pub fn apply_cached(app: &tauri::AppHandle)`
  - `pub fn reapply(app: &tauri::AppHandle)`

- [ ] **Step 1: Написать падающие тесты**

В `mod tests` файла `project_hotkeys.rs`:

```rust
    use tauri_plugin_global_shortcut::Shortcut;
    use std::str::FromStr;

    /// Клавиша пикера выигрывает у проектной, а из двух одинаковых проектных —
    /// первая по порядку.
    ///
    /// Правило то же, что у настроенных действий в `config-shape.js`, и цена
    /// его отсутствия та же: комбинация досталась бы тому, кто ниже в списке, а
    /// колонка `hk` обещала бы клавишу, ведущую в другое место.
    #[test]
    fn the_picker_key_wins_and_the_first_project_wins() {
        let picker = Shortcut::from_str("Super+F10").unwrap();
        let wanted = vec![
            Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() },
            Project { cwd: "/p/two".into(), hotkey: "Ctrl+F11".into() },
            Project { cwd: "/p/three".into(), hotkey: "Super+F10".into() },
        ];
        let (ok, taken) = plan(&wanted, Some(&picker));
        assert_eq!(ok.iter().map(|(p, _)| p.cwd.as_str()).collect::<Vec<_>>(), vec!["/p/one"]);
        assert_eq!(taken, vec!["Ctrl+F11".to_string(), "Super+F10".to_string()]);
    }

    /// Неразобранная комбинация — не повод уронить остальные.
    #[test]
    fn an_unparsable_key_costs_only_itself() {
        let wanted = vec![
            Project { cwd: "/p/one".into(), hotkey: "не хоткей".into() },
            Project { cwd: "/p/two".into(), hotkey: "Ctrl+F12".into() },
        ];
        let (ok, taken) = plan(&wanted, None);
        assert_eq!(ok.iter().map(|(p, _)| p.cwd.as_str()).collect::<Vec<_>>(), vec!["/p/two"]);
        assert_eq!(taken, vec!["не хоткей".to_string()]);
    }

    /// Записанное на диск читается обратно тем же списком: кэш вешается на
    /// setup() до первого опроса, и разойдись эти две формы — пикер поднимался
    /// бы без клавиш и молча.
    #[test]
    fn the_cache_survives_a_round_trip() {
        let list = vec![Project { cwd: "/p/one".into(), hotkey: "Ctrl+F11".into() }];
        let stored = to_cache(&list);
        assert_eq!(from_cache(&stored), list);
        assert_eq!(from_cache(&serde_json::json!({})), Vec::<Project>::new());
    }
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test project_hotkeys`
Expected: FAIL при компиляции — `cannot find function plan`.

- [ ] **Step 3: Реализовать чистую часть**

В `project_hotkeys.rs`, до тестов:

```rust
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Что висит прямо сейчас и по какому списку.
///
/// Отпечаток хранится рядом с самим списком: без него каждый секундный опрос
/// снимал бы и ставил регистрации заново — шестьдесят раз в минуту на ровном
/// месте.
#[derive(Default)]
pub struct RegisteredState {
    pub live: Vec<(Project, Shortcut)>,
    pub fingerprint: String,
}

#[derive(Default)]
pub struct Registered(pub Mutex<RegisteredState>);

/// Кто из желаемых получит клавишу, а кто останется ни с чем.
///
/// Столкновения решаются в одну сторону и всегда одинаково: встроенная клавиша
/// пикера выигрывает у настроенной, а из двух настроенных — первая по порядку.
/// Возвращается вторым списком то, о чём придётся сказать человеку: пока это
/// была строка в stderr, занятый `Ctrl+F11` расследовали полдня.
pub fn plan(
    wanted: &[Project],
    reserved: Option<&Shortcut>,
) -> (Vec<(Project, Shortcut)>, Vec<String>) {
    let mut ok: Vec<(Project, Shortcut)> = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    for project in wanted {
        let Ok(shortcut) = Shortcut::from_str(&project.hotkey) else {
            taken.push(project.hotkey.clone());
            continue;
        };
        let clashes = reserved == Some(&shortcut) || ok.iter().any(|(_, s)| *s == shortcut);
        if clashes {
            taken.push(project.hotkey.clone());
            continue;
        }
        ok.push((project.clone(), shortcut));
    }
    (ok, taken)
}

/// Вид кэша на диске. Объект, а не массив: `load_json` на отсутствующий файл
/// отдаёт `{}`, и массив пришлось бы отличать от него отдельной веткой.
pub fn to_cache(list: &[Project]) -> serde_json::Value {
    serde_json::json!({
        "projects": list.iter()
            .map(|p| serde_json::json!({"cwd": p.cwd, "hotkey": p.hotkey}))
            .collect::<Vec<_>>()
    })
}

pub fn from_cache(value: &serde_json::Value) -> Vec<Project> {
    let mut out = Vec::new();
    for row in value
        .get("projects")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(cwd), Some(hotkey)) = (
            row.get("cwd").and_then(|v| v.as_str()),
            row.get("hotkey").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if cwd.is_empty() || hotkey.is_empty() {
            continue;
        }
        out.push(Project { cwd: cwd.to_string(), hotkey: hotkey.to_string() });
    }
    out
}
```

- [ ] **Step 4: Прогнать тесты чистой части**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test project_hotkeys`
Expected: PASS, девять тестов.

- [ ] **Step 5: Реализовать регистрацию**

Там же, следом:

```rust
/// Повесить список, сняв прежний.
///
/// Снятие поимённое, а не `unregister_all()`: общий сброс на каждое изменение
/// списка уронил бы и хоткей самого пикера, а он живёт по другому поводу и
/// перевешивается только сменой конфига.
///
/// Наверх уходит `project-hotkeys` с занятыми комбинациями: отказ обязан быть
/// виден. До этой правки он стоил строки в stderr, которого у приложения из
/// трея не читает никто, — и `Ctrl+F11`, отобранный соседом по системе, выглядел
/// как сломанный конфиг.
pub fn apply(app: &tauri::AppHandle, wanted: Vec<Project>) {
    let reserved = crate::picker_hotkey(&crate::load_config().unwrap_or(serde_json::Value::Null)).0;
    let (ok, taken) = plan(&wanted, Some(&reserved));

    let Some(state) = app.try_state::<Registered>() else { return };
    let mut guard = state.0.lock().unwrap();
    for (_, shortcut) in guard.live.drain(..) {
        let _ = app.global_shortcut().unregister(shortcut);
    }

    let mut live = Vec::new();
    let mut failed = taken;
    for (project, shortcut) in ok {
        let handle = app.clone();
        let cwd = project.cwd.clone();
        let hooked = app
            .global_shortcut()
            .on_shortcut(shortcut, move |_app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = handle.emit("project-hotkey", cwd.clone());
                }
            });
        match hooked {
            Ok(()) => live.push((project, shortcut)),
            Err(e) => {
                eprintln!("ccfzf-picker: cannot register hotkey {}: {e}", project.hotkey);
                failed.push(project.hotkey);
            }
        }
    }
    guard.fingerprint = fingerprint(&wanted);
    guard.live = live;
    drop(guard);

    if let Err(e) = crate::save_json("hotkeys.json", &to_cache(&wanted)) {
        eprintln!("ccfzf-picker: cannot remember hotkeys: {e}");
    }
    let _ = app.emit("project-hotkeys", serde_json::json!({ "taken": failed }));
}

/// Применить то, что приехало ответом. Зовётся поллером на каждый удачный опрос.
pub fn apply_from_state(app: &tauri::AppHandle, state: &serde_json::Value) {
    let own = crate::load_config()
        .ok()
        .and_then(|c| c.get("windowHost").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default();
    let Some(wanted) = wanted_from_state(state, &own) else { return };
    if let Some(reg) = app.try_state::<Registered>() {
        if reg.0.lock().unwrap().fingerprint == fingerprint(&wanted) {
            return;
        }
    }
    apply(app, wanted);
}

/// Список прошлого запуска — до первого ответа.
///
/// Без него перезапуск пикера (или спящий хост) оставлял бы человека без
/// клавиш до первого удачного ssh, а на выключенной Windows-машине — навсегда.
pub fn apply_cached(app: &tauri::AppHandle) {
    let cached = from_cache(&crate::load_json("hotkeys.json").unwrap_or(serde_json::Value::Null));
    if cached.is_empty() {
        return;
    }
    apply(app, cached);
}

/// Повесить заново то, что уже висело: после `unregister_all()` в `apply_config`.
pub fn reapply(app: &tauri::AppHandle) {
    let Some(reg) = app.try_state::<Registered>() else { return };
    let wanted: Vec<Project> = reg.0.lock().unwrap().live.iter().map(|(p, _)| p.clone()).collect();
    if wanted.is_empty() {
        return;
    }
    apply(app, wanted);
}
```

- [ ] **Step 6: Подключить к main.rs и поллеру**

В `main.rs`:

1. `fn load_json` и `fn save_json` (строки 661 и 672) сделать `pub(crate) fn`.
2. `fn picker_hotkey` (строка 736) и `fn load_config` (строка 325) — тоже
   `pub(crate)`, если они ещё не видны модулю.
3. Удалить `fn register_project_hotkeys` целиком (строки 765-791).
4. В `apply_config` строку `register_project_hotkeys(app, &config);` заменить на
   `project_hotkeys::reapply(app);`.
5. В `setup`, сразу после `app.manage(HideOnBlur(...))`, добавить

```rust
            // Список хоткеев приезжает ответом агрегатора, а не из конфига:
            // единственный его источник — claudeWt.projects у
            // windows11-manager. До первого ответа висит список прошлого
            // запуска.
            app.manage(project_hotkeys::Registered::default());
```

6. Строку `register_project_hotkeys(app.handle(), &config);` в конце `setup`
   (строка 953) заменить на `project_hotkeys::apply_cached(app.handle());`.

В `poller.rs`, в удачной ветке (после `prev_fingerprint = Some(fp);`, до взятия
`cache`):

```rust
                            // Хоткеи вешает Rust, а не страница: у скрытого
                            // окна WebView2 умеет усыплять её целиком, и
                            // клавиши вставали бы только при открытом пикере.
                            crate::project_hotkeys::apply_from_state(&app, &state);
```

- [ ] **Step 7: Собрать и прогнать всё**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test`
Expected: PASS; предупреждений о неиспользуемых функциях нет.

- [ ] **Step 8: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add src-tauri/src/project_hotkeys.rs src-tauri/src/main.rs src-tauri/src/poller.rs
git commit -m "feat(picker): проектные хоткеи вешаются по ответу агрегатора"
```

---

### Task 7: Занятая клавиша видна человеку

**Files:**
- Modify: `~/projects/js/ccfzf-picker/frontend-src/session-glyph.js:176-185`
- Modify: `~/projects/js/ccfzf-picker/sessions.html` — подписка рядом с `listen('project-hotkey')` (строка 1564), ветка сообщения (строка 719-726), передача признака в строки
- Test: `~/projects/js/ccfzf-picker/test/session-glyph.test.js`

**Interfaces:**
- Consumes: событие `project-hotkeys` с телом `{taken: string[]}` (Task 6).
- Produces: `hotkeyHtml(session, showHotkey)` рисует `<div class="hk taken">`
  при `session.hotkeyTaken === true`.

- [ ] **Step 1: Написать падающий тест**

В `test/session-glyph.test.js`:

```js
// Занятый хоткей обязан быть виден: до этой правки отказ регистрации стоил
// строки в stderr, которого у приложения из трея не читает никто, — и клавиша,
// отобранная соседом по системе, выглядела как сломанный конфиг.
test('незарегистрированный хоткей помечен в колонке', () => {
  const html = SessionGlyph.hotkeyHtml({ hotkey: 'Ctrl+F11', hotkeyTaken: true });
  assert.match(html, /class="hk taken"/);
  assert.match(html, /Ctrl\+F11/);
});

test('обычный хоткей рисуется без пометки', () => {
  const html = SessionGlyph.hotkeyHtml({ hotkey: 'Ctrl+F11' });
  assert.match(html, /class="hk"/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd ~/projects/js/ccfzf-picker && npm test`
Expected: FAIL — разметка всегда `class="hk"`.

- [ ] **Step 3: Реализовать**

В `session-glyph.js`:

```js
  function hotkeyHtml(session, showHotkey = true) {
    if (!showHotkey) return '';
    // Занятую комбинацию гасим, а не прячем: человеку нужно видеть, какая
    // именно клавиша не сработала, а не только то, что что-то не сработало.
    const taken = session?.hotkeyTaken ? ' taken' : '';
    return `<div class="hk${taken}">${escapeHtml(session?.hotkey ?? '')}</div>`;
  }
```

В `sessions.html` в стилях рядом с `.hk`:

```css
    .hk.taken { opacity: .45; text-decoration: line-through; }
```

Рядом с подпиской `project-hotkey` (строка 1564):

```js
    // Какие клавиши не встали. Приезжает от Rust на каждое применение списка:
    // судить об этом со страницы нельзя — регистрирует не она.
    await listen('project-hotkeys', (event) => {
      const taken = Array.isArray(event.payload?.taken) ? event.payload.taken : [];
      hotkeysTaken = new Set(taken);
      regroup();
    });
```

Рядом с прочими переменными состояния объявить `let hotkeysTaken = new Set();`.

В том месте `regroup()`/`render()`, где строятся строки проектов
(`window.ProjectList.buildProjectList(...)`), после сборки проставить признак:

```js
    // Признак ставится здесь, а не в buildProjectList: тот про ответ
    // агрегатора, а «встала ли клавиша» знает только эта машина.
    for (const row of projectRows) row.hotkeyTaken = hotkeysTaken.has(row.hotkey);
```

В ветке сообщения (строка 719) добавить третью проверку, между `error` и
`else`:

```js
    } else if (hotkeysTaken.size) {
      message.style.display = 'block';
      // Единственное место, где человек узнаёт про отобранную клавишу.
      message.textContent = `${Array.from(hotkeysTaken).join(', ')} is taken by another app`;
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/ccfzf-picker && npm test`
Expected: PASS, включая `frontend-load.test.js` (он грузит страницу целиком).

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add frontend-src/session-glyph.js sessions.html test/session-glyph.test.js
git commit -m "feat(picker): занятый проектный хоткей виден в списке и в статуслайне"
```

---

### Task 8: `projects:` уходит из конфига и окна настроек

**Files:**
- Modify: `~/projects/js/ccfzf-picker/frontend-src/config-shape.js:133-167`
- Modify: `~/projects/js/ccfzf-picker/frontend-src/settings-form.js:52,105,118,144,215`
- Modify: `~/projects/js/ccfzf-picker/settings.html:116,173-177`
- Modify: `~/projects/js/ccfzf-picker/config.example.yml:137-138`
- Test: `~/projects/js/ccfzf-picker/test/config-shape.test.js`, `test/settings-form.test.js`, `test/settings-page.test.js`

**Interfaces:**
- Produces: `ConfigShape.normalizeConfig(raw)` больше не отдаёт ключ `projects`.

- [ ] **Step 1: Переписать тесты под новое поведение**

В `test/config-shape.test.js` удалить тесты, проверяющие разбор `projects`, и
поставить один сторожевой:

```js
// Ключ уехал в windows11-manager: единственный источник хоткеев — его
// claudeWt.projects, а сюда список приезжает ответом агрегатора. Оставшийся в
// файле человека ключ читать нельзя — два списка снова разошлись бы.
test('projects из конфига не читается вовсе', () => {
  const cfg = ConfigShape.normalizeConfig({
    sshHost: 'host', projects: [{ path: '/p/one', hotkey: 'Ctrl+F11' }],
  });
  assert.equal(cfg.projects, undefined);
});
```

В `test/settings-form.test.js` и `test/settings-page.test.js` удалить всё, что
проверяет поле типа `projects`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd ~/projects/js/ccfzf-picker && npm test`
Expected: FAIL — `cfg.projects` пока массив.

- [ ] **Step 3: Реализовать**

В `config-shape.js` удалить из `normalizeConfig` объявление `const projects = ...`
и ключ `projects,` из возвращаемого объекта.

В `settings-form.js` удалить строку поля `{ id: 'projects', label: 'Project
hotkeys', type: 'projects' }` и все три ветки `if (field.type === 'projects')`
(строки 105, 118, 144), а также цикл по `fields.projects` в сборке патча
(строка 215).

В `settings.html` удалить ветку `if (field.type === 'projects')` (строка 116) и
блок работы со строками проектов (строки 173-177).

В `config.example.yml` удалить блок `projects:` и заменить его комментарием:

```yaml
# Project hotkeys live in windows11-manager (claudeWt.projects) and reach the
# picker through `ccfzf --state`. There is no key for them here on purpose: two
# lists kept in sync by hand is exactly what this replaced.
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/ccfzf-picker && npm test && cd src-tauri && cargo test`
Expected: PASS оба.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add frontend-src/config-shape.js frontend-src/settings-form.js settings.html config.example.yml test/
git commit -m "refactor(picker): единственный источник проектных хоткеев — менеджер"
```

---

### Task 9: claude-wt уходит из windows-mqtt

**Files:**
- Delete: `~/projects/js/windows-mqtt/src/modules/windows.js`, `src/modules/claude-wt-watchdog.js`, `src/homeassistant/`, `src/picker/`, `sessions.html`, `data/ccfzf-picker/`, `test/claude-focus-subscription.test.js`, `test/claude-project-helpers.test.js`, `test/claude-wt-watchdog.test.js`
- Modify: `~/projects/js/windows-mqtt/src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `config.example.yml`, `scripts/prepare-frontend.js`, `CHANGELOG.md`

**Interfaces:**
- Produces: ничего. Задача — снять чужую регистрацию `Ctrl+F11`/`Ctrl+F12`,
  чтобы её мог взять пикер.

- [ ] **Step 1: Убедиться, что поддерево замкнуто**

Run:
```bash
cd ~/projects/js/windows-mqtt
grep -rn "modules/windows\|homeassistant/\|picker/" src scripts --include=*.js | grep -v node_modules
```
Expected: ссылки только изнутри удаляемого поддерева (`windows.js`,
`claude-sessions.js`, файлы `src/picker/`). Если всплывёт ссылка снаружи —
остановиться и разобраться, а не удалять.

- [ ] **Step 2: Удалить node-часть**

```bash
cd ~/projects/js/windows-mqtt
git rm -r src/modules/windows.js src/modules/claude-wt-watchdog.js src/homeassistant src/picker sessions.html data/ccfzf-picker
git rm test/claude-focus-subscription.test.js test/claude-project-helpers.test.js test/claude-wt-watchdog.test.js
```

- [ ] **Step 3: Вычистить Rust**

В `src-tauri/src/main.rs` удалить: `struct ClaudeProject`,
`parse_claude_projects_json`, `read_claude_projects_from_manager`,
`register_project_shortcut_with_retry`, цикл `for project in claude_projects`
вместе с `let claude_projects = ...`, `struct PickerConfig`,
`parse_picker_config`, `read_picker_config`, `fn toggle_picker`, вариант
`ShortcutAction::ShowPicker` и его ветку в `match what`, `app.manage(picker_cfg)`
и обращение `try_state::<PickerConfig>()`, а также тесты
`claude_projects_json_parses_entries`, `claude_projects_json_skips_incomplete`,
`claude_projects_json_empty_when_missing_or_broken` и тесты `parse_picker_config`.

В `src-tauri/tauri.conf.json` удалить объект окна с `"label": "sessions"`.

В `scripts/prepare-frontend.js` удалить всё, что собирает `sessions.html` и
модули `src/picker/`.

- [ ] **Step 4: Вычистить конфиг и документацию**

В `config.example.yml` удалить блок `modules.windows` целиком (вместе с
комментарием про откат в два шага) и на его месте оставить одну строку:

```yaml
  # Управление окнами, claude-wt, пикер сессий и экспорт в Home Assistant живут
  # в windows11-manager и ccfzf-picker. Здесь их больше нет: откат — это откат
  # коммита, а не флаг.
```

В `CHANGELOG.md` добавить запись о вычистке.

- [ ] **Step 5: Собрать и прогнать тесты**

Run: `cd ~/projects/js/windows-mqtt && npm test && npm run lint`
Expected: PASS; ни одного `Cannot find module`.

Run: `cd ~/projects/js/windows-mqtt/src-tauri && cargo check`
Expected: на Linux возможны ошибки только в `#[cfg(windows)]`-ветках — их
проверяет сборка на Windows на шаге выкатки. Всё прочее обязано компилироваться.

- [ ] **Step 6: Коммит**

```bash
cd ~/projects/js/windows-mqtt
git add -A
git commit -m "refactor: claude-wt уезжает в windows11-manager и ccfzf-picker"
```

---

### Task 10: Документация

**Files:**
- Modify: `~/.claude/skills/claude-wt/SKILL.md` (скилл лежит в домашнем
  каталоге той машины, с которой его читают, — он вне репозиториев)
- Modify: `~/projects/js/ccfzf-picker/CLAUDE.md`
- Modify: `~/projects/js/ccfzf-picker/docs/TODO.md`

- [ ] **Step 1: Поправить скилл claude-wt, три места**

1. Абзац **Project hotkeys** переписать: список живёт в `claudeWt.projects` у
   windows11-manager, оттуда демон кладёт его в файл трекера полем `projects`,
   `ccfzf --state` клеит `hotkey` к строкам проектов, регистрирует клавиши
   ccfzf-picker на машине, где совпал `windowHost`. Убрать утверждение, что
   пикер читает свой `projects:` из `config.yml` — его больше нет. Добавить
   строку: «Клавиша не отзывается — смотреть статуслайн пикера: занятую
   комбинацию он называет сам».
2. Абзац **«Откат — это два шага, а не один»**: после вычистки возвращать
   нечего, откат — это откат коммита в windows-mqtt.
3. Описание файла трекера (`модель-данных.md` и таблица «Кто где живёт»):
   добавить ключ `projects: [{cwd, name, hotkey}]` и то, что он входит в
   отпечаток файла.

- [ ] **Step 2: Дописать правило в CLAUDE.md пикера**

В раздел «Правила, за которые уже заплачено»:

```markdown
- **Проектные хоткеи приезжают ответом агрегатора, а не из конфига.** Список
  живёт в `claudeWt.projects` у windows11-manager, демон кладёт его в файл
  трекера, `ccfzf --state` отдаёт полем `hotkey` у строки проекта. Признак
  свежести у них общий с окнами — `windowHost`: пуст (трекер лежит или файл
  протух) — регистрации не трогаем вовсе, непуст и совпал с конфигом — список
  полон и заменяет прежний, даже пустой. Своего таймера у хоткеев нет
  намеренно: второй признак свежести разошёлся бы с первым на первой же правке.
  Вешает клавиши `project_hotkeys.rs` из поллера, а не страница: у скрытого
  окна WebView2 умеет усыплять её целиком, и клавиши вставали бы только при
  открытом пикере. До первого ответа висит список из `hotkeys.json`.

- **Отказ регистрации проектного хоткея обязан быть виден.** Раньше он стоил
  строки в stderr, и `Ctrl+F11`, отобранный соседом по системе (им оказался
  windows-mqtt, регистрировавший те же клавиши из того же конфига менеджера),
  выглядел как сломанный конфиг: расследование заняло полдня. Теперь занятая
  комбинация уходит наверх событием `project-hotkeys`, гаснет в колонке `hk` и
  называется в статуслайне.
```

- [ ] **Step 3: Закрыть пункт в TODO**

Удалить из `docs/TODO.md` пункт «**Колонка `hk` ничем не заполняется**» — он
закрыт задачей 4.

- [ ] **Step 4: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add CLAUDE.md docs/TODO.md
git commit -m "docs: правило про хоткеи из агрегатора и видимый отказ"
```

Скилл лежит вне репозитория — коммита не требует.

---

### Task 11: Выкатка и проверка на живой машине

Порядок продиктован тем, кто держит клавишу: пока windows-mqtt жив в нынешнем
виде, пикер зарегистрировать `Ctrl+F11` не может физически, и любая проверка на
середине пути покажет ложный отказ.

- [ ] **Step 1: Запушить всё**

```bash
for d in ~/projects/js/windows11-manager ~/projects/js/windows-mqtt ~/projects/js/ccfzf-picker; do git -C "$d" push; done
```

- [ ] **Step 2: Выкатить windows-mqtt (первым)**

На Windows-машине, из клона windows-mqtt: `npm run deploy-local`.

- [ ] **Step 3: Убедиться, что клавиши освободились**

На Windows, в PowerShell:

```powershell
$sig = '[DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
[DllImport("user32.dll", SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);'
$k = Add-Type -MemberDefinition $sig -Name HKChk -Namespace Probe -PassThru
foreach ($t in @(@('Ctrl+F11',0x0002,0x7A), @('Ctrl+F12',0x0002,0x7B))) {
  $ok = $k::RegisterHotKey([IntPtr]::Zero, 950, $t[1], $t[2])
  if ($ok) { $null = $k::UnregisterHotKey([IntPtr]::Zero, 950); "$($t[0]): FREE" } else { "$($t[0]): TAKEN" }
}
```

Expected: обе FREE (пикер в этот момент ещё старый и их не берёт).

- [ ] **Step 4: Выкатить windows11-manager**

На Windows-машине, из клона windows11-manager: `./data/scripts/deploy-pc.sh --no-build`.

- [ ] **Step 5: Убедиться, что хоткеи доехали до ответа**

На машине с сессиями:

```bash
cd ~/projects/shell/ccfzf && ./ccfzf --state | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['windowHost'], [p for p in s['projects'] if p.get('hotkey')])"
```

Expected: непустой `windowHost` и обе строки с хоткеями.

- [ ] **Step 6: Выкатить пикер**

На Windows-машине, из клона ccfzf-picker: `./data/scripts/deploy-win.sh`.

- [ ] **Step 7: Убрать `projects:` из живого конфига**

`merge_patch` незнакомые ключи не трогает, и ключ остался бы мусором:

```bash
# Файл — `~/.config/ccfzf-picker/config.yaml` на Windows-машине.
```

Блок `projects:` удалить руками тем редактором, который сохраняет UTF-8.

- [ ] **Step 8: Проверить руками**

1. Нажать `Ctrl+F11` — на машине с сессиями поднимается новая сессия в
   каталоге первого проекта из `claudeWt.projects`, окно пикера при этом не
   открывается.
2. Открыть пикер, нажать `/a` — в режиме проектов у двух строк видна колонка
   `hk` с `Ctrl+F11` и `Ctrl+F12`.
3. Убить процесс демона claude-wt и подождать три минуты — клавиши продолжают
   работать (липкий список), в списке пометки об окнах пропали. Демона поднимет
   Tauri сам.
4. Перезапустить пикер при выключенной машине с сессиями — клавиши работают из
   `hotkeys.json`.

- [ ] **Step 9: Повторить пробу занятости**

Тот же скрипт, что на шаге 3.
Expected: обе TAKEN — теперь их держит пикер.

---

## Self-Review

**Покрытие спеки:** экспорт менеджера — Task 1; пропуск в ccfzf — Task 2;
склейка со строками проектов — Task 3; колонка `hk` — Task 4; разбор ответа,
отпечаток, признак `windowHost` — Task 5; регистрация, кэш, поимённое снятие,
столкновения, событие про занятые — Task 6; видимость отказа — Task 7; уход
`projects:` из конфига и окна настроек — Task 8; вычистка windows-mqtt — Task 9;
документация, включая три места в скилле, — Task 10; порядок выкатки и ручная
проверка — Task 11.

**Заглушек нет:** каждый шаг несёт код или точную команду.

**Согласованность имён:** `Project {cwd, hotkey}`, `wanted_from_state`,
`fingerprint`, `plan`, `apply`, `apply_from_state`, `apply_cached`, `reapply`,
`to_cache`, `from_cache` — одни и те же в Task 5, 6 и в местах вызова;
`merge_project_hotkeys` — в Task 3 и в блоке `--state`; поле строки `hotkey` —
одно и то же имя в ccfzf, `project-list.js` и `session-glyph.js`.
