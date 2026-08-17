# Сессия на двух машинах: оба окна в строке — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сессия, открытая на двух машинах, показана одной строкой, которая
называет оба окна, не мигает между машинами и по Enter поднимает окно той
машины, где стоит человек.

**Architecture:** Агрегатор перестаёт выбрасывать проигравшую запись окна:
`windows[sid]` становится списком, отсортированным по свежести взгляда
(`focusedAt`), а поле `window` остаётся и равно первому — ради пикеров прошлой
версии. Пикер читает список через новую `windowsOf()` (она же понимает старый
ответ), рисует глиф на окно и имена чужих машин, ищет своё окно среди всех и
отматывает «просмотрено» у каждого трекера.

**Tech Stack:** python 3 (агрегатор `ccfzf` — один heredoc-блок внутри
bash-скрипта, тесты — самостоятельные скрипты в `tests/`), ES5-совместимый JS
без сборки (`frontend-src/`, UMD-шим), node:test (`npm test`), Rust + Tauri 2
(`src-tauri`, `cargo test`).

**Spec:** [docs/superpowers/specs/2026-08-18-session-on-two-hosts-design.md](../specs/2026-08-18-session-on-two-hosts-design.md)

## Global Constraints

- **Два репозитория, два git.** Задачи 1–2 правят `~/projects/shell/ccfzf`,
  задачи 3–8 — текущий репозиторий. Коммит делается в том репозитории, где
  лежит правка; `cd` в каждой команде указан явно.
- **Порядок обязателен:** агрегатор раньше пикера. Пикеру нечего читать, пока
  списка окон нет в ответе.
- **Язык.** Всё, что видит человек, — по-английски; комментарии,
  doc-комментарии, названия тестов и сообщения в `assert` — по-русски.
- **Имена машин в репозиторий не возвращать.** В тестах — только выдуманные
  (`windows-box`, `mac-host`), как уже принято в обоих репозиториях. Сторож —
  `test/no-private-data.test.js`.
- **Тесты пикера гоняются только через `npm test`.** `node --test test/` на
  этих версиях Node не работает.
- **Тесты агрегатора — самостоятельные скрипты:** `python3 tests/<файл>.py`,
  общего раннера нет, pytest не установлен.
- **Отсутствие поля и пустое значение неразличимы** для читателя окна: «окна
  нет» и «про окна ничего не известно» рисуются одинаково, и разницы между
  ними не заводится.

---

### Task 1: Агрегатор хранит все окна сессии, а не победителя гонки

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf:635-688` (`read_window_sources`)
- Modify: `~/projects/shell/ccfzf/tests/test_windows_merge.py` (существующие
  проверки читают запись как словарь — станут читать первую из списка)
- Test: `~/projects/shell/ccfzf/tests/test_windows_merge.py`

**Interfaces:**
- Consumes: `read_windows(path, now)` — уже есть, возвращает
  `(windows, host, pid, snapshots, projects, focus, open_session, mqtt_base)`,
  где `windows` — словарь `sid → {"title", "desktop", "lastSeen", "focusedAt", "app"}`.
- Produces: `sort_windows(recs) -> list` и `read_window_sources(...)`, первый
  элемент кортежа которого теперь `dict[str, list[dict]]` вместо
  `dict[str, dict]`. Каждая запись по-прежнему дополнена `host`, `pid`,
  `canFocus`, `mqttBase`.

- [ ] **Step 1: Написать падающий тест на порядок**

В `tests/test_windows_merge.py` после `test_windows_from_two_trackers_land_in_one_map`:

```python
def test_two_windows_of_one_session_are_kept_newest_look_first():
    # Ровно нынешняя гонка, записанная тестом: у windows-box запись свежее по
    # `lastSeen` (его демон тикнул только что), но на окно ни разу не смотрели;
    # у mac-host тик старее, а взгляд был. Побеждает взгляд — он отметка
    # человека, а `lastSeen` отметка трекера.
    windows, _, _, _, _, _ = _merge(
        legacy=_file("windows-box", {UUID_A: dict(_win("ccfzf", NOW - 2), focusedAt=0)}),
        dir_files={"mac.json": _file(
            "mac-host", {UUID_A: dict(_win("ccfzf", NOW - 40), focusedAt=NOW - 60)})},
    )
    assert [w["host"] for w in windows[UUID_A]] == ["mac-host", "windows-box"], windows[UUID_A]


def test_windows_order_is_stable_when_keys_are_equal():
    # На два окна, на которые не смотрели ни разу и чьи трекеры тикнули в одну
    # секунду, первых двух ключей не хватает. Без третьего порядок зависел бы
    # от порядка чтения файлов, а читатель перерисовывает список раз в секунду —
    # дрожь была бы видна глазом.
    windows, _, _, _, _, _ = _merge(
        legacy=_file("zeta-box", {UUID_A: _win("ccfzf")}),
        dir_files={"alpha.json": _file("alpha-box", {UUID_A: _win("ccfzf")})},
    )
    assert [w["host"] for w in windows[UUID_A]] == ["alpha-box", "zeta-box"], windows[UUID_A]
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_windows_merge.py`
Expected: FAIL — `TypeError: list indices must be integers` либо
`AssertionError` с записью-словарём вместо списка (сегодня в словаре остаётся
одна запись, выигравшая по `lastSeen`, то есть `windows-box`).

- [ ] **Step 3: Завести `sort_windows`**

Рядом с `read_window_sources` (перед ней), `~/projects/shell/ccfzf/ccfzf`:

```python
def sort_windows(recs):
    """Окна одной сессии: свежайший взгляд первым.

    `focusedAt` — отметка человека («перевёл взгляд на окно»), `lastSeen` —
    отметка трекера («видел окно на своём тике»). Вторая и есть источник
    гонки: у одного трекера она растёт раз в секунду, у другого раз в
    тридцать, и первым по ней оказывается то одно окно, то другое.

    Имя машины третьим ключом — ради устойчивости, а не красоты: у двух окон,
    на которые ни разу не смотрели, первые два ключа равны, а читатель
    перерисовывает список раз в секунду.
    """
    return sorted(recs, key=lambda r: (-num(r.get("focusedAt")),
                                       -num(r.get("lastSeen")),
                                       str(r.get("host") or "").lower()))
```

- [ ] **Step 4: Складывать записи в список**

В `read_window_sources` заменить хвост цикла (строки с `prev`) на накопление,
а после цикла — отсортировать:

```python
        for sid, rec in w.items():
            windows.setdefault(sid, []).append(
                dict(rec, host=host, pid=pid, canFocus=focus, mqttBase=mqtt_base))
    windows = {sid: sort_windows(recs) for sid, recs in windows.items()}
    host, pid, projects = lead if lead else ("", 0, [])
    return windows, host, pid, snaps, projects, hosts
```

В docstring той же функции заменить абзац про спор трекеров:

```
    Одну сессию могут показывать два трекера (её терминал открыт с обеих
    машин), и это не ошибка: работали на одной машине, продолжили на другой.
    Обе записи остаются — `windows[sid]` список, — а порядок задаёт
    `sort_windows`: свежайший взгляд первым. Прежде запись с меньшим
    `lastSeen` выбрасывалась, и читатель видел то одно окно, то другое.
```

- [ ] **Step 5: Поправить существующие проверки того же файла**

В `tests/test_windows_merge.py` записи `read_window_sources` читаются как
словари — теперь это первый элемент списка. Строки 64, 65, 66, 76, 77, 88,
140, 167, 168: `windows[UUID_A]["host"]` → `windows[UUID_A][0]["host"]` и так
далее. Тесты `tests/test_windows_file.py` не трогать: они зовут `read_windows`,
у которой формат не менялся.

- [ ] **Step 6: Прогнать все тесты агрегатора**

Run:
```bash
cd ~/projects/shell/ccfzf && for f in tests/test_*.py; do python3 "$f" >/dev/null && echo "ok $f" || echo "FAIL $f"; done
```
Expected: все `ok`. `test_state_mode.py` тоже зелёный: `live |= set(windows)`
читает ключи, а они не менялись.

- [ ] **Step 7: Коммит**

```bash
cd ~/projects/shell/ccfzf && git add ccfzf tests/test_windows_merge.py
git commit -m "fix(windows): окна одной сессии больше не вытесняют друг друга

Сессию открывают на двух машинах, и записи было две, а доезжала одна: словарь
хранил победителя по lastSeen. Победитель менялся от опроса к опросу, потому
что трекеры тикают с разной частотой.

Теперь windows[sid] — список, порядок задаёт sort_windows: свежайший взгляд
первым, при равных lastSeen, при равных имя машины."
```

---

### Task 2: `--state` отдаёт список окон рядом с прежним полем

**Files:**
- Modify: `~/projects/shell/ccfzf/ccfzf:2070-2079` (сборка сессии в режиме `state`)
- Modify: `~/projects/shell/ccfzf/tests/test_state_mode.py` (`run_state` учится
  принимать переменные окружения)
- Test: `~/projects/shell/ccfzf/tests/test_state_mode.py`

**Interfaces:**
- Consumes: `read_window_sources` из Task 1 — `windows[sid]` список.
- Produces: у сессии в ответе `--state` поля `window` (первое окно или `None`)
  и `windows` (список или `None`). Их читает пикер, задачи 3–7.

- [ ] **Step 1: Написать падающий тест**

В `tests/test_state_mode.py` — сперва дать `run_state` необязательный
`env_extra`, потому что путь к файлу окон задаётся переменной окружения
(`CCFZF_WINDOWS_FILE`), а не argv:

```python
def run_state(tmp, dump_path, *extra, env_extra=None):
    env = dict(os.environ)
    env.update(_facts_env(tmp, dump_path))
    env.update(env_extra or {})
    r = subprocess.run(["bash", SRC, "--state", *extra],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, (r.returncode, r.stderr)
    return json.loads(r.stdout)
```

Дальше сам тест:

```python
def test_state_reports_every_window_and_names_the_first_one():
    # Сессия открыта на двух машинах. Список отдаётся целиком, а `window`
    # остаётся и равно первому: его читает пикер прошлой версии, и он обязан
    # продолжать работать.
    with tempfile.TemporaryDirectory() as tmp:
        sid = "aaaaaaaa-1111-2222-3333-444444444444"
        build_home(tmp, [sid])
        wdir = os.path.join(tmp, "windows")
        os.makedirs(wdir)
        now = int(time.time())
        for name, host, focused in (("a.json", "windows-box", 0),
                                    ("b.json", "mac-host", now - 30)):
            with open(os.path.join(wdir, name), "w", encoding="utf-8") as fh:
                json.dump({"generated": now, "host": host, "pid": 42, "windows": {
                    sid: {"title": "ccfzf", "desktop": None,
                          "lastSeen": now - 1, "focusedAt": focused}}}, fh)
        out = run_state(tmp, os.path.join(tmp, "dump.json"),
                        env_extra={"CCFZF_WINDOWS_DIR": wdir, "CCFZF_WINDOWS_FILE": ""})
        row = [s for s in out["sessions"] if s["id"] == sid][0]
        assert [w["host"] for w in row["windows"]] == ["mac-host", "windows-box"], row["windows"]
        assert row["window"] == row["windows"][0], row["window"]
```

Наверху файла добавить `import time`, если его там нет.

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_state_mode.py`
Expected: FAIL — `KeyError: 'windows'` у строки сессии.

- [ ] **Step 3: Отдать оба поля**

В сборке сессии (`ccfzf`, режим `state`) заменить одну строку `"window"` на пару.
Перед `sessions.append(...)` уже есть `sid = sid_of(path)`, поэтому:

```python
        wins = windows.get(sid)
        sessions.append({
            ...
            # Отсутствует, а не null: «окна нет» и «про окна ничего не известно»
            # у читателя рисуются одинаково, и заводить между ними разницу
            # некому — она не видна ни в одной строке списка.
            #
            # Полей два, и второе не дубль. `windows` — все окна сессии: её
            # открывают и на двух машинах сразу. `window` — первое из них, и
            # живёт оно ради читателя прошлой версии: пикер и агрегатор
            # выкатываются порознь, порядок нам не подвластен.
            "window": wins[0] if wins else None,
            "windows": wins,
        })
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd ~/projects/shell/ccfzf && python3 tests/test_state_mode.py && python3 tests/test_dump_shape.py`
Expected: PASS. `test_dump_shape.py` сторожит, что в дамп лишние поля не
попадают, — `windows` там не должно появиться, оно не в `DUMP_KEEP`.

- [ ] **Step 5: Коммит**

```bash
cd ~/projects/shell/ccfzf && git add ccfzf tests/test_state_mode.py
git commit -m "feat(state): у сессии есть список окон, а не одно

windows — все окна сессии, window — первое из них. Второе поле оставлено ради
пикера прошлой версии: он и агрегатор выкатываются порознь."
```

---

### Task 3: `windowsOf` в пикере, и старый ответ понимается по-прежнему

**Files:**
- Modify: `frontend-src/session-windows.js:36-42`
- Test: `test/session-windows.test.js`

**Interfaces:**
- Consumes: поля `row.windows` / `row.window` и верхние `state.windowHost`,
  `state.windowPid` — Task 2 и старый ответ.
- Produces: `windowsOf(row, state) -> Array<window>` (пустой массив, если окон
  нет) в экспорте `SessionWindows`; `windowOf(row, state)` остаётся и
  становится первым элементом.

- [ ] **Step 1: Написать падающий тест**

В `test/session-windows.test.js`:

```js
test('windowsOf отдаёт все окна строки в порядке ответа', () => {
  const row = { windows: [{ host: 'mac-host', app: 'kitty' }, { host: 'windows-box' }] };
  assert.deepStrictEqual(windowsOf(row, {}).map(w => w.host), ['mac-host', 'windows-box']);
});

test('старый ответ понимается: одно окно становится списком из одного', () => {
  // Пикер новее агрегатора обязан вести себя как прежде, а не гасить пометки:
  // выкатываются они порознь, и порядок нам не подвластен.
  const row = { window: { host: 'mac-host' } };
  assert.deepStrictEqual(windowsOf(row, {}).map(w => w.host), ['mac-host']);
});

test('совсем старый ответ: машину называют верхние поля', () => {
  const row = { window: { title: 'ccfzf' } };
  const state = { windowHost: 'windows-box', windowPid: 7 };
  assert.deepStrictEqual(windowsOf(row, state).map(w => w.host), ['windows-box']);
  assert.strictEqual(windowsOf(row, state)[0].pid, 7);
});

test('строка без окон даёт пустой список, а windowOf — null', () => {
  assert.deepStrictEqual(windowsOf({}, {}), []);
  assert.strictEqual(windowOf({}, {}), null);
});
```

Дополнить импорт наверху файла: `windowsOf` и `windowOf` в списке из
`SessionWindows`.

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test 2>&1 | grep -E "windowsOf|^# fail"`
Expected: FAIL — `windowsOf is not a function`.

- [ ] **Step 3: Реализовать**

В `frontend-src/session-windows.js` заменить `windowOf` на пару. Doc-комментарий
у `windowOf` переезжает к `windowsOf` — развилку про старый ответ разбирает
теперь она:

```js
  /**
   * Окна строки, дополненные сведениями о машине.
   *
   * Окон у сессии бывает больше одного: её открывают на двух машинах сразу —
   * работали на одной, продолжили на другой. Агрегатор отдаёт их списком, в
   * порядке «свежайший взгляд первым».
   *
   * Две ветви совместимости, и обе обязательны: пикер и агрегатор
   * выкатываются порознь, а пикер новее агрегатора обязан вести себя как
   * прежде, а не гасить пометки. Старый ответ несёт одно `window` — из него
   * выходит список на одного; совсем старый не кладёт машину и в него, и
   * тогда её называют верхние поля ответа: там ровно один трекер, и все окна
   * его.
   */
  function windowsOf(row, state) {
    const r = row || {};
    if (Array.isArray(r.windows) && r.windows.length) return r.windows;
    const w = r.window;
    if (!w) return [];
    if (normHost(w.host)) return [w];
    const s = state || {};
    return [{ ...w, host: s.windowHost, pid: s.windowPid, canFocus: true }];
  }

  /** Первое окно строки — то, которое агрегатор назвал главным. */
  function windowOf(row, state) {
    return windowsOf(row, state)[0] || null;
  }
```

Добавить `windowsOf` в объект экспорта в конце файла (рядом с `windowOf`).

- [ ] **Step 4: Прогнать тесты**

Run: `npm test 2>&1 | tail -5`
Expected: 0 fail. Остальные сторожа `session-windows` зелёные: `canFocusRow`,
`mqttBaseFor` и `trackerHosts` ходят через `windowOf`, а она отвечает то же.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-windows.js test/session-windows.test.js
git commit -m "feat(picker): окон у строки может быть несколько"
```

---

### Task 4: Строка несёт список окон, чужие машины и максимум `focusedAt`

**Files:**
- Modify: `frontend-src/session-list.js:36-43` (`foreignHost`), `:68`
  (`focusedAt`), `:103` (`windowHost` в строке)
- Test: `test/session-list.test.js`

**Interfaces:**
- Consumes: `windowsOf` из Task 3.
- Produces: у строки списка поля `windows: Array` (все окна, готовые к
  отрисовке), `windowHost: string` (имена **чужих** машин через `', '`, пусто —
  все свои), `focusedAt: number` (максимум по своей отметке и всем окнам).

- [ ] **Step 1: Написать падающий тест**

В `test/session-list.test.js`:

```js
test('строка несёт все окна, а чужие машины названы через запятую', () => {
  const state = { sessions: [] };
  const [row] = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [
      { host: 'mac-host', app: 'kitty', focusedAt: 0 },
      { host: 'windows-box', app: 'WindowsTerminal.exe', focusedAt: 0 },
    ] }],
    seen: {}, state, configHost: 'windows-box',
  });
  assert.deepStrictEqual(row.windows.map(w => w.host), ['mac-host', 'windows-box']);
  // Своя машина по-прежнему названа пустотой: имя пикера в каждой строке шум.
  assert.strictEqual(row.windowHost, 'mac-host');
});

test('отметка «просмотрено» складывается по всем окнам, а не по первому', () => {
  // Смотрели на сессию, а не на окно: взгляд на любое из её окон гасит зов.
  const [row] = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [
      { host: 'mac-host', focusedAt: 10 },
      { host: 'windows-box', focusedAt: 900 },
    ] }],
    seen: {}, state: { sessions: [] }, configHost: 'mac-host',
  });
  assert.strictEqual(row.focusedAt, 900);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test 2>&1 | grep -E "все окна|складывается|^# fail"`
Expected: FAIL — `row.windows` не определено, `row.focusedAt` равен нулю.

- [ ] **Step 3: Реализовать**

`frontend-src/session-list.js`, заменить `foreignHost` на список:

```js
  /**
   * Имена машин чужих окон этой строки.
   *
   * Своё имя тут шум: у большинства строк окно там же, где пикер, и колонка из
   * повторяющегося имени машины не сообщала бы ничего. Окон бывает несколько,
   * и тогда названы все чужие — а то, что среди них есть и своё, видно по
   * лишнему глифу рядом.
   *
   * Наружу — имя как его написал трекер, а не приведённое к нижнему регистру:
   * сравнивают машины без учёта регистра, а показывают как есть.
   */
  function foreignHosts(s, state, configHost) {
    const mine = windowApi.normHost(configHost);
    const out = [];
    for (const w of windowApi.windowsOf(s, state)) {
      const host = windowApi.normHost(w.host);
      if (!host || host === mine) continue;
      const named = String(w.host).trim();
      if (!out.includes(named)) out.push(named);
    }
    return out;
  }
```

В сборке строки: `focusedAt` считается по всем окнам, добавляется `windows`,
`windowHost` склеивается:

```js
        const wins = windowApi.windowsOf(s, state);
        const focusedAt = Math.max(
          marks[s.id] || 0,
          ...wins.map(w => (w || {}).focusedAt || 0),
          0,
        );
```

```js
          window: s.window || null,
          // Все окна сессии: её открывают и на двух машинах сразу. Список
          // приезжает готовым от агрегатора, порядок — «свежайший взгляд
          // первым», и здесь он не пересчитывается.
          windows: wins,
          windowHost: foreignHosts(s, state, configHost).join(', '),
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test 2>&1 | tail -5`
Expected: 0 fail. `test/row-contract.test.js` считает поля строки по её
потребителям — новое поле `windows` производится здесь же, так что правки не
требует.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-list.js test/session-list.test.js
git commit -m "feat(picker): строка знает все окна сессии и все взгляды на них"
```

---

### Task 5: Глиф на каждое окно, подсказка называет их поимённо

**Files:**
- Modify: `frontend-src/session-glyph.js:208-238` (`windowHtml`, `windowHostHtml`)
- Test: `test/session-glyph.test.js`

**Interfaces:**
- Consumes: `session.windows` и `session.windowHost` из Task 4.
- Produces: разметка колонок `win` и `winhost`; форма элементов не меняется
  (`<div class="win open">`), меняется их число.

- [ ] **Step 1: Написать падающий тест**

В `test/session-glyph.test.js`:

```js
test('у сессии с двумя окнами глиф на каждое', () => {
  const html = windowHtml({ windows: [
    { app: 'kitty', host: 'mac-host' },
    { app: 'WindowsTerminal.exe', host: 'windows-box', desktop: 1 },
  ] }, true, true);
  assert.strictEqual((html.match(/class="win open"/g) || []).length, 2);
  assert.ok(html.includes('Windows Terminal'), html);
});

test('подсказка называет машину каждого окна', () => {
  const html = windowHtml({ windows: [
    { app: 'kitty', host: 'mac-host' },
    { app: 'WindowsTerminal.exe', host: 'windows-box', desktop: 1 },
  ] }, true, true);
  assert.ok(html.includes('title="kitty · mac-host"'), html);
  assert.ok(html.includes('title="Desktop 1 · Windows Terminal · windows-box"'), html);
});

test('две машины в колонке названы обе', () => {
  const html = windowHostHtml({ windowHost: 'mac-host, other-box' }, true);
  assert.ok(html.includes('>mac-host, other-box<'), html);
  assert.ok(html.includes('Windows are on'), html);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test 2>&1 | grep -E "глиф на каждое|подсказка называет|названы обе|^# fail"`
Expected: FAIL — сегодня `windowHtml` читает `session.window`, а его в этих
строках нет: возвращается пустой `<div class="win"></div>`.

- [ ] **Step 3: Реализовать**

`frontend-src/session-glyph.js`:

```js
  /**
   * Пометка об открытом окне — по глифу на каждое окно.
   *
   * Окон у сессии бывает несколько: её открывают на двух машинах сразу.
   * Глиф на окно отвечает сразу на два вопроса — сколько их и в каком
   * терминале каждое, — а имена машин стоят соседней колонкой.
   *
   * Подсказка складывается из того, что известно: стол называет трекер
   * Windows, имя терминала — оба, машину — новый агрегатор. Пустых
   * разделителей не бывает — склеиваются только непустые части.
   */
  function windowHtml(session, showWindow = true, showTerminalIcon = false) {
    if (!showWindow) return '';
    const wins = Array.isArray(session?.windows) && session.windows.length
      ? session.windows
      : (session?.window ? [session.window] : []);
    if (!wins.length) return '<div class="win"></div>';
    return wins.map((win) => {
      const terminal = showTerminalIcon ? terminalOf(win) : null;
      const parts = [];
      if (Number.isFinite(win.desktop)) parts.push(`Desktop ${win.desktop}`);
      if (terminal) parts.push(terminal.name);
      if (win.host) parts.push(String(win.host));
      const title = parts.length ? ` title="${escapeHtml(parts.join(' · '))}"` : '';
      return `<div class="win open"${title}>${terminal ? terminal.glyph : '▣'}</div>`;
    }).join('');
  }
```

`windowHostHtml` — только подпись подсказки, само имя уже склеено в строке:

```js
    if (!host) return '<div class="winhost"></div>';
    // Машин бывает две: сессию открывают и на соседней машине тоже.
    const label = host.includes(',') ? 'Windows are on' : 'Window is on';
    return `<div class="winhost" title="${label} ${escapeHtml(host)}">${escapeHtml(host)}</div>`;
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test 2>&1 | tail -5`
Expected: 0 fail. Старые сторожа `windowHtml` зелёные: строка с одним
`window` и без `windows` идёт запасной ветвью.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-glyph.js test/session-glyph.test.js
git commit -m "feat(picker): глиф на каждое окно сессии"
```

---

### Task 6: Enter поднимает своё окно, даже когда главным названо чужое

**Files:**
- Modify: `frontend-src/session-windows.js:44-60` (`canFocusRow`), `:104-108`
  (`mqttBaseFor`)
- Modify: `sessions.html:1713-1715` (`focusBase`)
- Test: `test/session-windows.test.js`

**Interfaces:**
- Consumes: `windowsOf` из Task 3.
- Produces: `focusWindowOf(row, state, configHost) -> window|null` — своё
  окно, которое можно поднять; `canFocusRow(row, state, configHost)` —
  прежняя сигнатура, теперь `Boolean(focusWindowOf(...))`;
  `mqttBaseFor(row, state, configHost)` — третий аргумент новый.

- [ ] **Step 1: Написать падающий тест**

В `test/session-windows.test.js`:

```js
test('своё окно находится, даже когда главным названо чужое', () => {
  // Агрегатор ставит первым окно со свежайшим взглядом — оно может быть на
  // соседней машине. Поднимать при этом надо здешнее: подъём на чужом экране
  // человеку ничего не даёт.
  const row = { windows: [
    { host: 'mac-host', pid: 5, canFocus: true, mqttBase: 'home/mac/windows' },
    { host: 'windows-box', pid: 7, canFocus: true, mqttBase: 'home/pc/windows' },
  ] };
  assert.strictEqual(canFocusRow(row, {}, 'windows-box'), true);
  assert.strictEqual(focusWindowOf(row, {}, 'windows-box').host, 'windows-box');
  assert.strictEqual(mqttBaseFor(row, {}, 'windows-box'), 'home/pc/windows');
});

test('своего окна нет — фокуса нет, а база остаётся у главного окна', () => {
  const row = { windows: [{ host: 'mac-host', pid: 5, canFocus: true, mqttBase: 'home/mac/windows' }] };
  assert.strictEqual(canFocusRow(row, {}, 'windows-box'), false);
  assert.strictEqual(mqttBaseFor(row, {}, 'windows-box'), 'home/mac/windows');
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test 2>&1 | grep -E "главным названо чужое|^# fail"`
Expected: FAIL — `focusWindowOf is not a function`, а `canFocusRow` отвечает
`false`: он смотрит на первое окно, а оно чужое.

- [ ] **Step 3: Реализовать**

`frontend-src/session-windows.js`:

```js
  /**
   * Своё окно этой строки — то, которое Enter поднимет.
   *
   * Ищется среди **всех** окон, а не берётся главное: главным агрегатор
   * называет окно со свежайшим взглядом, и на машине, где сессию открывали
   * раньше, это будет окно соседней машины. Подъём на чужом экране человеку
   * ничего не даёт, а Enter при этом теряет привычное открытие терминала.
   *
   * Три условия у окна те же, что были: машина совпала с нашей, трекер этой
   * машины умеет поднимать, pid ненулевой — признак живого трекера.
   */
  function focusWindowOf(row, state, configHost) {
    const mine = normHost(configHost);
    if (!mine) return null;
    return windowsOf(row, state).find(w => w && w.canFocus !== false
      && normHost(w.host) === mine && focusPid(w) > 0) || null;
  }

  function canFocusRow(row, state, configHost) {
    return Boolean(focusWindowOf(row, state, configHost));
  }
```

`mqttBaseFor` — база того окна, которое поднимаем; своего нет — главного:

```js
  function mqttBaseFor(row, state, configHost) {
    const w = focusWindowOf(row, state, configHost) || windowOf(row, state);
    const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
    return base;
  }
```

Экспортировать `focusWindowOf`. В `sessions.html` пробросить машину:

```js
  function focusBase(row) {
    return window.SessionWindows.mqttBaseFor(row, lastState, CONFIG.windowHost);
  }
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test 2>&1 | tail -5`
Expected: 0 fail.

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/session-windows.js sessions.html test/session-windows.test.js
git commit -m "fix(picker): Enter поднимает здешнее окно, а не названное главным"
```

---

### Task 7: «Mark unread» отматывает отметку у каждого трекера

**Files:**
- Modify: `src-tauri/src/mqtt.rs` (новая `unread_bases`, рядом с `resolve_base:321`)
- Modify: `src-tauri/src/main.rs:822-831` (команда `unread_session_mqtt`)
- Modify: `frontend-src/session-windows.js` (новая `unreadBases`)
- Modify: `sessions.html:1914-1920` (`markUnread`)
- Test: `src-tauri/src/mqtt.rs` (модульные тесты в том же файле),
  `test/session-windows.test.js`

**Interfaces:**
- Consumes: `windowsOf` из Task 3.
- Produces: `unreadBases(row, state) -> string[]` (непустые базы всех окон,
  без повторов); `mqtt::unread_bases(&Broker, &[String]) -> Vec<String>`;
  команда `unread_session_mqtt(id: String, bases: Vec<String>)`.

- [ ] **Step 1: Написать падающий тест на сторону страницы**

В `test/session-windows.test.js`:

```js
test('unreadBases называет базу каждого окна, без повторов', () => {
  // Отметка складывается по максимуму всех окон, значит отмотать надо у
  // каждого трекера: иначе второй вернёт «просмотрено» следующим же опросом.
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box', mqttBase: 'home/pc/windows' },
    { host: 'other-box', mqttBase: 'home/pc/windows' },
  ] };
  assert.deepStrictEqual(unreadBases(row, {}), ['home/mac/windows', 'home/pc/windows']);
});

test('строка без окон баз не называет — просьба уйдёт по своей', () => {
  assert.deepStrictEqual(unreadBases({}, {}), []);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test 2>&1 | grep -E "unreadBases|^# fail"`
Expected: FAIL — `unreadBases is not a function`.

- [ ] **Step 3: Реализовать на странице**

`frontend-src/session-windows.js` (экспортировать `unreadBases`):

```js
  /**
   * Куда отматывать отметку «просмотрено».
   *
   * Отметка строки — максимум по всем окнам, поэтому отмотать надо у каждого
   * трекера: отмотай у одного, и второй вернёт «просмотрено» на следующем же
   * опросе, а кнопка будет выглядеть сломанной.
   *
   * Пустой список — не отказ: просьба уйдёт по базе из своего конфига, как
   * было до появления нескольких трекеров. Слот в менеджере переживает
   * закрытие окна, и такую сессию он всё ещё может знать по id.
   */
  function unreadBases(row, state) {
    const out = [];
    for (const w of windowsOf(row, state)) {
      const base = w && typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '';
      if (base && !out.includes(base)) out.push(base);
    }
    return out;
  }
```

`sessions.html`, `markUnread`:

```js
    invoke('unread_session_mqtt', {
      id: row.id,
      bases: window.SessionWindows.unreadBases(row, lastState),
    })
      .catch((e) => { error = String(e); render(); });
```

- [ ] **Step 4: Написать падающий тест на стороне Rust**

В `src-tauri/src/mqtt.rs`, в блоке `mod tests` (строка 403). Вспомогательная
`broker(base)` там уже есть (строка 410) — новых не заводить; в
`use super::{...}` (строка 404) добавить `unread_bases`:

```rust
    #[test]
    fn unread_bases_resolves_each_and_drops_duplicates() {
        // Две базы просеиваются порознь, а совпавшие после просеивания
        // складываются в одну: две публикации в один топик — это два
        // одинаковых сообщения, а не две отметки.
        let b = broker("home/room/pc");
        let got = unread_bases(&b, &["home/room/mac/windows".into(),
                                     "home/room/mac/windows".into()]);
        assert_eq!(got, vec!["home/room/mac/windows".to_string()]);
    }

    #[test]
    fn unread_bases_falls_back_to_the_config_base() {
        // Строка без окон баз не называет, и просьба обязана уйти по своей:
        // слот в менеджере переживает закрытие окна.
        let b = broker("home/room/pc");
        assert_eq!(unread_bases(&b, &[]), vec![resolve_base(&b, "")]);
    }

    #[test]
    fn unread_bases_sifts_out_wildcards() {
        // Строка приезжает из файла, написанного на чужой машине, а `#` и `+`
        // в MQTT — подстановочные знаки: публикация по такому топику ушла бы
        // мимо всех.
        let b = broker("home/room/pc");
        assert_eq!(unread_bases(&b, &["home/+/windows".into()]),
                   vec![resolve_base(&b, "")]);
    }
```

- [ ] **Step 5: Прогнать и убедиться, что падает**

Run: `cd src-tauri && cargo test unread_bases 2>&1 | tail -5`
Expected: FAIL — `cannot find function unread_bases`.

- [ ] **Step 6: Реализовать в Rust**

`src-tauri/src/mqtt.rs`, рядом с `resolve_base`:

```rust
/// Адреса, по которым отматывается отметка «просмотрено».
///
/// Окон у сессии бывает несколько, отметка складывается по максимуму всех, и
/// отмотать надо у каждого трекера: отмотай у одного — второй вернёт
/// «просмотрено» на следующем же опросе.
///
/// Каждая база просеивается тем же белым списком, что и одиночная: строка
/// приезжает из файла, написанного на чужой машине. Совпавшие после
/// просеивания складываются — две публикации в один топик это два одинаковых
/// сообщения, а не две отметки. Пустой список даёт базу своего конфига: так
/// пикер вёл себя до появления нескольких трекеров.
pub fn unread_bases(broker: &Broker, asked: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for base in asked.iter().map(|a| resolve_base(broker, a.trim())) {
        if !out.contains(&base) {
            out.push(base);
        }
    }
    if out.is_empty() {
        out.push(resolve_base(broker, ""));
    }
    out
}
```

`src-tauri/src/main.rs`, команда:

```rust
#[tauri::command]
async fn unread_session_mqtt(id: String, bases: Vec<String>) -> Result<(), String> {
    let broker = configured_broker()?;
    // Адрес называет трекер той машины, где стоит окно, и таких машин бывает
    // две: сессию открывают на обеих. Пустой список — трекер прежней версии
    // или строка без окон, тогда остаётся база своего конфига.
    let bases = mqtt::unread_bases(&broker, &bases);
    tauri::async_runtime::spawn_blocking(move || {
        for base in &bases {
            mqtt::unread(&broker, base, &id)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("unread_session_mqtt task failed: {e}"))?
}
```

- [ ] **Step 7: Прогнать оба набора тестов**

Run: `npm test 2>&1 | tail -3 && cd src-tauri && cargo test 2>&1 | tail -5`
Expected: 0 fail в обоих.

- [ ] **Step 8: Коммит**

```bash
git add src-tauri/src/mqtt.rs src-tauri/src/main.rs frontend-src/session-windows.js sessions.html test/session-windows.test.js
git commit -m "fix(picker): «Mark unread» отматывает отметку у каждого трекера"
```

---

### Task 8: Правило в CLAUDE.md и закрытая строка в TODO

**Files:**
- Modify: `CLAUDE.md` (правила про окна — рядом с «Про окна пикер не спрашивает
  никого» и «Поднимать ли окно, решает совпадение имён машин»)
- Modify: `docs/TODO.md` (первый пункт группы `# future`)

**Interfaces:**
- Consumes: поведение, заведённое задачами 1–7.
- Produces: ничего исполняемого.

- [ ] **Step 1: Дописать правило в `CLAUDE.md`**

Сразу после правила «Поднимать ли окно, решает совпадение имён машин»:

```markdown
- **Окон у сессии бывает два, и строка остаётся одна.** Сессию открывают на
  двух машинах: работали на одной, продолжили с того же места на другой — id
  один, окон два. Агрегатор отдаёт их списком (`windows` у сессии), порядок —
  свежайший взгляд первым (`focusedAt`, дальше `lastSeen`, дальше имя машины
  ради устойчивости). Прежде запись с меньшим `lastSeen` выбрасывалась, и
  строка мигала между машинами: имя, пометка ▣, отметка «просмотрено» и
  адресат Enter менялись от опроса к опросу, потому что трекеры тикают с
  разной частотой.

  Поле `window` (первое из списка) осталось и не мёртвый груз: пикер и
  агрегатор выкатываются порознь, и пикер прошлой версии обязан продолжать
  работать. Читатель у него ровно один — сам пикер: в дамп поле не попадает
  (`DUMP_KEEP`), поэтому HA-экспорт и панель читают файл трекера сами.

  Три места, где список главнее главного окна. Enter ищет **своё** окно среди
  всех (`focusWindowOf`): главным бывает названо чужое, а подъём на чужом
  экране человеку ничего не даёт. Отметка «просмотрено» — максимум `focusedAt`
  по **всем** окнам: смотрели на сессию, а не на окно. И «Mark unread»
  отматывает у **каждого** трекера — отмотай у одного, второй вернёт
  «просмотрено» следующим же опросом.
```

- [ ] **Step 2: Закрыть пункт в `docs/TODO.md`**

Первый пункт группы `# future` («Одна сессия бывает открыта на двух машинах»)
удалить целиком: он закрыт этой веткой, а разбор переехал в `CLAUDE.md` и в
спеку.

- [ ] **Step 3: Проверить сторожа документации**

Run: `npm test 2>&1 | tail -3`
Expected: 0 fail. `test/no-private-data.test.js` читает и `CLAUDE.md`: имён
машин в новом правиле быть не должно.

- [ ] **Step 4: Коммит**

```bash
git add CLAUDE.md docs/TODO.md
git commit -m "docs: правило про два окна одной сессии"
```

---

### Task 9: Деплой

Код лежит на pc-virt, а работает на трёх машинах, и до выкатки правка не
проверена ничем, кроме тестов.

**Files:** ничего не правится.

- [ ] **Step 1: Запушить ветку**

```bash
git push && git log -1 --format='%h %s'
```

Без этого деплой выкатит прошлое: скрипты первым делом делают `git pull` на
целевой машине.

- [ ] **Step 2: Убедиться, что агрегатор на месте**

Своей выкатки у `ccfzf` нет — он живёт на pc-virt и читается по ssh. Проверить,
что правка задач 1–2 закоммичена и работает:

```bash
cd ~/projects/shell/ccfzf && git status --short && ~/bin/ccfzf --state | python3 -c "
import json,sys
d=json.load(sys.stdin)
for s in d['sessions']:
    w=s.get('windows') or []
    if len(w) > 1: print(s['id'][:8], [x['host'] for x in w])
"
```

Ожидается: пусто в `git status`, и хотя бы одна строка с двумя машинами (если
сессии на двух машинах сейчас нет — открыть одну и ту же сессию на маке и на
Windows).

- [ ] **Step 3: Выкатить пикер на три машины, параллельно**

```bash
BRANCH=<ветка> ./data/scripts/deploy-win.sh        # popstas-pc, ~3.5 мин
BRANCH=<ветка> ./data/scripts/deploy-mac.sh --all  # оба мака, ~1 мин
```

Обе команды пускать разом, в фоне. `BRANCH=` обязателен: умолчание у скриптов
`master`, и с ветки под ревью выкатился бы чужой код.

- [ ] **Step 4: Проверить, что доехало**

«Скрипт отработал» здесь не значит «правка на месте». Ожидается:

- в выводе `deploy-win.sh` — `Session Name: Console` и сессия `1` (иначе
  приложение поднялось в session 0, где нет ни трея, ни рабочего стола);
- в выводе `deploy-mac.sh` — `пикер работает, pid <N>` на каждой машине.

- [ ] **Step 5: Проверить руками**

- Сессия, открытая на маке и на popstas-pc, показана **одной** строкой с двумя
  глифами; имя чужой машины названо, своё — нет.
- Строка не мигает: имя машины и пометка не меняются от опроса к опросу.
- Enter на машине, где окно есть, поднимает **здешнее** окно.
- «Mark unread» гасит кружок, и через секунду он не возвращается в
  «просмотрено».

---

## Самопроверка плана

- **Покрытие спеки.** A1 → Task 1, A2 → Task 1 (`sort_windows`), Task 2 —
  поля ответа; B1 → Task 3, B2 → Task 4 и 5, B3 → Task 6, B4 → Task 7;
  «Сторожа» разложены по своим задачам; «Проверка руками» и «Деплой» → Task 9;
  «Чего не делаем» задач не порождает.
- **Имена сквозь задачи.** `windowsOf` (Task 3) зовут Task 4, 6, 7;
  `focusWindowOf` (Task 6) зовёт `mqttBaseFor` там же; `unreadBases` (Task 7)
  на обеих сторонах названа одинаково; `sort_windows` (Task 1) больше нигде не
  зовётся.
- **Совместимость** проверяется дважды и в разных местах: старый ответ — Task 3
  (список из одного, верхние поля), старый читатель — Task 2 (`window` равно
  первому).
