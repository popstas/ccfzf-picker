# Секции узкого режима — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** узкий список пикера показывает те же секции, что и широкий — со свёрнутой историей, проектами и снимками, — и у каждой секции есть свой слеш-префикс.

**Architecture:** одна функция `buildSections` собирает секции для обеих раскладок; от раскладки зависят только склейка чужих групп, колонки и умолчание свёрнутости. Заголовок секции становится обычной строкой списка, свёрнутость помнится в `ui.json` отдельно для каждой раскладки.

**Tech Stack:** ванильный JS без сборщика (модули — UMD-шим, грузятся и `<script>`-тегом, и через `require`), тесты — `node --test` через `npm test`, оболочка — Tauri 2 (Rust здесь не трогается).

**Spec:** `docs/superpowers/specs/2026-08-15-narrow-mode-sections-design.md`

## Global Constraints

- **Всё, что видит человек, — по-английски; всё, что видит разработчик, — по-русски.** Подписи, кнопки, сообщения об ошибках — английские. Комментарии, doc-комментарии, названия тестов и сообщения в `assert` — русские.
- **Имена машин в репозиторий не попадают.** В тестах — только выдуманные (`alpha-host`, `zeta-host`). Сторож — `test/no-private-data.test.js`.
- **Тесты гоняются только через `npm test`.** `node --test test/` на этих версиях Node не работает.
- **Каждый новый файл из `frontend-src/` обязан попасть в `FILES` в `scripts/prepare-frontend.js`** и в `<script>`-тег `sessions.html` — это сторожит `test/frontend-load.test.js`.
- **Модули пишутся UMD-шимом** — тем же, что у соседей: `(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.<Name> = factory(); })(typeof self !== 'undefined' ? self : this, function () { … });`
- **Зависимость одного frontend-модуля от другого берётся через `globalThis`, а не `root`:** `typeof module === 'object' && module.exports ? require('./x') : globalThis.X`.
- Команда проверки после каждой задачи: `npm test`.

---

### Task 1: стабильные ключи и заголовки без счёта

Ключ секции сегодня считается от заголовка (`g:Active sessions - 3`), а счёт в заголовке меняется при каждой смерти сессии. По ключу будет помниться свёрнутость — значит ключ обязан быть стабильным. Счёт при этом никуда не девается: он переезжает в поле `count` и рисуется сборкой заголовка (Task 3).

**Files:**
- Modify: `frontend-src/session-groups.js:134-229`
- Test: `test/session-groups.test.js`

**Interfaces:**
- Produces: каждая группа из `groupSessions(sessions, sort)` получает поле `key` (строка) и теряет счёт из `label`. Ключи: `live`, `remote:<host>`, `past`, `past:<N>`, `zellij`. Заголовки: `Active sessions`, `Active local sessions`, `Active on <host>`, `Not running`, `Desktop <N>`, `Zellij`.

- [ ] **Step 1: написать падающий тест**

В `test/session-groups.test.js` добавить в конец:

```js
test('ключ группы стабилен, а счёт из заголовка убран', () => {
  // Ключ — то, по чему помнится свёрнутость секции. Считайся он от заголовка
  // со счётом, уснувшая сессия меняла бы ключ и сбрасывала бы состояние.
  const live = (id) => ({ id, label: id, cwd: `/w/${id}`, live: true });
  const one = groupSessions([live('a')]);
  const two = groupSessions([live('a'), live('b')]);
  assert.strictEqual(one[0].key, 'live');
  assert.strictEqual(two[0].key, 'live');
  assert.strictEqual(one[0].label, 'Active sessions');
  assert.strictEqual(two[0].label, 'Active sessions');
});

test('ключи чужих групп, истории и зелия', () => {
  const row = (id, extra) => ({ id, label: id, cwd: `/w/${id}`, live: true, ...extra });
  const groups = groupSessions([
    row('a'),
    row('x', { windowHost: 'alpha-host' }),
    row('old', { live: false }),
    row('z', { kind: 'zellij' }),
  ]);
  const byKey = Object.fromEntries(groups.map(g => [g.key, g.label]));
  assert.strictEqual(byKey['live'], 'Active local sessions');
  assert.strictEqual(byKey['remote:alpha-host'], 'Active on alpha-host');
  assert.strictEqual(byKey['past'], 'Not running');
  assert.strictEqual(byKey['zellij'], 'Zellij');
});
```

- [ ] **Step 2: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `one[0].key` равен `undefined`, `label` равен `Active sessions - 1`.

- [ ] **Step 3: правка `groupSessions`**

В `frontend-src/session-groups.js` заменить создание группы истории (около строки 156):

```js
        groups.set(key, {
          desktop, past: true, sessions: [],
          // Ключ — стабильный, заголовок — то, что видит человек. Счёт в
          // заголовке не стоит намеренно: он меняется каждые несколько секунд,
          // и входи он в ключ, свёрнутость секции сбрасывалась бы сама собой.
          // Приписывает счёт сборка секции (picker-sections.js).
          key: desktop === null ? 'past' : `past:${desktop}`,
          label: desktop === null ? 'Not running' : `Desktop ${desktop}`,
        });
```

Заменить хвост с зелием (около строки 168):

```js
    const tail = zellij.length
      ? [{ desktop: null, key: 'zellij', label: 'Zellij', sessions: sortGroupSessions(zellij, mode) }]
      : [];
```

В `activeGroups` заменить три места, где собираются группы:

```js
    const remote = open.filter(s => s.windowHost);
    if (!remote.length) {
      return [{ desktop: null, key: 'live', label: 'Active sessions', sessions: open, remote: false, host: '' }];
    }
    const local = open.filter(s => !s.windowHost);
    const groups = [];
    if (local.length) {
      groups.push({ desktop: null, key: 'live', label: 'Active local sessions', sessions: local, remote: false, host: '' });
    }
    const byHost = new Map();
    for (const s of remote) {
      if (!byHost.has(s.windowHost)) byHost.set(s.windowHost, []);
      byHost.get(s.windowHost).push(s);
    }
    for (const host of [...byHost.keys()].sort((a, b) => a.localeCompare(b))) {
      const sessions = byHost.get(host);
      groups.push({ desktop: null, key: `remote:${host}`, label: `Active on ${host}`, sessions, remote: true, host });
    }
    return groups;
```

- [ ] **Step 4: поправить прежние ожидания в тестах**

В `test/session-groups.test.js` и `test/picker-blocks.test.js` заменить ожидаемые заголовки: `'Active sessions - 2'` → `'Active sessions'`, `'Active local sessions - 1'` → `'Active local sessions'`, `'Active on alpha-host - 1'` → `'Active on alpha-host'`, `'Zellij - 2'` → `'Zellij'`. Добавить `key` в литералы групп `GROUPS` и `REMOTE_GROUPS` в `test/picker-blocks.test.js`: `key: 'live'`, `key: 'remote:alpha-host'`, `key: 'remote:zeta-host'`, `key: 'past'`.

- [ ] **Step 5: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: коммит**

```bash
git add frontend-src/session-groups.js test/session-groups.test.js test/picker-blocks.test.js
git commit -m "refactor(picker): у группы сессий стабильный ключ, счёт вынесен из заголовка"
```

---

### Task 1b: чужие машины по свежести, а не по алфавиту

Раз `activeGroups` только что переписана ради ключей, там же чинится её
порядок: машина, на которой только что говорили, не должна стоять внизу
из-за того, что её имя начинается на «w».

**Files:**
- Modify: `frontend-src/session-groups.js` — `activeGroups`, строка сортировки хостов
- Test: `test/session-groups.test.js`

**Interfaces:**
- Consumes: `key` у группы (Task 1).
- Produces: порядок групп в результате `groupSessions` — чужие машины по убыванию свежести; ничего нового не экспортируется.

- [ ] **Step 1: написать падающий тест**

В `test/session-groups.test.js` добавить в конец:

```js
test('чужие машины идут по свежести, свежая первой', () => {
  // Машина, на которой только что говорили, должна стоять сверху. Раньше
  // порядок был алфавитным, и `zeta-host` с полуминутной сессией уходил вниз
  // под `alpha-host`, где последний раз говорили час назад.
  const now = Math.floor(Date.now() / 1000);
  const row = (id, host, ago) => ({
    id, label: id, cwd: `/w/${id}`, live: true,
    windowHost: host, lastActivity: now - ago,
  });
  const groups = groupSessions([
    row('a', 'alpha-host', 3600),
    row('z', 'zeta-host', 30),
  ]);
  assert.deepStrictEqual(
    groups.filter(g => g.remote).map(g => g.key),
    ['remote:zeta-host', 'remote:alpha-host'],
  );
});

test('на равной свежести машины разводятся по имени', () => {
  // Иначе две одинаково свежие менялись бы местами от опроса к опросу — тот же
  // класс дрожания, из-за которого свежесть меряется минутами, а не секундами.
  const now = Math.floor(Date.now() / 1000);
  const row = (id, host) => ({
    id, label: id, cwd: `/w/${id}`, live: true,
    windowHost: host, lastActivity: now,
  });
  const groups = groupSessions([row('z', 'zeta-host'), row('a', 'alpha-host')]);
  assert.deepStrictEqual(
    groups.filter(g => g.remote).map(g => g.key),
    ['remote:alpha-host', 'remote:zeta-host'],
  );
});
```

- [ ] **Step 2: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — первый тест даёт `['remote:alpha-host', 'remote:zeta-host']`.

- [ ] **Step 3: правка `activeGroups`**

Заменить цикл по машинам (тот, что в Task 1 был написан с `localeCompare`) на:

```js
    // Порядок машин — по свежести самой свежей сессии в группе, свежая первой.
    // Алфавитный порядок ставил ту машину, на которой только что говорили,
    // вниз, если её имя начинается на «w».
    //
    // Ключ тот же, которым меряется свежесть строк внутри группы (`recentKey`,
    // минуты), а не новый: второй разошёлся бы с первым. Минуты здесь нужны и
    // сами по себе — на секундах две почти одинаково свежие машины менялись бы
    // местами от опроса к опросу. На равном ключе они разводятся по имени: у
    // имён машин другого устойчивого порядка нет, а устойчивый нужен — список
    // перерисовывается раз в секунду.
    const freshness = (sessions) => sessions.reduce((max, s) => Math.max(max, recentKey(s)), 0);
    const hosts = [...byHost.keys()].sort((a, b) =>
      (freshness(byHost.get(b)) - freshness(byHost.get(a))) || a.localeCompare(b));
    for (const host of hosts) {
      const sessions = byHost.get(host);
      groups.push({ desktop: null, key: `remote:${host}`, label: `Active on ${host}`, sessions, remote: true, host });
    }
    return groups;
```

`recentKey` — уже существующая функция модуля (`frontend-src/session-groups.js:92`), наружу она не экспортируется и не должна.

- [ ] **Step 4: поправить прежние ожидания**

В `test/session-groups.test.js` и `test/picker-sections.test.js` проверить тесты, полагавшиеся на алфавитный порядок машин. В `REMOTE_GROUPS` (`test/picker-sections.test.js`) порядок задан литералом и от этой правки не зависит — там менять нечего.

- [ ] **Step 5: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: коммит**

```bash
git add frontend-src/session-groups.js test/session-groups.test.js
git commit -m "fix(picker): чужие машины в списке идут по свежести"
```

---

### Task 2: пять слеш-префиксов

**Files:**
- Modify: `frontend-src/picker-mode.js` (файл переписывается целиком)
- Modify: `sessions.html:1433-1438` (`showProjects`), `sessions.html:2116`
- Test: `test/picker-mode.test.js`

**Interfaces:**
- Consumes: ничего из прошлых задач.
- Produces: `parseQuery(raw) -> { mode, query }`, где `mode` — одно из `'sessions' | 'local' | 'remote' | 'history' | 'projects' | 'snapshots'`; `withPrefix(raw, mode) -> string`; `PREFIXES` — массив `{ mode, text, re }`. Функции `withProjectPrefix`, `withSnapshotPrefix`, `PREFIX_TEXT`, `SNAPSHOT_PREFIX_TEXT` исчезают.

- [ ] **Step 1: написать падающий тест**

`test/picker-mode.test.js` — заменить импорт первой строкой на `const { parseQuery, withPrefix } = require('../frontend-src/picker-mode');`, заменить во всех прежних тестах `/a` на `/p`, `/all` на `/projects`, `withProjectPrefix(x)` на `withPrefix(x, 'projects')`, `withSnapshotPrefix(x)` на `withPrefix(x, 'snapshots')`. Добавить в конец:

```js
test('все пять префиксов разбираются', () => {
  assert.deepStrictEqual(parseQuery('/l ccfzf'), { mode: 'local', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/local ccfzf'), { mode: 'local', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/r ccfzf'), { mode: 'remote', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/remote'), { mode: 'remote', query: '' });
  assert.deepStrictEqual(parseQuery('/h'), { mode: 'history', query: '' });
  assert.deepStrictEqual(parseQuery('/history ccfzf'), { mode: 'history', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/p'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/s'), { mode: 'snapshots', query: '' });
});

test('слово, начинающееся как префикс, префиксом не является', () => {
  // Хвост `(\s+|$)` в каждой записи таблицы — ради этого и только этого:
  // человек, ищущий сессию со словом `/lib` или `/home` в пути, не должен
  // молча оказаться в другом списке.
  for (const word of ['/lib', '/home', '/root', '/path', '/pr', '/api', '/src', '/session']) {
    assert.deepStrictEqual(parseQuery(word), { mode: 'sessions', query: word }, word);
  }
});

test('вставка префикса поверх чужого заменяет его, а не приписывает второй', () => {
  // Без этого `^L` на строке `/p picker` дал бы `/l /p picker` — режим с
  // запросом, которому ничем не соответствовать, то есть пустой список без
  // единого слова о причине.
  assert.strictEqual(withPrefix('/p picker', 'local'), '/l picker');
  assert.strictEqual(withPrefix('/s work', 'history'), '/h work');
  assert.strictEqual(withPrefix(' /h old', 'projects'), '/p old');
  assert.strictEqual(withPrefix('/l a', 'local'), '/l a');
  assert.strictEqual(withPrefix('', 'remote'), '/r ');
});
```

- [ ] **Step 2: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `withPrefix is not a function`.

- [ ] **Step 3: переписать `frontend-src/picker-mode.js`**

```js
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerMode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Режим списка живёт в самой строке поиска, а не отдельным флагом.
   *
   * Так всё, что происходит, написано на экране: видно и что ищем, и где.
   * Скрытый режим потребовал бы места под свой признак и научил бы Esc вести
   * себя по-разному без видимой причины — а стирание префикса возвращает к
   * сессиям само собой, безо всякого выхода из режима.
   *
   * Одна таблица на все пять, а не пять пар регулярок: разбор, снятие и
   * вставка обязаны видеть один и тот же набор, иначе `^L` на строке с чужим
   * префиксом приписал бы свой поверх.
   *
   * Хвост `(\s+|$)` у каждой записи обязателен: без него `/lib` уводил бы в
   * режим `local`, а `/home` — в `history`. По этой же причине префиксом не
   * считаются `/api`, `/src` и `/pr`.
   *
   * `\s*` впереди — не вольность: строка поиска приходит в хоткей живьём,
   * вместе с пробелом, который человек успел набрать. Без этой поблажки
   * `withPrefix` не узнавала бы уже стоящий префикс и приписывала бы второй.
   */
  const PREFIXES = [
    { mode: 'local', text: '/l ', re: /^\s*\/(local|l)(\s+|$)/i },
    { mode: 'remote', text: '/r ', re: /^\s*\/(remote|r)(\s+|$)/i },
    { mode: 'history', text: '/h ', re: /^\s*\/(history|h)(\s+|$)/i },
    { mode: 'projects', text: '/p ', re: /^\s*\/(projects|p)(\s+|$)/i },
    { mode: 'snapshots', text: '/s ', re: /^\s*\/(snapshots|s)(\s+|$)/i },
  ];

  /** Запись таблицы, которой отвечает начало строки, и длина совпадения. */
  function matchPrefix(text) {
    for (const prefix of PREFIXES) {
      const hit = text.match(prefix.re);
      if (hit) return { prefix, length: hit[0].length };
    }
    return null;
  }

  function parseQuery(raw) {
    const text = String(raw == null ? '' : raw);
    const hit = matchPrefix(text);
    if (hit) return { mode: hit.prefix.mode, query: text.slice(hit.length).trim() };
    return { mode: 'sessions', query: text.trim() };
  }

  /** Снять префикс любого из режимов, оставив сам запрос. */
  function stripPrefix(text) {
    const hit = matchPrefix(text);
    return hit ? text.slice(hit.length) : text;
  }

  /** Строка поиска с префиксом названного режима впереди — то, что делают хоткеи. */
  function withPrefix(raw, mode) {
    const text = String(raw == null ? '' : raw);
    const target = PREFIXES.find(p => p.mode === mode);
    if (!target) return text;
    if (target.re.test(text)) return text;
    return target.text + stripPrefix(text).replace(/^\s+/, '');
  }

  return { parseQuery, withPrefix, stripPrefix, PREFIXES };
});
```

- [ ] **Step 4: поправить вызовы на странице**

`sessions.html`, `showProjects` (около строки 1433) — заменить тело и doc-комментарий:

```js
  /**
   * Открыть список названного режима: поставить его префикс в начало строки
   * поиска.
   *
   * Режим живёт префиксом в тексте, а не отдельным флагом, поэтому «открыть в
   * режиме X» — это правка строки поиска, и сделать её может только страница.
   * Входов у проектов два и код у них общий: `^P` внутри окна и глобальный
   * хоткей, приезжающий событием `picker-projects` от Rust.
   */
  function showMode(mode) {
    search.value = window.PickerMode.withPrefix(search.value, mode);
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
    onSearchInput();
  }

  function showProjects() {
    showMode('projects');
  }
```

`sessions.html`, ветка `KeyS` (строка 2116) — заменить три строки на:

```js
      showMode('snapshots');
```

(строки `search.value = …`, `search.focus();`, `search.setSelectionRange(…)`, `onSearchInput();` удаляются — `showMode` делает всё это.)

- [ ] **Step 5: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: коммит**

```bash
git add frontend-src/picker-mode.js sessions.html test/picker-mode.test.js
git commit -m "feat(picker): пять слеш-префиксов вместо двух"
```

---

### Task 3: `picker-sections.js` — одна сборка на обе раскладки

**Files:**
- Create: `frontend-src/picker-sections.js` (переезд `frontend-src/picker-blocks.js`)
- Delete: `frontend-src/picker-blocks.js`
- Create: `test/picker-sections.test.js` (переезд `test/picker-blocks.test.js`)
- Delete: `test/picker-blocks.test.js`
- Modify: `scripts/prepare-frontend.js:36`
- Modify: `sessions.html:468` (тег `<script>`), `sessions.html:994`, `sessions.html:1336`, `sessions.html:1344`
- Modify: `test/frontend-load.test.js:70` (комментарий)

**Interfaces:**
- Consumes: поле `key` у группы (Task 1).
- Produces: `window.PickerSections` / `require('./picker-sections')` с `{ buildSections, sectionHeaderText, moveInBlocks, moveBetweenBlocks }`.
  `buildSections({ groups, projects, snapshots, mode, query, trackerHere, collapsed, layout })` возвращает массив секций
  `{ key, label, kind, rows, count, lastAt, collapsed, past, column? }`, где `column` ставится только при `layout: 'wide'`.
  `sectionHeaderText(section) -> string`.

- [ ] **Step 1: перенести файлы под новыми именами**

```bash
git mv frontend-src/picker-blocks.js frontend-src/picker-sections.js
git mv test/picker-blocks.test.js test/picker-sections.test.js
```

- [ ] **Step 2: написать падающий тест**

В `test/picker-sections.test.js` заменить первые строки на:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSections, sectionHeaderText, moveInBlocks, moveBetweenBlocks } = require('../frontend-src/picker-sections');
```

Заменить во всех прежних тестах `buildBlocks(` на `buildSections(`, а в `base()` добавить раскладку:

```js
function base(extra) {
  return {
    groups: GROUPS, projects: PROJECTS, snapshots: SNAPSHOTS,
    mode: 'sessions', query: '', trackerHere: true, collapsed: {},
    layout: 'wide', ...extra,
  };
}
```

Добавить в конец файла:

```js
test('узкая раскладка не склеивает чужие группы и не считает колонок', () => {
  // Склейка — правило раскладки, а не группировки: в широком блок занимает
  // колонку, и пять трекеров дали бы пять узких колонок на то, что человек
  // читает как одно «не здесь». В узком строки идут сверху вниз, и лишний
  // заголовок там ничего не стоит.
  const narrow = buildSections(base({ groups: REMOTE_GROUPS, layout: 'narrow' }));
  assert.deepStrictEqual(narrow.map(s => s.key), [
    'live', 'remote:alpha-host', 'remote:zeta-host', 'past', 'projects', 'snapshots',
  ]);
  assert.ok(narrow.every(s => s.column === undefined));
});

test('широкая раскладка склеивает чужие группы и раскладывает по колонкам', () => {
  const wide = buildSections(base({ groups: REMOTE_GROUPS, layout: 'wide' }));
  assert.deepStrictEqual(wide.map(s => s.key), [
    'live', 'remote', 'projects', 'past', 'snapshots',
  ]);
  assert.deepStrictEqual(wide.map(s => s.column), [1, 2, 2, 3, 3]);
});

test('счёт секции не считает подзаголовки, а заголовок собирается из него', () => {
  const wide = buildSections(base({ groups: REMOTE_GROUPS, layout: 'wide' }));
  const remote = wide.find(s => s.key === 'remote');
  // Три чужие сессии на двух машинах: строк в секции пять (две из них —
  // подзаголовки машин), а счёт — по сессиям.
  assert.strictEqual(remote.count, 3);
  assert.strictEqual(remote.rows.length, 5);
  assert.strictEqual(sectionHeaderText(remote), 'Active remote sessions - 3');
});

test('у свёрнутой истории в заголовке дата последней сессии', () => {
  const past = { key: 'past', label: 'Not running', count: 1, lastAt: AUG_12, collapsed: true };
  assert.strictEqual(sectionHeaderText(past), 'Not running - 1 · last Aug 12');
  // Развёрнутая дату не показывает: строки видны, и подпись повторяла бы их.
  assert.strictEqual(sectionHeaderText({ ...past, collapsed: false }), 'Not running - 1');
});

test('умолчание свёрнутости зависит от раскладки', () => {
  // В узком списке история оттесняет вниз то, что работает сейчас, а проекты и
  // снимки — справочники, за которыми приходят намеренно. В широком у каждой
  // своя колонка, и оттеснять там некого.
  const narrow = buildSections(base({ layout: 'narrow' }));
  assert.deepStrictEqual(
    Object.fromEntries(narrow.map(s => [s.key, s.collapsed])),
    { live: false, past: true, projects: true, snapshots: true },
  );
  const wide = buildSections(base({ layout: 'wide' }));
  assert.ok(wide.every(s => s.collapsed === false));
});

test('карта человека перекрывает умолчание, отсутствие ключа — нет', () => {
  // Отсутствие ключа значит «как по умолчанию», а не «развёрнута»: так
  // умолчание остаётся в коде и его можно менять, не переписывая людям ui.json.
  const sections = buildSections(base({
    layout: 'narrow', collapsed: { past: false, live: true },
  }));
  const byKey = Object.fromEntries(sections.map(s => [s.key, s.collapsed]));
  assert.strictEqual(byKey.past, false);
  assert.strictEqual(byKey.live, true);
  assert.strictEqual(byKey.projects, true);
});

test('префикс оставляет одну секцию и разворачивает её', () => {
  // Иначе `/h` при свёрнутой по умолчанию истории показал бы один заголовок,
  // то есть ровно ничего.
  const history = buildSections(base({
    layout: 'narrow', mode: 'history', collapsed: { past: true },
  }));
  assert.deepStrictEqual(history.map(s => s.key), ['past']);
  assert.strictEqual(history[0].collapsed, false);

  const local = buildSections(base({ groups: REMOTE_GROUPS, layout: 'narrow', mode: 'local' }));
  assert.deepStrictEqual(local.map(s => s.key), ['live']);

  const remote = buildSections(base({ groups: REMOTE_GROUPS, layout: 'narrow', mode: 'remote' }));
  assert.deepStrictEqual(remote.map(s => s.key), ['remote:alpha-host', 'remote:zeta-host']);

  const projects = buildSections(base({ layout: 'narrow', mode: 'projects' }));
  assert.deepStrictEqual(projects.map(s => s.key), ['projects']);
});

test('в режиме remote своя живая группа не показывается, и наоборот', () => {
  const remote = buildSections(base({ groups: GROUPS, layout: 'narrow', mode: 'remote' }));
  // В GROUPS чужих машин нет вовсе — секций не будет ни одной, и страница
  // скажет об этом подписью, а не подменит список.
  assert.deepStrictEqual(remote, []);
});
```

- [ ] **Step 3: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `buildSections is not a function`.

- [ ] **Step 4: переписать `frontend-src/picker-sections.js`**

Заменить шапку шима (`root.PickerBlocks` → `root.PickerSections`) и всё, что ниже комментария про колонки, на:

```js
  // Колонки широкого режима. Раскладка задана человеком и держится на смысле
  // строк, а не на их числе:
  //
  //   1 — свои живые сессии (и зелий): главный список, ему отдана вся высота;
  //   2 — чужие живые сессии, под ними проекты;
  //   3 — история, под ней снимки.
  //
  // Номер живёт здесь, а не в CSS: колонку выбирают по тому же признаку, по
  // которому секция собрана (`group.remote`, `group.past`), а разбор заголовка
  // сделал бы видимую человеку строку форматом.
  const COLUMN_LIVE = 1;
  const COLUMN_NEAR = 2;
  const COLUMN_PAST = 3;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * Заголовок секции: подпись, счёт и — у свёрнутой истории — дата последней
   * сессии.
   *
   * Одна функция на обе раскладки. Счёт приписывается здесь, а не в
   * `groupSessions`: там он попадал бы в `label`, а по `label` считался ключ —
   * и уснувшая сессия сбрасывала бы свёрнутость секции.
   *
   * Месяц из своей таблицы, а не toLocaleDateString: у того вид зависит от
   * локали системы, а всё видимое человеку у нас английское. Дата местная
   * (getMonth/getDate), потому что «когда я в это заходил» человек меряет
   * своими часами.
   */
  function sectionHeaderText(section) {
    const head = `${section.label} - ${section.count}`;
    if (!section.collapsed || !section.lastAt) return head;
    const d = new Date(section.lastAt * 1000);
    return `${head} · last ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  function lastActivityOf(sessions) {
    return sessions.reduce((max, s) => Math.max(max, (s || {}).lastActivity || 0), 0);
  }

  // Заголовок склеенной секции: тот же, каким чужие сессии назывались до
  // деления по машинам. Имени машины в нём быть не может — секция одна на все.
  const REMOTE_LABEL = 'Active remote sessions';
  // Ключ склеенной секции не зависит от набора машин: по ключу помнится и
  // отрисовка, и свёрнутость, и считайся он от имён — уснувшая на соседней
  // машине сессия пересобирала бы колонку целиком.
  const REMOTE_KEY = 'remote';

  /**
   * Подзаголовок машины внутри склеенной секции чужих сессий.
   *
   * Строка эта — подпись, а не строка списка: выбрать её нельзя, Enter на ней
   * не сработает, и в `rows` страницы она не попадает вовсе (см. `subheadItem`
   * в sessions.html). Поэтому же она не входит в `count`.
   */
  function subheadRow(group) {
    return {
      kind: 'block-subhead',
      key: `sub:${group.host}`,
      label: `${group.host} - ${group.sessions.length}`,
    };
  }

  /**
   * Свёрнута ли секция, если человек её не трогал.
   *
   * В узком списке история оттесняет вниз то, что работает сейчас, а проекты и
   * снимки — справочники, за которыми приходят намеренно. В широком у каждой
   * из них своя колонка, и оттеснять там некого: умолчание перевёрнуто вместе
   * с причиной.
   */
  function defaultCollapsed(section, layout) {
    if (layout !== 'narrow') return false;
    return section.past === true || section.kind === 'projects' || section.kind === 'snapshots';
  }

  /**
   * Входит ли группа сессий в названный режим.
   *
   * Зелий виден только в общем списке: `/l` — это «мои сессии агента», а зелий
   * справочник о том, что ещё открыто на машине.
   */
  function groupInMode(group, mode) {
    if (mode === 'sessions') return true;
    if (mode === 'local') return group.key === 'live';
    if (mode === 'remote') return group.remote === true;
    if (mode === 'history') return group.past === true;
    return false;
  }

  const SESSION_MODES = ['sessions', 'local', 'remote', 'history'];

  /**
   * Секции списка — одни и те же для обеих раскладок.
   *
   * Своего правила группировки у раскладки нет: секции приезжают из
   * groupSessions один в один. От раскладки зависят ровно три вещи — склейка
   * чужих групп, номер колонки и умолчание свёрнутости; всё три перечислены
   * ниже поимённо и больше нигде не решаются.
   *
   * Отбор идёт теми же filterSessions/filterProjects, что и раньше: запрос без
   * префикса отбирает строки во всех секциях сразу, и секция, где не нашлось
   * ничего, исчезает.
   *
   * `opts.collapsed` — карта «ключ секции → свёрнута ли», то, что человек
   * трогал руками. Отсутствие ключа значит «как по умолчанию», а не «развёрнута»:
   * так умолчание остаётся в коде и его можно менять, не переписывая людям
   * ui.json. В режиме с префиксом карта не спрашивается вовсе — названная
   * секция всегда развёрнута, иначе `/h` при свёрнутой истории показал бы один
   * заголовок, то есть ничего.
   */
  function buildSections(opts) {
    const o = opts || {};
    const mode = o.mode || 'sessions';
    const query = o.query || '';
    const wide = o.layout === 'wide';
    const override = o.collapsed && typeof o.collapsed === 'object' ? o.collapsed : {};
    const sections = [];

    if (SESSION_MODES.includes(mode)) {
      let remote = null;
      for (const group of filterApi.filterSessions(o.groups || [], query)) {
        if (!groupInMode(group, mode)) continue;
        // Склейка чужих групп — только в широкой раскладке, и только потому,
        // что секция там занимает колонку. Узнаётся чужая группа по своей
        // пометке (`group.remote`), а не по заголовку: заголовок носит имя
        // машины — данные с той стороны, — и разбор текста сделал бы это имя
        // форматом, который нельзя менять.
        if (wide && group.remote) {
          if (!remote) {
            remote = {
              key: REMOTE_KEY, label: REMOTE_LABEL, kind: 'sessions',
              rows: [], count: 0, lastAt: 0, past: false, column: COLUMN_NEAR,
            };
            sections.push(remote);
          }
          remote.rows = [...remote.rows, subheadRow(group), ...group.sessions];
          remote.count += group.sessions.length;
          continue;
        }
        sections.push({
          key: group.key, label: group.label, kind: 'sessions',
          rows: group.sessions, count: group.sessions.length,
          lastAt: lastActivityOf(group.sessions),
          past: group.past === true,
          ...(wide ? { column: group.past ? COLUMN_PAST : COLUMN_LIVE } : {}),
        });
      }
    }

    // Проекты и снимки — секции того же списка, а не отдельные режимы: их
    // видно сразу, свёрнутыми, и префикс оставляет на экране одну из них.
    if (mode === 'sessions' || mode === 'projects') {
      const rows = filterApi.filterProjects(o.projects || [], query);
      if (rows.length) {
        sections.push({
          key: 'projects', label: 'Projects', kind: 'projects',
          rows, count: rows.length, lastAt: 0, past: false,
          ...(wide ? { column: COLUMN_NEAR } : {}),
        });
      }
    }
    // Снимки уже отобраны запросом на стороне buildSnapshotRows: у них своя
    // пара «заголовок раскладки и её сессии», и отбор строкой порознь порвал
    // бы её. trackerHere — то же условие, что у ^S.
    if ((mode === 'sessions' || mode === 'snapshots') && o.trackerHere) {
      const rows = o.snapshots || [];
      if (rows.length) {
        sections.push({
          key: 'snapshots', label: 'Snapshots', kind: 'snapshots',
          rows, count: rows.length, lastAt: 0, past: false,
          ...(wide ? { column: COLUMN_PAST } : {}),
        });
      }
    }

    const shaped = sections.map(section => ({
      ...section,
      collapsed: mode !== 'sessions' ? false
        : (typeof override[section.key] === 'boolean'
          ? override[section.key]
          : defaultCollapsed(section, wide ? 'wide' : 'narrow')),
    }));

    // Порядок секций в узкой раскладке — порядок сборки: живые, чужие,
    // история, зелий, проекты, снимки. В широкой он пересчитывается по
    // колонкам: колонка за колонкой, сверху вниз внутри колонки. По этому же
    // порядку ходят `←/→` (moveBetweenBlocks), и разъедься он с видимым,
    // стрелка уводила бы не туда, куда смотрит глаз. Сортировка устойчива,
    // поэтому внутри колонки секции остаются в порядке сборки.
    if (!wide) return shaped;
    return shaped
      .map((section, at) => ({ section, at }))
      .sort((a, b) => (a.section.column - b.section.column) || (a.at - b.at))
      .map(({ section }) => section);
  }
```

Функции `collapsedLabel`, `collapsedRow` и константа `MONTHS` в прежнем виде удаляются — их заменил `sectionHeaderText`. `blockIndexes`, `moveInBlocks`, `moveBetweenBlocks` остаются как есть.

Экспорт в конце файла:

```js
  return { buildSections, sectionHeaderText, moveInBlocks, moveBetweenBlocks };
```

- [ ] **Step 5: обновить места, где модуль зовут по имени**

- `scripts/prepare-frontend.js:36`: `'frontend-src/picker-blocks.js',` → `'frontend-src/picker-sections.js',`
- `sessions.html:468`: `<script src="picker-blocks.js"></script>` → `<script src="picker-sections.js"></script>`
- `sessions.html:994`: `window.PickerBlocks.buildBlocks({` → `window.PickerSections.buildSections({`, и добавить в объект аргументов `layout: 'wide',`
- `sessions.html:1336`: `window.PickerBlocks.moveInBlocks` → `window.PickerSections.moveInBlocks`
- `sessions.html:1344`: `window.PickerBlocks.moveBetweenBlocks` → `window.PickerSections.moveBetweenBlocks`
- `sessions.html:30` и `sessions.html:1026`: в комментариях `picker-blocks.js` → `picker-sections.js`
- `test/frontend-load.test.js:70`: в комментарии `picker-blocks` → `picker-sections`

`sessions.html:996` временно продолжает передавать `collapsed: collapsedBlocks` (массив). `buildSections` читает его как объект, `typeof [] === 'object'` — массив пройдёт, ключей в нём нет, и все секции получат умолчание. Это рабочее промежуточное состояние: широкая раскладка по умолчанию не сворачивает ничего, а настоящую карту страница начнёт передавать в Task 6.

- [ ] **Step 6: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: коммит**

```bash
git add -A frontend-src sessions.html scripts test
git commit -m "refactor(picker): buildSections собирает секции для обеих раскладок"
```

---

### Task 4: `ui.json` помнит свёрнутость по раскладкам

**Files:**
- Modify: `frontend-src/ui-state.js:57-85`
- Test: `test/ui-state.test.js`

**Interfaces:**
- Produces: `normalizeUiState(raw, defaults)` возвращает четвёртое поле `collapsed: { narrow: {…}, wide: {…} }`, значения внутри — только `boolean`. `uiStateToSave(sort, toggles, fullscreen, collapsed)` принимает четвёртый аргумент.

- [ ] **Step 1: написать падающий тест**

В `test/ui-state.test.js` добавить в конец:

```js
test('свёрнутость читается по раскладкам и чистится от мусора', () => {
  const ui = normalizeUiState({
    collapsed: {
      narrow: { past: true, projects: 'да', snapshots: false },
      wide: { past: false },
      garbage: { x: true },
    },
  }, { toggles: {} });
  assert.deepStrictEqual(ui.collapsed, {
    narrow: { past: true, snapshots: false },
    wide: { past: false },
  });
});

test('старый ui.json без collapsed читается как «человек ничего не трогал»', () => {
  // Не поняв старый файл, первый же запуск после обновления сбросил бы
  // человеку настройки — и выглядело бы это потерей, а не сменой формата.
  for (const raw of [{}, { collapsed: null }, { collapsed: 'нет' }, { collapsed: [] }]) {
    assert.deepStrictEqual(
      normalizeUiState(raw, { toggles: {} }).collapsed,
      { narrow: {}, wide: {} },
    );
  }
});

test('свёрнутость доезжает до файла четвёртым аргументом', () => {
  const saved = uiStateToSave('cost', {}, false, { narrow: { past: true }, wide: {} });
  assert.deepStrictEqual(saved.collapsed, { narrow: { past: true }, wide: {} });
});
```

- [ ] **Step 2: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `ui.collapsed` равен `undefined`.

- [ ] **Step 3: правка `frontend-src/ui-state.js`**

Перед `normalizeUiState` добавить:

```js
  // Раскладок две, и умолчания свёрнутости у них разные и по разным причинам:
  // в узкой история оттесняет живые сессии вниз, в широкой у неё своя колонка
  // и она никому не мешает. Один список на обе значил бы, что свёрнутая в
  // узком история опустошает колонку в широком.
  const COLLAPSE_LAYOUTS = ['narrow', 'wide'];

  /**
   * Свёрнутые секции из файла: только то, что человек трогал руками.
   *
   * Отсутствие ключа — не «развёрнута», а «как по умолчанию»: умолчание живёт
   * в коде (picker-sections.js), и так его можно менять, не переписывая людям
   * ui.json. Нелогические значения выбрасываются вместе с чужими раскладками —
   * файл правят чем угодно, а испорченный вид списка чинить изнутри нечем.
   */
  function normalizeCollapsed(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const layout of COLLAPSE_LAYOUTS) {
      const saved = src[layout] && typeof src[layout] === 'object' ? src[layout] : {};
      const one = {};
      for (const key of Object.keys(saved)) {
        if (typeof saved[key] === 'boolean') one[key] = saved[key];
      }
      out[layout] = one;
    }
    return out;
  }
```

В `normalizeUiState` в возвращаемый объект добавить последним полем:

```js
      // Четвёртое поле верхнего уровня, рядом с sort/toggles/fullscreen.
      collapsed: normalizeCollapsed(src.collapsed),
```

Заменить `uiStateToSave`:

```js
  function uiStateToSave(sort, toggles, fullscreen, collapsed) {
    return normalizeUiState({ sort, toggles, fullscreen, collapsed }, { toggles: toggles || {} });
  }
```

- [ ] **Step 4: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: коммит**

```bash
git add frontend-src/ui-state.js test/ui-state.test.js
git commit -m "feat(picker): ui.json помнит свёрнутость секций по раскладкам"
```

---

### Task 5: окно настроек возвращает свёрнутость нетронутой

Мина известная и однажды уже сработавшая: окно настроек звало `uiStateToSave` тремя аргументами, и первое же сохранение вкладки UI гасило запомненный `^F`.

**Files:**
- Modify: `settings.html:210-218`
- Test: `test/settings-page.test.js`

**Interfaces:**
- Consumes: `uiStateToSave(sort, toggles, fullscreen, collapsed)` (Task 4).

- [ ] **Step 1: написать падающий тест**

В `test/settings-page.test.js` добавить в конец:

```js
test('вкладка UI возвращает в файл и режим окна, и свёрнутость секций', () => {
  // Ни тем, ни другим окно настроек не распоряжается — ими распоряжается
  // пикер (`^F` и Enter на заголовке секции). Не верни их uiStateToSave
  // четвёртым и третьим аргументом, и первое же сохранение вкладки UI забыло
  // бы и раскладку, и все свёрнутые секции.
  const source = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  const call = source.match(/uiStateToSave\(([^)]*)\)/);
  assert.ok(call, 'вызов uiStateToSave не найден в settings.html — тест сторожит не то');
  const args = call[1].split(',').map(s => s.trim());
  assert.deepStrictEqual(args, ['fresh.sort', 'fresh.toggles', 'fresh.fullscreen', 'fresh.collapsed']);
});
```

Если `fs` и `path` в этом файле ещё не подключены — добавить в его начало `const fs = require('node:fs');` и `const path = require('node:path');`.

- [ ] **Step 2: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — четвёртого аргумента нет.

- [ ] **Step 3: правка `settings.html`**

Заменить комментарий и вызов (строки 210–218):

```js
        // Режим окна и свёрнутые секции возвращаются в файл нетронутыми — по
        // той же причине, что и `sort`: ими распоряжается пикер (`^F` и Enter
        // на заголовке секции), а окно настроек их не показывает и не правит.
        // Не верни их uiStateToSave третьим и четвёртым аргументом — и первое
        // же сохранение вкладки UI забыло бы широкий режим и все свёрнутые
        // секции, а пикер получил бы по `ui-changed` узкую раскладку внутри
        // широкой рамы.
        await invoke('save_ui', {
          ui: window.UiState.uiStateToSave(
            fresh.sort, fresh.toggles, fresh.fullscreen, fresh.collapsed),
        });
```

- [ ] **Step 4: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: коммит**

```bash
git add settings.html test/settings-page.test.js
git commit -m "fix(settings): вкладка UI не гасит свёрнутость секций"
```

---

### Task 6: страница рисует секции в обеих раскладках

Самая крупная задача. Узкий список перестаёт собираться тремя ветками и идёт через те же секции, что и широкий; заголовок становится строкой; свёрнутость читается из `ui.json` и пишется туда же.

**Files:**
- Modify: `sessions.html` — `collapsedBlocks` (строка 599), `saveUi` (722), `renderSessions` (918), `blockToggleItem` (931-942), `blockCellHtml` (964-968), `itemsOfBlock` (985-991), `renderBlocks` (993-1035), `render` (1060-1130), `choose` (1649-1659), ветка `KeyF` (2122-2137), загрузка `ui` (2314-2336 и 2385-2411)

**Interfaces:**
- Consumes: `buildSections`, `sectionHeaderText` (Task 3); `ui.collapsed` (Task 4).
- Produces: строка `{ kind: 'section', sectionKey, collapsed }` в массиве `rows`; функция `layoutName()`.

- [ ] **Step 1: заменить состояние свёрнутости**

`sessions.html`, строки 595-599 — заменить на:

```js
  // Режим окна и свёрнутые секции. Оба живут в ui.json: отступление от
  // умолчания запоминается, как сортировка и showAll. Свёрнутость — своя у
  // каждой раскладки: умолчания у них разные и по разным причинам (см.
  // defaultCollapsed в picker-sections.js).
  let fullscreen = false;
  let collapsed = { narrow: {}, wide: {} };
```

Сразу после — добавить:

```js
  /** Имя текущей раскладки: им же именуются половинки `collapsed`. */
  function layoutName() {
    return fullscreen ? 'wide' : 'narrow';
  }
```

- [ ] **Step 2: заменить `saveUi`**

`sessions.html:726` — заменить строку на:

```js
    invoke('save_ui', { ui: window.UiState.uiStateToSave(sortMode, uiToggles, fullscreen, collapsed) })
```

- [ ] **Step 3: заменить строку-переключатель на строку-заголовок**

`sessions.html`, `blockToggleItem` (строки 931-942) — заменить целиком на:

```js
  /**
   * Заголовок секции — обычная строка списка.
   *
   * Строкой, а не подписью: свернуть секцию иначе нечем. Раньше здесь была
   * отдельная строка-переключатель, показывавшаяся только у уже свёрнутой
   * секции, — развернуть можно было, свернуть обратно нет. Теперь свёрнутая и
   * развёрнутая формы — одна и та же строка, и вид строки `block-toggle`
   * исчез вместе с этой развилкой.
   *
   * Значок `▾`/`▸` — часть подписи, а не отдельная колонка: у заголовка нет ни
   * точки состояния, ни правых колонок, и ставить ради него сетку не за чем.
   */
  function sectionItem(section) {
    const index = rows.length;
    rows.push({ kind: 'section', sectionKey: section.key, collapsed: section.collapsed });
    const mark = section.collapsed ? '▸' : '▾';
    const text = window.PickerSections.sectionHeaderText(section);
    return {
      key: `sec:${section.key}`,
      html: `<div class="row section" data-index="${index}">` +
        `<div class="text"><div class="name">${escapeHtml(`${mark} ${text}`)}</div></div>` +
        `</div>`,
    };
  }
```

- [ ] **Step 4: убрать подпись из каркаса блока и собрать элементы секции**

`sessions.html`, `blockCellHtml` (строки 964-968) — заменить на:

```js
  // Подписи в каркасе нет: заголовок стал строкой и живёт внутри `.block-rows`
  // вместе с остальными. Снаружи он не был бы строкой, а его счёт менялся бы
  // каждые несколько секунд и пересобирал бы каркас в такт опросу.
  function blockCellHtml(section) {
    return `<div class="block" data-block="${escapeHtml(section.key)}">` +
      `<div class="block-rows"></div></div>`;
  }
```

`itemsOfBlock` (строки 985-991) — заменить на:

```js
  /**
   * Элементы одной секции: её заголовок и, если она развёрнута, её строки.
   *
   * Свёрнутая секция отдаёт один заголовок — строки при этом остаются в
   * `section.rows` нетронутыми, потому что по ним считается счёт в подписи.
   */
  function itemsOfSection(section, nowSec) {
    const items = [sectionItem(section)];
    if (section.collapsed) return items;
    if (section.kind === 'projects') {
      for (const row of section.rows) items.push(projectItem(row, nowSec));
    } else if (section.kind === 'snapshots') {
      for (const row of section.rows) items.push(snapshotItem(row, nowSec));
    } else {
      for (const row of section.rows) {
        items.push(row.kind === 'block-subhead' ? subheadItem(row) : sessionItem(row, nowSec));
      }
    }
    return items;
  }
```

- [ ] **Step 5: заменить `renderSessions` и `renderBlocks` на две ветки одной сборки**

`sessions.html`, `renderSessions` (строки 918-929) — удалить целиком. `renderProjects` (807-811) и `renderSnapshots` (864-866) — тоже удалить: их работу делает `itemsOfSection`. (`projectItem`, `snapshotItem`, `snapshotItemsFor` остаются.)

`renderBlocks` (строки 993-1035) — заменить на:

```js
  /** Секции текущего режима и раскладки. Один вызов на обе ветки render(). */
  function sectionsFor(mode, query) {
    return window.PickerSections.buildSections({
      groups, projects: projectRows, snapshots: snapshotItemsFor(query),
      mode, query, trackerHere: trackerIsHere(),
      layout: layoutName(), collapsed: collapsed[layoutName()],
    });
  }

  /** Узкий список: секции одним потоком, сверху вниз. */
  function renderNarrow(sections, nowSec, items) {
    for (const section of sections) {
      for (const item of itemsOfSection(section, nowSec)) items.push(item);
    }
  }

  function renderWide(sections, nowSec) {
    const shape = sections.map(s => `${s.key}|${s.column}`).join('\n');
    if (shape !== blocksShape) {
      // Колонки — flex-строка из flex-колонок, а не сетка. Сеткой это не
      // делается: колонка во всю высоту требует охватить все ряды, а
      // `grid-row: 1 / -1` считает `-1` по **явной** сетке, которой здесь нет —
      // ряды неявные, размеченные по содержимому, и охватывать нечего.
      //
      // Пустая колонка не рисуется вовсе: она забрала бы у соседей свою долю
      // ширины ради пустоты. Поэтому же ширину колонки задаёт `flex`, а не
      // доля от трёх, — на `/p` и `/s` колонка остаётся одна и занимает экран.
      const byColumn = [1, 2, 3]
        .map(column => sections.filter(s => s.column === column))
        .filter(column => column.length);
      list.innerHTML = byColumn.map(column =>
        `<div class="block-col col-${column[0].column}">` +
        column.map(blockCellHtml).join('') + '</div>').join('');
      blocksShape = shape;
      renderedBlocks = new Map();
      blockBodies = new Map(Array.from(list.querySelectorAll('.block'),
        el => [el.getAttribute('data-block'), el.querySelector('.block-rows')]));
    }
    sections.forEach((section, i) => {
      // Сколько строк было до секции — считается ДО сборки её элементов, а не
      // вычитанием их числа: подзаголовок машины — элемент без строки, и
      // арифметика «строк ровно столько же, сколько элементов» на нём врёт.
      const before = rows.length;
      const items = itemsOfSection(section, nowSec);
      // Номер секции — на строке: по нему ходят стрелки (picker-sections.js).
      for (let n = before; n < rows.length; n++) rows[n].block = i;
      const body = blockBodies.get(section.key);
      const plan = window.PickerListSync.planListSync(
        renderedBlocks.get(section.key), items, body.children.length);
      applyPlan(body, plan);
      renderedBlocks.set(section.key, { keys: plan.keys, html: plan.html });
    });
  }
```

Обратить внимание: `blocksShape` теперь считается по `key|column` без подписи — счёт в заголовке меняется постоянно, и входи он в отпечаток, контейнеры пересобирались бы в такт опросу.

- [ ] **Step 6: заменить ветки в `render()`**

`sessions.html`, строки 1069-1083 — заменить на:

```js
    list.classList.toggle('blocks', fullscreen);
    const sections = sectionsFor(mode, query);
    if (fullscreen) {
      // Узкое состояние отрисовки сбрасывается: вернувшись, planListSync
      // сравнил бы новые строки со старым снимком чужой раскладки и правил бы
      // не те элементы. Тот же сброс в обратную сторону — ниже.
      rendered = { keys: [], html: [] };
      renderWide(sections, nowSec);
    } else {
      blocksShape = null;
      renderedBlocks = new Map();
      renderNarrow(sections, nowSec, items);
      syncList(items);
    }
```

- [ ] **Step 7: добавить подписи пустых режимов**

`sessions.html`, ветка `else { message.style.display = rows.length ? 'none' : 'block'; …}` (строки 1100-1130) — в цепочку выбора текста добавить перед веткой `mode === 'projects'`:

```js
        message.textContent = mode === 'local' ? 'No sessions on this machine.'
          : mode === 'remote' ? 'No sessions on other machines.'
          : mode === 'history' ? 'Nothing in history.'
          : mode === 'projects'
```

Отката в поиск по сессиям у этих трёх режимов нет намеренно: пустая история — факт, а не непонятая команда, и подмена списка молча врала бы про причину. Способность гейтит только `snapshots`, и его откат живёт в `shownModeAndQuery` — там ничего не меняется.

- [ ] **Step 8: `choose()` переключает свёрнутость**

`sessions.html`, строки 1652-1659 — заменить на:

```js
    // Заголовок секции: Enter на нём не открывает ничего, а сворачивает или
    // разворачивает секцию. Стоит до разбора обычных видов строк: сессии за
    // ним нет вовсе, и любая ветка ниже приняла бы его за строку без id.
    if (row.kind === 'section') {
      const layout = layoutName();
      collapsed = {
        ...collapsed,
        [layout]: { ...collapsed[layout], [row.sectionKey]: !row.collapsed },
      };
      saveUi();
      render();
      return;
    }
```

- [ ] **Step 9: `^F` больше не сбрасывает свёрнутость**

`sessions.html`, строки 2128-2131 — удалить сброс:

```js
      fullscreen = !fullscreen;
      invoke('set_picker_size', { fullscreen })
```

(строки с комментарием про «свёрнутые блоки — состояние одной раскладки» и `collapsedBlocks = [];` уходят: состояние теперь и так своё у каждой раскладки и переживает переключение.)

- [ ] **Step 10: читать свёрнутость при загрузке и по `ui-changed`**

`sessions.html:2322` и `sessions.html:2396` — после `fullscreen = ui.fullscreen;` в обоих местах добавить:

```js
      collapsed = ui.collapsed;
```

- [ ] **Step 11: прогнать тесты**

Run: `npm test`
Expected: PASS. Тесты, ожидавшие `renderSessions`/`renderProjects`/`renderSnapshots` в `test/row-contract.test.js`, надо переписать на `itemsOfSection`: `pageFunctions('sectionItem(section)', 'itemsOfSection(section, nowSec)', …)` и вызов `itemsOfSection(section, nowSec)` вместо `renderProjects(query, items, nowSec)`.

- [ ] **Step 12: коммит**

```bash
git add sessions.html test/row-contract.test.js
git commit -m "feat(picker): узкий список рисует те же секции, что и широкий"
```

---

### Task 7: клавиши

**Files:**
- Modify: `frontend-src/action-hotkey.js:20-41`
- Modify: `sessions.html:2100-2121` (ветки `KeyA` и `KeyS`), `sessions.html:2138-2139` (комментарий)
- Test: `test/action-hotkey.test.js`

**Interfaces:**
- Consumes: `showMode(mode)` (Task 2).
- Produces: `BUILTIN_ACTION_KEYS.pr === 'g'`; `RESERVED_CODES` содержит `KeyP`, `KeyL`, `KeyH` и не содержит `KeyA`.

- [ ] **Step 1: написать падающий тест**

В `test/action-hotkey.test.js` добавить в конец:

```js
test('ярлыки режимов заняли свои буквы, а pr уступил свою', () => {
  // `^P` отдан ярлыку проектов, поэтому `pr` переехал на свободную `g`
  // (GitHub). Без переезда встроенная ветка перехватывала бы первой, и
  // действие молчало бы — ровно та поломка, за которую уже заплачено списком
  // `c v x z` и правилом про `KeyF`.
  assert.strictEqual(BUILTIN_ACTION_KEYS.pr, 'g');
  for (const code of ['KeyP', 'KeyL', 'KeyH', 'KeyS', 'KeyF', 'KeyK', 'KeyG']) {
    assert.ok(RESERVED_CODES.includes(code), code);
  }
  // `^A` вернулся полю поиска: ярлык проектов ушёл на `^P`, и «выделить всё»
  // в строке поиска снова работает.
  assert.ok(!RESERVED_CODES.includes('KeyA'));
});
```

- [ ] **Step 2: прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `BUILTIN_ACTION_KEYS.pr` равен `'p'`.

- [ ] **Step 3: правка `frontend-src/action-hotkey.js`**

Заменить строку 20 и комментарий над ней (добавив абзац):

```js
   * Буква `pr` — `g`, а не напрашивавшаяся `p`: `^P` отдан ярлыку режима
   * проектов. Мнемоника у `g` своя — GitHub, куда действие и ведёт.
   */
  const BUILTIN_ACTION_KEYS = { new: 'n', pr: 'g', unread: 'u', seen: 'd', attach: 'r', info: 'i' };
```

Заменить блок `'KeyA'` (строки 29-32) на:

```js
    // Не действие, а ярлык: ставит `/p ` в начало строки поиска. Клавишу он
    // всё равно занимает, и настроенному действию её отдавать нельзя.
    'KeyP',
    // Ярлыки остальных двух режимов, у которых клавиша есть. `/r` клавиши не
    // получил намеренно — к чужим сессиям отдельно ходят реже, чем к своим и
    // к истории, а каждая буква отнимается у поля поиска насовсем.
    'KeyL',
    // Цена `^H` известна и принята: на macOS это системная emacs-привязка
    // «удалить символ слева» в текстовом поле, и прямые клавиши гасят событие
    // через preventDefault. Backspace и Delete работают, теряется только она.
    'KeyH',
```

- [ ] **Step 4: правка веток на странице**

`sessions.html`, строки 2100-2107 (ветка `KeyA`) — заменить на:

```js
    if (plainCtrl && e.code === 'KeyP') {
      // Ставит `/p ` в начало строки поиска. Не режим и не переключатель:
      // состояние живёт в самом тексте, и стирание префикса возвращает к
      // сессиям. preventDefault обязателен и здесь: без него Ctrl+P в webview
      // уйдёт в печать.
      e.preventDefault();
      showProjects();
      return;
    }
    if (plainCtrl && e.code === 'KeyL') {
      // `/l ` — только свои живые сессии.
      e.preventDefault();
      showMode('local');
      return;
    }
    if (plainCtrl && e.code === 'KeyH') {
      // `/h ` — история. Цена клавиши записана в action-hotkey.js.
      e.preventDefault();
      showMode('history');
      return;
    }
```

`sessions.html:2109` — в комментарии ветки `KeyS` заменить «как `^A` ставит `/a `» на «как `^P` ставит `/p `».

`sessions.html:2138` — заменить комментарий на:

```js
    // ^G/^U/^I и прочие действия — те же, что и в меню. preventDefault здесь
    // обязателен: иначе Ctrl+P в webview уйдёт в печать, а Ctrl+G — в поиск.
```

- [ ] **Step 5: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: коммит**

```bash
git add frontend-src/action-hotkey.js sessions.html test/action-hotkey.test.js
git commit -m "feat(picker): ^P открывает проекты, ^L и ^H — свои сессии и историю"
```

---

### Task 8: тесты на отрисовку секций и на уход стрелок

Закрывает пункт `# next` «Широкий режим не покрыт тестами в двух местах».

**Files:**
- Modify: `test/row-contract.test.js`

**Interfaces:**
- Consumes: `renderWide`, `itemsOfSection`, `sectionItem`, `atQueryEdge` из `sessions.html` — вычитываются `pageFunctions` и исполняются в `vm`, как уже делают тесты `renderProjects` и `shownModeAndQuery` в этом же файле.

- [ ] **Step 1: написать тест на порядок строк против DOM**

В `test/row-contract.test.js` добавить в конец:

```js
test('renderWide: номер строки в разметке совпадает с её местом в rows', () => {
  // По индексу строки ходит клик, по номеру секции — `←/→`. Подзаголовок
  // машины при этом элемент без строки, и арифметика «строк ровно столько же,
  // сколько элементов» на нём врёт — ради этого случая тест и написан.
  const SECTIONS = [
    {
      key: 'live', label: 'Active local sessions', kind: 'sessions',
      count: 1, lastAt: 0, collapsed: false, column: 1,
      rows: [{ id: 'a' }],
    },
    {
      key: 'remote', label: 'Active remote sessions', kind: 'sessions',
      count: 2, lastAt: 0, collapsed: false, column: 2,
      rows: [
        { kind: 'block-subhead', key: 'sub:alpha-host', label: 'alpha-host - 2' },
        { id: 'x' }, { id: 'y' },
      ],
    },
  ];

  const rows = [];
  // Заглушка строки: делает ровно то, что делают настоящие sessionItem и
  // соседи, — кладёт строку в rows и подписывает разметку её номером.
  const stubItem = (row) => {
    const index = rows.length;
    rows.push(row);
    return { key: `k:${index}`, html: `<div class="row" data-index="${index}"></div>` };
  };

  const ctx = vm.createContext({
    rows,
    escapeHtml: (s) => String(s),
    window: {
      PickerSections: require('../frontend-src/picker-sections'),
      // Отдаёт элементы как есть: что попало в план, то и нарисовано.
      PickerListSync: {
        planListSync: (_prev, items) => ({
          mode: 'rebuild', keys: items.map(i => i.key), html: items.map(i => i.html),
        }),
      },
    },
    // Каркас считается уже собранным: тогда renderWide не трогает `list`
    // вовсе, и двойник DOM нужен только на тела секций.
    blocksShape: SECTIONS.map(s => `${s.key}|${s.column}`).join('\n'),
    renderedBlocks: new Map(),
    blockBodies: new Map(SECTIONS.map(s => [s.key, { children: [] }])),
    applyPlan: () => {},
    sessionItem: stubItem,
    projectItem: stubItem,
    snapshotItem: stubItem,
    // Подзаголовок — подпись, а не строка: в rows он не попадает.
    subheadItem: (row) => ({ key: `sh:${row.key}`, html: '<div class="group-label"></div>' }),
    SECTIONS,
  });

  vm.runInContext(
    `${pageFunctions('sectionItem(section)', 'itemsOfSection(section, nowSec)', 'renderWide(sections, nowSec)')}
     renderWide(SECTIONS, 0);`,
    ctx, { filename: 'sessions.html' });

  // Две строки-заголовка и три сессии; подзаголовок машины строкой не стал.
  assert.deepStrictEqual(rows.map(r => r.kind || r.id), ['section', 'a', 'section', 'x', 'y']);
  // Номер секции стоит у каждой строки, включая заголовки.
  assert.deepStrictEqual(rows.map(r => r.block), [0, 0, 1, 1, 1]);
  // Заголовок знает свой ключ и своё состояние — по ним choose() переключает.
  assert.deepStrictEqual(
    rows.filter(r => r.kind === 'section').map(r => r.sectionKey),
    ['live', 'remote'],
  );
});

test('свёрнутая секция отдаёт один заголовок, но счёт в нём полный', () => {
  const rows = [];
  const ctx = vm.createContext({
    rows,
    escapeHtml: (s) => String(s),
    window: { PickerSections: require('../frontend-src/picker-sections') },
    sessionItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    projectItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    snapshotItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    subheadItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    SECTION: {
      key: 'past', label: 'Not running', kind: 'sessions', count: 47,
      lastAt: 0, collapsed: true, rows: new Array(47).fill({ id: 'old' }),
    },
  });
  const items = vm.runInContext(
    `${pageFunctions('sectionItem(section)', 'itemsOfSection(section, nowSec)')}
     itemsOfSection(SECTION, 0);`,
    ctx, { filename: 'sessions.html' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(rows.length, 1);
  assert.ok(items[0].html.includes('Not running - 47'), items[0].html);
});
```

- [ ] **Step 2: написать тест на `atQueryEdge`**

```js
test('стрелки уходят в навигацию только на краю запроса и без выделения', () => {
  // Поле поиска сфокусировано всегда, и отнять у него стрелки насовсем значило
  // бы лишить человека правки запроса.
  const ctx = vm.createContext({});
  const check = (value, start, end, key) => {
    ctx.search = { value, selectionStart: start, selectionEnd: end };
    return vm.runInContext(
      `${pageFunctions('atQueryEdge(key)')}\natQueryEdge(${JSON.stringify(key)});`,
      ctx, { filename: 'sessions.html' });
  };
  assert.strictEqual(check('picker', 0, 0, 'ArrowLeft'), true);
  assert.strictEqual(check('picker', 6, 6, 'ArrowRight'), true);
  assert.strictEqual(check('picker', 3, 3, 'ArrowLeft'), false);
  assert.strictEqual(check('picker', 3, 3, 'ArrowRight'), false);
  // Есть выделение — стрелки остаются полю: ими его снимают.
  assert.strictEqual(check('picker', 0, 6, 'ArrowLeft'), false);
});
```

- [ ] **Step 3: прогнать тесты**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: коммит**

```bash
git add test/row-contract.test.js
git commit -m "test(picker): отрисовка секций и уход стрелок в навигацию"
```

---

### Task 9: вёрстка в двух движках, документация, TODO

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/TODO.md`
- Возможно: `sessions.html` (`<style>`), если стенд покажет расхождение

- [ ] **Step 1: собрать стенд и прогнать в Chromium**

Стенд собирается из настоящего `<style>` страницы и настоящей разметки строк — так же, как он собирался при поиске схлопывания колонок на маке. Chromium берётся из кэша puppeteer и водится по CDP. Проверить четыре раскладки: полную, короткую, одну колонку (`/p`) и две.

Что смотреть: заголовок секции переехал внутрь `.block-rows`, то есть теперь он скроллится вместе со строками, а не стоит шапкой. Убедиться, что колонка по-прежнему делится по правилу `flex: 1 1 0` у верхней секции и `flex: 0 1 auto; max-height: 50%` у нижней.

- [ ] **Step 2: прогнать тот же стенд в WebKit**

WebKit — `WebKit2` из `python3-gi` (`gi.require_version('WebKit2', '4.1')`) в `Gtk.OffscreenWindow` под `xvfb-run`. Это тот движок, на котором пикер живёт на маке, и именно он однажды схлопнул блоки с `max-height: max-content` в один заголовок при исправном Chromium.

- [ ] **Step 3: править `CLAUDE.md`**

- В правиле про широкий режим: «блоки» → «секции», `picker-blocks.js` → `picker-sections.js`, `buildBlocks` → `buildSections`; добавить, что сборка одна на обе раскладки и от раскладки зависят только склейка, колонки и умолчание свёрнутости.
- Заменить абзац «История приходит развёрнутой»: механизм больше не без входа — заголовок стал строкой, свёрнутая и развёрнутая формы это одна строка, и в узком списке история приходит свёрнутой.
- В правиле про букву встроенного действия: дописать цену `^H` на macOS и переезд `pr` на `^G`; убрать утверждение, что `^A` отдан ярлыку.
- Добавить правило про пять префиксов и про то, почему у `/l`, `/r`, `/h` нет отката в поиск по сессиям, а у `/s` есть.
- Добавить правило про стабильные ключи секций и про то, что счёт живёт в `count`, а не в `label`.
- Добавить правило про порядок чужих машин: по `recentKey` самой свежей сессии, на равном ключе — по имени, и почему ключ тот же, что у строк внутри группы.
- В правиле про `ui.json`: четвёртое поле `collapsed`, две половинки по раскладкам, и что окно настроек обязано вернуть его четвёртым аргументом.

- [ ] **Step 4: править `docs/TODO.md`**

Убрать из `# next`: пункт про узкий режим (сделан), пункт «Свернуть блок теперь нечем» (сделан), пункт «Широкий режим не покрыт тестами в двух местах» (сделан), пункт «Чужие машины идут по алфавиту» (сделан в Task 1b). Убрать из `# minor` пункт «`^A` больше не „выделить всё“» — клавиша вернулась полю поиска.

- [ ] **Step 5: прогнать тесты и закоммитить**

```bash
npm test
git add CLAUDE.md docs/TODO.md sessions.html
git commit -m "docs: правила секций, префиксов и свёрнутости"
```

---

## Что этот план не закрывает

Остаются четыре задачи `# next`, к секциям отношения не имеющие: `normHost` тремя копиями, проверка формы `windowHosts` в `trackerHosts`, тест на `restoreLocally`, выбор терминала в настройках. И проверка iTerm2/Ghostty/kitty — она делается руками на макбуке.
