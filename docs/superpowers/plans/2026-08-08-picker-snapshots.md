# Снимки раскладки в ccfzf-picker — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Режим `/s` в ccfzf-picker: список снимков раскладки окон и восстановление снимка целиком или одной его сессии.

**Architecture:** Снимки едут в пикер той же односторонней дорогой, что уже везёт `window` и `focusedAt` — демон windows11-manager кладёт их в файл оконного трекера, `ccfzf --state` отдаёт их полем ответа, пикер рисует. Обратно уходит только просьба о восстановлении — публикацией в MQTT-подписку, которая уже есть. Своего клиента и ожидания ответа у пикера не появляется.

**Tech Stack:** JS без сборщика (UMD-шимы, `node --test`), Rust + Tauri 2 (`rumqttc`), Python внутри bash-скрипта (агрегатор `ccfzf`), Node + vitest (windows11-manager, windows-mqtt).

## Global Constraints

- **Спека:** `docs/superpowers/specs/2026-08-08-picker-snapshots-design.md`. Читать перед началом.
- **Тесты пикера — только `npm test`.** `node --test test/` на этих версиях Node не работает.
- **Тесты оболочки — `cd src-tauri && cargo test`.**
- **Тесты windows11-manager — `npm test` (vitest), файл рядом с исходником: `<имя>.test.js`.**
- **Тесты агрегатора — `python3 tests/test_windows_file.py`**, каталог `~/projects/shell/ccfzf`.
- **Имена машин в репозиторий ccfzf-picker не возвращать.** Хост берётся из конфига, умолчания нет. Сторожит `test/no-private-data.test.js`. В тестах и коде — только `pc`, `host`, `broker`.
- **Каждый новый файл в `frontend-src/` попадает в три места:** сам файл, `<script src=…>` в `sessions.html` и список `FILES` в `scripts/prepare-frontend.js`. Порядок тегов — часть контракта (модуль берёт соседа из `globalThis` при загрузке), сторожит `test/frontend-load.test.js`.
- **Комментарии — по-русски**, как во всём репозитории: объясняют «почему», а не «что».
- **`;` в удалённой команде не ставить** — для Windows Terminal это разделитель панелей. Здесь не всплывает, но правило общее.
- **Коммиты частые**, по одному на задачу, префиксы `feat:` / `fix:` / `test:` / `docs:`.

Работа идёт в **четырёх репозиториях**. Задачи 1–2 и 7 — в соседних, остальные — в `ccfzf-picker`.

| Репозиторий | Путь |
|---|---|
| ccfzf-picker | `/home/popstas/projects/js/ccfzf-picker` |
| windows11-manager | `/home/popstas/projects/js/windows11-manager` |
| ccfzf | `/home/popstas/projects/shell/ccfzf` |
| windows-mqtt | `/home/popstas/projects/js/windows-mqtt` |

---

## Порядок задач

Задачи 1 → 2 → 3 связаны дорогой данных и делаются по порядку: без поля в файле трекера агрегатору нечего читать, без поля в ответе агрегатора пикеру нечего рисовать.

Задачи 4–6 (режим, строки, Rust) от них не зависят и могут идти параллельно.

Задачи 7–8 — сшивка: 8 требует 3, 4, 5 и 6; 7 требует 6 только по смыслу, не по коду.

---

## Файлы

**Создаются:**

| Файл | Ответственность |
|---|---|
| `frontend-src/picker-snapshots.js` | Чистые функции режима: строки снимков, ключи, отбор |
| `test/picker-snapshots.test.js` | Тесты того же |

**Правятся:**

| Файл | Что |
|---|---|
| `windows11-manager/src/claude-wt/snapshotter.js` | `currentSnapshots()` — кэш наружу без ввода-вывода |
| `windows11-manager/src/claude-wt/windows-file-helpers.js` | `buildWindowsFile` кладёт снимки, `windowsFingerprint` их учитывает |
| `windows11-manager/src/claude-wt/index.js` | `publishWindows` передаёт снимки |
| `ccfzf/ccfzf` | `read_windows` отдаёт снимки, `--state` кладёт их в ответ |
| `ccfzf-picker/frontend-src/state-shape.js` | Проверка формы поля `snapshots` |
| `ccfzf-picker/frontend-src/picker-mode.js` | Третий режим `snapshots` |
| `ccfzf-picker/frontend-src/action-hotkey.js` | `KeyS` в `RESERVED_CODES` |
| `windows-mqtt/src/picker/restore-payload.js` | Разбор тела просьбы (новый файл) |
| `ccfzf-picker/src-tauri/src/mqtt.rs` | Обобщённый `publish`, `restore` |
| `ccfzf-picker/src-tauri/src/main.rs` | Команда `restore_snapshot_mqtt` |
| `ccfzf-picker/sessions.html` | Отрисовка режима, `choose()`, подсказка, порядок тегов |
| `ccfzf-picker/scripts/prepare-frontend.js` | Новый файл в `FILES` |
| `windows-mqtt/src/modules/windows.js` | `claudeSnapshotRestore` разбирает JSON |

---

### Task 1: windows11-manager — снимки в файле оконного трекера

**Files:**
- Modify: `src/claude-wt/snapshotter.js` (рядом с `listSnapshots`, около строки 104)
- Modify: `src/claude-wt/windows-file-helpers.js:32-69`
- Modify: `src/claude-wt/index.js:256-274`
- Test: `src/claude-wt/windows-file-helpers.test.js`, `src/claude-wt/snapshot-helpers.test.js`

**Interfaces:**
- Consumes: `snapshotTick` уже держит модульный кэш `cache` (`{version, snapshots}`) и `cachePath`.
- Produces:
  - `currentSnapshots(): Array<{id, created, sessions: Array<{id, cwd, title, bounds, desktop, monitor}>}>` — сырые снимки из кэша, пустой массив на холодном кэше.
  - `buildWindowsFile({windows, slots, host, pid, nowMs, snapshots})` — в результате появляется ключ `snapshots` с **обрезанными** записями: `{id, created, sessions: [{id, cwd, title}]}`.
  - `windowsFingerprint(windows, snapshots)` — второй аргумент необязателен.

- [ ] **Step 1: Написать падающий тест на `currentSnapshots()`**

В `src/claude-wt/snapshot-helpers.test.js` дописать в конец файла:

```javascript
import { currentSnapshots, resetSnapshotter } from './snapshotter.js';

describe('currentSnapshots', () => {
  it('отдаёт пустой список на холодном кэше, а не читает файл', () => {
    // Демон только поднялся, snapshotTick ещё не отработал. Читать файл
    // отсюда нельзя: publishWindows зовётся каждый тик, а файл снимков лежит
    // на сетевом диске. Первый же тик кэш заполнит.
    resetSnapshotter();
    expect(currentSnapshots()).toEqual([]);
  });
});
```

- [ ] **Step 2: Прогнать — тест должен упасть**

Run: `cd /home/popstas/projects/js/windows11-manager && npm test -- snapshot-helpers`
Expected: FAIL — `currentSnapshots` не экспортируется из `./snapshotter.js`.

- [ ] **Step 3: Добавить `currentSnapshots()` в `snapshotter.js`**

Рядом с `listSnapshots` (около строки 104), и дописать в экспорт:

```javascript
/**
 * Снимки, которые процесс уже знает, — без ввода-вывода.
 *
 * Для файла оконного трекера: он пишется из тика, а `listSnapshots` читает
 * файл снимков с диска. Кэш здесь тот же, что заполняет и переписывает
 * snapshotTick, так что свежее него в этом процессе всё равно ничего нет.
 *
 * Холодный кэш (демон только поднялся) — пустой список, а не чтение файла:
 * первый же тик его заполнит, а до тех пор поле в файле трекера просто
 * пустое. Читатель на той стороне пустой список переживает.
 */
function currentSnapshots() {
  return cache?.snapshots ?? [];
}

export { snapshotTick, resetSnapshotter, listSnapshots, snapshotId, currentSnapshots };
```

Убедиться, что `resetSnapshotter()` обнуляет `cache` (если нет — обнулить).

- [ ] **Step 4: Прогнать — тест должен пройти**

Run: `cd /home/popstas/projects/js/windows11-manager && npm test -- snapshot-helpers`
Expected: PASS

- [ ] **Step 5: Написать падающие тесты на файл трекера**

В `src/claude-wt/windows-file-helpers.test.js` дописать:

```javascript
const SNAPSHOTS = [{
  id: 'snap-1',
  created: 1_700_000,
  sessions: [
    { id: 'aaa', title: 'ccfzf-picker', cwd: '/home/user/projects/js/ccfzf-picker',
      bounds: { x: 0, y: 0, width: 800, height: 600 }, desktop: 2, monitor: 0 },
    { id: 'ccc', title: 'gone', cwd: '/home/user/projects/js/notes',
      bounds: { x: 10, y: 10, width: 400, height: 300 }, desktop: 1, monitor: 1 },
  ],
}];

describe('buildWindowsFile — снимки', () => {
  it('кладёт снимки обрезанными: без bounds, desktop и monitor', () => {
    // Геометрия нужна только восстановлению, а оно живёт на этой же машине и
    // читает свой файл. Читателю она ехала бы в каждом тике --state, раз в
    // секунду.
    const out = buildWindowsFile({
      windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42,
      nowMs: 1_800_000, snapshots: SNAPSHOTS,
    });
    expect(out.snapshots).toEqual([{
      id: 'snap-1',
      created: 1_700_000,
      sessions: [
        { id: 'aaa', title: 'ccfzf-picker', cwd: '/home/user/projects/js/ccfzf-picker' },
        { id: 'ccc', title: 'gone', cwd: '/home/user/projects/js/notes' },
      ],
    }]);
  });

  it('без снимков поле есть и пустое', () => {
    // Ключ на месте всегда: читателю дешевле пустой массив, чем проверка на
    // отсутствие ключа при каждом использовании.
    const out = buildWindowsFile({
      windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42, nowMs: 1_800_000,
    });
    expect(out.snapshots).toEqual([]);
  });
});

describe('windowsFingerprint — снимки', () => {
  it('новый снимок меняет отпечаток', () => {
    // Иначе снимок доезжал бы до читателя только сердцебиением — до тридцати
    // секунд. Снимки редкие (debounce 60 с), лишних записей это не даёт.
    const windows = buildWindowsFile({
      windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42, nowMs: 1_800_000,
    }).windows;
    const before = windowsFingerprint(windows, []);
    const after = windowsFingerprint(windows, [{ id: 'snap-1', created: 1_700_000 }]);
    expect(after).not.toBe(before);
  });

  it('отпечаток без снимков совпадает с прежним', () => {
    // Второй аргумент необязателен: вызовов windowsFingerprint(windows) в
    // тестах и коде хватает, и все они должны остаться верными.
    const windows = buildWindowsFile({
      windows: WINDOWS, slots: SLOTS, host: 'pc', pid: 42, nowMs: 1_800_000,
    }).windows;
    expect(windowsFingerprint(windows, [])).toBe(windowsFingerprint(windows));
  });
});
```

- [ ] **Step 6: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/js/windows11-manager && npm test -- windows-file-helpers`
Expected: FAIL — `out.snapshots` равно `undefined`.

- [ ] **Step 7: Научить `windows-file-helpers.js`**

В `buildWindowsFile` добавить параметр и сборку поля, в `windowsFingerprint` — второй аргумент:

```javascript
/**
 * Обрезанный вид снимка для читателя на той стороне.
 *
 * `bounds`, `desktop` и `monitor` остаются в файле снимков: их читает
 * восстановление, а оно работает на этой же машине. Читателю они не нужны, а
 * ехали бы в каждом ответе агрегатора, раз в секунду.
 */
function trimSnapshot(snap) {
  return {
    id: typeof snap?.id === 'string' ? snap.id : '',
    created: Number.isFinite(snap?.created) ? snap.created : 0,
    sessions: (snap?.sessions ?? []).map(s => ({
      id: typeof s?.id === 'string' ? s.id : '',
      title: typeof s?.title === 'string' ? s.title : '',
      cwd: typeof s?.cwd === 'string' ? s.cwd : '',
    })),
  };
}

function buildWindowsFile({ windows, slots, host, pid, nowMs, snapshots }) {
  // …существующий цикл по windows без изменений…
  return {
    host, pid, generated: Math.floor(nowMs / 1000), windows: out,
    // Ключ на месте всегда, даже пустой: читателю дешевле пустой массив, чем
    // проверка на отсутствие ключа при каждом использовании.
    snapshots: (snapshots ?? []).map(trimSnapshot),
  };
}
```

К `windowsFingerprint` дописать снимки — по составу, а не по содержимому сессий: снимок неизменяем, кроме последнего, которому `snapshotTick` правит координаты, а координаты сюда всё равно не едут.

```javascript
function windowsFingerprint(windows, snapshots) {
  const win = Object.entries(windows ?? {})
    .map(([id, w]) => `${id} ${w.desktop} ${w.title} ${w.focusedAt}`)
    .sort()
    .join('');
  // Состав, не содержимое: снимок неизменяем, кроме последнего, которому тик
  // правит координаты, — а координаты в файл трекера не едут вовсе.
  const snaps = (snapshots ?? [])
    .map(s => `${s?.id} ${s?.created}`)
    .join('');
  return `${win}${snaps}`;
}
```

- [ ] **Step 8: Прогнать — тесты должны пройти**

Run: `cd /home/popstas/projects/js/windows11-manager && npm test -- windows-file-helpers`
Expected: PASS

- [ ] **Step 9: Связать в `publishWindows`**

В `src/claude-wt/index.js` добавить `currentSnapshots` в импорт из `./snapshotter.js` и править `publishWindows` (строки 256–274):

```javascript
function publishWindows(cfg, windows, slots) {
  if (!cfg.windowsFile) return;
  const nowMs = Date.now();
  // Снимки берутся из кэша снапшотера, а не из файла: publishWindows зовётся
  // каждый тик, а файл снимков лежит там же, где состояние, — на диске.
  const snapshots = currentSnapshots();
  const payload = buildWindowsFile({
    windows, slots, host: os.hostname(), pid: process.pid, nowMs, snapshots,
  });
  const fingerprint = windowsFingerprint(payload.windows, payload.snapshots);
  // …остальное без изменений…
}
```

- [ ] **Step 10: Прогнать весь набор**

Run: `cd /home/popstas/projects/js/windows11-manager && npm test`
Expected: PASS, ни один прежний тест не сломан.

- [ ] **Step 11: Коммит**

```bash
cd /home/popstas/projects/js/windows11-manager
git add src/claude-wt/snapshotter.js src/claude-wt/windows-file-helpers.js \
        src/claude-wt/index.js src/claude-wt/windows-file-helpers.test.js \
        src/claude-wt/snapshot-helpers.test.js
git commit -m "feat(claude-wt): снимки раскладки в файле оконного трекера

Читателю на другой машине их взять больше неоткуда: список снимков в
windows-mqtt отвечал через stdout своему Tauri-процессу. Вид обрезанный —
геометрия остаётся в файле снимков, восстановление живёт на этой машине.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: ccfzf — снимки из файла трекера в ответ `--state`

**Files:**
- Modify: `ccfzf` — `read_windows` (строка 376), вызовы на строках 1236 и 1307, `json.dump` на 1390
- Test: `tests/test_windows_file.py`

**Interfaces:**
- Consumes: файл трекера с полем `snapshots` из задачи 1.
- Produces: `read_windows(path, now)` возвращает **четыре** значения — `(windows, host, pid, snapshots)`. `ccfzf --state` кладёт в ответ ключ `snapshots`.

- [ ] **Step 1: Написать падающие тесты**

В `tests/test_windows_file.py` поправить помощник `_payload` и дописать тесты. Помощник `_read` не трогается — он возвращает то, что вернул `read_windows`.

```python
def _payload(win, snaps=None):
    out = {"generated": NOW - 1, "host": "pc", "pid": 42, "windows": {UUID_A: win}}
    if snaps is not None:
        out["snapshots"] = snaps
    return out


SNAP = {"id": "snap-1", "created": NOW - 3600,
        "sessions": [{"id": UUID_A, "title": "ccfzf", "cwd": "/home/user/projects/js/ccfzf-picker"}]}


def test_snapshots_reach_the_reader():
    # Снимки раскладки живут на машине трекера; у читателя своего доступа к
    # ним нет, и приезжают они тем же файлом, что и окна.
    _, _, _, snaps = _read(_payload({"title": "ccfzf", "desktop": 2,
                                     "lastSeen": NOW - 5, "focusedAt": 0}, [SNAP]))
    assert len(snaps) == 1, snaps
    assert snaps[0]["id"] == "snap-1", snaps[0]
    assert snaps[0]["sessions"][0]["cwd"].endswith("ccfzf-picker"), snaps[0]


def test_snapshots_missing_is_empty_list():
    # Трекер прежней версии поля не пишет. Пустой список стоит читателю
    # дешевле, чем проверка на None при каждом использовании.
    _, _, _, snaps = _read(_payload({"title": "ccfzf", "desktop": 2,
                                     "lastSeen": NOW - 5, "focusedAt": 0}))
    assert snaps == [], snaps


def test_junk_snapshots_cost_the_field_not_the_list():
    # Порченая добавка не имеет права стоить списка сессий — это правило всей
    # read_windows, и снимки из него не исключение.
    windows, host, pid, snaps = _read(_payload(
        {"title": "ccfzf", "desktop": 2, "lastSeen": NOW - 5, "focusedAt": 0},
        "не список"))
    assert snaps == [], snaps
    assert windows[UUID_A]["title"] == "ccfzf", windows
    assert host == "pc" and pid == 42, (host, pid)


def test_snapshot_entries_are_checked_one_by_one():
    # Одна кривая запись выбрасывается, соседние остаются: снимков двадцать,
    # и терять девятнадцать из-за одной было бы обидно.
    _, _, _, snaps = _read(_payload(
        {"title": "ccfzf", "desktop": 2, "lastSeen": NOW - 5, "focusedAt": 0},
        [SNAP, {"id": 42}, {"sessions": []}, "строка"]))
    assert [s["id"] for s in snaps] == ["snap-1"], snaps


def test_stale_file_gives_no_snapshots_either():
    # Правило TTL общее: протухший файл не даёт ни окон, ни снимков. Отдельной
    # ветки для снимков нет намеренно — она разошлась бы с окнами.
    windows, _, _, snaps = _read({"generated": NOW - 10_000, "host": "pc", "pid": 42,
                                  "windows": {UUID_A: {"title": "x"}},
                                  "snapshots": [SNAP]}, now=NOW)
    assert windows == {} and snaps == [], (windows, snaps)
```

Прежние тесты в файле распаковывают три значения — поправить их на четыре (`windows, host, pid, _`).

- [ ] **Step 2: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/shell/ccfzf && python3 tests/test_windows_file.py`
Expected: FAIL — распаковка трёх значений в четыре.

- [ ] **Step 3: Научить `read_windows`**

В `ccfzf`, функция `read_windows` (строка 376). Пустышка `empty` становится четвёрткой, и в конце функции добавляется разбор снимков:

```python
def read_windows(path, now):
    """Файл оконного трекера: у какой сессии открыто окно, на чьей машине и
    какие раскладки он помнит.

    Файл необязательный и приезжает с другой машины, поэтому не доверяется
    ничему в нём. Нет файла, не разбирается json, нет ожидаемых ключей, отметка
    старше WINDOWS_TTL — возвращается пустота, и ни ошибки, ни строчки в stderr.
    Список сессий обязан пережить любой мусор в добавке: порченый файл должен
    стоить пометки, а не списка. Со снимками то же правило: кривая запись стоит
    себя, порченое поле — только поля.
    """
    empty = ({}, "", 0, [])
```

Все `return empty` внутри остаются как есть. Перед финальным `return` собрать снимки:

```python
    snaps = []
    raw_snaps = o.get("snapshots")
    if isinstance(raw_snaps, list):
        for s in raw_snaps:
            if not isinstance(s, dict):
                continue
            sid = s.get("id")
            if not isinstance(sid, str) or not sid:
                continue
            sessions = []
            for m in s.get("sessions") if isinstance(s.get("sessions"), list) else []:
                if not isinstance(m, dict):
                    continue
                mid = m.get("id")
                if not isinstance(mid, str) or not mid:
                    continue
                sessions.append({
                    "id": mid,
                    "title": m.get("title") if isinstance(m.get("title"), str) else "",
                    "cwd": m.get("cwd") if isinstance(m.get("cwd"), str) else "",
                })
            snaps.append({"id": sid, "created": num(s.get("created")), "sessions": sessions})
```

и вернуть `out, host, pid, snaps` — по образцу того, как функция возвращает `host` и `pid` сейчас.

- [ ] **Step 4: Поправить оба вызова**

Строка 1236 (режим `dump`, снимки там не нужны):

```python
windows, _, _, _ = read_windows(windows_path, now)
```

Строка 1307 (режим `state`):

```python
    windows, window_host, window_pid, window_snapshots = read_windows(
        sys.argv[3] if len(sys.argv) > 3 else "", now)
```

- [ ] **Step 5: Положить снимки в ответ**

В `json.dump` (около строки 1390), рядом с `windowHost` / `windowPid`:

```python
               "windowHost": window_host, "windowPid": window_pid,
               # Раскладки, которые помнит трекер. Оттуда же, откуда окна:
               # здесь видны процессы, а окна — на другой машине.
               "snapshots": window_snapshots},
```

- [ ] **Step 6: Прогнать тесты агрегатора**

Run: `cd /home/popstas/projects/shell/ccfzf && for t in tests/test_*.py; do python3 "$t" || exit 1; done`
Expected: все PASS — `read_windows` зовут и другие тесты.

- [ ] **Step 7: Проверить на живом ответе**

Run: `cd /home/popstas/projects/shell/ccfzf && ./ccfzf --state | python3 -c "import json,sys; o=json.load(sys.stdin); print('snapshots:', len(o.get('snapshots', [])))"`
Expected: строка `snapshots: N`. Ноль — тоже успех: на этой машине трекера нет, важно, что ключ на месте и разбор не упал.

- [ ] **Step 8: Коммит**

```bash
cd /home/popstas/projects/shell/ccfzf
git add ccfzf tests/test_windows_file.py
git commit -m "feat(state): снимки раскладки из файла оконного трекера

read_windows отдаёт их четвёртым значением, --state кладёт рядом с
windowHost. Правило то же, что у окон: порченая добавка стоит поля, а не
списка сессий; протухший файл не даёт ни того, ни другого.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: пикер — форма ответа со снимками

**Files:**
- Modify: `frontend-src/state-shape.js:29-55`
- Test: `test/state-shape.test.js`

**Interfaces:**
- Consumes: ключ `snapshots` в ответе `--state` из задачи 2.
- Produces: `validateState(obj)` не ругается на ответ со снимками; `snapshotProblems(obj): string[]` — претензии к отдельным записям, отдельным списком.

- [ ] **Step 1: Написать падающие тесты**

В `test/state-shape.test.js` дописать:

```javascript
test('ответ без snapshots — не поломка', () => {
  // Агрегатор стоит на другой машине и обновляется отдельно. Старый ответ без
  // поля значит «режим /s ничего не покажет» — честный ответ, а не повод
  // гасить список сессий.
  assert.deepEqual(validateState({ generated: 1, sessions: [] }), []);
});

test('snapshots не массив — поломка', () => {
  // Случай дешёвый и однозначный, а перебирать такое поле нечем.
  const problems = validateState({ generated: 1, sessions: [], snapshots: 'нет' });
  assert.ok(problems.includes('snapshots is not an array'), problems);
});

test('кривая запись снимка — претензия, а не отказ опроса', () => {
  // Тот же размен, что у projects: переименованное на той стороне поле не
  // должно замораживать список сессий, к снимкам отношения не имеющий.
  const state = { generated: 1, sessions: [], snapshots: [{ id: 42, created: 'вчера' }] };
  assert.deepEqual(validateState(state), []);
  const problems = snapshotProblems(state);
  assert.ok(problems.some(p => p.includes('snapshots[0].id')), problems);
});

test('снимок без sessions — претензия', () => {
  const problems = snapshotProblems({
    snapshots: [{ id: 'snap-1', created: 10 }],
  });
  assert.ok(problems.some(p => p.includes('snapshots[0].sessions')), problems);
});

test('целый снимок претензий не вызывает', () => {
  assert.deepEqual(snapshotProblems({
    snapshots: [{ id: 'snap-1', created: 10, sessions: [{ id: 'a', cwd: '/p', title: 't' }] }],
  }), []);
});
```

Импорт вверху файла (строка 3) дополнить — без расширения, как в остальном файле:

```javascript
const { validateState, projectProblems, snapshotProblems } = require('../frontend-src/state-shape');
```

- [ ] **Step 2: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: FAIL — `snapshotProblems is not a function`.

- [ ] **Step 3: Научить `state-shape.js`**

Рядом с `PROJECT_FIELDS` добавить:

```javascript
  // Снимки раскладки. Приезжают из файла оконного трекера через агрегатор;
  // геометрии среди полей нет намеренно — она осталась на той машине.
  const SNAPSHOT_FIELDS = [
    ['id', 'string'],
    ['created', 'number'],
  ];

  const SNAPSHOT_SESSION_FIELDS = [
    ['id', 'string'],
    ['cwd', 'string'],
    ['title', 'string'],
  ];
```

В `validateState`, следом за проверкой `projects`:

```javascript
    // То же правило, что у projects: поля может не быть вовсе (старый
    // агрегатор), и это значит «режим /s пуст», а не поломка. Не массив —
    // всё же поломка: перебирать такое нечем.
    if (obj.snapshots !== undefined && !Array.isArray(obj.snapshots)) {
      out.push('snapshots is not an array');
    }
```

И новая функция рядом с `projectProblems`:

```javascript
  /**
   * Претензии к отдельным записям `snapshots` — отдельным списком, как у
   * проектов и по той же причине: агрегатор обновляется сам по себе, и
   * переименованное там поле снимка не должно морозить список сессий.
   */
  function snapshotProblems(obj) {
    if (!obj || !Array.isArray(obj.snapshots)) return [];
    const out = [];
    obj.snapshots.forEach((s, i) => {
      for (const [key, type] of SNAPSHOT_FIELDS) {
        if (typeof (s || {})[key] !== type) out.push(`snapshots[${i}].${key} is not a ${type}`);
      }
      if (!Array.isArray((s || {}).sessions)) {
        out.push(`snapshots[${i}].sessions is not an array`);
        return;
      }
      s.sessions.forEach((m, j) => {
        for (const [key, type] of SNAPSHOT_SESSION_FIELDS) {
          if (typeof (m || {})[key] !== type) {
            out.push(`snapshots[${i}].sessions[${j}].${key} is not a ${type}`);
          }
        }
      });
    });
    return out;
  }
```

Дописать в возврат: `return { validateState, projectProblems, snapshotProblems };`

- [ ] **Step 4: Прогнать — тесты должны пройти**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
cd /home/popstas/projects/js/ccfzf-picker
git add frontend-src/state-shape.js test/state-shape.test.js
git commit -m "feat(picker): форма ответа со снимками раскладки

Отсутствие поля — не поломка: агрегатор на той стороне обновляется отдельно.
Кривые записи собираются отдельным списком, как у projects, и опрос не
отбрасывают.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: пикер — режим `/s` в строке поиска

**Files:**
- Modify: `frontend-src/picker-mode.js:23-40`
- Test: `test/picker-mode.test.js`

**Interfaces:**
- Produces: `parseQuery(raw)` возвращает `{mode: 'sessions' | 'projects' | 'snapshots', query}`. `withSnapshotPrefix(raw)` — по образцу `withProjectPrefix`, ставит `/s `. Константа `SNAPSHOT_PREFIX_TEXT = '/s '`.

- [ ] **Step 1: Написать падающие тесты**

В `test/picker-mode.test.js` дописать:

```javascript
test('/s и /snapshots уводят в режим снимков', () => {
  assert.deepEqual(parseQuery('/s'), { mode: 'snapshots', query: '' });
  assert.deepEqual(parseQuery('/snapshots picker'), { mode: 'snapshots', query: 'picker' });
  assert.deepEqual(parseQuery('  /s  picker '), { mode: 'snapshots', query: 'picker' });
});

test('/src и /session режимом не считаются', () => {
  // Человек, ищущий сессию со словом /src в пути, не должен молча оказаться
  // в другом списке. То же правило, что уберегло /a от /api.
  assert.deepEqual(parseQuery('/src'), { mode: 'sessions', query: '/src' });
  assert.deepEqual(parseQuery('/session'), { mode: 'sessions', query: '/session' });
});

test('/a по-прежнему уводит в проекты', () => {
  assert.deepEqual(parseQuery('/a picker'), { mode: 'projects', query: 'picker' });
});

test('withSnapshotPrefix ставит префикс и не удваивает его', () => {
  assert.equal(withSnapshotPrefix('picker'), '/s picker');
  assert.equal(withSnapshotPrefix('/s picker'), '/s picker');
  assert.equal(withSnapshotPrefix(''), '/s ');
});
```

Импорт вверху файла дополнить `withSnapshotPrefix`.

- [ ] **Step 2: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: FAIL — `/s` разбирается как режим `sessions`.

- [ ] **Step 3: Научить `picker-mode.js`**

Заменить одну пару констант на две и переписать `parseQuery`:

```javascript
  const PROJECT_PREFIX = /^\s*\/(all|a)(\s+|$)/i;
  const PROJECT_PREFIX_TEXT = '/a ';

  /**
   * Снимки — третий режим той же строки поиска.
   *
   * `/session` и `/src` префиксом не считаются по той же причине, по которой
   * им не считается `/api`: хвост `(\s+|$)` требует, чтобы после `/s` строка
   * кончилась или пошёл пробел.
   */
  const SNAPSHOT_PREFIX = /^\s*\/(snapshots|s)(\s+|$)/i;
  const SNAPSHOT_PREFIX_TEXT = '/s ';

  function parseQuery(raw) {
    const text = String(raw == null ? '' : raw);
    const project = text.match(PROJECT_PREFIX);
    if (project) return { mode: 'projects', query: text.slice(project[0].length).trim() };
    const snapshot = text.match(SNAPSHOT_PREFIX);
    if (snapshot) return { mode: 'snapshots', query: text.slice(snapshot[0].length).trim() };
    return { mode: 'sessions', query: text.trim() };
  }

  function withProjectPrefix(raw) {
    const text = String(raw == null ? '' : raw);
    if (PROJECT_PREFIX.test(text)) return text;
    return PROJECT_PREFIX_TEXT + text.replace(/^\s+/, '');
  }

  /** Строка поиска с префиксом снимков впереди. */
  function withSnapshotPrefix(raw) {
    const text = String(raw == null ? '' : raw);
    if (SNAPSHOT_PREFIX.test(text)) return text;
    return SNAPSHOT_PREFIX_TEXT + text.replace(/^\s+/, '');
  }

  return {
    parseQuery, withProjectPrefix, withSnapshotPrefix,
    PREFIX_TEXT: PROJECT_PREFIX_TEXT, SNAPSHOT_PREFIX_TEXT,
  };
```

`PREFIX_TEXT` остаётся под прежним именем: его читает `sessions.html`, и переименование ушло бы за границы задачи.

- [ ] **Step 4: Прогнать — тесты должны пройти**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
cd /home/popstas/projects/js/ccfzf-picker
git add frontend-src/picker-mode.js test/picker-mode.test.js
git commit -m "feat(picker): режим снимков в строке поиска

Третий режим той же строки: /s и /snapshots. /src и /session префиксом не
считаются — хвост (\\s+|\$) требует пробела или конца строки, как у /a и /api.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: пикер — строки режима снимков

**Files:**
- Create: `frontend-src/picker-snapshots.js`
- Create: `test/picker-snapshots.test.js`
- Modify: `sessions.html` (тег `<script>`), `scripts/prepare-frontend.js` (список `FILES`)

**Interfaces:**
- Consumes: `snapshots` из ответа агрегатора (задача 3), `window.PickerFilter.searchableCwd` для отбора.
- Produces:
  - `openIdsFromState(state): Set<string>` — id сессий, у которых в ответе есть `window`.
  - `buildSnapshotRows(snapshots, openIds, query): Array<row>`, где `row` — либо заголовок `{kind: 'snapshot', key, id, label, missing, total}`, либо сессия `{kind: 'snapshot-session', key, id, snapshotId, cwd, label, open}`.
  - `formatSnapshotTime(snapshot): string` — `'10:31 · 2026-08-08'`.

- [ ] **Step 1: Написать падающие тесты**

Создать `test/picker-snapshots.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');

const { buildSnapshotRows, openIdsFromState, formatSnapshotTime } =
  require('../frontend-src/picker-snapshots.js');

const SNAP = {
  id: 'snap-1',
  created: 1754640660,
  sessions: [
    { id: 'aaa', cwd: '/home/user/projects/js/ccfzf-picker', title: 'picker' },
    { id: 'bbb', cwd: '/home/user/projects/js/windows-mqtt', title: 'mqtt' },
  ],
};

test('openIdsFromState берёт сессии с окном', () => {
  // Отдельного openSessionIds возить неоткуда: всё уже в том же ответе.
  const ids = openIdsFromState({
    sessions: [
      { id: 'aaa', window: { title: 'x' } },
      { id: 'bbb' },
      { id: 'ccc', window: null },
    ],
  });
  assert.deepEqual([...ids].sort(), ['aaa']);
});

test('openIdsFromState на пустом ответе — пустое множество', () => {
  assert.equal(openIdsFromState({}).size, 0);
  assert.equal(openIdsFromState(null).size, 0);
});

test('заголовок снимка считает, скольких не хватает', () => {
  const rows = buildSnapshotRows([SNAP], new Set(['aaa']), '');
  assert.equal(rows[0].kind, 'snapshot');
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].missing, 1);
});

test('строки сессий помечены открытостью', () => {
  const rows = buildSnapshotRows([SNAP], new Set(['aaa']), '');
  const sessions = rows.filter(r => r.kind === 'snapshot-session');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'aaa');
  assert.equal(sessions[0].open, true);
  assert.equal(sessions[1].open, false);
});

test('ключи строк разведены и стабильны', () => {
  // picker-list-sync правит только отличающиеся строки, и совпавший ключ
  // заголовка с ключом сессии подменял бы одну строку другой.
  const rows = buildSnapshotRows([SNAP], new Set(), '');
  assert.deepEqual(rows.map(r => r.key),
    ['g:snap:snap-1', 'snap:snap-1:aaa', 'snap:snap-1:bbb']);
});

test('имя строки сессии — basename каталога', () => {
  const rows = buildSnapshotRows([SNAP], new Set(), '');
  assert.equal(rows[1].label, 'ccfzf-picker');
});

test('без cwd имя берётся из заголовка', () => {
  const rows = buildSnapshotRows(
    [{ id: 's', created: 1, sessions: [{ id: 'x', cwd: '', title: 'заголовок' }] }],
    new Set(), '');
  assert.equal(rows[1].label, 'заголовок');
});

test('фильтр уносит снимок вместе с заголовком', () => {
  // Снимок без подошедших сессий не должен оставлять на экране пустую группу.
  const rows = buildSnapshotRows([SNAP], new Set(), 'mqtt');
  assert.deepEqual(rows.map(r => r.key), ['g:snap:snap-1', 'snap:snap-1:bbb']);
  assert.deepEqual(buildSnapshotRows([SNAP], new Set(), 'ничего'), []);
});

test('пустой список снимков — пустой список строк', () => {
  assert.deepEqual(buildSnapshotRows([], new Set(), ''), []);
  assert.deepEqual(buildSnapshotRows(undefined, new Set(), ''), []);
});

test('снимок без сессий не даёт даже заголовка', () => {
  // Восстанавливать в нём нечего, а строка обещала бы обратное.
  assert.deepEqual(buildSnapshotRows([{ id: 's', created: 1, sessions: [] }], new Set(), ''), []);
});

test('время снимка — час и дата', () => {
  const text = formatSnapshotTime({ created: 1754640660 });
  assert.match(text, /^\d{2}:\d{2} · \d{4}-\d{2}-\d{2}$/);
});

test('снимок без времени показывает id вместо даты', () => {
  assert.equal(formatSnapshotTime({ id: 'snap-1' }), 'snap-1');
});
```

- [ ] **Step 2: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: FAIL — `Cannot find module '../frontend-src/picker-snapshots.js'`.

- [ ] **Step 3: Написать `frontend-src/picker-snapshots.js`**

```javascript
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(
    typeof require === 'function' ? require('./picker-filter.js') : root.PickerFilter,
  );
  else root.PickerSnapshots = factory(root.PickerFilter);
})(typeof self !== 'undefined' ? self : this, function (PickerFilter) {
  /**
   * Строки режима снимков — плоским списком, без механики сворачивания.
   *
   * Заголовок снимка и его сессии идут одним потоком: группы в списке уже
   * есть (`g:`), и заводить рядом раскрытие значило бы объяснять человеку
   * второй способ навигации там, где хватает стрелок.
   */

  /** Имя строки: каталог проекта, а не полный путь. */
  function projectBasename(session) {
    const cwd = session?.cwd != null ? String(session.cwd).trim() : '';
    if (cwd) {
      const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return String(session?.title ?? '').trim() || '—';
  }

  /**
   * Час и дата снимка. Часы впереди: снимков за день несколько, и различает их
   * именно время, а дата повторяется.
   *
   * Нет отметки — показывается id: строка без опознавательных знаков хуже
   * строки с непонятным, но своим именем.
   */
  function formatSnapshotTime(snapshot) {
    const sec = Number(snapshot?.created);
    if (Number.isFinite(sec) && sec > 0) {
      const d = new Date(sec * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`
        + ` · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    return String(snapshot?.id ?? '');
  }

  /**
   * Сессии, у которых окно открыто прямо сейчас.
   *
   * Считается по тому же ответу агрегатора, что и весь список: поле `window`
   * приезжает от оконного трекера. Отдельного вызова, как в windows-mqtt, тут
   * не нужно — всё уже пришло.
   */
  function openIdsFromState(state) {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    return new Set(sessions.filter(s => s && s.window).map(s => s.id));
  }

  /**
   * Строки снимков, отобранные запросом.
   *
   * Отбор идёт по строкам сессий; заголовок сам по себе не ищется — искать по
   * дате незачем, а совпадение по ней оставляло бы на экране снимок, ни одна
   * сессия которого запросу не отвечает. Снимок без подошедших уходит целиком.
   */
  function buildSnapshotRows(snapshots, openIds, query) {
    const open = openIds instanceof Set ? openIds : new Set(openIds ?? []);
    const q = String(query ?? '').trim().toLowerCase();
    const searchable = PickerFilter && PickerFilter.searchableCwd
      ? PickerFilter.searchableCwd
      : (cwd => String(cwd ?? ''));
    const out = [];
    for (const snap of snapshots ?? []) {
      const all = snap?.sessions ?? [];
      const rows = all
        .map(s => ({
          kind: 'snapshot-session',
          key: `snap:${snap.id}:${s.id}`,
          id: s.id,
          snapshotId: snap.id,
          cwd: String(s?.cwd ?? ''),
          label: projectBasename(s),
          open: open.has(s.id),
        }))
        .filter(r => !q || `${r.label} ${searchable(r.cwd)}`.toLowerCase().includes(q));
      // Снимок без сессий — ни строки: восстанавливать в нём нечего, а
      // заголовок обещал бы обратное.
      if (!rows.length) continue;
      out.push({
        kind: 'snapshot',
        key: `g:snap:${snap.id}`,
        id: snap.id,
        label: formatSnapshotTime(snap),
        total: all.length,
        missing: all.filter(s => !open.has(s.id)).length,
      });
      out.push(...rows);
    }
    return out;
  }

  return { buildSnapshotRows, openIdsFromState, formatSnapshotTime, projectBasename };
});
```

- [ ] **Step 4: Прогнать — тесты должны пройти**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: PASS

- [ ] **Step 5: Записать файл в оба списка**

В `sessions.html` — тег **после** `picker-filter.js` (модуль берёт соседа из `globalThis` в момент загрузки):

```html
<script src="picker-filter.js"></script>
<script src="picker-snapshots.js"></script>
<script src="picker-mode.js"></script>
```

В `scripts/prepare-frontend.js`, в списке `FILES`, в том же порядке:

```javascript
'frontend-src/picker-filter.js',
'frontend-src/picker-snapshots.js',
'frontend-src/picker-mode.js',
```

- [ ] **Step 6: Прогнать — порядок загрузки должен сойтись**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: PASS, включая `test/frontend-load.test.js` — он и сторожит порядок тегов.

- [ ] **Step 7: Коммит**

```bash
cd /home/popstas/projects/js/ccfzf-picker
git add frontend-src/picker-snapshots.js test/picker-snapshots.test.js \
        sessions.html scripts/prepare-frontend.js
git commit -m "feat(picker): строки режима снимков

Плоский список: заголовок снимка и его сессии одним потоком, ключи разведены
под picker-list-sync. Отбор идёт по сессиям — снимок без подошедших уходит
вместе с заголовком.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: пикер — просьба о восстановлении по MQTT

**Files:**
- Modify: `src-tauri/src/mqtt.rs:23-24, 70-145, 147-198`
- Modify: `src-tauri/src/main.rs:198-208` (рядом), `src-tauri/src/main.rs:414` (регистрация)
- Test: `src-tauri/src/mqtt.rs` (модуль `tests` внизу файла)

**Interfaces:**
- Consumes: `Broker`, `broker_from_config` — как есть.
- Produces:
  - `mqtt::restore(broker: &Broker, id: &str, session_ids: &[String]) -> Result<(), String>`
  - `restore_payload(id: &str, session_ids: &[String]) -> String` — тело для теста
  - Команда Tauri `restore_snapshot_mqtt(id: String, sessionIds: Vec<String>) -> Result<(), String>`

- [ ] **Step 1: Написать падающие тесты**

В модуль `tests` внизу `src-tauri/src/mqtt.rs` дописать (импорт вверху модуля дополнить `restore_payload, RESTORE_TOPIC`):

```rust
    // Хвост задан приёмником — подпиской в windows-mqtt. Опечатка здесь ничего
    // не ломает на глаз: публикация проходит, PubAck приходит, а раскладка не
    // поднимается, потому что никто не слушает.
    #[test]
    fn restore_topic_is_the_one_the_daemon_listens_to() {
        let broker = broker_from_config(&serde_json::json!({
            "mqtt": { "host": "broker", "base": "home/room/pc/" }
        }));
        assert_eq!(
            topic_of(&broker, RESTORE_TOPIC),
            "home/room/pc/windows/claude-snapshot-restore"
        );
    }

    // Без sessionIds приёмник поднимает снимок целиком. Пустой массив в теле
    // он прочитал бы как «поднять ноль сессий», поэтому ключа быть не должно
    // вовсе — разница между «все» и «никого» стоит целой раскладки.
    #[test]
    fn whole_snapshot_body_carries_no_session_ids() {
        assert_eq!(restore_payload("snap-1", &[]), r#"{"id":"snap-1"}"#);
    }

    #[test]
    fn single_session_body_names_it() {
        let body = restore_payload("snap-1", &["aaa".to_string()]);
        assert_eq!(body, r#"{"id":"snap-1","sessionIds":["aaa"]}"#);
    }
```

- [ ] **Step 2: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/js/ccfzf-picker/src-tauri && cargo test`
Expected: FAIL — `restore_payload` и `RESTORE_TOPIC` не найдены.

- [ ] **Step 3: Обобщить `publish` и добавить `restore`**

В `src-tauri/src/mqtt.rs` — новая константа рядом с прежними:

```rust
const RESTORE_TOPIC: &str = "/windows/claude-snapshot-restore";
```

Дописать в шапку файла, к перечню топиков: `<base>/windows/claude-snapshot-restore` с телом `{"id": …}` и необязательным `sessionIds`.

`publish` теперь принимает готовое тело, а прежнюю склейку берёт на себя обёртка:

```rust
/// Тело просьбы о восстановлении.
///
/// Без `sessionIds` приёмник поднимает снимок целиком. Пустой массив он
/// прочитал бы как «поднять ноль сессий», поэтому при пустом списке ключа в
/// теле нет вовсе: разница между «все» и «никого» стоит целой раскладки.
fn restore_payload(id: &str, session_ids: &[String]) -> String {
    if session_ids.is_empty() {
        return serde_json::json!({ "id": id }).to_string();
    }
    serde_json::json!({ "id": id, "sessionIds": session_ids }).to_string()
}

/// Попросить о подъёме окна сессии.
pub fn focus(broker: &Broker, id: &str) -> Result<(), String> {
    publish(broker, FOCUS_TOPIC, &serde_json::json!({ "id": id }).to_string())
}

pub fn unread(broker: &Broker, id: &str) -> Result<(), String> {
    publish(broker, UNREAD_TOPIC, &serde_json::json!({ "id": id }).to_string())
}

/// Попросить поднять раскладку снимка — целиком или одну её сессию.
///
/// Ответа у просьбы нет, как и у фокуса: подписка на той стороне отчитывается
/// в свой лог. Заводить здесь приёмник ради отчёта значило бы держать
/// соединение и ждать — ровно то, чего вся эта дорога избегает. Не сработало
/// — видно на экране, окна там же.
pub fn restore(broker: &Broker, id: &str, session_ids: &[String]) -> Result<(), String> {
    publish(broker, RESTORE_TOPIC, &restore_payload(id, session_ids))
}
```

В самой `publish` заменить параметр `id: &str` на `payload: &str` и убрать строку, которая клеила `{"id": id}`; всё остальное в функции не трогать.

- [ ] **Step 4: Прогнать — тесты должны пройти**

Run: `cd /home/popstas/projects/js/ccfzf-picker/src-tauri && cargo test`
Expected: PASS

- [ ] **Step 5: Добавить команду в `main.rs`**

Следом за `unread_session_mqtt` (после строки 208):

```rust
/// Попросить поднять раскладку снимка.
///
/// Пустой `session_ids` значит «весь снимок». Права на передний план здесь не
/// выдаётся: восстановление открывает новые окна, а не поднимает существующее,
/// и `AllowSetForegroundWindow` тут не при чём.
#[tauri::command]
async fn restore_snapshot_mqtt(id: String, session_ids: Vec<String>) -> Result<(), String> {
    let raw = load_config()?;
    let broker = mqtt::broker_from_config(&raw);
    if !broker.is_configured() {
        return Err("mqtt не настроен: нужны host и base в config.yaml".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || mqtt::restore(&broker, &id, &session_ids))
        .await
        .map_err(|e| format!("restore_snapshot_mqtt task failed: {e}"))?
}
```

И в перечень команд (строка 414):

```rust
            copy_to_clipboard, load_ui, save_ui, focus_window_mqtt, unread_session_mqtt,
            restore_snapshot_mqtt
```

Из фронтенда команда зовётся как `invoke('restore_snapshot_mqtt', { id, sessionIds })` — Tauri сам переводит `sessionIds` в `session_ids`.

- [ ] **Step 6: Собрать и прогнать**

Run: `cd /home/popstas/projects/js/ccfzf-picker/src-tauri && cargo test && cargo check`
Expected: PASS, без предупреждений о неиспользуемом коде.

- [ ] **Step 7: Коммит**

```bash
cd /home/popstas/projects/js/ccfzf-picker
git add src-tauri/src/mqtt.rs src-tauri/src/main.rs
git commit -m "feat(picker): просьба о восстановлении раскладки по MQTT

publish принимает готовое тело: у восстановления оно своё — с sessionIds для
одной сессии. Пустой список ключа в теле не даёт вовсе, иначе приёмник
прочитал бы его как «поднять ноль сессий».

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: windows-mqtt — разбор тела просьбы

**Files:**
- Create: `src/picker/restore-payload.js`
- Create: `test/restore-payload.test.js`
- Modify: `src/modules/windows.js:657-671` (и `require` в шапке)

**Interfaces:**
- Consumes: тело от `mqtt::restore` из задачи 6.
- Produces: `parseRestorePayload(message): {id: string, sessionIds: string[]}` — отдельным файлом; `claudeSnapshotRestore` зовёт `winMan.restoreSnapshot({id, sessionIds})`.

**Почему отдельным файлом.** `src/modules/windows.js` — это `module.exports = async (mqtt, config, log) => {…}`, одна фабрика: тестом он не грузится, и соседний `test/claude-focus-subscription.test.js` проверяет его текстом файла, а не вызовом. Чистые помощники в этом репозитории живут в `src/picker/` (`session-open-helpers.js`, `session-slots.js`, `claude-project-helpers.js`) и оттуда же тестируются. Тесты здесь — `node --test`, CommonJS, **не vitest**.

- [ ] **Step 1: Написать падающие тесты**

Создать `test/restore-payload.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');

const {parseRestorePayload} = require('../src/picker/restore-payload');

test('пустое сообщение значит самый свежий снимок', () => {
  // Кнопка Restore last на панели шлёт пустоту. Снимок, а не lastLayout:
  // последний обнуляется через секунду после закрытия окон.
  assert.deepEqual(parseRestorePayload(''), {id: 'last', sessionIds: []});
  assert.deepEqual(parseRestorePayload(null), {id: 'last', sessionIds: []});
});

test('сырая строка — это id снимка', () => {
  // С панели прилетает так же, как и прежде: ветка не меняется.
  assert.deepEqual(parseRestorePayload('snap-1'), {id: 'snap-1', sessionIds: []});
});

test('объект от пикера разбирается, а не уезжает литералом', () => {
  // Без этой ветки id снимка стал бы строкой `{"id":"snap-1"}`, и
  // восстановление молча не находило бы ничего: ошибки на такой вход нет,
  // есть пустой результат.
  assert.deepEqual(parseRestorePayload('{"id":"snap-1"}'), {id: 'snap-1', sessionIds: []});
});

test('sessionIds доезжает до restoreSnapshot', () => {
  assert.deepEqual(parseRestorePayload('{"id":"snap-1","sessionIds":["aaa"]}'),
    {id: 'snap-1', sessionIds: ['aaa']});
});

test('объект без id — тоже самый свежий снимок', () => {
  assert.deepEqual(parseRestorePayload('{"sessionIds":["aaa"]}'),
    {id: 'last', sessionIds: ['aaa']});
});

test('мусор в sessionIds отбрасывается, а снимок поднимается целиком', () => {
  // Полбеды лучше беды: раскладка поднимется вся, а не ни одна.
  assert.deepEqual(parseRestorePayload('{"id":"snap-1","sessionIds":"aaa"}'),
    {id: 'snap-1', sessionIds: []});
});
```

- [ ] **Step 2: Прогнать — тесты должны упасть**

Run: `cd /home/popstas/projects/js/windows-mqtt && node --test test/restore-payload.test.js`
Expected: FAIL — `Cannot find module '../src/picker/restore-payload'`.

- [ ] **Step 3: Написать `src/picker/restore-payload.js`**

Файл целиком (CommonJS, как соседи в этом каталоге):

```javascript
/**
 * Тело просьбы о восстановлении — от панели и от пикера.
 *
 * С панели прилетает сырая строка (или пустота, что значит «самый свежий»), от
 * ccfzf-picker — объект `{id, sessionIds}`. Без разбора JSON id снимка стал бы
 * литералом `{"id":"snap-1"}`, и восстановление молча не находило бы ничего:
 * ошибки у него на такой вход нет, есть пустой результат.
 *
 * Тот же приём, что у claudeFocusSlot, и по той же причине.
 */
function parseRestorePayload(message) {
  const raw = String(message ?? '').trim();
  if (!raw) return { id: 'last', sessionIds: [] };
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed?.sessionIds)
        ? parsed.sessionIds.filter(v => typeof v === 'string' && v)
        : [];
      const id = typeof parsed?.id === 'string' && parsed.id.trim() ? parsed.id.trim() : 'last';
      return { id, sessionIds: ids };
    } catch {
      // Не JSON, хотя начинается с фигурной скобки: снимка с таким id всё
      // равно нет, и «самый свежий» здесь честнее отказа.
      return { id: 'last', sessionIds: [] };
    }
  }
  return { id: raw, sessionIds: [] };
}

module.exports = {parseRestorePayload};
```

- [ ] **Step 4: Прогнать — тесты должны пройти**

Run: `cd /home/popstas/projects/js/windows-mqtt && node --test test/restore-payload.test.js`
Expected: PASS

- [ ] **Step 5: Связать в `windows.js`**

В шапку, рядом с прочими помощниками из `../picker/` (строки 7–21):

```javascript
const {parseRestorePayload} = require('../picker/restore-payload');
```

Сама `claudeSnapshotRestore` (строка 657) становится:

```javascript
  async function claudeSnapshotRestore(topic, message) {
    const { id, sessionIds } = parseRestorePayload(message);
    log(`< ${topic}: ${id}${sessionIds.length ? ` (${sessionIds.length})` : ''}`);
    try {
      const {restored, skipped} = await winMan.restoreSnapshot({id, sessionIds});
      log(`claude-wt snapshot ${id}: restored ${restored.length}, skipped ${skipped.length}`);
      if (!restored.length && !skipped.length) notifyPicker('claude-wt: нечего восстанавливать');
    } catch (e) {
      log(`claude-wt snapshot restore failed: ${e.message}`, 'error');
      notifyPicker(`claude-wt: ошибка восстановления — ${e.message}`);
    }
  }
```

Проверить, что `claudeSnapshotRestorePayload` (строка 724, ветка stdin) продолжает работать: она передаёт `payload?.id` строкой, и ветка `raw.startsWith('{')` на ней не сработает.

- [ ] **Step 6: Прогнать весь набор**

Run: `cd /home/popstas/projects/js/windows-mqtt && npm test`
Expected: PASS, ни один прежний тест не сломан.

- [ ] **Step 7: Коммит**

```bash
cd /home/popstas/projects/js/windows-mqtt
git add src/picker/restore-payload.js src/modules/windows.js test/restore-payload.test.js
git commit -m "fix(windows): разбирать JSON в просьбе о восстановлении

ccfzf-picker публикует тело объектом, и без разбора id снимка уезжал в
restoreSnapshot литералом {\"id\":\"…\"} — ошибки на такой вход нет, есть
пустой результат. Сырая строка с панели читается как прежде.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: пикер — отрисовка режима и Enter

**Files:**
- Modify: `sessions.html:56-96` (стили), `234` (подсказка), `464-605` (отрисовка), `654-685` (`refresh`), `827-834` (`choose`), `1087-1097` (хоткей)
- Modify: `frontend-src/action-hotkey.js:22-29` (`KeyS` в `RESERVED_CODES`)
- Test: `test/action-hotkey.test.js`, `test/row-contract.test.js` (контракт строки)

**Interfaces:**
- Consumes: `window.PickerSnapshots.buildSnapshotRows / openIdsFromState` (задача 5), `window.PickerMode.parseQuery / withSnapshotPrefix` (задача 4), `window.StateShape.snapshotProblems` (задача 3), команда `restore_snapshot_mqtt` (задача 6), `canFocusWindows()` — как есть.
- Produces: работающий режим на экране.

- [ ] **Step 1: Хранить снимки из ответа**

Рядом с `projectRows` завести `let snapshotRows = [];` и наполнять его в `refresh()`, следом за `projectRows`:

```javascript
    // Претензии к записям снимков опрос не отбрасывают — та же причина, что и
    // у projects. Первая непустая строка отказа побеждает: показывается всё
    // равно одна.
    error = window.StateShape.projectProblems(state)[0]
      || window.StateShape.snapshotProblems(state)[0] || '';
    lastSessions = state.sessions;
    projectRows = window.ProjectList.buildProjectList(state);
    // Поля может не быть — старый агрегатор на той стороне. Тогда режим /s
    // покажет пустой список, и это честный ответ, а не поломка.
    snapshotRows = Array.isArray(state.snapshots) ? state.snapshots : [];
```

- [ ] **Step 2: Написать отрисовку**

Рядом с `renderProjects`, новая функция:

```javascript
  /**
   * Строки снимков: заголовок раскладки и её сессии одним потоком.
   *
   * Заголовок в `rows` не кладётся вместе с сессиями по одному правилу с
   * группами сессий — но здесь кладётся: у него есть своё действие, Enter
   * поднимает раскладку целиком. Поэтому и класс `row`, а не `group-label`.
   */
  function renderSnapshots(query, items, nowSec) {
    const open = window.PickerSnapshots.openIdsFromState(lastState);
    for (const row of window.PickerSnapshots.buildSnapshotRows(snapshotRows, open, query)) {
      const index = rows.length;
      rows.push(row);
      if (row.kind === 'snapshot') {
        const missing = row.missing
          ? `${row.missing} не открыты`
          : 'все на экране';
        items.push({
          key: row.key,
          html: `<div class="row snapshot" data-index="${index}">` +
            `<div class="dot"></div>` +
            `<div class="text"><div class="name">${escapeHtml(row.label)}</div></div>` +
            `<div class="meta"><div class="count">${row.total} · ${escapeHtml(missing)}</div>` +
            `</div></div>`,
        });
        continue;
      }
      // Открытая сессия — тусклая: восстановление её всё равно пропустит, а
      // Enter на ней поднимет уже существующее окно.
      items.push({
        key: row.key,
        html: `<div class="row snapshot-session${row.open ? ' closed' : ''}" data-index="${index}"` +
          ` title="${escapeHtml(row.cwd)}">` +
          `<div class="dot${row.open ? ' active' : ''}"></div>` +
          `<div class="text"><div class="name">${escapeHtml(row.label)}</div>` +
          (toggles.showPaths
            ? `<div class="cwd">${escapeHtml(shortPath(row.cwd))}</div>` : '') +
          `</div>` +
          `<div class="meta"><div class="count">${row.open ? '▣ открыта' : ''}</div>` +
          `</div></div>`,
      });
    }
  }
```

`nowSec` в сигнатуре — ради единообразия с соседями; если линтер ругается на неиспользуемый параметр, убрать его и из вызова.

- [ ] **Step 3: Подключить режим в `render()`**

```javascript
    const { mode, query } = window.PickerMode.parseQuery(search.value);
    // Режим снимков предлагается только там, где восстановление выполнимо:
    // те же условия, что у ветки focus. Не выполнены — `/s` остаётся обычным
    // поиском по сессиям, и Enter делает привычное, а не молчит.
    const snapshotsMode = mode === 'snapshots' && canFocusWindows();
    if (mode === 'projects') renderProjects(query, items, nowSec);
    else if (snapshotsMode) renderSnapshots(query, items, nowSec);
    else renderSessions(mode === 'snapshots' ? search.value.trim() : query, items, nowSec);
```

И ветка пустого списка — третьим случаем в том же `if`, что уже разбирает `mode === 'projects'`:

```javascript
        message.textContent = mode === 'projects'
          ? (projectRows.length ? 'Nothing matches.'
            : lastState.sessions ? 'No projects — is ccfzf on the host up to date?'
              : 'Loading…')
          : snapshotsMode
            ? (snapshotRows.length ? 'Nothing matches.'
              // Пустой список снимков почти всегда значит «трекер на той
              // стороне ещё не научился их публиковать» — на вид это не
              // отличить от «раскладок ещё не запоминали».
              : lastState.sessions ? 'No snapshots — is the window tracker up to date?'
                : 'Loading…')
            : (groups.length ? 'Nothing matches.' : 'No claude sessions yet.');
```

- [ ] **Step 4: Научить `choose()`**

```javascript
  function choose() {
    const row = rows[active];
    if (!row) return;
    // Заголовок снимка: поднять раскладку целиком.
    if (row.kind === 'snapshot') return restoreSnapshot(row.id, []);
    // Сессия из снимка: у открытой окно уже есть, и Enter должен поднять его,
    // а не заводить второе — восстановление её всё равно пропустило бы.
    if (row.kind === 'snapshot-session') {
      return row.open ? focusSession(row) : restoreSnapshot(row.snapshotId, [row.id]);
    }
    if (row.kind === 'project') return newSession(row.cwd);
    return openSession(row);
  }
```

И сама функция, рядом с `focusSession`:

```javascript
  /**
   * Попросить поднять раскладку снимка.
   *
   * Пикер гасится до просьбы, как и на фокусе: окна поднимутся на том же
   * экране, и держать поверх них список незачем. Итог не показывается —
   * ответа у просьбы нет по замыслу, а не сработавшее видно на экране.
   */
  async function restoreSnapshot(snapshotId, sessionIds) {
    await invoke('hide_picker');
    try {
      await invoke('restore_snapshot_mqtt', { id: snapshotId, sessionIds });
    } catch (e) {
      error = String(e);
      render();
      return;
    }
    error = '';
  }
```

- [ ] **Step 5: Подсказка в статуслайне**

Строка 234 становится динамической. Заменить статичный текст на `<span id="menu-hint"></span>` и красить его там же, где красятся переключатели, — в `paintToggles()`:

```javascript
    // Про `/s` рассказываем только там, где он работает: подсказка о режиме,
    // которого нет, обманывает ровно так же, как молчащий Enter.
    menuHint.textContent = '^K - Session menu, ^N - new session, ^A - all projects'
      + (canFocusWindows() ? ', ^S - snapshots' : '');
```

`const menuHint = document.getElementById('menu-hint');` — рядом с `const statusline = …` (строка 394).

`paintToggles()` зовётся не на каждый опрос, а `canFocusWindows()` зависит от ответа; добавить вызов `paintToggles()` в конец `regroup()` — он идёт следом за каждым удачным опросом.

- [ ] **Step 6: Хоткей `^S`**

Рядом с веткой `KeyA` (строка 1087):

```javascript
    if (plainCtrl && e.code === 'KeyS') {
      // Ставит `/s ` в начало строки поиска — как `^A` ставит `/a `. Режим
      // живёт в самом тексте, стирание префикса возвращает к сессиям.
      //
      // Молча ничего не делает там, где восстановление невыполнимо: тот же
      // отказ, что и у подсказки, и лучше молчащего режима с молчащим Enter.
      e.preventDefault();
      if (!canFocusWindows()) return;
      search.value = window.PickerMode.withSnapshotPrefix(search.value);
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
      onSearchInput();
      return;
    }
```

**`KeyS` свободен, но его надо занять.** `BUILTIN_ACTION_KEYS` в `frontend-src/action-hotkey.js:16` — это `n, p, u, r, i`; `KeyK` и `KeyA` перечислены отдельно в `RESERVED_CODES` (строки 22–29). `KeyS` там нет, поэтому настроенное действие сейчас вправе его забрать, и тогда `^S` уводил бы в действие, а не в режим. Дописать в `RESERVED_CODES`:

```javascript
    // Тоже ярлык, а не действие: ставит `/s ` в начало строки поиска. Клавишу
    // занимает и отдавать настроенному действию её нельзя — иначе `^S` уводил
    // бы в действие, а режим оказался бы доступен только набором руками.
    'KeyS',
```

Тест — в `test/action-hotkey.test.js`, через `isReserved`, рядом со строками 69–70, которые так же сторожат `Ctrl+A`:

```javascript
  // ^S — ярлык режима снимков, не действие. Отдать его настроенному действию
  // значило бы увести `^S` в действие, а режим оставить только набором руками.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+S')), true);
  assert.strictEqual(isReserved(parseHotkey('Cmd+S')), true);
```

- [ ] **Step 7: Стили**

В `<style>`, следом за `.row.closed .name` (строка 90):

```css
        /* Заголовок раскладки. Не group-label: у него есть своё действие —
           Enter поднимает снимок целиком, — поэтому это строка, а не подпись.
           Отличается от строки сессии разрядкой и цветом подписи, как группа. */
        .row.snapshot .name {
            font-size: 11px; letter-spacing: .06em; color: #9aa0a8;
        }
        .row.snapshot .dot { background: #4d525a; }
        /* Сессия, чьё окно уже открыто: восстановление её пропустит. Тусклая
           тем же способом, что и закрытая сессия в списке. */
        .row.snapshot-session.closed .name { color: #a8adb5; }
```

Класс `.closed` на строке уже гасит имя через существующее правило; отдельного цвета для `.count` не нужно — `.meta` его задаёт.

- [ ] **Step 8: Прогнать всё**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test && (cd src-tauri && cargo test)`
Expected: PASS. `test/frontend-load.test.js` и `test/row-contract.test.js` должны остаться зелёными.

- [ ] **Step 9: Проверить глазами**

Run: `cd /home/popstas/projects/js/ccfzf-picker && cargo tauri dev` (или `npm run dev`, если он заведён)

Проверить:
1. `^S` (или `/s` руками) — список снимков, у заголовка счёт «не открыты».
2. Открытые сессии тусклые с пометкой `▣`.
3. Поиск фильтрует; снимок без подошедших уходит с заголовком.
4. Стирание `/s` возвращает к сессиям.
5. На машине без `windowHost` в конфиге режима нет, подсказка без `^S`.

- [ ] **Step 10: Коммит**

```bash
cd /home/popstas/projects/js/ccfzf-picker
git add sessions.html frontend-src/action-hotkey.js test/action-hotkey.test.js
git commit -m "feat(picker): режим снимков на экране

Enter на заголовке поднимает раскладку целиком, на строке сессии — одну её;
у открытой сессии окно уже есть, и Enter поднимает его. Режим и подсказка
показываются только там, где восстановление выполнимо.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: документы и отметка в TODO

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/TODO.md`
- Modify: скилл `/claude-wt` — `~/.claude/skills/claude-wt/ccfzf-picker.md` и `SKILL.md`

- [ ] **Step 1: README — про режим**

В раздел «Настройка», следом за абзацем про `pathMap`:

```markdown
Если настроен `mqtt` и `windowHost` совпадает с машиной, где видны окна, у
пикера появляется режим снимков — `^S` или `/s` в строке поиска. Снимок
раскладки запоминает оконный трекер, когда состав открытых сессий устоялся;
Enter на заголовке поднимает раскладку целиком, на строке сессии — одну её.
Снимки приезжают тем же ответом агрегатора, что и список; своего клиента у
пикера для них нет.
```

- [ ] **Step 2: CLAUDE.md — правило, за которое заплачено**

В раздел «Правила, за которые уже заплачено»:

```markdown
- **Снимки раскладки приезжают в ответе агрегатора, а не по запросу.** Список
  снимков в windows-mqtt отвечал через `mqtt.sendEvent()` — это запись в stdout
  своему Tauri-процессу, и стороннему читателю там взяться неоткуда. Дорога
  та же, что у окон: демон кладёт снимки в файл трекера, `ccfzf --state` их
  отдаёт. Обратно уходит только просьба о восстановлении, публикацией в
  `<base>/windows/claude-snapshot-restore`. Заводить ради списка подписку в
  пикере значило бы держать соединение и ждать — ровно того, чего эта схема
  избегает.

- **Тело просьбы о восстановлении разбирается на той стороне двумя видами.**
  С панели openHASP прилетает сырая строка или пустота, от пикера — объект
  `{id, sessionIds}`. `parseRestorePayload` в windows-mqtt знает оба; без
  разбора JSON id снимка уезжал в `restoreSnapshot` литералом `{"id":"…"}`, и
  ошибки на такой вход нет — есть пустой результат.
```

- [ ] **Step 3: TODO — отметить сделанное**

В `docs/TODO.md` заменить строку задачи на `- [x]` с коротким пояснением, где что легло.

- [ ] **Step 4: Скилл `/claude-wt`**

В `~/.claude/skills/claude-wt/ccfzf-picker.md` — новый раздел про режим снимков и дорогу данных. В `SKILL.md`, в раздел «Поток», дописать снимки к тому, что везёт файл трекера, и строку в таблицу частых ошибок:

| Симптом | Причина |
|---|---|
| Режим `/s` в пикере пуст, хотя снимки есть | Трекер на той стороне старой версии — снимки в файл окон не пишет; либо `windowHost`/`mqtt` в конфиге пикера не настроены и режима нет вовсе |

- [ ] **Step 5: Прогнать проверку на приватные данные**

Run: `cd /home/popstas/projects/js/ccfzf-picker && npm test`
Expected: PASS, включая `test/no-private-data.test.js`.

- [ ] **Step 6: Коммит**

```bash
cd /home/popstas/projects/js/ccfzf-picker
git add README.md CLAUDE.md docs/TODO.md
git commit -m "docs: режим снимков раскладки

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Деплой после реализации

Правки в windows11-manager и windows-mqtt едут в живое приложение (см. скилл `/claude-wt`):

```bash
cd /home/popstas/projects/js/windows-mqtt && npm run deploy-fast
```

Помнить про две молчащие ловушки `deploy-fast` через `ssh popstas-pc`: джанкшен `node_modules\windows11-manager` сетевой логон не проходит (обход — `xcopy` напрямую), и `cmd /c start` в конце скрипта до рабочего стола не доходит (поднимать через временную задачу `schtasks`). Проверка — `tasklist /FI "IMAGENAME eq windows-mqtt.exe" /FO CSV` показывает `Console`, сессию 1.

Агрегатор на pc-virt обновляется своим репозиторием. Пикер — скриптами из `data/scripts/`.

## Общая проверка после всех задач

- [ ] `cd /home/popstas/projects/js/ccfzf-picker && npm test` — зелено
- [ ] `cd /home/popstas/projects/js/ccfzf-picker/src-tauri && cargo test` — зелено
- [ ] `cd /home/popstas/projects/js/windows11-manager && npm test` — зелено
- [ ] `cd /home/popstas/projects/js/windows-mqtt && npm test` — зелено
- [ ] `cd /home/popstas/projects/shell/ccfzf && for t in tests/test_*.py; do python3 "$t"; done` — зелено
- [ ] `ccfzf --state | node scripts/check-state.js` на живом ответе — без претензий
- [ ] Полный путь на Windows-машине: `^S` → Enter на заголовке → окна раскладки поднялись
- [ ] Полный путь на Windows-машине: `^S` → Enter на закрытой сессии → поднялось одно окно
