# Режим fullscreen: сессии блоками — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Второй вид того же списка — широкое окно, где сессия показана карточкой, а группы, проекты и снимки стоят блоками со своими скроллами; переключается `^F`.

**Architecture:** Один рендер, две раскладки. `render()` в `sessions.html` ветвится по флагу `fullscreen`: узкий режим рисует нынешний единственный поток строк в `#list`, широкий — блоки внутри того же `#list`, у каждого свой скролл и своё состояние `rendered`. Что во что складывается и куда ходят стрелки, считает новый чистый модуль `frontend-src/picker-blocks.js`. Карточка — вёрстка, а не вторая разметка: та же строка под селектором `#list.blocks`.

**Tech Stack:** Ванильный JS без сборщика (шим `module.exports` / `globalThis`), `node --test` для фронтенда, Tauri 2 + Rust для окна, `cargo test` для оболочки.

**Spec:** [docs/superpowers/specs/2026-08-14-fullscreen-blocks-design.md](../specs/2026-08-14-fullscreen-blocks-design.md)

## Global Constraints

- **Всё, что видит человек, — по-английски; всё, что видит разработчик, — по-русски.** Заголовки блоков, строка свёрнутого блока, подсказка про `^F` — английские. Комментарии, названия тестов и сообщения `assert` — русские.
- **Тесты фронтенда гоняются только через `npm test`** (`node --test` из корня). `node --test test/` на этих версиях Node не работает.
- **Тесты оболочки — `cd src-tauri && cargo test`.**
- **Новый файл в `frontend-src/` обязан попасть в два места:** тег `<script src="…">` в `sessions.html` и список `FILES` в `scripts/prepare-frontend.js`. Расхождение ловит `test/frontend-load.test.js`.
- **Имена машин в репозиторий не возвращать** — ни в тестах, ни в примерах (`test/no-private-data.test.js`).
- **Список не перерисовывается целиком:** запись в DOM идёт через `planListSync`, а не `innerHTML` на каждый тик.
- **Модуль в `frontend-src/` пишется шимом**, как соседи:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () { /* … */ });
```

- **Соседний модуль берётся через `globalThis`, а не `root`** (тот внутрь factory не передаётся):

```js
const filterApi = typeof module === 'object' && module.exports
  ? require('./picker-filter')
  : globalThis.PickerFilter;
```

---

### Task 1: `picker-blocks.js` — что во что складывается

**Files:**
- Create: `frontend-src/picker-blocks.js`
- Create: `test/picker-blocks.test.js`
- Modify: `sessions.html:347` (добавить тег `<script src="picker-blocks.js">` после `picker-list-sync.js`)
- Modify: `scripts/prepare-frontend.js:12-34` (добавить `'frontend-src/picker-blocks.js'` в `FILES`)

**Interfaces:**
- Consumes: `PickerFilter.filterSessions(groups, query)`, `PickerFilter.filterProjects(rows, query)` (`frontend-src/picker-filter.js`); группы вида `{ label, sessions }` от `SessionGroups.groupSessions`; строки проектов от `ProjectList.buildProjectList`; строки снимков от `PickerSnapshots.buildSnapshotRows` (плоский список с `kind: 'snapshot' | 'snapshot-session'` и своим `key`).
- Produces:
  - `buildBlocks({ groups, projects, snapshots, mode, query, trackerHere, expanded }) → [{ key, label, kind, rows, collapsed }]`,
    где `kind` — `'sessions' | 'projects' | 'snapshots'`, `rows` — готовые строки в порядке показа, `collapsed` — булево.
  - `collapsedRow(block) → { kind: 'block-toggle', blockKey, label, count }` — одна строка свёрнутого блока.

- [ ] **Step 1: Написать падающий тест**

Создать `test/picker-blocks.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildBlocks } = require('../frontend-src/picker-blocks');

/** Живая сессия в том объёме, в каком её читают блоки. */
function session(id, extra) {
  return { id, label: id, cwd: `/home/user/${id}`, live: true, ...extra };
}

// Полдень по местным часам: подпись свёрнутого блока считает дату местной, и
// от полудня она одинакова в любом часовом поясе, где гоняются тесты.
const AUG_12 = Math.floor(new Date(2026, 7, 12, 12, 0).getTime() / 1000);

const GROUPS = [
  { label: 'Active local sessions - 2', sessions: [session('a'), session('b')] },
  { label: 'Not running', sessions: [session('old', { live: false, lastActivity: AUG_12 })] },
];
const PROJECTS = [{ id: 'p1', kind: 'project', label: 'picker', cwd: '/home/user/picker' }];
const SNAPSHOTS = [{ key: 'sn:1', kind: 'snapshot', label: 'work', total: 3 }];

function base(extra) {
  return {
    groups: GROUPS, projects: PROJECTS, snapshots: SNAPSHOTS,
    mode: 'sessions', query: '', trackerHere: true, expanded: [], ...extra,
  };
}

test('каждая группа сессий становится блоком, проекты и снимки — своими', () => {
  const blocks = buildBlocks(base());
  assert.deepStrictEqual(blocks.map(b => b.label), [
    'Active local sessions - 2', 'Not running', 'Projects', 'Snapshots',
  ]);
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'sessions', 'projects', 'snapshots']);
});

test('пустой блок не заводится', () => {
  // Правило то же, по которому не заводится пустая половина живых сессий:
  // блок без строк — это заголовок, обещающий содержимое, которого нет.
  const blocks = buildBlocks(base({ projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'sessions']);
});

test('снимков нет там, где восстанавливать их нечем', () => {
  // То же условие, что у ^S: блок, чей Enter молчит, хуже отсутствующего.
  const blocks = buildBlocks(base({ trackerHere: false }));
  assert.ok(!blocks.some(b => b.kind === 'snapshots'));
});

test('префикс оставляет на экране один блок', () => {
  assert.deepStrictEqual(buildBlocks(base({ mode: 'projects' })).map(b => b.kind), ['projects']);
  assert.deepStrictEqual(buildBlocks(base({ mode: 'snapshots' })).map(b => b.kind), ['snapshots']);
});

test('запрос отбирает строки во всех блоках сразу', () => {
  // Снимки приезжают сюда уже отобранными: buildSnapshotRows берёт запрос
  // сама, и второй отбор здесь порвал бы пару «заголовок раскладки и её
  // сессии». Поэтому на непустом запросе вызывающая сторона передаёт то, что
  // осталось, — здесь ничего.
  const blocks = buildBlocks(base({ query: 'picker', snapshots: [] }));
  // Сессий с таким именем нет, проект есть — блоки сессий исчезают целиком.
  assert.deepStrictEqual(blocks.map(b => b.kind), ['projects']);
});

test('свёрнутая история — одна строка со счётом и датой последней активности', () => {
  const blocks = buildBlocks(base());
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, true);
  assert.strictEqual(history.rows.length, 1);
  assert.strictEqual(history.rows[0].kind, 'block-toggle');
  assert.strictEqual(history.rows[0].label, '1 session · last Aug 12');
});

test('развёрнутая история отдаёт свои сессии', () => {
  const blocks = buildBlocks(base({ expanded: ['g:Not running'] }));
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, false);
  assert.deepStrictEqual(history.rows.map(r => r.id), ['old']);
});

test('живые блоки свёрнутыми не приходят', () => {
  // Свёрнута только история: ради неё и заведено сворачивание — «что было
  // раньше» не должно оттеснять вниз «что работает сейчас».
  const blocks = buildBlocks(base());
  assert.strictEqual(blocks[0].collapsed, false);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test -- test/picker-blocks.test.js`
Expected: FAIL, `Cannot find module '../frontend-src/picker-blocks'`

- [ ] **Step 3: Написать модуль**

Создать `frontend-src/picker-blocks.js`:

```js
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const filterApi = typeof module === 'object' && module.exports
    ? require('./picker-filter')
    : globalThis.PickerFilter;

  // Сворачивается только история: ради неё сворачивание и заведено — «что
  // было раньше» в широком окне не должно оттеснять вниз «что работает
  // сейчас». Признак — заголовок группы, который ставит groupSessions.
  const COLLAPSED_LABELS = ['Not running'];

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * Подпись свёрнутого блока: сколько сессий и когда была последняя.
   *
   * Месяц из своей таблицы, а не toLocaleDateString: у того вид зависит от
   * локали системы, а всё видимое человеку у нас английское — на чужой локали
   * подпись разошлась бы с остальным списком. Дата местная (getMonth/getDate),
   * потому что «когда я в это заходил» человек меряет своими часами.
   */
  function collapsedLabel(count, lastAt) {
    const word = count === 1 ? 'session' : 'sessions';
    if (!lastAt) return `${count} ${word}`;
    const d = new Date(lastAt * 1000);
    return `${count} ${word} · last ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  function lastActivityOf(sessions) {
    return sessions.reduce((max, s) => Math.max(max, (s || {}).lastActivity || 0), 0);
  }

  /** Одна строка свёрнутого блока. Enter на ней разворачивает блок. */
  function collapsedRow(block) {
    return {
      kind: 'block-toggle',
      blockKey: block.key,
      count: block.rows.length,
      label: collapsedLabel(block.rows.length, lastActivityOf(block.rows)),
    };
  }

  /**
   * Блоки широкого режима.
   *
   * Блоки сессий приезжают из groupSessions один в один: своего деления у
   * fullscreen нет намеренно — второе правило группировки разошлось бы с
   * первым на первой же правке, а признак деления живых («своё окно или
   * чужое») тот же, что решает поведение Enter.
   *
   * Отбор идёт теми же filterSessions/filterProjects, что и в узком списке:
   * запрос без префикса отбирает строки во всех блоках сразу, и блок, где не
   * нашлось ничего, исчезает.
   */
  function buildBlocks(opts) {
    const o = opts || {};
    const mode = o.mode || 'sessions';
    const query = o.query || '';
    const expanded = new Set(o.expanded || []);
    const blocks = [];

    if (mode === 'sessions') {
      for (const group of filterApi.filterSessions(o.groups || [], query)) {
        blocks.push({
          key: `g:${group.label}`, label: group.label, kind: 'sessions',
          rows: group.sessions, collapsed: false,
        });
      }
    }

    // Проекты и снимки — блоки того же ряда, а не отдельные режимы: в широком
    // окне они помещаются рядом с сессиями. Префикс при этом смысла не теряет,
    // он оставляет на экране один блок.
    if (mode === 'sessions' || mode === 'projects') {
      const rows = filterApi.filterProjects(o.projects || [], query);
      if (rows.length) blocks.push({ key: 'projects', label: 'Projects', kind: 'projects', rows, collapsed: false });
    }
    // Снимки уже отобраны запросом на стороне buildSnapshotRows: у них своя
    // пара «заголовок раскладки и её сессии», и отбор строкой порознь порвал
    // бы её. trackerHere — то же условие, что у ^S.
    if ((mode === 'sessions' || mode === 'snapshots') && o.trackerHere) {
      const rows = o.snapshots || [];
      if (rows.length) blocks.push({ key: 'snapshots', label: 'Snapshots', kind: 'snapshots', rows, collapsed: false });
    }

    return blocks.map(block => {
      if (!COLLAPSED_LABELS.includes(block.label) || expanded.has(block.key)) return block;
      return { ...block, collapsed: true, rows: [collapsedRow(block)] };
    });
  }

  return { buildBlocks, collapsedRow, collapsedLabel };
});
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test -- test/picker-blocks.test.js`
Expected: PASS, все восемь тестов.

- [ ] **Step 5: Прописать модуль в двух местах**

В `sessions.html` — тег после `picker-list-sync.js` (порядок важен: модуль берёт `PickerFilter` из `globalThis` в момент загрузки, а тот подключён выше, строка 343):

```html
<script src="picker-list-sync.js"></script>
<script src="picker-blocks.js"></script>
```

В `scripts/prepare-frontend.js` — в конец списка `FILES`:

```js
  'frontend-src/picker-blocks.js',
```

- [ ] **Step 6: Прогнать весь набор**

Run: `npm test`
Expected: PASS. Отдельно смотреть на `frontend-load.test.js` — он и сторожит, что тег и `FILES` не разошлись.

- [ ] **Step 7: Коммит**

```bash
git add frontend-src/picker-blocks.js test/picker-blocks.test.js sessions.html scripts/prepare-frontend.js
git commit -m "feat(picker): блоки широкого режима считаются отдельным модулем"
```

---

### Task 2: Навигация по блокам

**Files:**
- Modify: `frontend-src/picker-blocks.js` (добавить `moveInBlocks` и `moveBetweenBlocks`)
- Modify: `test/picker-blocks.test.js` (дописать тесты навигации)

**Interfaces:**
- Consumes: плоский массив строк, где у каждой есть числовое поле `block` — номер её блока. Это поле проставляет `sessions.html` при сборке (Task 5).
- Produces:
  - `moveInBlocks(rows, active, delta) → number` — новый индекс: `↑/↓` внутри своего блока, с упором в края.
  - `moveBetweenBlocks(rows, active, delta) → number` — новый индекс: `←/→` в соседний блок, на строку с тем же порядковым номером внутри него или в последнюю, если сосед короче.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/picker-blocks.test.js`:

```js
const { moveInBlocks, moveBetweenBlocks } = require('../frontend-src/picker-blocks');

// Три блока подряд в одном плоском массиве: 0-1 в первом, 2-3-4 во втором,
// 5 в третьем. Ровно так строки и лежат в rows у страницы.
const ROWS = [
  { block: 0 }, { block: 0 },
  { block: 1 }, { block: 1 }, { block: 1 },
  { block: 2 },
];

test('стрелки вверх-вниз ходят внутри блока', () => {
  assert.strictEqual(moveInBlocks(ROWS, 2, 1), 3);
  assert.strictEqual(moveInBlocks(ROWS, 3, -1), 2);
});

test('вниз в конце блока упирается, а не заворачивается', () => {
  // Круг по одной колонке из шести читался бы как «список кончился и начался
  // заново», а конец блока в широком режиме виден глазом.
  assert.strictEqual(moveInBlocks(ROWS, 4, 1), 4);
  assert.strictEqual(moveInBlocks(ROWS, 2, -1), 2);
});

test('вправо переводит в соседний блок на ту же позицию', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 1, 1), 3);
  assert.strictEqual(moveBetweenBlocks(ROWS, 3, -1), 1);
});

test('в коротком соседе выбирается последняя строка', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 4, 1), 5);
});

test('за крайним блоком стоять некуда — выбор не двигается', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 5, 1), 5);
  assert.strictEqual(moveBetweenBlocks(ROWS, 0, -1), 0);
});

test('пустой список никуда не ведёт', () => {
  assert.strictEqual(moveInBlocks([], 0, 1), 0);
  assert.strictEqual(moveBetweenBlocks([], 0, 1), 0);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `npm test -- test/picker-blocks.test.js`
Expected: FAIL, `moveInBlocks is not a function`

- [ ] **Step 3: Дописать модуль**

В `frontend-src/picker-blocks.js`, перед `return`:

```js
  /** Индексы строк одного блока, в порядке показа. */
  function blockIndexes(rows, block) {
    const out = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].block === block) out.push(i);
    return out;
  }

  /**
   * `↑/↓` — внутри своего блока, с упором в края.
   *
   * Не по кругу, в отличие от узкого списка: там круг возвращает к началу
   * единственного списка, а здесь он гонял бы по одной колонке из шести, и на
   * глаз это неотличимо от «выбор застрял».
   */
  function moveInBlocks(rows, active, delta) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    const current = list[active];
    if (!current) return 0;
    const indexes = blockIndexes(list, current.block);
    const at = indexes.indexOf(active);
    const next = Math.min(indexes.length - 1, Math.max(0, at + delta));
    return indexes[next];
  }

  /**
   * `←/→` — в соседний блок, на строку с тем же порядковым номером.
   *
   * Сосед короче — берётся его последняя строка: прыжок в начало сбивал бы
   * глаз, который держится за высоту строки, а не за её номер.
   */
  function moveBetweenBlocks(rows, active, delta) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    const current = list[active];
    if (!current) return 0;
    const blocks = [...new Set(list.map(r => r.block))];
    const at = blocks.indexOf(current.block);
    const target = blocks[at + delta];
    if (target === undefined) return active;
    const offset = blockIndexes(list, current.block).indexOf(active);
    const indexes = blockIndexes(list, target);
    return indexes[Math.min(offset, indexes.length - 1)];
  }
```

И в `return`: `{ buildBlocks, collapsedRow, collapsedLabel, moveInBlocks, moveBetweenBlocks }`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/picker-blocks.test.js`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/picker-blocks.js test/picker-blocks.test.js
git commit -m "feat(picker): стрелки в блоках ходят внутри блока, ←/→ между"
```

---

### Task 3: Флаг `fullscreen` в `ui.json`

**Files:**
- Modify: `frontend-src/ui-state.js:57-80` (`normalizeUiState`, `uiStateToSave`)
- Modify: `test/ui-state.test.js`

**Interfaces:**
- Consumes: ничего нового; Rust хранит `ui.json` как есть (`load_ui`/`save_ui`, `src-tauri/src/main.rs:903-911`), проверки формы там нет.
- Produces: `normalizeUiState(raw, defaults) → { sort, toggles, fullscreen }` и `uiStateToSave(sort, toggles, fullscreen) → тот же вид`.

Поле — третье верхнего уровня, а **не** запись в `toggles`: у галки две оси (`list`, `statusline`) и чекбокс в статуслайне, а fullscreen — не колонка и в статуслайн не выносится.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/ui-state.test.js`:

```js
test('режим окна читается из файла и переживает запись', () => {
  const ui = normalizeUiState({ fullscreen: true }, { toggles: {} });
  assert.strictEqual(ui.fullscreen, true);
  assert.strictEqual(uiStateToSave(ui.sort, ui.toggles, ui.fullscreen).fullscreen, true);
});

test('старый ui.json без режима читается как узкое окно', () => {
  // Умолчание — то, с чем пикер жил до появления режима: файл, написанный
  // прошлой версией, не должен открывать окно, которого человек не просил.
  assert.strictEqual(normalizeUiState({ sort: 'name' }, { toggles: {} }).fullscreen, false);
  assert.strictEqual(normalizeUiState(null, { toggles: {} }).fullscreen, false);
});

test('нелогичный режим в файле заменяется умолчанием', () => {
  assert.strictEqual(normalizeUiState({ fullscreen: 'да' }, { toggles: {} }).fullscreen, false);
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `npm test -- test/ui-state.test.js`
Expected: FAIL, `undefined !== true`

- [ ] **Step 3: Правка модуля**

В `frontend-src/ui-state.js`, в `normalizeUiState`, заменить возврат:

```js
    return {
      sort: groupsApi.normalizeSort(src.sort),
      toggles,
      // Третье поле верхнего уровня, а не запись в toggles: у галки две оси
      // и чекбокс в статуслайне, а режим окна — не колонка. Нелогичное
      // значение читается как узкое окно: испорченный файл не должен
      // открывать окно, которого человек не просил.
      fullscreen: src.fullscreen === true,
    };
```

и `uiStateToSave`:

```js
  function uiStateToSave(sort, toggles, fullscreen) {
    return normalizeUiState({ sort, toggles, fullscreen }, { toggles: toggles || {} });
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- test/ui-state.test.js`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add frontend-src/ui-state.js test/ui-state.test.js
git commit -m "feat(picker): ui.json помнит режим окна"
```

---

### Task 4: Команда `set_picker_size` в Rust

**Files:**
- Modify: `src-tauri/src/main.rs` (команда рядом с `hide_picker`, строка 173; регистрация в `invoke_handler`, строка ~1079; тест в `mod tests`, строка 1293)

**Interfaces:**
- Consumes: окно с меткой `picker` (`app.get_webview_window("picker")`).
- Produces: команда `set_picker_size(app, fullscreen: bool) -> Result<(), String>`, вызываемая со страницы как `invoke('set_picker_size', { fullscreen })`; константы `NARROW_SIZE: (f64, f64)` и `WIDE_SIZE: (f64, f64)`.

- [ ] **Step 1: Написать падающий тест**

В `src-tauri/src/main.rs`, в `mod tests`:

```rust
    /// Узкий размер обязан совпадать с тем, что стоит в tauri.conf.json:
    /// разойдись они, выход из режима давал бы окно не того размера, с
    /// которым пикер открылся, и поймать это можно было бы только глазами.
    #[test]
    fn narrow_size_matches_the_window_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &conf["app"]["windows"][0];
        assert_eq!(window["width"].as_f64().unwrap(), NARROW_SIZE.0);
        assert_eq!(window["height"].as_f64().unwrap(), NARROW_SIZE.1);
    }

    /// Широкий шире узкого — иначе режим не делает того, ради чего заведён.
    #[test]
    fn wide_size_is_wider_than_narrow() {
        assert!(WIDE_SIZE.0 > NARROW_SIZE.0);
        assert!(WIDE_SIZE.1 > NARROW_SIZE.1);
    }
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd src-tauri && cargo test narrow_size_matches_the_window_config`
Expected: FAIL, `cannot find value NARROW_SIZE in this scope`

- [ ] **Step 3: Написать команду**

В `src-tauri/src/main.rs`, после `hide_picker` (строка 176):

```rust
/// Размеры окна пикера.
///
/// Узкий обязан совпадать с `tauri.conf.json` — с ним пикер открывается, к
/// нему же возвращается выход из широкого режима; сторожит это тест.
/// Широкий — не весь экран намеренно: окно `alwaysOnTop`, и под ним должно
/// остаться видно, что было.
const NARROW_SIZE: (f64, f64) = (900.0, 640.0);
const WIDE_SIZE: (f64, f64) = (1400.0, 900.0);

/// Размер окна под режим списка.
///
/// Размер меняет Rust, а не страница: у окна нет декораций
/// (`decorations: false`), и `window.resizeTo` в webview на таком окне не
/// работает. Центровка после смены размера обязательна — без неё окно
/// растёт вправо и вниз от прежнего угла и уезжает за край экрана.
#[tauri::command]
fn set_picker_size(app: tauri::AppHandle, fullscreen: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("picker") else {
        return Err("picker window is gone".into());
    };
    let (w, h) = if fullscreen { WIDE_SIZE } else { NARROW_SIZE };
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| format!("cannot resize picker: {e}"))?;
    window
        .center()
        .map_err(|e| format!("cannot center picker: {e}"))
}
```

В список `invoke_handler` (строка ~1079) добавить `set_picker_size` рядом с `hide_picker`.

- [ ] **Step 4: Запустить тесты**

Run: `cd src-tauri && cargo test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(picker): размер окна под режим списка ставит Rust"
```

---

### Task 5: Отрисовка блоков

**Files:**
- Modify: `sessions.html:289` (разметка `#list`), `:22` (CSS `#list`), `:604-620` (`syncList` и `rendered`), `:629-763` (`renderProjects` / `renderSnapshots` / `renderSessions`), `:765-824` (`render`)

**Interfaces:**
- Consumes: `window.PickerBlocks.buildBlocks(...)` из Task 1; `window.PickerListSync.planListSync(prev, items, nodeCount)` без изменений.
- Produces: `let fullscreen` (флаг режима) и `let expandedBlocks` (массив ключей развёрнутых блоков) в области видимости страницы; у каждой строки в `rows` — поле `block` с номером её блока (его читает Task 6).

Разметка строк не дублируется: три нынешних рисовальщика распадаются на «строку» и «обход», и обход в широком режиме идёт по блокам, а разметка та же.

- [ ] **Step 1: Вынести сборку одной строки**

В `sessions.html` заменить тела трёх рисовальщиков так, чтобы разметка каждой строки считалась отдельной функцией, а рисовальщик только обходил список:

```js
  // Строка списка — одна функция на вид строки. Обход у узкого и широкого
  // режимов разный, а разметка одна: вторая копия разошлась бы с первой на
  // первой же правке колонок.
  function sessionItem(session, nowSec) {
    const index = rows.length;
    rows.push(session);
    const markable = markToggleId(session) !== null;
    const html = /* сюда дословно переносится нынешняя склейка из
      renderSessions, sessions.html:732-759 — от `<div class="row …` до
      `</div></div>`, вместе со всеми комментариями внутри неё */;
    return { key: `s:${session.id}`, html };
  }
```

Разметка переносится **дословно**, без правок: цель шага — только отделить сборку строки от обхода списка, и всякая правка разметки здесь смешалась бы с переносом так, что в ревью их уже не разделить.

Так же:

- `projectItem(project, nowSec)` — тело из `renderProjects` (`sessions.html:631-664`), возвращает `{ key: `p:${project.id}`, html }`;
- `snapshotItem(row, nowSec)` — тело из `renderSnapshots` (`sessions.html:680-711`), обе его ветки: заголовок раскладки (`row.kind === 'snapshot'`) и её сессия; ключ у обеих — уже готовый `row.key`.

Тогда узкие рисовальщики становятся обходом:

```js
  function renderSessions(query, items, nowSec) {
    for (const group of window.PickerFilter.filterSessions(groups, query)) {
      items.push({ key: `g:${group.label}`, html: `<div class="group-label">${escapeHtml(group.label)}</div>` });
      for (const session of group.sessions) items.push(sessionItem(session, nowSec));
    }
  }
```

- [ ] **Step 2: Проверить, что узкий режим не тронут**

Run: `npm test`
Expected: PASS — правка чисто механическая, ни один тест не должен измениться.

- [ ] **Step 3: Коммит промежуточного шага**

```bash
git add sessions.html
git commit -m "refactor(picker): разметка строки отделена от обхода списка"
```

- [ ] **Step 4: Добавить строку свёрнутого блока и рисовальщик блоков**

```js
  /** Строка свёрнутого блока: Enter на ней разворачивает блок. */
  function blockToggleItem(row) {
    const index = rows.length;
    rows.push(row);
    return {
      key: `bt:${row.blockKey}`,
      html: `<div class="row block-toggle" data-index="${index}">` +
        `<div class="dot"></div>` +
        `<div class="text"><div class="name">${escapeHtml(row.label)}</div></div>` +
        `</div>`,
    };
  }

  // Что нарисовано в каждом блоке. Своё состояние на блок, а не одно на весь
  // список: planListSync сравнивает содержимое одного контейнера, и общая
  // память заставляла бы его пересобирать все блоки на каждое изменение
  // любого. Ключ — тот же key блока.
  let renderedBlocks = new Map();
  // Каркас, который сейчас в DOM: ключи и подписи блоков. Сменился — контейнеры
  // пересобираются целиком; строки внутри правит planListSync, как и раньше.
  let blocksShape = '';

  function itemsOfBlock(block, nowSec) {
    if (block.collapsed) return block.rows.map(blockToggleItem);
    if (block.kind === 'projects') return block.rows.map(r => projectItem(r, nowSec));
    if (block.kind === 'snapshots') return block.rows.map(r => snapshotItem(r, nowSec));
    return block.rows.map(s => sessionItem(s, nowSec));
  }

  function renderBlocks(mode, query, nowSec) {
    const blocks = window.PickerBlocks.buildBlocks({
      groups, projects: projectRows, snapshots: snapshotItemsFor(query),
      mode, query, trackerHere: trackerIsHere(), expanded: expandedBlocks,
    });
    const shape = blocks.map(b => `${b.key}|${b.label}`).join('\n');
    if (shape !== blocksShape) {
      list.innerHTML = blocks.map(b =>
        `<div class="block" data-block="${escapeHtml(b.key)}">` +
        `<div class="group-label">${escapeHtml(b.label)}</div>` +
        `<div class="block-rows"></div></div>`).join('');
      blocksShape = shape;
      renderedBlocks = new Map();
    }
    blocks.forEach((block, i) => {
      const items = itemsOfBlock(block, nowSec);
      // Номер блока — на строке: по нему ходят стрелки (picker-blocks.js).
      for (let n = rows.length - items.length; n < rows.length; n++) rows[n].block = i;
      const body = list.children[i].querySelector('.block-rows');
      const plan = window.PickerListSync.planListSync(
        renderedBlocks.get(block.key), items, body.children.length);
      if (plan.mode === 'rebuild') body.innerHTML = plan.html.join('');
      else {
        const nodes = Array.from(body.children);
        for (const update of plan.updates) nodes[update.index].outerHTML = update.html;
      }
      renderedBlocks.set(block.key, { keys: plan.keys, html: plan.html });
    });
    return blocks.length;
  }
```

где `snapshotItemsFor(query)` — уже существующий расчёт строк снимков, вынесенный из `renderSnapshots`:

```js
  function snapshotItemsFor(query) {
    const open = window.PickerSnapshots.openIdsFromState(lastState);
    return window.PickerSnapshots.buildSnapshotRows(snapshotRows, open, query);
  }
```

- [ ] **Step 5: Развести две раскладки в `render()`**

```js
    const snapshotsMode = mode === 'snapshots' && trackerIsHere();
    list.classList.toggle('blocks', fullscreen);
    if (fullscreen) {
      // Узкое состояние отрисовки сбрасывается: вернувшись, planListSync
      // сравнил бы новые строки со старым снимком чужой раскладки и правил бы
      // не те элементы. Тот же сброс в обратную сторону — ниже.
      rendered = { keys: [], html: [] };
      renderBlocks(mode, mode === 'snapshots' ? search.value.trim() : query, nowSec);
    } else {
      blocksShape = '';
      renderedBlocks = new Map();
      if (mode === 'projects') renderProjects(query, items, nowSec);
      else if (snapshotsMode) renderSnapshots(query, items, nowSec);
      else renderSessions(mode === 'snapshots' ? search.value.trim() : query, items, nowSec);
      syncList(items);
    }
```

Объявить рядом с прочими переменными состояния (около строки 473):

```js
  // Режим окна и развёрнутые блоки. Первый живёт в ui.json (отступление от
  // умолчания запоминается, как сортировка и showAll), второе — только до
  // перерисовки: свёрнутость истории это умолчание блока, а не настройка.
  let fullscreen = false;
  let expandedBlocks = [];
```

- [ ] **Step 6: CSS блоков**

В `<style>` рядом с правилом `#list` (строка 22):

```css
        /* Широкий режим: блоки колонками, у каждого свой скролл. Свой
           overflow у самого списка гасится — иначе скроллов два вложенных, и
           колесо работает по тому, над которым курсор, то есть непредсказуемо. */
        #list.blocks {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
            gap: 8px; overflow: hidden; align-items: start;
        }
        /* min-height: 0 — иначе элемент грида растёт под содержимое, и
           скроллится не блок, а страница целиком. */
        #list.blocks .block {
            display: flex; flex-direction: column;
            min-height: 0; max-height: 100%; overflow: hidden;
        }
        #list.blocks .block-rows { overflow-y: auto; min-height: 0; }
```

- [ ] **Step 7: Проверить весь набор**

Run: `npm test`
Expected: PASS. `frontend-load.test.js` грузит `sessions.html` не целиком (только теги модулей), поэтому синтаксис страницы он не проверит — прочитать правку глазами обязательно.

- [ ] **Step 8: Коммит**

```bash
git add sessions.html
git commit -m "feat(picker): широкий режим рисует список блоками"
```

---

### Task 6: `^F`, стрелки, память режима

**Files:**
- Modify: `frontend-src/action-hotkey.js:26-37` (`RESERVED_CODES`)
- Modify: `test/action-hotkey.test.js:72-94`
- Modify: `sessions.html:1757-1808` (ветки `plainCtrl`, стрелки), `:1014-1028` (`paint`/`move`), `:580-602` (`paintToggles`, `saveUi`), `:1948-1960` и `:2014-2022` (чтение `ui.json`)

**Interfaces:**
- Consumes: `PickerBlocks.moveInBlocks` / `moveBetweenBlocks` (Task 2), `UiState.uiStateToSave(sort, toggles, fullscreen)` (Task 3), команда `set_picker_size` (Task 4).
- Produces: рабочий `^F` и навигация; никаких новых имён для следующих задач.

- [ ] **Step 1: Написать падающий тест на занятую букву**

В `test/action-hotkey.test.js`, в тест `занятыми считаются встроенные клавиши окна и только они`:

```js
  // ^F — ярлык широкого режима, не действие. Не займи его окно, встроенная
  // ветка съедала бы событие у действия, которое человек назначил на Ctrl+F,
  // и оно молча перестало бы работать.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+F')), true);
  assert.strictEqual(isReserved(parseHotkey('Cmd+F')), true);
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `npm test -- test/action-hotkey.test.js`
Expected: FAIL, `false !== true`

- [ ] **Step 3: Занять букву**

В `frontend-src/action-hotkey.js`, в конец `RESERVED_CODES`:

```js
    // Ярлык широкого режима: переключает раскладку списка. Действием он не
    // является, но клавишу занимает — отдать её настроенному действию значило
    // бы, что встроенная ветка перехватит первой, и действие молчит.
    'KeyF',
```

- [ ] **Step 4: Запустить тест**

Run: `npm test -- test/action-hotkey.test.js`
Expected: PASS

- [ ] **Step 5: Ветка `^F` на странице**

В `sessions.html`, рядом с ветками `^A` и `^S` (после строки 1784):

```js
    if (plainCtrl && e.code === 'KeyF') {
      // Режим окна — не префикс в строке поиска, в отличие от `^A` и `^S`: он
      // меняет раскладку, а не то, что показано, и потому живёт флагом и
      // помнится в ui.json.
      e.preventDefault();
      fullscreen = !fullscreen;
      expandedBlocks = [];
      invoke('set_picker_size', { fullscreen })
        .catch((err) => { error = String(err); });
      saveUi();
      render();
      return;
    }
```

- [ ] **Step 6: Стрелки**

Заменить хвост обработчика (строки 1804-1807):

```js
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    // ←/→ уходят в навигацию только в широком режиме и только когда каретка
    // на краю запроса: внутри набранного текста они правят его, как раньше.
    // Поле поиска сфокусировано всегда, и отнять у него стрелки насовсем
    // значило бы лишить человека правки запроса — ту же цену уже заплатили за
    // `^A`, второй раз она ни к чему.
    else if (fullscreen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && atQueryEdge(e.key)) {
      e.preventDefault();
      moveBlock(e.key === 'ArrowRight' ? 1 : -1);
    }
    else if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); invoke('hide_picker'); }
```

и рядом с `move` (строка 1019):

```js
  /** Каретка на краю запроса и ничего не выделено. */
  function atQueryEdge(key) {
    if (search.selectionStart !== search.selectionEnd) return false;
    return key === 'ArrowLeft'
      ? search.selectionStart === 0
      : search.selectionStart === search.value.length;
  }

  function move(delta) {
    if (!rows.length) return;
    // В широком режиме — внутри своего блока, с упором в края; в узком — по
    // кругу, как было: там список один, и круг возвращает к его началу.
    active = fullscreen
      ? window.PickerBlocks.moveInBlocks(rows, active, delta)
      : (active + delta + rows.length) % rows.length;
    paint();
    scrollActiveIntoView();
  }

  function moveBlock(delta) {
    if (!rows.length) return;
    active = window.PickerBlocks.moveBetweenBlocks(rows, active, delta);
    paint();
    scrollActiveIntoView();
  }

  // Только на нажатие клавиши, не в paint: render() тикает раз в секунду, и
  // scrollIntoView каждый раз дёргал бы скролл к активной строке, даже когда
  // человек сам ушёл вниз читать другие сессии.
  function scrollActiveIntoView() {
    const current = list.querySelectorAll('.row')[active];
    // block: 'nearest' сам находит ближайший скроллящийся предок — в широком
    // режиме это тело блока, в узком сам список.
    if (current) current.scrollIntoView({ block: 'nearest' });
  }
```

- [ ] **Step 7: Enter на свёрнутом блоке**

В `choose()` (`sessions.html:1320`), сразу после `if (!row) return;` — до разбора обычных видов строк:

```js
    if (row.kind === 'block-toggle') {
      expandedBlocks = [...expandedBlocks, row.blockKey];
      render();
      return;
    }
```

- [ ] **Step 8: Память режима и подсказка**

В `saveUi` — третий аргумент:

```js
    invoke('save_ui', { ui: window.UiState.uiStateToSave(sortMode, uiToggles, fullscreen) })
```

В обоих местах чтения `ui.json` (строки ~1956 и ~2021), рядом с `uiToggles = ui.toggles;`:

```js
      fullscreen = ui.fullscreen;
      // Размер просим у Rust сразу: окно открывается с размером из
      // tauri.conf.json, и без этого широкий режим помнился бы, а окно
      // осталось бы узким.
      if (fullscreen) invoke('set_picker_size', { fullscreen: true });
```

В `paintToggles` (строка 584) — подсказка:

```js
    menuHint.textContent = '^K / right click - Session menu, ^N - new session, ^A - all projects, ^F - wide view'
      + (trackerIsHere() ? ', ^S - snapshots' : '');
```

- [ ] **Step 9: Прогнать весь набор**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: PASS

- [ ] **Step 10: Коммит**

```bash
git add sessions.html frontend-src/action-hotkey.js test/action-hotkey.test.js
git commit -m "feat(picker): ^F переключает широкий режим и помнится в ui.json"
```

---

### Task 7: Карточка сессии

**Files:**
- Modify: `sessions.html:100-136` (CSS `.row`, `.name`, `.prompt`, `.summary`, `.meta` — добавить правила под `#list.blocks`)

**Interfaces:**
- Consumes: разметку строки из Task 5 — она не меняется вовсе.
- Produces: ничего для следующих задач.

Карточка делается вёрсткой, а не второй разметкой: поля `prompt` и `summary` уже в строке и уже под галками `showPrompt`/`showAnswer`; в узком списке их сжимает в строку `white-space: nowrap`.

- [ ] **Step 1: Написать правила**

В `<style>`, после правил широкого режима из Task 5:

```css
        /* Карточка: та же строка, другая вёрстка. Метаданные уходят под текст,
           а не вправо — в колонке 420px правая группа отобрала бы у имени
           почти всю ширину. */
        #list.blocks .row {
            align-items: flex-start; flex-wrap: wrap; gap: 8px;
            padding: 8px 12px; border-radius: 6px;
        }
        #list.blocks .text { flex: 1 1 100%; }
        #list.blocks .meta { flex: 1 1 100%; margin-left: 0; flex-wrap: wrap; gap: 10px; }
        /* Запрос и ответ — до трёх строк каждый, с обрезкой по последней.
           Ради этого режим и заведён: в строке от них видно первые слова, а
           узнают сессию как раз по тому, чем она занята. */
        #list.blocks .prompt,
        #list.blocks .summary {
            white-space: normal; display: -webkit-box;
            -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
        }
        /* Имя переносится: обрезка многоточием оставляла бы от длинного имени
           сессии первые пару слов, а в карточке место под него есть. */
        #list.blocks .name { white-space: normal; }
        /* Кружок стоит у первой строки имени, а не по центру карточки. */
        #list.blocks .dot { margin-top: 5px; }
```

- [ ] **Step 2: Проверить набор**

Run: `npm test`
Expected: PASS (правка чисто в CSS, тесты её не видят — она проверяется глазами на шаге 3).

- [ ] **Step 3: Коммит**

```bash
git add sessions.html
git commit -m "feat(picker): в широком режиме сессия показана карточкой"
```

---

### Task 8: Правило в CLAUDE.md и закрытие задачи

**Files:**
- Modify: `CLAUDE.md` (раздел «Правила, за которые уже заплачено»)
- Modify: `docs/TODO.md:5-27` (убрать выполненный пункт)

- [ ] **Step 1: Записать правило**

В `CLAUDE.md`, в конец раздела «Правила, за которые уже заплачено»:

```markdown
- **Широкий режим — вторая раскладка того же списка, а не второй список.**
  `^F` переключает флаг `fullscreen`: `#list` получает класс `blocks` и хранит
  не строки, а блоки — по блоку на группу `groupSessions`, плюс `Projects` и
  `Snapshots`. Своего деления на группы у режима нет намеренно: второе правило
  группировки разошлось бы с первым на первой же правке. Разметка строки одна
  на оба режима (`sessionItem`, `projectItem`, `snapshotItem`), карточка — это
  CSS под `#list.blocks`, а не вторая разметка.

  Состояние отрисовки при переключении сбрасывается в обе стороны: `planListSync`
  сравнивает новые строки со снимком прошлой раскладки и правил бы не те
  элементы. Своё состояние на блок (`renderedBlocks`), а не одно на список, —
  иначе изменение в одном блоке пересобирало бы все.

  `KeyF` обязан стоять в `RESERVED_CODES` (`action-hotkey.js`): без этого
  встроенная ветка съедала бы `Ctrl+F` у настроенного человеком действия, и оно
  молчало бы — ровно та ошибка, за которую уже заплачено списком `c v x z`.

  `←/→` в этом режиме уходят в навигацию по блокам, но только когда каретка на
  краю запроса и ничего не выделено: поле поиска сфокусировано всегда, и отнять
  у него стрелки насовсем значило бы лишить человека правки запроса.

  Размер окна меняет Rust (`set_picker_size`), а не страница: у окна нет
  декораций, и `window.resizeTo` на нём не работает. Узкий размер обязан
  совпадать с `tauri.conf.json` — сторожит тест
  `narrow_size_matches_the_window_config`.
```

- [ ] **Step 2: Убрать пункт из TODO**

Удалить из `docs/TODO.md` пункт «Режим «fullscreen»: сессии блоками, а не строками» целиком (строки 5-27), оставив раздел `# next` пустым.

- [ ] **Step 3: Прогнать весь набор в последний раз**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: PASS

- [ ] **Step 4: Коммит**

```bash
git add CLAUDE.md docs/TODO.md
git commit -m "docs(claude-md): правило про широкий режим списка"
```

---

## Проверка живьём

Тестами это не ловится, и делается руками — на машине с Windows, куда пикер выкатывается скриптом:

```bash
./data/scripts/deploy-win.sh
```

- [ ] `^F` разворачивает окно до 1400×900 по центру, повторный `^F` возвращает 900×640 по центру.
- [ ] Блоки стоят колонками; у каждого свой скролл, общий скролл страницы не появляется.
- [ ] `↑/↓` не выходят за края блока, `←/→` переводят в соседний.
- [ ] `←/→` внутри набранного запроса по-прежнему двигают курсор в поле поиска.
- [ ] Enter на строке `N sessions · last …` разворачивает историю.
- [ ] Enter на карточке открывает сессию так же, как строка узкого списка (окно поднимается там, где поднималось).
- [ ] `^A` и `^S` оставляют на экране один блок; стирание префикса возвращает все.
- [ ] Перезапуск пикера открывает его в том режиме, в котором закрыли.
- [ ] `Ctrl+F`, назначенный своему действию в `config.yaml`, помечен в окне настроек занятым.
