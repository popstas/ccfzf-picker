# macos-windows-manager, этап 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Окна терминалов на маке попадают в список сессий: у сессий, открытых с мака, появляется поле `window`, отчего сами собой начинают работать пометка ▣ и фильтр `only windowed`.

**Architecture:** Новый Tauri-2 трей на маке следит за окнами через Accessibility, привязывает заголовки к сессиям по дампу с remote-host и кладёт туда файл окон того же формата, что кладёт Windows-трекер. Агрегатор `ccfzf` учится читать каталог таких файлов вместо одного и приписывает каждой записи окна её машину. Пикер перестаёт судить о машине по единственному верхнему полю ответа и судит построчно.

**Tech Stack:** Rust 1.93 + Tauri 2.11, `accessibility-sys` 0.2, `objc2-app-kit` 0.3, `core-foundation` 0.10 (мак); python3 внутри `ccfzf` (агрегатор); node `--test` и Rust (пикер).

**Spec:** `docs/superpowers/specs/2026-08-13-macos-windows-manager-design.md`

**Имена модулей разошлись со спекой, и это осознанно.** Спека называет четыре
модуля по ролям; план разложил их по границе «платформенное / чистое», потому
что от этой границы зависит, где гоняются тесты. Соответствие:

| Спека | План | Почему так |
|---|---|---|
| `windows.rs` | `src-tauri/src/ax.rs` | Всё платформенное в одном месте и с одним именем — по интерфейсу, а не по предмету |
| `tracker.rs` | `crates/mwm-core/src/tracker.rs` | Без изменений |
| `sessions.rs` | `crates/mwm-core/src/index.rs` + `src-tauri/src/dump.rs` | Разбор — чистый и с тестами, ssh — нет |
| `publish.rs` | `crates/mwm-core/src/publish.rs` + `src-tauri/src/deliver.rs` | Ровно та же причина: сборка файла проверяема, доставка нет |

## Global Constraints

- **Три репозитория.** Пикер — `~/projects/js/ccfzf-picker`. Агрегатор — `~/projects/shell/ccfzf`. Новый — `~/projects/js/macos-windows-manager`. Коммиты в каждом свои; задача не смешивает репозитории, если это прямо не сказано.
- **Язык.** Всё, что видит человек, — по-английски; всё, что видит разработчик (комментарии, doc-комментарии, названия тестов, сообщения в `assert`), — по-русски.
- **Имена машин в репозитории не возвращать.** Ни в коде, ни в тестах, ни в документации. Сторож — `test/no-private-data.test.js` в пикере, проверяет `git ls-files`. В примерах писать `remote-host`, `mac-host`, `windows-box`.
- **Тесты пикера гоняются только через `npm test`.** `node --test test/` на этих версиях Node не работает.
- **Тесты агрегатора** — `python3 tests/test_<имя>.py`, каждый файл сам по себе; загрузка python-блока из bash-скрипта — через `tests/harness.py`.
- **Файл окон читается недоверчиво.** Порченая запись стоит себя, порченое поле — только поля, порченый файл — только этого файла. Ни ошибок, ни строк в stderr.
- **Отпечаток состояния считается без времени.** `generated` меняется на каждом такте; отпечаток, включивший его, не сэкономил бы ни одной записи.
- **Пустой `host` в файле трекера значит «источника нет».** `read_windows` возвращает пустоту целиком на любой отказ — отсутствие файла, нечитаемый json, протухший `generated`. Это и есть признак живости, второго заводить не нужно.

---

## Task 1: Агрегатор — файл трекера объявляет, умеет ли он поднимать окно

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — функция `read_windows` (около строки 433)
- Test: `~/projects/shell/ccfzf/tests/test_windows_file.py`

**Interfaces:**
- Consumes: ничего.
- Produces: `read_windows(path, now)` возвращает кортеж из **шести** элементов — `(windows, host, pid, snapshots, projects, focus)`, где `focus: bool`. Прежние пять на прежних местах.

- [ ] **Step 1: Написать падающий тест**

Дописать в `tests/test_windows_file.py`:

```python
def _read_focus(obj, now=NOW):
    """Шестое значение read_windows: умеет ли этот трекер поднимать окно."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "windows.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return CC["read_windows"](path, now)[5]


def test_focus_flag_absent_means_able():
    # Трекер прежней версии поля не пишет, а поднимать окна умеет и умел
    # всегда. Прочитать его отсутствие как «не умеет» значило бы выключить
    # подъём на Windows правкой, которая Windows не касается вовсе.
    assert _read_focus(_payload({"title": "ccfzf", "desktop": None, "lastSeen": 0})) is True


def test_focus_flag_false_is_respected():
    # Трекер, который окон не поднимает, говорит об этом сам. Без этого поля
    # заполненное имя машины в конфиге пикера включало бы ветку подъёма, и
    # просьба уезжала бы менеджеру на другой машине.
    payload = _payload({"title": "ccfzf", "desktop": None, "lastSeen": 0})
    payload["focus"] = False
    assert _read_focus(payload) is False


def test_focus_garbage_reads_as_able():
    # Недоверие к файлу здесь то же, что к остальным полям: мусор стоит себя,
    # а не ветки поведения. «Умеет» — то же умолчание, что и у отсутствия.
    for junk in ["no", 0, None, {}, []]:
        payload = _payload({"title": "ccfzf", "desktop": None, "lastSeen": 0})
        payload["focus"] = junk
        assert _read_focus(payload) is True, junk
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_file.py`
Expected: FAIL — `IndexError: tuple index out of range` (пятиэлементный кортеж).

- [ ] **Step 3: Минимальная реализация**

В `ccfzf`, в `read_windows`, заменить строку `empty = ({}, "", 0, [], [])` на:

```python
    empty = ({}, "", 0, [], [], True)
```

Перед `return out, host, pid, snaps, projects` добавить:

```python
    # Умеет ли этот трекер поднимать окно по просьбе. Отсутствие поля — «умеет»:
    # Windows-трекер его не пишет и не должен, подъём там работал всегда. Мусор
    # читается так же, как отсутствие, — недоверие к файлу не заводит третьей
    # ветки поведения.
    focus = o.get("focus")
    if not isinstance(focus, bool):
        focus = True
```

и заменить `return` на:

```python
    return out, host, pid, snaps, projects, focus
```

- [ ] **Step 4: Прогнать тесты и убедиться, что они проходят**

Run: `cd ~/projects/shell/ccfzf && for t in tests/test_*.py; do python3 "$t" || break; done`
Expected: все файлы отрабатывают без ошибок. Прежние тесты распаковывают `[:4]` и `[4]`, шестой элемент их не задевает.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_windows_file.py
git commit -m "feat(state): файл трекера объявляет, умеет ли он поднимать окно"
```

---

## Task 2: Агрегатор — слияние каталога файлов трекеров

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf` — переменная `WINDOWS_FILE` (около строки 59), новые функции рядом с `read_windows`, вызовы в режимах `dump` и `state`, две строки запуска python внизу
- Test: `~/projects/shell/ccfzf/tests/test_windows_merge.py` (создать)

**Interfaces:**
- Consumes: `read_windows(path, now) -> (windows, host, pid, snapshots, projects, focus)` из Task 1.
- Produces:
  - `window_sources(file_path, dir_path) -> list[str]` — пути источников в детерминированном порядке.
  - `read_window_sources(file_path, dir_path, now) -> (windows, host, pid, snapshots, projects, hosts)`, где каждая запись `windows[sid]` дополнена ключами `host: str`, `pid: int`, `canFocus: bool`, а `hosts` — список `{"host": str, "pid": int, "canFocus": bool}` по одному на живой источник.
  - В ответе `--state` появляется верхнее поле `windowHosts` — тот самый список.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_windows_merge.py`:

```python
"""Слияние нескольких файлов трекеров. Запуск: python3 tests/test_windows_merge.py"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness

CC = harness.load()
UUID_A = "aaaaaaaa-1111-2222-3333-444444444444"
UUID_B = "bbbbbbbb-1111-2222-3333-444444444444"
NOW = 1785958293


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def _file(host, windows, pid=42, focus=None, projects=None, snapshots=None):
    out = {"generated": NOW - 1, "host": host, "pid": pid, "windows": windows}
    if focus is not None:
        out["focus"] = focus
    if projects is not None:
        out["projects"] = projects
    if snapshots is not None:
        out["snapshots"] = snapshots
    return out


def _win(title, last_seen=NOW - 5):
    return {"title": title, "desktop": None, "lastSeen": last_seen, "focusedAt": 0}


def _merge(legacy=None, dir_files=None, now=NOW):
    """read_window_sources принимает путь к файлу и путь к каталогу."""
    with tempfile.TemporaryDirectory() as d:
        file_path = ""
        if legacy is not None:
            file_path = os.path.join(d, "legacy.json")
            _write(file_path, legacy)
        dir_path = os.path.join(d, "windows")
        os.makedirs(dir_path)
        for name, obj in (dir_files or {}).items():
            _write(os.path.join(dir_path, name), obj)
        return CC["read_window_sources"](file_path, dir_path, now)


def test_windows_from_two_trackers_land_in_one_map():
    # Ради этого всё и затевается: две машины, один список. Без слияния окна
    # второго трекера не видны никому — поле `window` есть только у сессий с
    # окнами того трекера, чей файл прочитали единственным.
    windows, _, _, _, _, _ = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf")}),
        dir_files={"mac-host.json": _file("mac-host", {UUID_B: _win("other")}, pid=7)},
    )
    assert set(windows) == {UUID_A, UUID_B}, windows
    assert windows[UUID_A]["host"] == "windows-box", windows[UUID_A]
    assert windows[UUID_B]["host"] == "mac-host", windows[UUID_B]
    assert windows[UUID_B]["pid"] == 7, windows[UUID_B]


def test_window_carries_focus_ability_of_its_own_tracker():
    # Машина строки и умение её трекера — разные вопросы, и оба нужны построчно.
    # Одно верхнее поле на весь ответ не отвечает ни на один из них.
    windows, _, _, _, _, _ = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf")}),
        dir_files={"mac-host.json": _file("mac-host", {UUID_B: _win("other")}, focus=False)},
    )
    assert windows[UUID_A]["canFocus"] is True, windows[UUID_A]
    assert windows[UUID_B]["canFocus"] is False, windows[UUID_B]


def test_same_session_in_two_trackers_goes_to_the_fresher_one():
    # Одна сессия, открытая с обеих машин. Спор разрешается свежестью, а не
    # порядком чтения: порядок задан нами и о том, где сессию видели последней,
    # не знает ничего.
    windows, _, _, _, _, _ = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf", last_seen=NOW - 90)}),
        dir_files={"mac-host.json": _file("mac-host", {UUID_A: _win("ccfzf", last_seen=NOW - 2)})},
    )
    assert windows[UUID_A]["host"] == "mac-host", windows[UUID_A]


def test_stale_source_drops_whole_and_alone():
    # Протухший файл выбрасывается целиком и в одиночку: соседний трекер жив, и
    # его окна обязаны пережить смерть чужого демона.
    stale = _file("windows-box", {UUID_A: _win("ccfzf")})
    stale["generated"] = NOW - 100000
    windows, _, _, _, _, hosts = _merge(
        legacy=stale,
        dir_files={"mac-host.json": _file("mac-host", {UUID_B: _win("other")})},
    )
    assert set(windows) == {UUID_B}, windows
    assert [h["host"] for h in hosts] == ["mac-host"], hosts


def test_hosts_list_names_every_live_tracker():
    # Пикеру нужно отличать «моей машины среди трекеров нет» от «есть, но окон
    # у неё сейчас нет». По окнам этого не понять: у здорового трекера без
    # открытых терминалов список окон пуст.
    _, _, _, _, _, hosts = _merge(
        legacy=_file("windows-box", {UUID_A: _win("ccfzf")}),
        dir_files={"mac-host.json": _file("mac-host", {}, pid=7, focus=False)},
    )
    assert hosts == [
        {"host": "windows-box", "pid": 42, "canFocus": True},
        {"host": "mac-host", "pid": 7, "canFocus": False},
    ], hosts


def test_top_level_fields_follow_the_tracker_that_has_hotkeys():
    # Верхние windowHost/windowPid/projects кормят проектные хоткеи, и пикер
    # сверяет с ними своё имя. Взять их у первого попавшегося источника значило
    # бы, что клавиши пропадают, стоит соседнему трекеру подняться раньше.
    _, host, pid, _, projects, _ = _merge(
        legacy=_file("mac-host", {}, pid=7),
        dir_files={"windows-box.json": _file(
            "windows-box", {UUID_A: _win("ccfzf")}, pid=42,
            projects=[{"cwd": "/projects/js/ccfzf-picker", "name": "picker", "hotkey": "Ctrl+F11"}])},
    )
    assert host == "windows-box" and pid == 42, (host, pid)
    assert [p["hotkey"] for p in projects] == ["Ctrl+F11"], projects


def test_missing_directory_is_not_an_error():
    # Каталога может не быть вовсе — на машине, где никто не переезжал на новую
    # схему. Это норма, а не отказ: единственный файл остаётся источником.
    with tempfile.TemporaryDirectory() as d:
        file_path = os.path.join(d, "legacy.json")
        _write(file_path, _file("windows-box", {UUID_A: _win("ccfzf")}))
        windows, host, _, _, _, _ = CC["read_window_sources"](
            file_path, os.path.join(d, "nope"), NOW)
    assert set(windows) == {UUID_A} and host == "windows-box", (windows, host)


def test_sources_are_ordered_file_then_directory_by_name():
    # Порядок задан, а не случаен: из него берутся верхние поля ответа, и без
    # него они прыгали бы от запуска к запуску.
    with tempfile.TemporaryDirectory() as d:
        dir_path = os.path.join(d, "windows")
        os.makedirs(dir_path)
        for name in ["b.json", "a.json", "skip.txt"]:
            _write(os.path.join(dir_path, name), {})
        got = CC["window_sources"](os.path.join(d, "legacy.json"), dir_path)
    assert [os.path.basename(p) for p in got] == ["legacy.json", "a.json", "b.json"], got


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_"):
            fn()
            print("ok", name)
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_merge.py`
Expected: FAIL — `KeyError: 'read_window_sources'`.

- [ ] **Step 3: Реализация**

В `ccfzf` сразу после `read_windows` добавить:

```python
def window_sources(file_path, dir_path):
    """Пути ко всем файлам трекеров: старый одиночный плюс каталог.

    Порядок задан и потому предсказуем — одиночный файл, затем файлы каталога
    по имени. Из первого подходящего источника берутся верхние поля ответа, и
    случайный порядок означал бы, что они меняются от запуска к запуску.

    Отсутствие каталога — норма, а не отказ: на машине, где никто не переезжал
    на новую схему, источник по-прежнему один.
    """
    out = []
    if file_path:
        out.append(file_path)
    if dir_path:
        try:
            names = sorted(os.listdir(dir_path))
        except OSError:
            names = []
        out += [os.path.join(dir_path, n) for n in names if n.endswith(".json")]
    return out


def read_window_sources(file_path, dir_path, now):
    """Слить файлы трекеров в один вид: окна, машины, снимки, хоткеи.

    Трекеров теперь может быть несколько — по одному на машину, где открыты
    терминалы. «Чьё это окно» перестаёт быть свойством всего ответа и
    становится свойством записи: к каждой приписывается `host`, `pid` и
    `canFocus` того файла, из которого она приехала.

    Живость источника читается по непустому `host`: `read_windows` на любой
    отказ — нет файла, не разобрался json, протух `generated` — возвращает
    пустоту целиком. Второго признака заводить не нужно, и заводить его было
    бы вредно: два признака расходятся на первой же правке.

    Одну сессию могут показывать два трекера (её терминал открыт с обеих
    машин). Спор разрешается свежестью `lastSeen`, а не порядком чтения:
    порядок задан нами и о том, где сессию видели последней, не знает ничего.

    Верхние `host` / `pid` / `projects` остаются такими, какими были, потому
    что их читает не список окон, а проектные хоткеи. Берутся они у источника,
    который несёт хоткеи; если таких нет — у первого живого.
    """
    windows = {}
    hosts = []
    snaps = []
    lead = None
    for path in window_sources(file_path, dir_path):
        w, host, pid, sn, pr, focus = read_windows(path, now)
        if not host:
            continue
        hosts.append({"host": host, "pid": pid, "canFocus": focus})
        snaps += sn
        if lead is None or (pr and not lead[2]):
            lead = (host, pid, pr)
        for sid, rec in w.items():
            prev = windows.get(sid)
            if prev is not None and prev["lastSeen"] >= rec["lastSeen"]:
                continue
            windows[sid] = dict(rec, host=host, pid=pid, canFocus=focus)
    host, pid, projects = lead if lead else ("", 0, [])
    return windows, host, pid, snaps, projects, hosts
```

- [ ] **Step 4: Прогнать тест и убедиться, что он проходит**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_merge.py`
Expected: PASS — восемь строк `ok test_…`.

- [ ] **Step 5: Подключить слияние к обоим режимам**

В `ccfzf` заменить объявление переменной (около строки 59):

```bash
WINDOWS_FILE="${CCFZF_WINDOWS_FILE-$HOME/.ccfzf.sessions.claude-wt.json}"
# Каталог файлов трекеров: по одному на машину, где открыты терминалы. Старый
# одиночный файл читается по-прежнему и остаётся первым источником.
WINDOWS_DIR="${CCFZF_WINDOWS_DIR-$HOME/.ccfzf/windows}"
```

В режиме `dump` заменить строку `windows, _, _, _, _ = read_windows(windows_path, now)` на:

```python
    windows, _, _, _, _, _ = read_window_sources(
        windows_path, sys.argv[7] if len(sys.argv) > 7 else "", now)
```

В режиме `state` заменить вызов `read_windows(...)` на:

```python
    windows, window_host, window_pid, window_snapshots, window_projects, window_hosts = \
        read_window_sources(sys.argv[3] if len(sys.argv) > 3 else "",
                            sys.argv[6] if len(sys.argv) > 6 else "", now)
```

В `json.dump` того же режима, сразу после `"windowHost": window_host, "windowPid": window_pid,` добавить:

```python
               # Живые трекеры поимённо. Пикеру нужно отличать «моей машины
               # среди трекеров нет» от «есть, но окон у неё сейчас нет»: по
               # списку окон этого не понять, у здорового трекера без открытых
               # терминалов он пуст.
               "windowHosts": window_hosts,
```

Внизу скрипта дописать новый аргумент в обе строки запуска python:

```bash
  python3 -c "$PY" dump "$MARKS" "$SESSIONS_FILE" "$PROJECTS_FILE" "$WINDOWS_FILE" "$limit" "$WINDOWS_DIR"
```

```bash
  python3 -c "$PY" state "$MARKS" "$WINDOWS_FILE" "$SESSIONS_FILE" "$limit" "$WINDOWS_DIR"
```

(в файле две строки с `dump` — обе, около строк 1793 и 1835.)

- [ ] **Step 6: Прогнать все тесты агрегатора и живой вызов**

Run:
```bash
cd ~/projects/shell/ccfzf
for t in tests/test_*.py; do python3 "$t" >/dev/null || echo "FAIL $t"; done
./ccfzf --state | python3 -c 'import json,sys; o=json.load(sys.stdin); print(o["windowHost"], o["windowHosts"])'
```
Expected: ни одного `FAIL`; последняя строка печатает имя машины и список из одного элемента с тем же именем.

- [ ] **Step 7: Коммит**

```bash
cd ~/projects/shell/ccfzf
git add ccfzf tests/test_windows_merge.py
git commit -m "feat(state): несколько файлов трекеров сливаются в один список окон"
```

---

## Task 3: Пикер — «чья машина» становится свойством строки

**Files:**
- Modify: `frontend-src/session-windows.js`
- Test: `test/session-windows.test.js`

**Interfaces:**
- Consumes: ответ агрегатора с полями `windowHosts`, `window.host`, `window.pid`, `window.canFocus` (Task 2).
- Produces: модуль `SessionWindows` экспортирует `{ canFocusRow, trackerHere, trackerHosts, focusPid }`. Функция `canFocus(state, configHost)` **удаляется** — её место занимают две.
  - `canFocusRow(row, state, configHost) -> boolean`
  - `trackerHere(state, configHost) -> {host, pid, canFocus} | null`
  - `trackerHosts(state) -> Array<{host, pid, canFocus}>`
  - `focusPid(src) -> number`

- [ ] **Step 1: Написать падающий тест**

Заменить `test/session-windows.test.js` целиком:

```js
const test = require('node:test');
const assert = require('node:assert');
const { canFocusRow, trackerHere, trackerHosts, focusPid } =
  require('../frontend-src/session-windows');

// Ответ нового агрегатора: две машины, у каждой свой трекер.
const STATE = {
  windowHost: 'desktop-box',
  windowPid: 4242,
  windowHosts: [
    { host: 'desktop-box', pid: 4242, canFocus: true },
    { host: 'macbook', pid: 77, canFocus: false },
  ],
};
const rowOn = (host, extra = {}) => ({
  window: { title: 'ccfzf', lastSeen: 1, focusedAt: 0, host, pid: 1, canFocus: true, ...extra },
});

test('окно на своей машине поднимается', () => {
  assert.strictEqual(canFocusRow(rowOn('desktop-box'), STATE, 'desktop-box'), true);
});

test('окно на чужой машине не поднимается', () => {
  // Пометка о таком окне полезна — сессия где-то открыта, — а подъём ничего не
  // дал бы человеку перед экраном и отнял бы у Enter привычное открытие.
  assert.strictEqual(canFocusRow(rowOn('macbook'), STATE, 'desktop-box'), false);
});

test('регистр и пробелы в именах машин не значат ничего', () => {
  // Одна сторона — hostname машины, другая — строка, набранная человеком.
  assert.strictEqual(canFocusRow(rowOn('DESKTOP-BOX'), STATE, '  desktop-box '), true);
});

test('трекер, не умеющий поднимать окна, не поднимает их и на своей машине', () => {
  // Это единственное, что отличает «мой хост» от «мой хост, и он правда
  // умеет». Без проверки Enter отправил бы просьбу, которую разберёт менеджер
  // на другой машине.
  assert.strictEqual(
    canFocusRow(rowOn('desktop-box', { canFocus: false }), STATE, 'desktop-box'), false);
});

test('строка без окна не поднимается ничем', () => {
  assert.strictEqual(canFocusRow({}, STATE, 'desktop-box'), false);
  assert.strictEqual(canFocusRow(null, STATE, 'desktop-box'), false);
});

test('пустое имя машины в конфиге значит «фокуса не бывает»', () => {
  // Умолчание: пикер, которому не сказали, на какой он машине, ведёт себя
  // как прежде.
  for (const mine of ['', '   ', undefined, null]) {
    assert.strictEqual(canFocusRow(rowOn('desktop-box'), STATE, mine), false, String(mine));
  }
});

test('нулевой pid у окна значит «трекера не слышно»', () => {
  for (const pid of [0, -1, undefined, 'x']) {
    assert.strictEqual(
      canFocusRow(rowOn('desktop-box', { pid }), STATE, 'desktop-box'), false, String(pid));
  }
});

test('старый агрегатор без полей у окна читается верхними полями ответа', () => {
  // Пикер и агрегатор обновляются порознь, и порядок нам не подвластен:
  // пикер новее агрегатора обязан вести себя как прежде, а не гаснуть.
  const old = { windowHost: 'desktop-box', windowPid: 4242 };
  const row = { window: { title: 'ccfzf', lastSeen: 1, focusedAt: 0 } };
  assert.strictEqual(canFocusRow(row, old, 'desktop-box'), true);
  assert.strictEqual(canFocusRow(row, old, 'macbook'), false);
});

test('trackerHere находит свою машину среди трекеров', () => {
  assert.deepStrictEqual(trackerHere(STATE, 'desktop-box'),
    { host: 'desktop-box', pid: 4242, canFocus: true });
});

test('trackerHere молчит про машину, чей трекер не умеет поднимать', () => {
  assert.strictEqual(trackerHere(STATE, 'macbook'), null);
});

test('trackerHere молчит, когда нашей машины среди трекеров нет', () => {
  assert.strictEqual(trackerHere(STATE, 'thinkpad'), null);
  assert.strictEqual(trackerHere(STATE, ''), null);
});

test('trackerHosts собирает список и из старого ответа', () => {
  // Старый агрегатор списка не отдаёт, но одну машину называет. Пустой список
  // на таком ответе выключил бы режим снимков там, где он работал.
  assert.deepStrictEqual(trackerHosts({ windowHost: 'desktop-box', windowPid: 7 }),
    [{ host: 'desktop-box', pid: 7, canFocus: true }]);
  assert.deepStrictEqual(trackerHosts({}), []);
});

test('focusPid отдаёт ноль всему, что не положительное число', () => {
  assert.strictEqual(focusPid({ pid: 4242 }), 4242);
  assert.strictEqual(focusPid({ windowPid: 4242 }), 4242);
  for (const src of [{ pid: 0 }, { pid: -1 }, { pid: '4242' }, {}, null]) {
    assert.strictEqual(focusPid(src), 0, JSON.stringify(src));
  }
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/ccfzf-picker && npm test 2>&1 | grep -E "^not ok|# fail" | head`
Expected: падения с `canFocusRow is not a function`.

- [ ] **Step 3: Реализация**

Заменить тело фабрики в `frontend-src/session-windows.js` (всё между `function normHost` и `return`):

```js
  function normHost(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /** pid трекера; ноль значит «трекера не слышно». */
  function focusPid(src) {
    const o = src || {};
    const pid = typeof o.pid === 'number' ? o.pid : o.windowPid;
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  }

  /**
   * Запись окна строки, дополненная сведениями о машине.
   *
   * Трекеров теперь может быть несколько, и «чья это машина» перестало быть
   * свойством всего ответа: агрегатор приписывает `host`, `pid` и `canFocus`
   * каждой записи окна отдельно.
   *
   * Старый агрегатор этих полей не кладёт, и тогда берутся верхние поля
   * ответа — там ровно один трекер, и все окна его. Пикер и агрегатор
   * обновляются порознь, порядок нам не подвластен, а пикер новее агрегатора
   * обязан вести себя как прежде, а не гасить пометки.
   */
  function windowOf(row, state) {
    const w = (row || {}).window;
    if (!w) return null;
    if (normHost(w.host)) return w;
    const s = state || {};
    return { ...w, host: s.windowHost, pid: s.windowPid, canFocus: true };
  }

  /**
   * Поднимать ли окно этой строки вместо открытия терминала.
   *
   * Три условия, и каждое стоит починенной поломки. Машина окна совпала с
   * нашей — иначе подъём на чужом экране ничего не даёт человеку, а Enter
   * теряет привычное открытие терминала. Трекер этой машины умеет поднимать —
   * иначе просьбу разберёт менеджер на другой машине, и окно поднимется не
   * то. Pid ненулевой — это признак живого трекера: свой pid в файл окон
   * кладёт он сам, и ноль значит «файла нет, он чужой или протух».
   */
  function canFocusRow(row, state, configHost) {
    const w = windowOf(row, state);
    if (!w || w.canFocus === false) return false;
    const host = normHost(w.host);
    const mine = normHost(configHost);
    return Boolean(host) && host === mine && focusPid(w) > 0;
  }

  /**
   * Машины, чьи трекеры сейчас живы.
   *
   * Старый агрегатор списка не отдаёт, но одну машину называет верхними
   * полями — из них и собирается список на одного. Пустой список на таком
   * ответе выключил бы режим снимков там, где он работает.
   */
  function trackerHosts(state) {
    const s = state || {};
    if (Array.isArray(s.windowHosts)) return s.windowHosts.filter(Boolean);
    return s.windowHost ? [{ host: s.windowHost, pid: s.windowPid, canFocus: true }] : [];
  }

  /**
   * Наш ли трекер жив и умеет ли он поднимать окна.
   *
   * Отвечает на вопросы про машину целиком, а не про строку: доступен ли режим
   * снимков, показывать ли подсказку о нём. По списку окон этого не понять — у
   * здорового трекера без открытых терминалов он пуст.
   */
  function trackerHere(state, configHost) {
    const mine = normHost(configHost);
    if (!mine) return null;
    return trackerHosts(state).find(e => normHost((e || {}).host) === mine
      && e.canFocus !== false && focusPid(e) > 0) || null;
  }

  return { canFocusRow, trackerHere, trackerHosts, focusPid };
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/ccfzf-picker && npm test 2>&1 | tail -8`
Expected: `test/session-windows.test.js` зелёный. `sessions.html` пока зовёт удалённую `canFocus` — это чинится следующей задачей, тестами не ловится.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add frontend-src/session-windows.js test/session-windows.test.js
git commit -m "feat(picker): машина окна читается построчно, а не из верхнего поля"
```

---

## Task 4: Пикер — развилка подъёма читает строку, режим снимков читает машину

**Files:**
- Modify: `sessions.html` — `canFocusWindows()` (около строки 867), вызов `chooseOpenStrategy` (около строки 1040)
- Test: `test/session-groups.test.js` (дописать один сторож)

**Interfaces:**
- Consumes: `SessionWindows.canFocusRow`, `SessionWindows.trackerHere` (Task 3).
- Produces: в `sessions.html` две функции вместо одной — `trackerIsHere()` (машина) и `rowCanFocus(row)` (строка). Внешних потребителей нет.

- [ ] **Step 1: Написать сторож фильтра**

Дописать в конец `test/session-groups.test.js`:

```js
// Фильтр `only windowed` живёт на одном лишь наличии поля `window` и о машинах
// не знает ничего: `rows.filter(r => r.window)` в buildSessionsPayload. Сторож
// на то, что окно с чужой машины он считает окном — этим и чинится «чекбокс
// only windowed на macOS»: не правкой фильтра, а появлением источника.
test('onlyWindow считает окном и окно на соседней машине', () => {
  const raw = {
    ok: true,
    seen: {},
    sessions: [
      { id: 'mac-1', title: 'На маке', cwd: '/home/user/a', live: true,
        window: { title: 'На маке', host: 'macbook', pid: 7, canFocus: false, lastSeen: 1 } },
      { id: 'win-1', title: 'На Windows', cwd: '/home/user/b', live: true,
        window: { title: 'На Windows', host: 'desktop-box', pid: 42, canFocus: true, lastSeen: 1 } },
      { id: 'none-1', title: 'Без окна', cwd: '/home/user/c', live: true },
    ],
  };
  assert.deepStrictEqual(
    idsOf(buildSessionsPayload(raw, 'name', { onlyWindow: true })),
    ['mac-1', 'win-1'],
  );
});
```

- [ ] **Step 2: Прогнать и посмотреть, что получится**

Run: `cd ~/projects/js/ccfzf-picker && npm test 2>&1 | grep -E "onlyWindow считает|^not ok" | head`
Expected: тест проходит сразу. Это и надо доказать: фильтр к машинам отношения не имеет, и правки в нём не будет. Если он падает — значит, `buildSessionList` теряет поле `window`, и **чинить надо её**, а не фильтр.

- [ ] **Step 3: Развести две развилки в `sessions.html`**

Заменить функцию `canFocusWindows()` целиком на:

```js
  /**
   * Жив ли трекер на этой машине и умеет ли он поднимать окна.
   *
   * Вопрос про машину целиком, а не про строку: доступен ли режим снимков и
   * показывать ли подсказку о нём. Настроенный брокер — не второе решение, а
   * условие выполнимости: просьба уходит только публикацией, и без брокера её
   * некуда отправить. Предложить режим, у которого нет транспорта, значит
   * подарить человеку молчащий Enter.
   */
  function trackerIsHere() {
    return CONFIG.mqtt.configured
      && !!window.SessionWindows.trackerHere(lastState, CONFIG.windowHost);
  }

  /**
   * Поднимать ли окно этой строки.
   *
   * Раньше на этот вопрос отвечала машина целиком, и другого ответа быть не
   * могло: трекер был один. Теперь окно строки может стоять на соседней
   * машине, и подъём его отсюда ничего не дал бы человеку перед экраном.
   */
  function rowCanFocus(row) {
    return CONFIG.mqtt.configured
      && window.SessionWindows.canFocusRow(row, lastState, CONFIG.windowHost);
  }
```

- [ ] **Step 4: Развести вызовы**

Заменить три вызова машинного вопроса на `trackerIsHere()`:

- около строки 563: `+ (trackerIsHere() ? ', ^S - snapshots' : '');`
- около строки 759: `const snapshotsMode = mode === 'snapshots' && trackerIsHere();`
- около строки 1576: `if (!trackerIsHere()) return;`

Заменить построчный вызов в `openSession` (около строки 1040):

```js
    const strategy = window.OpenStrategy.chooseOpenStrategy(
      row, CONFIG.caps, { canFocus: rowCanFocus(row) },
    );
```

Проверить `rtk grep -n "canFocusWindows" sessions.html` — не должно остаться ни одного вхождения.

- [ ] **Step 5: Прогнать тесты и убедиться, что они проходят**

Run: `cd ~/projects/js/ccfzf-picker && npm test 2>&1 | tail -8`
Expected: 0 fail.

- [ ] **Step 6: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add sessions.html test/session-groups.test.js
git commit -m "feat(picker): подъём решает строка, режим снимков — машина"
```

---

## Task 5: Пикер — заметка про хоткеи перестаёт ругаться на маке

**Files:**
- Modify: `src-tauri/src/project_hotkeys.rs` — `host_mismatch_note` (около строки 84)
- Test: `src-tauri/src/project_hotkeys.rs`, блок `#[cfg(test)]` (около строки 640)

**Interfaces:**
- Consumes: поле `windowHosts` в ответе агрегатора (Task 2).
- Produces: `host_mismatch_note(state, own) -> Option<String>` молчит, когда `own` назван среди `windowHosts`.

- [ ] **Step 1: Написать падающий тест**

Дописать в блок `#[cfg(test)]` файла `src-tauri/src/project_hotkeys.rs`:

```rust
    /// Мак теперь называет себя в конфиге — иначе подъём окна не с чем
    /// сверять, — и заметка про чужие хоткеи начала бы ругаться на каждом
    /// запуске. Ругаться ей положено на «настроили не ту машину», а это
    /// отличается ровно одним: нашего имени нет среди трекеров вовсе.
    #[test]
    fn no_note_when_our_host_is_a_known_tracker() {
        let state = serde_json::json!({
            "windowHost": "windows-box",
            "windowHosts": [
                { "host": "windows-box", "pid": 42, "canFocus": true },
                { "host": "mac-host", "pid": 7, "canFocus": false },
            ],
            "projects": [{ "path": "/projects/js/picker", "hotkey": "Ctrl+F11" }],
        });
        assert!(
            host_mismatch_note(&state, "mac-host").is_none(),
            "мак — известный трекер, ругаться не на что"
        );
    }

    /// А вот имя, которого среди трекеров нет, — это и есть опечатка в
    /// конфиге, ради которой заметка заведена.
    #[test]
    fn note_stays_for_a_host_no_tracker_knows() {
        let state = serde_json::json!({
            "windowHost": "windows-box",
            "windowHosts": [{ "host": "windows-box", "pid": 42, "canFocus": true }],
            "projects": [{ "path": "/projects/js/picker", "hotkey": "Ctrl+F11" }],
        });
        let note = host_mismatch_note(&state, "windwos-box").expect("опечатку надо назвать");
        assert!(note.contains("windwos-box"), "человеку нужно его же имя: {note}");
    }
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test project_hotkeys 2>&1 | tail -15`
Expected: FAIL — `no_note_when_our_host_is_a_known_tracker`, заметка выдана.

- [ ] **Step 3: Реализация**

В `host_mismatch_note`, сразу после `if wanted_from_state(state, own).is_some() { return None; }`, добавить:

```rust
    // Наше имя названо среди живых трекеров — значит, конфиг верен, а хоткеи
    // просто приехали от соседней машины. Раньше этот случай был невозможен:
    // трекер был один, и несовпадение имён значило опечатку. Теперь их
    // несколько, и без этой проверки заметка ругалась бы на маке всегда.
    let own_norm = norm_host(own);
    let known = state
        .get("windowHosts")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|e| e.get("host").and_then(|v| v.as_str()))
        .any(|h| norm_host(h) == own_norm);
    if known && !own_norm.is_empty() {
        return None;
    }
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/ccfzf-picker/src-tauri && cargo test 2>&1 | tail -6`
Expected: `test result: ok`.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/ccfzf-picker
git add src-tauri/src/project_hotkeys.rs
git commit -m "fix(hotkeys): заметка молчит про машину, которую трекеры знают"
```

---

## Task 6: Новый репозиторий — каркас и заголовки

**Files:**
- Create: `~/projects/js/macos-windows-manager/Cargo.toml` (workspace)
- Create: `~/projects/js/macos-windows-manager/crates/mwm-core/Cargo.toml`
- Create: `~/projects/js/macos-windows-manager/crates/mwm-core/src/lib.rs`
- Create: `~/projects/js/macos-windows-manager/crates/mwm-core/src/title.rs`
- Create: `~/projects/js/macos-windows-manager/.gitignore`
- Create: `~/projects/js/macos-windows-manager/README.md`

**Interfaces:**
- Consumes: ничего.
- Produces: крейт `mwm-core` — вся логика без платформенных зависимостей, тесты гоняются где угодно. `title::strip_decoration(&str) -> String`.

- [ ] **Step 1: Завести репозиторий и каркас**

```bash
mkdir -p ~/projects/js/macos-windows-manager/crates/mwm-core/src
cd ~/projects/js/macos-windows-manager
git init
```

`.gitignore`:

```
/target
/data
```

`Cargo.toml`:

```toml
# Два крейта, и разделены они не по вкусу. `mwm-core` не знает ни про macOS, ни
# про Tauri: его тесты гоняются на любой машине, и вся логика трекера живёт
# здесь. `src-tauri` — приложение, собирается только на маке. Держи логику
# внутри приложения — и проверить её было бы негде, кроме той самой машины,
# на которой она и работает.
[workspace]
resolver = "2"
members = ["crates/mwm-core", "src-tauri"]

[workspace.package]
version = "0.1.0"
edition = "2021"
```

`crates/mwm-core/Cargo.toml`:

```toml
[package]
name = "mwm-core"
version.workspace = true
edition.workspace = true

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`README.md`:

```markdown
# macos-windows-manager

Оконный трекер claude-wt для macOS. Следит за окнами терминалов, привязывает
их заголовки к сессиям и кладёт список на машину, где живёт агрегатор `ccfzf`.
Окон у самого приложения нет — только значок в трее.

Спека: `ccfzf-picker/docs/superpowers/specs/2026-08-13-macos-windows-manager-design.md`.

## Сборка и тесты

```
cargo test -p mwm-core       # логика, гоняется на любой машине
cargo build --release        # приложение, только на macOS
```

## Разрешения

Нужно одно — Accessibility. Без него окна не перечисляются и файл не пишется
вовсе: пустой файл означал бы «окон нет» и погасил бы чужие пометки.
```

- [ ] **Step 2: Написать падающий тест**

`crates/mwm-core/src/title.rs`:

```rust
//! Заголовок окна в том виде, в котором его сравнивают с заголовком сессии.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_prefix_is_stripped() {
        // Claude Code ставит перед заголовком значок состояния, пока работает,
        // а дамп хранит голую сводку. Без снятия значка две стороны сравнения
        // перестают сходиться ровно тогда, когда сессия работает.
        assert_eq!(strip_decoration("✳ Check branch commit count"), "Check branch commit count");
    }

    #[test]
    fn punctuation_survives() {
        // Снимаются только символы, но не знаки препинания: заголовок, честно
        // начинающийся с тире или кавычки, обязан дожить до сравнения целым.
        assert_eq!(strip_decoration("- fix the parser"), "- fix the parser");
        assert_eq!(strip_decoration("\"quoted\" title"), "\"quoted\" title");
    }

    #[test]
    fn edges_are_trimmed_and_empty_survives() {
        assert_eq!(strip_decoration("  ccfzf  "), "ccfzf");
        assert_eq!(strip_decoration(""), "");
        assert_eq!(strip_decoration("✳   "), "");
    }
}
```

`crates/mwm-core/src/lib.rs`:

```rust
//! Логика оконного трекера без платформенных зависимостей.

pub mod title;
```

- [ ] **Step 3: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core 2>&1 | tail -10`
Expected: FAIL — `cannot find function strip_decoration`.

- [ ] **Step 4: Реализация**

Дописать в начало `crates/mwm-core/src/title.rs` (перед блоком тестов):

```rust
/// Снять со значка состояния и привести к сравнимому виду.
///
/// Значок опознаётся по разряду символа (`char::is_symbol`-эквивалент), а не по
/// конкретному знаку: это индикатор, и он меняется от версии к версии Claude
/// Code. Знаки препинания не снимаются никогда — заголовок, начинающийся с
/// тире или кавычки, законен, и его правка развела бы две стороны сравнения.
pub fn strip_decoration(title: &str) -> String {
    let rest = title.trim_start();
    let head: String = rest.chars().take_while(|c| is_symbol(*c)).collect();
    let out = if head.is_empty() {
        rest
    } else {
        let tail = &rest[head.len()..];
        // Значок отделён от заголовка пробелом. Без пробела это не значок, а
        // первый символ самого заголовка.
        if tail.starts_with(char::is_whitespace) { tail } else { rest }
    };
    out.trim().to_string()
}

/// Значок ли это — то есть не буква, не цифра, не пробел и не препинание.
///
/// Своя проверка, а не таблица разрядов Unicode из крейта: нужны ровно четыре
/// разряда, и полная таблица ради них в дерево сборки не поедет. Приближение
/// честное — всё, что эта проверка пропустит вперёд, и есть значок состояния,
/// который надо снять.
fn is_symbol(c: char) -> bool {
    !c.is_alphanumeric() && !c.is_whitespace() && !is_punctuation(c)
}

/// Препинание: ASCII плюс те немногие не-ASCII знаки, что встречаются в
/// заголовках сессий. Их снимать нельзя — заголовок, честно начинающийся с
/// тире или кавычки, обязан дожить до сравнения целым.
fn is_punctuation(c: char) -> bool {
    c.is_ascii_punctuation()
        || matches!(c, '–' | '—' | '«' | '»' | '“' | '”' | '‘' | '’' | '…')
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core 2>&1 | tail -6`
Expected: `test result: ok. 3 passed`.

Если `punctuation_survives` падает на `"` или `-` — поправить `is_symbol`, а не тест: правило «снимаем символы, не трогаем препинание» задано спекой.

- [ ] **Step 6: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add .
git commit -m "feat: каркас репозитория и разбор заголовка окна"
```

---

## Task 7: mwm-core — тик трекера, привязка окна к сессии

**Files:**
- Create: `crates/mwm-core/src/tracker.rs`
- Modify: `crates/mwm-core/src/lib.rs`

**Interfaces:**
- Consumes: `title::strip_decoration` (Task 6).
- Produces:
  ```rust
  pub struct Seen { pub id: u64, pub title: String, pub focused: bool }
  pub struct Bound { pub session_id: String, pub title: String,
                     pub last_seen_ms: u64, pub focused_at_ms: u64 }
  pub struct Tracker { /* приватно */ }
  impl Tracker {
      pub fn new(stable_ticks: u32) -> Self;
      pub fn tick(&mut self, seen: &[Seen], index: &BTreeMap<String, String>, now_ms: u64);
      pub fn bound(&self) -> BTreeMap<String, Bound>;   // session_id -> запись
      pub fn unresolved(&self) -> Vec<String>;          // устоявшиеся заголовки без сессии
  }
  ```
  `index` — карта «очищенный заголовок → id сессии», её готовит слой дампа (Task 11).

- [ ] **Step 1: Написать падающий тест**

`crates/mwm-core/src/tracker.rs`:

```rust
//! Тик трекера: какое окно какой сессии принадлежит.

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const SID: &str = "aaaaaaaa-1111-2222-3333-444444444444";

    fn index(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(t, s)| (t.to_string(), s.to_string())).collect()
    }

    fn seen(id: u64, title: &str) -> Seen {
        Seen { id, title: title.to_string(), focused: false }
    }

    #[test]
    fn binding_waits_for_the_title_to_settle() {
        // Вход в сессию перещёлкивает заголовок два-три раза подряд — шелл,
        // claude, имя сессии. Привязка по первому же значению села бы на
        // промежуточное, и окно осталось бы за чужой сессией до перезапуска.
        let mut t = Tracker::new(2);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen(1, "ccfzf")], &idx, 1_000);
        assert!(t.bound().is_empty(), "одного такта мало");
        t.tick(&[seen(1, "ccfzf")], &idx, 2_000);
        assert_eq!(t.bound().keys().collect::<Vec<_>>(), vec![SID]);
    }

    #[test]
    fn binding_survives_the_title_changing() {
        // Сессия правит заголовок терминала на каждый ответ, а дамп отстаёт до
        // тридцати секунд. Слот — это ровно то, что удерживает окно за сессией
        // в промежутке; без него окно мигало бы в списке, пока сессия работает.
        let mut t = Tracker::new(2);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen(1, "ccfzf")], &idx, 1_000);
        t.tick(&[seen(1, "ccfzf")], &idx, 2_000);
        t.tick(&[seen(1, "writing the plan")], &BTreeMap::new(), 3_000);
        t.tick(&[seen(1, "writing the plan")], &BTreeMap::new(), 4_000);
        assert_eq!(t.bound().keys().collect::<Vec<_>>(), vec![SID], "окно осталось за сессией");
    }

    #[test]
    fn closed_window_leaves_the_published_list() {
        // Публикуются окна текущего такта, а не слоты: слот переживает закрытие
        // окна намеренно, и по слотам файл рассказывал бы про окна, которых на
        // экране нет.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen(1, "ccfzf")], &idx, 1_000);
        assert_eq!(t.bound().len(), 1);
        t.tick(&[], &idx, 2_000);
        assert!(t.bound().is_empty(), "окна нет — и записи нет");
    }

    #[test]
    fn unknown_settled_title_is_reported() {
        // Ходить за дампом на каждом такте незачем: заголовок меняется на
        // каждый ответ агента. Спрашивают его тогда, когда есть о чём — вот об
        // этом списке.
        let mut t = Tracker::new(1);
        t.tick(&[seen(1, "brand new session")], &BTreeMap::new(), 1_000);
        assert_eq!(t.unresolved(), vec!["brand new session".to_string()]);
    }

    #[test]
    fn a_restarted_session_takes_its_window_back() {
        // В том же терминале запустили claude заново: id новый, окно прежнее.
        // Привязавшись однажды и перестав спрашивать дамп, трекер держал бы
        // строку на прошлой сессии вечно, а работающую не показывал бы вовсе.
        let mut t = Tracker::new(1);
        t.tick(&[seen(1, "ccfzf")], &index(&[("ccfzf", SID)]), 1_000);
        assert_eq!(t.bound().keys().collect::<Vec<_>>(), vec![SID]);
        // Заголовок сменился, дамп ещё не знает нового имени — про него и
        // спрашивают.
        t.tick(&[seen(1, "ccfzf-2")], &index(&[("ccfzf", SID)]), 2_000);
        assert_eq!(t.unresolved(), vec!["ccfzf-2".to_string()]);
        // Дамп освежился — окно переехало к новой сессии.
        const SID2: &str = "cccccccc-1111-2222-3333-444444444444";
        t.tick(&[seen(1, "ccfzf-2")], &index(&[("ccfzf-2", SID2)]), 3_000);
        assert_eq!(t.bound().keys().collect::<Vec<_>>(), vec![SID2]);
    }

    #[test]
    fn focus_stamp_is_set_when_the_window_becomes_frontmost() {
        // «Просмотрено» приезжает отсюда и ниоткуда больше: переход взгляда на
        // окно виден только трекеру.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen(1, "ccfzf")], &idx, 1_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 0);
        t.tick(&[Seen { id: 1, title: "ccfzf".into(), focused: true }], &idx, 5_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 5_000);
        t.tick(&[seen(1, "ccfzf")], &idx, 9_000);
        assert_eq!(t.bound()[SID].focused_at_ms, 5_000, "отметка не откатывается");
    }

    #[test]
    fn twins_by_title_go_to_the_newer_window() {
        // Два окна с одним заголовком законны. Драться за один слот им нельзя:
        // побеждает окно с большим идентификатором — оно новее.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen(1, "ccfzf"), seen(9, "ccfzf")], &idx, 1_000);
        let bound = t.bound();
        assert_eq!(bound.len(), 1, "одна сессия — одно окно: {bound:?}");
    }

    #[test]
    fn decorated_title_matches_the_bare_one() {
        // Значок состояния перед заголовком снимается перед сравнением.
        let mut t = Tracker::new(1);
        let idx = index(&[("ccfzf", SID)]);
        t.tick(&[seen(1, "✳ ccfzf")], &idx, 1_000);
        assert_eq!(t.bound().keys().collect::<Vec<_>>(), vec![SID]);
    }
}
```

Дописать в `lib.rs`: `pub mod tracker;`

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core tracker 2>&1 | tail -10`
Expected: FAIL — `cannot find struct Tracker`.

- [ ] **Step 3: Реализация**

Дописать в начало `crates/mwm-core/src/tracker.rs`:

```rust
use crate::title::strip_decoration;
use std::collections::{BTreeMap, HashMap};

/// Окно, каким его увидел платформенный слой на этом такте.
#[derive(Debug, Clone)]
pub struct Seen {
    /// Устойчив в пределах жизни трекера и больше нигде не нужен: в
    /// публикуемом файле идентификатора окна нет вовсе.
    pub id: u64,
    pub title: String,
    pub focused: bool,
}

/// Что уезжает читателю про одну сессию.
#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub session_id: String,
    pub title: String,
    pub last_seen_ms: u64,
    pub focused_at_ms: u64,
}

#[derive(Debug, Default, Clone)]
struct Tracked {
    title: String,
    ticks: u32,
    stable: Option<String>,
    session_id: Option<String>,
}

/// Слот переживает закрытие окна: он затем и заведён, чтобы вернуть сессию на
/// прежнее место и удержать привязку, пока заголовок меняется.
#[derive(Debug, Default, Clone)]
struct Slot {
    focused_at_ms: u64,
}

pub struct Tracker {
    stable_ticks: u32,
    windows: HashMap<u64, Tracked>,
    slots: HashMap<String, Slot>,
    bound: BTreeMap<String, Bound>,
    unresolved: Vec<String>,
}

impl Tracker {
    pub fn new(stable_ticks: u32) -> Self {
        Self {
            stable_ticks: stable_ticks.max(1),
            windows: HashMap::new(),
            slots: HashMap::new(),
            bound: BTreeMap::new(),
            unresolved: Vec::new(),
        }
    }

    /// Один такт: что видно на экране, что об этом знает дамп, который час.
    pub fn tick(&mut self, seen: &[Seen], index: &BTreeMap<String, String>, now_ms: u64) {
        // Двойники по заголовку: побеждает больший идентификатор — окно новее.
        // Остальные остаются непривязанными, чтобы не драться за один слот.
        let mut winners: HashMap<&str, u64> = HashMap::new();
        for w in seen {
            let e = winners.entry(w.title.as_str()).or_insert(w.id);
            if w.id > *e {
                *e = w.id;
            }
        }

        let live: Vec<u64> = seen.iter().map(|w| w.id).collect();
        self.windows.retain(|id, _| live.contains(id));
        self.bound.clear();
        self.unresolved.clear();

        for w in seen {
            let t = self.windows.entry(w.id).or_default();
            if t.title == w.title {
                t.ticks += 1;
            } else {
                t.title = w.title.clone();
                t.ticks = 1;
            }
            if t.ticks >= self.stable_ticks {
                t.stable = Some(w.title.clone());
            }
            let Some(stable) = t.stable.clone() else { continue };
            if winners.get(w.title.as_str()) != Some(&w.id) {
                continue;
            }
            let key = strip_decoration(&stable);
            if let Some(sid) = index.get(&key) {
                t.session_id = Some(sid.clone());
            } else if !key.is_empty() {
                // Заголовок устоялся, а сессии под него нет — значит, дамп
                // пора освежить. Ходить за ним на каждом такте незачем: он
                // меняется на каждый ответ агента.
                //
                // Спрашивают и про окно, у которого привязка уже есть, и это
                // не расточительство. В том же терминале запускают claude
                // заново: id новый, окно прежнее. Привяжись мы однажды и
                // перестань спрашивать — строка навсегда осталась бы на
                // прошлой сессии, а работающая не была бы видна вовсе.
                self.unresolved.push(key.clone());
            }
            let Some(sid) = t.session_id.clone() else { continue };
            let slot = self.slots.entry(sid.clone()).or_default();
            if w.focused {
                slot.focused_at_ms = now_ms;
            }
            self.bound.insert(
                sid.clone(),
                Bound {
                    session_id: sid,
                    title: key,
                    last_seen_ms: now_ms,
                    focused_at_ms: slot.focused_at_ms,
                },
            );
        }
    }

    /// Окна текущего такта, привязанные к сессиям.
    pub fn bound(&self) -> BTreeMap<String, Bound> {
        self.bound.clone()
    }

    /// Устоявшиеся заголовки, которым дамп не нашёл сессии.
    pub fn unresolved(&self) -> Vec<String> {
        self.unresolved.clone()
    }
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core 2>&1 | tail -6`
Expected: `test result: ok. 10 passed`.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add crates/mwm-core
git commit -m "feat(core): тик трекера — привязка окна к сессии и отметка взгляда"
```

---

## Task 8: mwm-core — файл окон, отпечаток и решение «писать ли»

**Files:**
- Create: `crates/mwm-core/src/publish.rs`
- Modify: `crates/mwm-core/src/lib.rs`

**Interfaces:**
- Consumes: `tracker::Bound` (Task 7).
- Produces:
  ```rust
  pub const HEARTBEAT_MS: u64 = 30_000;
  pub fn build_file(bound: &BTreeMap<String, Bound>, host: &str, pid: u32,
                    now_ms: u64, can_focus: bool) -> serde_json::Value;
  pub fn fingerprint(bound: &BTreeMap<String, Bound>) -> String;
  pub fn should_write(fingerprint: &str, last: Option<&str>,
                      last_write_ms: u64, now_ms: u64) -> bool;
  ```

- [ ] **Step 1: Написать падающий тест**

`crates/mwm-core/src/publish.rs`:

```rust
//! Файл окон: что уезжает читателю и когда.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::Bound;
    use std::collections::BTreeMap;

    const SID: &str = "aaaaaaaa-1111-2222-3333-444444444444";

    fn bound(title: &str, last_seen_ms: u64) -> BTreeMap<String, Bound> {
        let mut m = BTreeMap::new();
        m.insert(SID.to_string(), Bound {
            session_id: SID.to_string(),
            title: title.to_string(),
            last_seen_ms,
            focused_at_ms: 9_000,
        });
        m
    }

    #[test]
    fn file_shape_matches_what_the_reader_expects() {
        // Формат — тот же, что у Windows-трекера, и это условие всей затеи:
        // читатель уже умеет его разбирать, и переучивать его не пришлось.
        // Время в файле — в секундах: читатель сравнивает `generated` со своим
        // «сейчас», а оно у него в секундах.
        let v = build_file(&bound("ccfzf", 60_000), "mac-host", 7, 60_000, false);
        assert_eq!(v["host"], "mac-host");
        assert_eq!(v["pid"], 7);
        assert_eq!(v["generated"], 60);
        assert_eq!(v["focus"], false);
        assert_eq!(v["windows"][SID]["title"], "ccfzf");
        assert_eq!(v["windows"][SID]["lastSeen"], 60);
        assert_eq!(v["windows"][SID]["focusedAt"], 9);
        // Виртуальных столов у macOS программно нет, и подменять их нечем.
        assert!(v["windows"][SID]["desktop"].is_null());
        // Снимки и хоткеи — не этого этапа и не этой машины, но ключи должны
        // быть: читатель разбирает их терпимо, а вот отсутствие разберёт как
        // «трекер прежней версии» и промолчит.
        assert!(v["snapshots"].as_array().unwrap().is_empty());
        assert!(v["projects"].as_array().unwrap().is_empty());
    }

    #[test]
    fn fingerprint_ignores_time() {
        // `generated` меняется на каждом такте. Отпечаток, включивший его, не
        // сэкономил бы ни одной записи, а выглядело бы это работающей
        // экономией.
        assert_eq!(fingerprint(&bound("ccfzf", 1_000)), fingerprint(&bound("ccfzf", 90_000)));
    }

    #[test]
    fn fingerprint_notices_a_new_title() {
        assert_ne!(fingerprint(&bound("ccfzf", 1_000)), fingerprint(&bound("other", 1_000)));
    }

    #[test]
    fn heartbeat_writes_even_when_nothing_changed() {
        // Читатель судит о живости по `generated` и только по нему. Без
        // сердцебиения отметка залипала бы у здорового трекера, и читатель
        // погасил бы пометки об окнах, которые открыты.
        assert!(!should_write("abc", Some("abc"), 1_000, 1_000 + HEARTBEAT_MS - 1));
        assert!(should_write("abc", Some("abc"), 1_000, 1_000 + HEARTBEAT_MS));
    }

    #[test]
    fn change_writes_at_once() {
        assert!(should_write("abc", Some("xyz"), 1_000, 1_001));
        assert!(should_write("abc", None, 0, 1), "первая запись обязана состояться");
    }
}
```

Дописать в `lib.rs`: `pub mod publish;`

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core publish 2>&1 | tail -10`
Expected: FAIL — `cannot find function build_file`.

- [ ] **Step 3: Реализация**

Дописать в начало `crates/mwm-core/src/publish.rs`:

```rust
use crate::tracker::Bound;
use serde_json::json;
use std::collections::BTreeMap;

/// Как часто файл переписывается, когда расклад не менялся.
///
/// Читатель судит о свежести по полю `generated` и только по нему: mtime не
/// отличает «демон умер» от «ничего не менялось», а разница между этими
/// случаями — вся суть файла.
pub const HEARTBEAT_MS: u64 = 30_000;

/// Публикуемый вид: у какой сессии открыто окно, на какой машине и когда на
/// него смотрели.
///
/// Формат — тот же, что у Windows-трекера, и это не совпадение, а условие
/// затеи: читатель уже умеет его разбирать. Отличий три, и все объявлены.
/// `desktop` всегда `null` — программного интерфейса к Spaces у macOS нет.
/// `snapshots` и `projects` пусты — первое отложено, второе живёт на
/// Windows-стороне. `focus` говорит, умеет ли этот трекер поднимать окно; на
/// этом этапе он не умеет, и без такого признания пикер предложил бы человеку
/// молчащий Enter.
///
/// Время наружу уезжает в секундах: читатель сравнивает `generated` со своим
/// «сейчас», а оно у него в секундах.
pub fn build_file(
    bound: &BTreeMap<String, Bound>,
    host: &str,
    pid: u32,
    now_ms: u64,
    can_focus: bool,
) -> serde_json::Value {
    let mut windows = serde_json::Map::new();
    for (sid, b) in bound {
        windows.insert(
            sid.clone(),
            json!({
                "title": b.title,
                "desktop": serde_json::Value::Null,
                "lastSeen": b.last_seen_ms / 1000,
                "focusedAt": if b.focused_at_ms == 0 { 0 } else { b.focused_at_ms / 1000 },
            }),
        );
    }
    json!({
        "generated": now_ms / 1000,
        "host": host,
        "pid": pid,
        "focus": can_focus,
        "windows": windows,
        "snapshots": [],
        "projects": [],
    })
}

/// Отпечаток расклада — без времени.
///
/// Считается по тому, что читатель увидит как изменение: набор сессий, их
/// заголовки и отметка взгляда. `lastSeen` в него не входит намеренно — он
/// растёт каждый такт, и включив его, мы получили бы отпечаток, который всегда
/// разный.
pub fn fingerprint(bound: &BTreeMap<String, Bound>) -> String {
    let mut out = String::new();
    for (sid, b) in bound {
        out.push_str(sid);
        out.push('\u{1}');
        out.push_str(&b.title);
        out.push('\u{1}');
        out.push_str(&b.focused_at_ms.to_string());
        out.push('\u{2}');
    }
    out
}

/// Писать ли файл на этом такте.
pub fn should_write(
    fingerprint: &str,
    last: Option<&str>,
    last_write_ms: u64,
    now_ms: u64,
) -> bool {
    match last {
        None => true,
        Some(prev) if prev != fingerprint => true,
        _ => now_ms.saturating_sub(last_write_ms) >= HEARTBEAT_MS,
    }
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core 2>&1 | tail -6`
Expected: `test result: ok. 15 passed`.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add crates/mwm-core
git commit -m "feat(core): файл окон, отпечаток без времени и сердцебиение"
```

---

## Task 9: mwm-core — конфиг

**Files:**
- Create: `crates/mwm-core/src/config.rs`
- Create: `config.example.yml`
- Modify: `crates/mwm-core/src/lib.rs`, `crates/mwm-core/Cargo.toml`

**Interfaces:**
- Consumes: ничего.
- Produces:
  ```rust
  pub struct Config { pub ssh_host: String, pub remote_dir: String, pub host: String,
                      pub terminals: Vec<String>, pub tick_ms: u64, pub dump_cache_ms: u64 }
  pub fn parse_config(text: &str, hostname: &str) -> Config;   // мусор — умолчания
  pub fn config_path(home: &str) -> String;
  ```

- [ ] **Step 1: Написать падающий тест**

`crates/mwm-core/src/config.rs`:

```rust
//! Настройки трекера.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_everything_but_the_ssh_host() {
        // Умолчания отвечают на вопрос «что делать, когда не сказали ничего».
        // У имени машины с сессиями ответа нет и быть не может — пустое поле
        // значит «настроить забыли», и трекер об этом скажет.
        let c = parse_config("", "mac-host");
        assert_eq!(c.ssh_host, "");
        assert_eq!(c.remote_dir, "~/.ccfzf/windows");
        assert_eq!(c.host, "mac-host", "имя своей машины берётся у системы");
        assert_eq!(c.tick_ms, 1_000);
        assert_eq!(c.dump_cache_ms, 15_000);
        assert_eq!(c.terminals, vec![
            "net.kovidgoyal.kitty".to_string(),
            "com.mitchellh.ghostty".to_string(),
            "com.googlecode.iterm2".to_string(),
        ]);
    }

    #[test]
    fn fields_are_read() {
        let c = parse_config(
            "sshHost: remote-host\nwindowHost: my-mac\nterminals:\n  - com.apple.Terminal\n",
            "mac-host",
        );
        assert_eq!(c.ssh_host, "remote-host");
        assert_eq!(c.host, "my-mac", "имя из конфига главнее системного");
        assert_eq!(c.terminals, vec!["com.apple.Terminal".to_string()]);
    }

    #[test]
    fn broken_config_is_defaults_not_a_crash() {
        // Испорченный конфиг стоит настроек, а не запуска: трекер без настроек
        // хотя бы скажет об этом в трее, а не поднявшийся не скажет ничего.
        let c = parse_config("sshHost: [unclosed\n\t\tnonsense", "mac-host");
        assert_eq!(c.host, "mac-host");
        assert_eq!(c.tick_ms, 1_000);
    }
}
```

Дописать в `lib.rs`: `pub mod config;`
Дописать в `crates/mwm-core/Cargo.toml` в `[dependencies]`: `serde_yaml = "0.9"`

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core config 2>&1 | tail -8`
Expected: FAIL — `cannot find function parse_config`.

- [ ] **Step 3: Реализация**

Дописать в начало `crates/mwm-core/src/config.rs`:

```rust
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// Машина, где живут сессии и агрегатор. Умолчания нет намеренно.
    pub ssh_host: String,
    /// Каталог файлов трекеров на той машине.
    pub remote_dir: String,
    /// Имя этой машины — то самое, которое человек пишет в `windowHost`
    /// конфига пикера. По нему пикер решает, поднимать ли окно.
    pub host: String,
    /// Bundle id приложений, чьи окна считаются терминалами.
    pub terminals: Vec<String>,
    pub tick_ms: u64,
    /// Срок годности индекса сессий. Ходить за дампом на каждом такте незачем:
    /// заголовок меняется на каждый ответ агента, а дамп и так отстаёт.
    pub dump_cache_ms: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Raw {
    ssh_host: Option<String>,
    #[serde(rename = "sshHost")]
    ssh_host_camel: Option<String>,
    #[serde(rename = "remoteDir")]
    remote_dir: Option<String>,
    #[serde(rename = "windowHost")]
    window_host: Option<String>,
    terminals: Option<Vec<String>>,
    #[serde(rename = "tickMs")]
    tick_ms: Option<u64>,
    #[serde(rename = "dumpCacheMs")]
    dump_cache_ms: Option<u64>,
}

/// Разобрать конфиг, подставив умолчания всему, чего в нём нет.
///
/// Испорченный файл стоит настроек, а не запуска: трекер без настроек хотя бы
/// скажет об этом в трее, а не поднявшийся не скажет ничего.
pub fn parse_config(text: &str, hostname: &str) -> Config {
    let raw: Raw = serde_yaml::from_str(text).unwrap_or_default();
    Config {
        ssh_host: raw.ssh_host_camel.or(raw.ssh_host).unwrap_or_default(),
        remote_dir: raw.remote_dir.unwrap_or_else(|| "~/.ccfzf/windows".to_string()),
        host: raw
            .window_host
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| hostname.to_string()),
        terminals: raw.terminals.filter(|t| !t.is_empty()).unwrap_or_else(|| {
            vec![
                "net.kovidgoyal.kitty".to_string(),
                "com.mitchellh.ghostty".to_string(),
                "com.googlecode.iterm2".to_string(),
            ]
        }),
        tick_ms: raw.tick_ms.unwrap_or(1_000),
        dump_cache_ms: raw.dump_cache_ms.unwrap_or(15_000),
    }
}

/// Где лежит конфиг. Тот же вид пути, что у пикера, — человеку их настраивать
/// рядом.
pub fn config_path(home: &str) -> String {
    format!("{home}/.config/macos-windows-manager/config.yaml")
}
```

- [ ] **Step 4: Написать `config.example.yml`**

```yaml
# Скопируйте в ~/.config/macos-windows-manager/config.yaml

# Машина, где живут сессии и агрегатор ccfzf. Умолчания нет: без неё трекеру
# некуда класть свой файл и не у кого спрашивать, какая сессия как называется.
# Любая форма, понятная ssh: имя из ~/.ssh/config, user@host, host.domain.
sshHost: remote-host

# Каталог файлов трекеров на той машине. По одному файлу на машину, где открыты
# терминалы; агрегатор читает их все и сливает.
remoteDir: ~/.ccfzf/windows

# Имя этой машины. То же самое пишется в `windowHost` конфига пикера — по
# совпадению этих двух строк пикер решает, поднимать ли окно.
# Не задано — берётся у системы.
# windowHost: my-mac

# Bundle id приложений, чьи окна считаются терминалами.
terminals:
  - net.kovidgoyal.kitty
  - com.mitchellh.ghostty
  - com.googlecode.iterm2
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core 2>&1 | tail -6`
Expected: `test result: ok. 18 passed`.

- [ ] **Step 6: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add crates/mwm-core config.example.yml
git commit -m "feat(core): конфиг трекера с умолчаниями"
```

---

## Task 10: Приложение — слой Accessibility

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/ax.rs`
- Create: `src-tauri/src/main.rs` (заглушка, чтобы крейт собирался)

**Interfaces:**
- Consumes: `mwm_core::tracker::Seen` (Task 7).
- Produces:
  ```rust
  pub fn trusted() -> bool;             // выдано ли разрешение
  pub fn prompt_for_trust();            // показать системный запрос
  pub fn list_windows(bundle_ids: &[String]) -> Vec<Seen>;
  ```

- [ ] **Step 1: Завести крейт приложения**

`src-tauri/Cargo.toml`:

```toml
[package]
name = "macos-windows-manager"
version.workspace = true
edition.workspace = true

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
mwm-core = { path = "../crates/mwm-core" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2", features = ["tray-icon", "image-png"] }

# Accessibility: и перечисление окон, и (на следующем этапе) их подъём. Одно
# разрешение на оба дела, и потому один интерфейс: заголовки можно было бы
# брать через CGWindowList, но тот с macOS 10.15 требует Screen Recording —
# второе разрешение ради того же самого.
[target.'cfg(target_os = "macos")'.dependencies]
accessibility = "0.2"
accessibility-sys = "0.2"
core-foundation = "0.10"
objc2 = "0.6"
objc2-app-kit = { version = "0.3", features = ["NSWorkspace", "NSRunningApplication"] }
objc2-foundation = "0.3"
```

- [ ] **Step 2: Написать `ax.rs`**

```rust
//! Окна терминалов глазами Accessibility.
//!
//! Всё, что трогает macOS, живёт здесь и только здесь: остальная логика — в
//! `mwm-core`, и её тесты гоняются на любой машине. Этот модуль тестами не
//! покрыт намеренно — проверять его нечем, кроме той самой машины, на которой
//! он и работает.

use mwm_core::tracker::Seen;

#[cfg(target_os = "macos")]
mod imp {
    use super::Seen;
    // Обёртка `accessibility` поверх `accessibility-sys` берёт на себя ровно
    // то, ради чего пришлось бы писать свой тип: `AXUIElement` там —
    // полноценный CF-тип, а значит `Clone` считает ссылки, а `PartialEq` —
    // это `CFEqual`, то самое «то же самое окно», на котором стоит реестр.
    use accessibility::{AXAttribute, AXUIElement};
    use accessibility_sys::{kAXTrustedCheckOptionPrompt, AXIsProcessTrustedWithOptions};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use objc2_app_kit::NSWorkspace;

    /// Секунда на приложение — и это не перестраховка.
    ///
    /// Вызовы Accessibility синхронны и блокируются на неотвечающем
    /// приложении. Один подвисший терминал вешает весь такт, трекер молча
    /// перестаёт публиковать, а выглядит это как «менеджер умер».
    const MESSAGING_TIMEOUT_S: f32 = 1.0;

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) }
    }

    pub fn prompt_for_trust() {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let opts = CFDictionary::from_CFType_pairs(&[(key, CFType::from(CFBoolean::true_value()))]);
        unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef() as _) };
    }

    /// Кто есть кто между тактами.
    ///
    /// У окна macOS нет открытого стабильного номера: `AXUIElement` — ссылка, а
    /// не идентификатор, и порядок в `AXWindows` ничем не закреплён. Считать
    /// окно по порядковому номеру нельзя — перестановка выглядела бы сменой
    /// заголовка, и привязка сбрасывалась бы на ровном месте.
    ///
    /// Зато ссылки на одно и то же окно сравнимы: `CFEqual` отвечает «то же
    /// самое». Отсюда реестр: увидели впервые — выдали номер, увидели снова —
    /// нашли прежний. Частный `_AXUIElementGetWindow` дал бы номер сразу, но
    /// это непубличный интерфейс, а платить за него нечем: в публикуемом файле
    /// идентификатора окна нет вовсе, он нужен трекеру и никому больше.
    #[derive(Default)]
    pub struct Registry {
        known: Vec<(AXUIElement, u64)>,
        next: u64,
    }

    impl Registry {
        fn id_of(&mut self, el: &AXUIElement) -> u64 {
            if let Some((_, id)) = self.known.iter().find(|(k, _)| k == el) {
                return *id;
            }
            self.next += 1;
            self.known.push((el.clone(), self.next));
            self.next
        }

        /// Закрытые окна из реестра убираются: иначе он рос бы всю жизнь
        /// процесса, а сравнение с каждым его элементом — это и есть цена
        /// такта.
        fn retain_seen(&mut self, seen: &[AXUIElement]) {
            self.known.retain(|(k, _)| seen.iter().any(|s| s == k));
        }
    }

    /// Заголовки окон всех запущенных терминалов из списка.
    pub fn list_windows(reg: &mut Registry, bundle_ids: &[String]) -> Vec<Seen> {
        let mut out = Vec::new();
        let mut alive: Vec<AXUIElement> = Vec::new();
        let ws = unsafe { NSWorkspace::sharedWorkspace() };
        let apps = unsafe { ws.runningApplications() };
        let front_pid = unsafe { ws.frontmostApplication() }
            .map(|a| unsafe { a.processIdentifier() })
            .unwrap_or(-1);
        for app in apps.iter() {
            let Some(id) = (unsafe { app.bundleIdentifier() }) else { continue };
            let id = id.to_string();
            if !bundle_ids.iter().any(|b| b.eq_ignore_ascii_case(&id)) {
                continue;
            }
            let pid = unsafe { app.processIdentifier() };
            let el = AXUIElement::application(pid);
            let _ = el.set_messaging_timeout(MESSAGING_TIMEOUT_S);
            // Фронтовое окно спрашивается только у фронтового приложения:
            // у остальных ответ есть, но означает он «последнее активное здесь»,
            // а нам нужно «то, на которое человек смотрит сейчас».
            let focused_title = if pid == front_pid {
                el.attribute(&AXAttribute::focused_window())
                    .ok()
                    .and_then(|w| title_of(&w))
            } else {
                None
            };
            for w in windows_of(&el) {
                let Some(title) = title_of(&w) else { continue };
                if title.trim().is_empty() {
                    continue;
                }
                let id = reg.id_of(&w);
                alive.push(w);
                out.push(Seen {
                    id,
                    focused: focused_title.as_deref() == Some(title.as_str()),
                    title,
                });
            }
        }
        reg.retain_seen(&alive);
        out
    }

    /// Окна приложения. Отказ — пустой список, а не ошибка: приложение могло
    /// закрыться между перечислением и вопросом, и это норма такта, а не сбой.
    fn windows_of(app: &AXUIElement) -> Vec<AXUIElement> {
        match app.attribute(&AXAttribute::windows()) {
            Ok(arr) => arr.iter().map(|w| w.clone()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn title_of(w: &AXUIElement) -> Option<String> {
        w.attribute(&AXAttribute::title()).ok().map(|t| t.to_string())
    }
}

/// На не-macOS модуль отвечает пустотой: крейт должен собираться где угодно,
/// чтобы `cargo check` был доступен и не на маке.
#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Seen;
    #[derive(Default)]
    pub struct Registry;
    pub fn trusted() -> bool { false }
    pub fn prompt_for_trust() {}
    pub fn list_windows(_reg: &mut Registry, _bundle_ids: &[String]) -> Vec<Seen> { Vec::new() }
}

pub use imp::{list_windows, prompt_for_trust, trusted, Registry};
```

- [ ] **Step 3: Заглушка `main.rs`, чтобы крейт собирался**

```rust
mod ax;

fn main() {
    // Настоящее приложение собирается в задаче 13. Пока — точка входа, чтобы
    // крейт компилировался и `cargo check` ловил ошибки в слое Accessibility.
    println!("accessibility trusted: {}", ax::trusted());
}
```

- [ ] **Step 4: Проверить сборку**

Run: `cd ~/projects/js/macos-windows-manager && cargo check -p macos-windows-manager 2>&1 | tail -20`
Expected: на не-macOS соберётся ветка-заглушка. Ошибки Tauri-зависимостей на этой машине допустимы — тогда проверять `cargo check` уже на маке в задаче 15; в этом случае здесь достаточно `cargo check -p mwm-core`.

**Правки под настоящий API.** Сигнатуры `accessibility-sys` 0.2 и `objc2-app-kit` 0.3 могли разойтись с написанным. Смотреть `cargo doc -p accessibility-sys --open` и править **вызовы**, а не устройство модуля: граница «всё платформенное здесь, логика в `mwm-core`» задана спекой и переезду не подлежит.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add src-tauri
git commit -m "feat(app): перечисление окон терминалов через Accessibility"
```

---

## Task 11: Приложение — индекс сессий с машины агрегатора

**Files:**
- Create: `src-tauri/src/dump.rs`
- Create: `crates/mwm-core/src/index.rs`
- Modify: `crates/mwm-core/src/lib.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `title::strip_decoration` (Task 6), `Config` (Task 9).
- Produces:
  - `mwm_core::index::parse_index(json: &str) -> BTreeMap<String, String>` — «очищенный заголовок → id сессии».
  - `dump::fetch(ssh_host: &str) -> Result<String, String>` — сырой json дампа по ssh.
  - `dump::Cache` — обёртка со сроком годности; `Cache::get(&mut self, cfg, now_ms, want_refresh: bool) -> &BTreeMap<String, String>`.

- [ ] **Step 1: Написать падающий тест на разбор**

`crates/mwm-core/src/index.rs`:

```rust
//! Индекс «заголовок окна → id сессии» из дампа агрегатора.

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaa-1111-2222-3333-444444444444";
    const B: &str = "bbbbbbbb-1111-2222-3333-444444444444";

    #[test]
    fn titles_map_to_sessions() {
        let idx = parse_index(&format!(
            r#"{{"sessions":[{{"id":"{A}","title":"ccfzf"}},{{"id":"{B}","title":"other"}}]}}"#
        ));
        assert_eq!(idx.get("ccfzf"), Some(&A.to_string()));
        assert_eq!(idx.get("other"), Some(&B.to_string()));
    }

    #[test]
    fn title_is_stored_stripped() {
        // Сравнивать будут с заголовком окна, а он приезжает со значком
        // состояния. Чистить одну сторону — значит не сойтись с другой.
        let idx = parse_index(&format!(r#"{{"sessions":[{{"id":"{A}","title":"✳ ccfzf"}}]}}"#));
        assert_eq!(idx.get("ccfzf"), Some(&A.to_string()));
    }

    #[test]
    fn twins_go_to_the_livelier_one() {
        // Два заголовка-тёзки законны. Побеждает тот, у кого свежее активность:
        // иначе только что открытая сессия проигрывала бы суточной тёзке
        // навсегда.
        let idx = parse_index(&format!(
            r#"{{"sessions":[{{"id":"{A}","title":"ccfzf","activityAt":10}},
                             {{"id":"{B}","title":"ccfzf","activityAt":99}}]}}"#
        ));
        assert_eq!(idx.get("ccfzf"), Some(&B.to_string()));
    }

    #[test]
    fn garbage_costs_itself_and_nothing_more() {
        // Порченый дамп стоит индекса, а не запуска: без индекса привязка живёт
        // на прежних слотах, а без трекера не живёт ничего.
        assert!(parse_index("not json at all").is_empty());
        assert!(parse_index(r#"{"sessions":"nope"}"#).is_empty());
        let idx = parse_index(&format!(
            r#"{{"sessions":[{{"id":42}},{{"title":"x"}},{{"id":"{A}","title":"ok"}}]}}"#
        ));
        assert_eq!(idx.len(), 1);
    }
}
```

Дописать в `lib.rs`: `pub mod index;`

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core index 2>&1 | tail -8`
Expected: FAIL — `cannot find function parse_index`.

- [ ] **Step 3: Реализация разбора**

Дописать в начало `crates/mwm-core/src/index.rs`:

```rust
use crate::title::strip_decoration;
use std::collections::BTreeMap;

/// «Очищенный заголовок → id сессии» из дампа агрегатора.
///
/// Недоверие к содержимому то же, что у файла окон: запись без id или без
/// заголовка не значит ничего и выбрасывается молча. Порченый дамп стоит
/// индекса, а не запуска — без индекса привязка живёт на прежних слотах.
pub fn parse_index(json: &str) -> BTreeMap<String, String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return BTreeMap::new();
    };
    let mut out: BTreeMap<String, (String, f64)> = BTreeMap::new();
    for s in v.get("sessions").and_then(|s| s.as_array()).into_iter().flatten() {
        let (Some(id), Some(title)) = (
            s.get("id").and_then(|x| x.as_str()),
            s.get("title").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        let key = strip_decoration(title);
        if key.is_empty() || id.is_empty() {
            continue;
        }
        let activity = s.get("activityAt").and_then(|x| x.as_f64()).unwrap_or(0.0);
        // Тёзки: побеждает свежесть активности. Иначе только что открытая
        // сессия проигрывала бы суточной тёзке навсегда.
        match out.get(&key) {
            Some((_, prev)) if *prev >= activity => {}
            _ => {
                out.insert(key, (id.to_string(), activity));
            }
        }
    }
    out.into_iter().map(|(k, (id, _))| (k, id)).collect()
}
```

- [ ] **Step 4: Написать слой доставки**

`src-tauri/src/dump.rs`:

```rust
//! Дамп сессий с машины агрегатора.
//!
//! Ходим за ним по ssh и редко: заголовок меняется на каждый ответ агента, а
//! дамп и так отстаёт до тридцати секунд. Спрашивают его тогда, когда трекеру
//! попался незнакомый заголовок, и не чаще срока годности.

use mwm_core::config::Config;
use mwm_core::index::parse_index;
use std::collections::BTreeMap;
use std::process::Command;

/// Одно ssh-соединение на всё: мультиплексирование делает второй и третий
/// вызовы почти бесплатными, а без него каждый стоил бы рукопожатия.
fn ssh(host: &str, remote: &str) -> Result<String, String> {
    let out = Command::new("ssh")
        .args([
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=8",
            "-o", "ControlMaster=auto",
            "-o", "ControlPath=~/.ssh/mwm-%r@%h-%p",
            "-o", "ControlPersist=300",
            host, remote,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn fetch(ssh_host: &str) -> Result<String, String> {
    if ssh_host.trim().is_empty() {
        return Err("sshHost is not set".to_string());
    }
    ssh(ssh_host, "cat ~/.ccfzf.sessions.json")
}

/// Индекс со сроком годности.
#[derive(Default)]
pub struct Cache {
    index: BTreeMap<String, String>,
    fetched_ms: u64,
    pub last_error: Option<String>,
}

impl Cache {
    /// Отдать индекс, освежив его, если пора и если есть зачем.
    ///
    /// `wanted` — трекеру попался заголовок, которого в индексе нет. Без этого
    /// признака ходили бы каждые пятнадцать секунд впустую: у машины, где
    /// ничего не открывали, индекс не меняется часами.
    pub fn get(&mut self, cfg: &Config, now_ms: u64, wanted: bool) -> &BTreeMap<String, String> {
        let stale = now_ms.saturating_sub(self.fetched_ms) >= cfg.dump_cache_ms;
        if (wanted && stale) || self.fetched_ms == 0 {
            match fetch(&cfg.ssh_host) {
                Ok(text) => {
                    let idx = parse_index(&text);
                    // Пустой разбор прежний индекс не затирает: дамп мог не
                    // дочитаться, а привязка, живущая на прежних слотах, —
                    // единственное, что держит окна в списке до следующей
                    // удачи.
                    if !idx.is_empty() {
                        self.index = idx;
                    }
                    self.last_error = None;
                }
                Err(e) => self.last_error = Some(e),
            }
            self.fetched_ms = now_ms;
        }
        &self.index
    }
}
```

- [ ] **Step 5: Прогнать тесты и сборку**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p mwm-core 2>&1 | tail -6`
Expected: `test result: ok. 22 passed`.

Дописать в `src-tauri/src/main.rs`: `mod dump;`

- [ ] **Step 6: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add crates/mwm-core src-tauri
git commit -m "feat: индекс сессий из дампа агрегатора по ssh"
```

---

## Task 12: Приложение — доставка файла окон

**Files:**
- Create: `src-tauri/src/deliver.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `dump::ssh`-подобный вызов (Task 11), `mwm_core::publish::build_file` (Task 8).
- Produces: `deliver::send(cfg: &Config, payload: &serde_json::Value) -> Result<(), String>`.
  Модуль назван не `publish` намеренно: `mwm_core::publish` собирает файл, этот его везёт, и два одноимённых модуля в одном `main.rs` читались бы как один.

- [ ] **Step 1: Написать доставку**

`src-tauri/src/deliver.rs`:

```rust
//! Доставка файла окон на машину агрегатора.

use mwm_core::config::Config;
use std::io::Write;
use std::process::{Command, Stdio};

/// Положить файл рядом с чужими и подменить атомарно.
///
/// Временный файл и `mv` в том же каталоге — потому что читатель опрашивает
/// раз в секунду, и без атомарной подмены он рано или поздно прочитает
/// половину json. Половина json — это не «неполные данные», это исключение
/// вместо списка сессий у человека на экране.
///
/// Имя файла — имя машины: по нему и человек, и агрегатор понимают, чей это
/// файл, а два трекера с одним именем — это одна машина, дважды запущенная,
/// и второй экземпляр обязан перетереть первый, а не завести соседний файл.
///
/// `;` в удалённой команде не ставится: у Windows Terminal это разделитель
/// панелей. Здесь та сторона не Windows, но правило связки одно на все
/// удалённые команды, и исключение из него пришлось бы помнить.
pub fn send(cfg: &Config, payload: &serde_json::Value) -> Result<(), String> {
    if cfg.ssh_host.trim().is_empty() {
        return Err("sshHost is not set".to_string());
    }
    let dir = &cfg.remote_dir;
    let name = safe_name(&cfg.host);
    let remote = format!(
        "mkdir -p {dir} && cat > {dir}/{name}.json.tmp && mv {dir}/{name}.json.tmp {dir}/{name}.json"
    );
    let mut child = Command::new("ssh")
        .args([
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=8",
            "-o", "ControlMaster=auto",
            "-o", "ControlPath=~/.ssh/mwm-%r@%h-%p",
            "-o", "ControlPersist=300",
            &cfg.ssh_host, &remote,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(payload.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Имя машины в имени файла: буквы, цифры, точка, дефис — и ничего больше.
///
/// Строка едет в команду чужого шелла, и кавычить её было бы половиной защиты:
/// hostname с пробелом или кавычкой законен, а команда от него разваливается.
fn safe_name(host: &str) -> String {
    let s: String = host
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '-' })
        .collect();
    if s.is_empty() { "unnamed".to_string() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_becomes_a_safe_file_name() {
        // Строка едет в команду чужого шелла. Пробел или кавычка в имени
        // машины законны, а команда от них разваливается.
        assert_eq!(safe_name("my-mac.local"), "my-mac.local");
        assert_eq!(safe_name("my mac; rm -rf /"), "my-mac--rm--rf--");
        assert_eq!(safe_name("   "), "unnamed");
    }
}
```

- [ ] **Step 2: Прогнать тест**

Run: `cd ~/projects/js/macos-windows-manager && cargo test -p macos-windows-manager deliver 2>&1 | tail -6`
Expected: PASS. Если крейт приложения на этой машине не собирается из-за Tauri — перенести `safe_name` и его тест в `mwm-core/src/publish.rs` и звать оттуда.

- [ ] **Step 3: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add src-tauri
git commit -m "feat(app): доставка файла окон на машину агрегатора"
```

---

## Task 13: Приложение — трей, поток трекера, разрешение

**Files:**
- Modify: `src-tauri/src/main.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/icons/icon.png`

**Interfaces:**
- Consumes: всё из задач 6–12.
- Produces: работающее приложение. Меню трея: строка состояния, `Grant Accessibility…`, `Quit`.

- [ ] **Step 1: Конфиг Tauri и сборка**

`src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "macos-windows-manager",
  "version": "0.1.0",
  "identifier": "pro.popstas.macos-windows-manager",
  "build": { "frontendDist": "../frontend" },
  "app": {
    "windows": [],
    "macOSPrivateApi": false,
    "trayIcon": { "iconPath": "icons/icon.png", "iconAsTemplate": true }
  },
  "bundle": {
    "active": true,
    "targets": ["app"],
    "icon": ["icons/icon.png"]
  }
}
```

```bash
cd ~/projects/js/macos-windows-manager
mkdir -p frontend src-tauri/icons
printf '<!doctype html><title>macos-windows-manager</title>' > frontend/index.html
python3 -c "
import struct, zlib, pathlib
w = h = 32
raw = b''.join(b'\x00' + b'\x00\x00\x00\xff' * w for _ in range(h))
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c))
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw))
       + chunk(b'IEND', b''))
pathlib.Path('src-tauri/icons/icon.png').write_bytes(png)
"
```

- [ ] **Step 2: Написать `main.rs`**

```rust
//! Оконный трекер claude-wt для macOS.
//!
//! Окна у приложения нет — только значок в трее. Работа идёт в отдельном
//! потоке: у Tauri главный поток занят циклом событий, и такт трекера, встав в
//! него, отнял бы у меню отзывчивость.

mod ax;
mod deliver;
mod dump;

use mwm_core::config::{config_path, parse_config, Config};
use mwm_core::publish::{build_file, fingerprint, should_write};
use mwm_core::tracker::Tracker;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

/// Что показывать человеку в трее. Английский — правило проекта: всё, что
/// видит человек, по-английски.
#[derive(Clone)]
struct Status(Arc<Mutex<String>>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn load_config() -> Config {
    let home = std::env::var("HOME").unwrap_or_default();
    let text = std::fs::read_to_string(config_path(&home)).unwrap_or_default();
    let hostname = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    parse_config(&text, &hostname)
}

/// Такт трекера.
///
/// Разрешение проверяется на каждом обороте, а не однажды при старте: человек
/// выдаёт его в System Settings уже после запуска, и приложение обязано
/// заработать без перезапуска.
///
/// Без разрешения файл не пишется вовсе. Пустой файл означал бы «окон нет» и
/// погасил бы чужие пометки; прежний протухнет у читателя сам, и это правда.
fn run_tracker(status: Status) {
    let cfg = load_config();
    let mut tracker = Tracker::new(2);
    let mut registry = ax::Registry::default();
    let mut cache = dump::Cache::default();
    let mut last_print: Option<String> = None;
    let mut last_write_ms = 0u64;
    let pid = std::process::id();
    loop {
        std::thread::sleep(Duration::from_millis(cfg.tick_ms));
        if !ax::trusted() {
            *status.0.lock().unwrap() = "Accessibility not granted".to_string();
            continue;
        }
        let now = now_ms();
        let seen = ax::list_windows(&mut registry, &cfg.terminals);
        // Список незнакомых заголовков — с прошлого такта, и это правильно:
        // за дампом идут до тика, а узнают о незнакомом заголовке из него.
        // Отставание в один такт стоит секунды, а спрашивать дважды за оборот
        // стоило бы второго ssh.
        let wanted = !tracker.unresolved().is_empty();
        let index = cache.get(&cfg, now, wanted).clone();
        tracker.tick(&seen, &index, now);
        let bound = tracker.bound();
        let print = fingerprint(&bound);
        if should_write(&print, last_print.as_deref(), last_write_ms, now) {
            let payload = build_file(&bound, &cfg.host, pid, now, false);
            match deliver::send(&cfg, &payload) {
                Ok(()) => {
                    last_print = Some(print);
                    last_write_ms = now;
                    *status.0.lock().unwrap() = format!("{} windows tracked", bound.len());
                }
                // Ничего не копится: следующая посылка везёт текущее состояние
                // целиком, а протухший файл читатель отбрасывает сам.
                Err(e) => *status.0.lock().unwrap() = format!("publish failed: {e}"),
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let status = Status(Arc::new(Mutex::new("starting…".to_string())));
            let state = MenuItem::with_id(app, "status", "starting…", false, None::<&str>)?;
            let grant = MenuItem::with_id(app, "grant", "Grant Accessibility…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&state, &grant, &quit])?;
            TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().cloned().unwrap())
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "grant" => ax::prompt_for_trust(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let worker = status.clone();
            std::thread::spawn(move || run_tracker(worker));

            // Строка состояния обновляется своим тиком: лезть в меню из потока
            // трекера нельзя — пункты меню живут на главном потоке.
            let painter = status.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let text = painter.0.lock().unwrap().clone();
                let _ = handle.run_on_main_thread({
                    let state = state.clone();
                    move || { let _ = state.set_text(&text); }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Проверить сборку**

Run: `cd ~/projects/js/macos-windows-manager && cargo check 2>&1 | tail -20`
Expected: собирается. На не-macOS ветка `ax` — заглушка; ошибки Tauri-зависимостей на этой машине означают, что проверка переезжает в задачу 15, на мак.

- [ ] **Step 4: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add .
git commit -m "feat(app): трей, поток трекера и запрос разрешения"
```

---

## Task 14: Выкатка — скрипт, автозапуск, документация

**Files:**
- Create: `~/projects/js/macos-windows-manager/data/scripts/deploy-mac.sh` (каталог под `.gitignore`)
- Create: `~/projects/js/macos-windows-manager/docs/launchagent.md`
- Modify: `~/projects/js/macos-windows-manager/README.md`

**Interfaces:**
- Consumes: собранное приложение (Task 13).
- Produces: `./data/scripts/deploy-mac.sh [--no-build] [--no-launch]`.

- [ ] **Step 1: Написать скрипт выкатки**

`data/scripts/deploy-mac.sh` (каталог `data/` не публикуется — он знает имена машин и пути этой установки, а не проекта):

```bash
#!/usr/bin/env bash
# Выкатка на мак. Первым шагом — git pull на той стороне: выкатывается
# запушенное, а не то, что лежит в рабочем каталоге.
set -euo pipefail

HOST="${MWM_HOST:?set MWM_HOST to the mac ssh host}"
DIR="${MWM_DIR:-~/projects/js/macos-windows-manager}"
BUILD=1
LAUNCH=1
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --no-launch) LAUNCH=0 ;;
  esac
done

run() { ssh -o BatchMode=yes "$HOST" "\$SHELL -lc '$1'"; }

run "cd $DIR && git pull --ff-only"
if ((BUILD)); then
  run "cd $DIR && cargo build --release"
fi
# Приложение держит своё имя в списке процессов, а линковщик не пишет в файл
# работающего бинаря. Снимаем перед подъёмом, а не после сборки: пока сборка
# идёт, прежний экземпляр продолжает публиковать окна.
run "pkill -x macos-windows-manager || true"
if ((LAUNCH)); then
  run "cd $DIR && nohup ./target/release/macos-windows-manager >/dev/null 2>&1 &"
fi
echo "deployed to $HOST"
```

```bash
chmod +x ~/projects/js/macos-windows-manager/data/scripts/deploy-mac.sh
```

- [ ] **Step 2: Описать автозапуск**

`docs/launchagent.md`:

```markdown
# Автозапуск

`~/Library/LaunchAgents/pro.popstas.macos-windows-manager.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>pro.popstas.macos-windows-manager</string>
  <key>ProgramArguments</key>
  <array><string>/Users/USER/projects/js/macos-windows-manager/target/release/macos-windows-manager</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```
launchctl load -w ~/Library/LaunchAgents/pro.popstas.macos-windows-manager.plist
```

Разрешение Accessibility выдаётся **этому бинарю**, а не терминалу, из которого
его запустили. После пересборки путь тот же, и разрешение переживает выкатку;
после переезда каталога — не переживает, и его придётся выдать заново.
```

- [ ] **Step 3: Дописать README**

Добавить раздел:

```markdown
## Выкатка

```
MWM_HOST=<ssh host> ./data/scripts/deploy-mac.sh
MWM_HOST=<ssh host> ./data/scripts/deploy-mac.sh --no-build   # только перезапустить
```

Разово на маке: `rustup`, разрешение Accessibility, LaunchAgent (см.
`docs/launchagent.md`).

## Проверка, что доехало

На машине агрегатора:

```
python3 -c "import json,time;o=json.load(open('$HOME/.ccfzf/windows/<host>.json'));print(time.time()-o['generated'],len(o['windows']))"
```

Первое число меньше тридцати — трекер публикует. Второе — сколько окон он
видит.
```

- [ ] **Step 4: Коммит**

```bash
cd ~/projects/js/macos-windows-manager
git add README.md docs/launchagent.md
git commit -m "docs: выкатка на мак и автозапуск"
```

---

## Task 15: Деплой на mac и проверка связки целиком

Отдельной задачей, а не строчкой внутри предыдущей: код лежит на одной машине,
а работает на другой, и до выкатки правка не проверена ничем, кроме тестов.
Деплой этой связки уже врал молча не один раз, и «скрипт отработал» здесь не
значит «правка на месте».

**Files:** правок нет; при находках — точечные, каждая своим коммитом.

- [ ] **Step 1: Поднять Rust на маке**

```bash
ssh <mac host> '$SHELL -lc "curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"'
ssh <mac host> '$SHELL -lc "rustc --version"'
```
Expected: печатает версию. Rust на маке до этого не стоял вовсе.

- [ ] **Step 2: Выкатить агрегатор и пикер**

Агрегатор живёт на той же машине, где идёт разработка, — выкатывать нечего,
достаточно убедиться, что в `~/bin/ccfzf` лежит новая версия:

```bash
./ccfzf --state | python3 -c 'import json,sys; print(json.load(sys.stdin)["windowHosts"])'
```

Пикер на Windows-машине:

```bash
cd ~/projects/js/ccfzf-picker && git push && ./data/scripts/deploy-win.sh
```

- [ ] **Step 3: Выкатить менеджер на мак**

```bash
cd ~/projects/js/macos-windows-manager && git push
MWM_HOST=<mac host> ./data/scripts/deploy-mac.sh
```

- [ ] **Step 4: Выдать разрешение и убедиться, что трекер публикует**

Разрешение выдаётся руками: System Settings → Privacy & Security →
Accessibility → добавить бинарь. Затем на машине агрегатора:

```bash
ls -la ~/.ccfzf/windows/
python3 -c "import json,time,glob;[print(p, round(time.time()-json.load(open(p))['generated']), len(json.load(open(p))['windows'])) for p in glob.glob('$HOME/.ccfzf/windows/*.json')]"
```
Expected: файл мака есть, возраст меньше тридцати секунд, число окон совпадает
с числом открытых окон терминалов на маке.

- [ ] **Step 5: Проверить пикер на маке**

Прописать в `~/.config/ccfzf-picker/config.yaml` на маке `windowHost` — то же
имя, что менеджер положил в имя своего файла. Перезапустить пикер, открыть.

Expected:
- У сессий, открытых с мака, появилась пометка ▣.
- Чекбокс `only windowed` оставляет ровно эти строки.
- Enter на строке с окном мака **по-прежнему открывает терминал**, а не молчит:
  подъём — этап 2, и трекер честно объявил, что не умеет.
- В статуслайне нет заметки про чужой `windowHost`.
- Подсказки `^S - snapshots` на маке нет — режим снимков живёт на машине,
  чей трекер умеет поднимать окна.

- [ ] **Step 6: Проверить, что Windows-пикер не изменился**

Expected: список тот же, пометки на месте, Enter поднимает окно, `^S` работает,
проектные хоткеи зарегистрированы (в статуслайне нет жалоб на занятые
комбинации сверх прежних).

- [ ] **Step 7: Записать цену, если что-то нашлось**

Всё, что пришлось чинить на живой машине, дописать в `README.md` нового
репозитория разделом «Правила, за которые уже заплачено» — то же место и та же
форма, что в соседних проектах связки. Найденное на выкатке дороже найденного в
тестах, и терять его нельзя.

---

## Что этот план намеренно не делает

- **Не переносит Windows-трекер в каталог.** Он продолжает писать свой
  единственный файл, и тот читается первым источником. Переезд — отдельная
  правка в другом репозитории, и делать её заодно значило бы проверять две
  вещи одним запуском.
- **Не поднимает окна.** Мак объявляет `focus: false`, и пикер честно
  оставляет Enter на открытии терминала. Это этап 2.
- **Не трогает Spaces, геометрию и снимки.** Первого у macOS нет, второе и
  третье — этап 3.
