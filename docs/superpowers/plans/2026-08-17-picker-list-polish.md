# Девять правок списка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** закрыть девять задач из `# next`, которые не требуют правок в
агрегаторе `ccfzf` и в менеджерах окон, и разложить остаток очереди по
репозиториям.

**Architecture:** правки фронтендовые и независимые друг от друга. Общее
правило: чистая логика уезжает в модуль `frontend-src/` и проверяется прямым
вызовом, страничная — остаётся в `sessions.html` и проверяется либо через
`vm`-стенд `test/row-contract.test.js`, либо текстовым сторожем по исходнику
страницы.

**Tech Stack:** ES5-совместимый JS без сборщика (модули — UMD-шим «script или
require»), тесты — `node:test` + `node:assert`, разметка и стили — прямо в
`sessions.html` и `settings.html`.

**Spec:** [docs/superpowers/specs/2026-08-17-picker-list-polish-design.md](../specs/2026-08-17-picker-list-polish-design.md)

## Global Constraints

- **Язык.** Всё, что видит человек, — по-английски (подписи, галки, подсказки).
  Всё, что видит разработчик, — по-русски (комментарии, имена тестов, тексты в
  `assert`).
- **Тесты.** Один файл — `node --test test/<имя>.test.js`; перед коммитом —
  `npm test` целиком. `node --test test/` на этих версиях Node не работает.
  `cargo test` в этом плане не нужен: `src-tauri` не трогается.
- **Один коммит на задачу.** Галка в `docs/TODO.md` снимается тем же коммитом,
  что и код (`feat:`/`fix:`), а не отдельным `task:`.
- **Правило про два списка.** Всюду, где число или таблица уже где-то
  объявлены, брать существующее, а не писать второе.
- **Тест, сверяющийся с видимой строкой, правится вместе с ней** — это не
  «поломка теста», а часть задачи.
- **Ветка** — `feat/picker-list-polish`, уже создана от `master`; спека на ней
  уже лежит (коммит `7adb864`).

---

### Task 1: Кружок у проекта, где не было ни одной сессии

**Files:**
- Modify: `sessions.html:1057-1066` (функция `projectItem`)
- Test: `test/row-contract.test.js` (существующий тест правится, добавляется новый)
- Modify: `docs/TODO.md` (снять пункт про серый кружок)

**Interfaces:**
- Consumes: `buildProjectList` даёт строке `liveCount` и `sessionCount`
  (`frontend-src/project-list.js`).
- Produces: ничего для следующих задач.

- [ ] **Step 1: Поправить существующий тест — он сторожит прежнее поведение**

В `test/row-contract.test.js`, в тесте «строка проекта доезжает с настоящего
пути до разметки списка», заменить блок про точку:

```js
  // Точка: зелёная там, где кто-то работает, обычная серая — где никого.
  // `closed` (прозрачная) у проекта не появляется: она про закрытую сессию.
  assert.ok(items[0].html.includes('<div class="dot active"></div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="dot"></div>'), items[1].html);
  assert.ok(!items[1].html.includes('closed'), items[1].html);
```

на:

```js
  // Точка: зелёная там, где кто-то работает; у проекта без единой сессии —
  // прозрачная. Второй проект фикстуры именно такой (`sessions: 0`).
  assert.ok(items[0].html.includes('<div class="dot active"></div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="dot closed"></div>'), items[1].html);
```

- [ ] **Step 2: Дописать тест на все три состояния**

В тот же файл, следом за поправленным тестом:

```js
test('кружок проекта различает живое, прошлое и пустое', () => {
  // Три состояния, а не два: серый кружок у закладки, в которой не работали
  // никогда, обещал историю, которой нет. Прозрачный оставляет место пустым —
  // ровно как у закрытой сессии.
  const { items } = renderProjectRows([
    { path: '/home/user/projects/a', name: 'a', mark: false, sessions: 12, live: 2, mtime: 1786045860 },
    { path: '/home/user/projects/b', name: 'b', mark: false, sessions: 5, live: 0, mtime: 1786045800 },
    { path: '/home/user/projects/c', name: 'c', mark: false, sessions: 0, live: 0, mtime: 0 },
  ]);
  assert.strictEqual(items.length, 3);
  assert.ok(items[0].html.includes('<div class="dot active"></div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="dot"></div>'), items[1].html);
  assert.ok(items[2].html.includes('<div class="dot closed"></div>'), items[2].html);
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `node --test test/row-contract.test.js`
Expected: FAIL — оба теста ждут `dot closed` у проекта без сессий, а страница
рисует `dot`.

- [ ] **Step 4: Правка страницы**

В `sessions.html`, в `projectItem`, заменить строку `const dotClass = ...`
вместе с комментарием над ней:

```js
    // Зелёная точка у проекта, где кто-то работает прямо сейчас: тот же
    // словарь цветов, что и у сессии, и та же ширина левой колонки.
    //
    // Состояний три, и третье — не придирка. Серый кружок значит «сессии
    // были, сейчас никто не работает»; у закладки, в которой не работали
    // **никогда**, он обещал историю, которой нет. Такой строке достаётся
    // `closed` — прозрачная точка, оставляющая место пустым. Прежний
    // комментарий здесь возражал против `closed` у проекта, и возражение было
    // верно для своего случая: оно про «сейчас никого», а не про «не было
    // никого».
    const dotClass = project.liveCount
      ? 'dot active'
      : (project.sessionCount ? 'dot' : 'dot closed');
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `node --test test/row-contract.test.js`
Expected: PASS

- [ ] **Step 6: Прогнать всё и закоммитить**

```bash
npm test
```

Снять пункт в `docs/TODO.md`: удалить строку
`- [ ] **Прятать серый кружок у проектов, где не было ни одной сессии.**`

```bash
git add sessions.html test/row-contract.test.js docs/TODO.md
git commit -m "fix(picker): у проекта без единой сессии кружок прозрачный"
```

---

### Task 2: Выделение больше не снимает затемнение stale

**Files:**
- Modify: `sessions.html:253-260` (правила `.row.stale`)
- Create: `test/stale-dim.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: класс `stale` вешает `StaleItems.staleClass` — не трогается.
- Produces: файл `test/stale-dim.test.js`, который Task 3 дополнит.

- [ ] **Step 1: Написать падающий тест**

Create `test/stale-dim.test.js`:

```js
// Затемнение старых строк: правила CSS и галка в статуслайне.
//
// Оба сторожа текстовые, и это не лень. Правило CSS поведением не проверить
// вовсе — DOM в тестах нет; а галка ломается тихо: перепутанная сторона в
// TOGGLE_CHECKS уводит её в фильтры, и она начинает пересобирать состав
// списка вместо перерисовки.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
const STYLES = SESSIONS_HTML.split('</style>')[0];

test('выбор не снимает затемнение stale, наведение снимает', () => {
  // Выбор стоит на первой строке при каждом показе окна и при каждой правке
  // запроса — то есть сам собой. Снимая с неё затемнение, он делал старую
  // сессию самой яркой в списке. Наведение остаётся: это жест человека, по
  // одной строке и руками.
  assert.ok(/\.row\.stale:hover\s*\{[^}]*opacity:\s*1/.test(STYLES),
    'наведение перестало снимать затемнение stale');
  assert.ok(!/\.row\.stale\.active/.test(STYLES),
    'выделение снова снимает затемнение stale — первая строка станет самой яркой');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/stale-dim.test.js`
Expected: FAIL на втором `assert` — `.row.stale.active` пока в стилях есть.

- [ ] **Step 3: Правка стилей**

В `sessions.html` заменить

```css
.row.stale { opacity: var(--stale-opacity, 0.5); }
.row.stale:hover,
.row.stale.active { opacity: 1; }
```

на

```css
.row.stale { opacity: var(--stale-opacity, 0.5); }
/* Снимает затемнение только наведение. Выбор его снимал тоже — и делал самой
   яркой строкой списка первую попавшуюся: `active` ставится на неё при каждом
   показе окна и при каждой правке запроса, то есть без участия человека.
   Наведение — наоборот, прямой жест и по одной строке. */
.row.stale:hover { opacity: 1; }
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node --test test/stale-dim.test.js`
Expected: PASS

- [ ] **Step 5: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] Сейчас первая сессия в списке слишком
яркая, когда она не активная...` целиком.

```bash
git add sessions.html test/stale-dim.test.js docs/TODO.md
git commit -m "fix(picker): выбор больше не снимает затемнение stale"
```

---

### Task 3: Галка `dim stale` в статуслайне

**Files:**
- Modify: `sessions.html` — `TOGGLE_CHECKS` (~779), умолчания `uiToggles` (~809),
  вызовы `staleClass` (1058 и 1186), оба вызова `normalizeUiState` (~3200 и ~3284)
- Modify: `test/stale-dim.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `StaleItems.staleClass(row, nowSec, stale, kind)` — сигнатура не меняется.
- Produces: функции страницы `staleSettings()` и `toggleDefaults()`; ключ
  `dimStale` в `ui.json` (`{list, statusline}`, как у остальных галок).

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/stale-dim.test.js`:

```js
test('галка dim stale есть и она не фильтр', () => {
  // Сторона решает, что позовёт обработчик: фильтру — regroup (он меняет
  // состав списка), остальным — render. Затемнение состава не меняет, и
  // сторона `filter` заставила бы пересобирать группы на каждое нажатие.
  assert.match(SESSIONS_HTML, /\{ key: 'dimStale', label: 'dim stale', side: 'dim' \}/,
    'галки dim stale нет в TOGGLE_CHECKS или у неё другая сторона');
  const filters = SESSIONS_HTML.match(/side: 'filter'/g) || [];
  assert.strictEqual(filters.length, 2,
    'фильтров стало не два — проверь, не уехала ли dimStale в фильтры');
});

test('умолчание галки берётся из конфига, а не из литерала', () => {
  // В литерале умолчаний CONFIG ещё пустой (load_config идёт позже), и
  // значение застыло бы на встроенном. Обе дороги к normalizeUiState —
  // первая загрузка и событие ui-changed — обязаны звать одну функцию.
  assert.match(SESSIONS_HTML, /function toggleDefaults\(\)/,
    'нет функции toggleDefaults');
  assert.match(SESSIONS_HTML, /dimStale: \{ \.\.\.uiToggles\.dimStale, list: CONFIG\.stale\.enabled \}/,
    'умолчание dimStale считается не от CONFIG.stale.enabled');
  const calls = SESSIONS_HTML.match(/toggles: toggleDefaults\(\)/g) || [];
  assert.strictEqual(calls.length, 2,
    `normalizeUiState зовётся с toggleDefaults() ${calls.length} раз из двух`);
});

test('затемнение спрашивает галку, а не CONFIG.stale напрямую', () => {
  // Два вызова staleClass — у строки сессии и у строки проекта. Оставь один
  // из них на CONFIG.stale, и галка гасила бы половину списка.
  const direct = SESSIONS_HTML.match(/staleClass\([^)]*CONFIG\.stale[^)]*\)/g) || [];
  assert.deepStrictEqual(direct, [],
    `staleClass всё ещё зовётся с CONFIG.stale: ${direct.join(' | ')}`);
  const viaSettings = SESSIONS_HTML.match(/staleClass\([^)]*staleSettings\(\)[^)]*\)/g) || [];
  assert.strictEqual(viaSettings.length, 2,
    `через staleSettings() идёт ${viaSettings.length} вызова из двух`);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/stale-dim.test.js`
Expected: FAIL — ни `dimStale`, ни `toggleDefaults`, ни `staleSettings` пока нет.

- [ ] **Step 3: Завести галку и умолчание**

В `TOGGLE_CHECKS`, после записи `showAll` и перед `showTerminalIcon`:

```js
    // Четвёртая группа, `dim`, — и не колонка, и не фильтр. Состав списка
    // затемнение не меняет (класс вешает отрисовщик строки), поэтому
    // обработчику хватает render(); попади ключ в FILTER_KEYS, каждое
    // нажатие пересобирало бы группы впустую.
    { key: 'dimStale', label: 'dim stale', side: 'dim' },
```

В литерал `uiToggles`, рядом с `showAll`:

```js
    // Умолчание подставляется при загрузке ui.json (toggleDefaults): здесь
    // CONFIG ещё пустой — load_config идёт позже, — и значение застыло бы на
    // встроенном. `true` тут только затем, чтобы ключ существовал.
    dimStale: { list: true, statusline: true },
```

- [ ] **Step 4: Завести обе функции**

Рядом с `applyStaleOpacity()` (`sessions.html:891`):

```js
  /**
   * Настройка затемнения, какой её видит отрисовщик строки.
   *
   * Вето у конфига нет намеренно. `CONFIG.stale.enabled && dimStale` дал бы
   * нажатую галку, от которой ничего не происходит, — ровно та болезнь, что
   * уже живёт у `show all` при выключенном `onlyLive`. Конфиг решает, с чем
   * пикер открывается (умолчание галки), дальше решает галка.
   */
  function staleSettings() {
    return { ...CONFIG.stale, enabled: toggles.dimStale };
  }

  /**
   * Умолчания галок для normalizeUiState — с оглядкой на уже загруженный
   * конфиг. Одна функция на обе дороги (первая загрузка и `ui-changed`):
   * второе такое же выражение разошлось бы с первым молча.
   */
  function toggleDefaults() {
    return { ...uiToggles, dimStale: { ...uiToggles.dimStale, list: CONFIG.stale.enabled } };
  }
```

- [ ] **Step 5: Развести вызовы**

В `projectItem` (`sessions.html:1058`) и в `sessionItem` (`sessions.html:1186`)
заменить третий аргумент `CONFIG.stale` на `staleSettings()`.

В обоих вызовах `normalizeUiState` заменить `toggles: uiToggles` на
`toggles: toggleDefaults()`.

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `node --test test/stale-dim.test.js`
Expected: PASS

- [ ] **Step 7: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] Добавить в статуслайн переключатель
затенения stale сессий.`

```bash
git add sessions.html test/stale-dim.test.js docs/TODO.md
git commit -m "feat(picker): галка dim stale в статуслайне"
```

---

### Task 4: Сброс выбора остаётся в своей панели

**Files:**
- Modify: `frontend-src/picker-sections.js` (новая `firstRowInPanel`, экспорт)
- Modify: `sessions.html` — `itemsOfSection` (~1312), `paint` (~1700),
  сброс в `render` (~1487), `beginShow` (~3102), объявления рядом с `let rows` (~659)
- Modify: `test/picker-sections.test.js`, `test/row-contract.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `section.key` из `buildSections`; `HEADER_KINDS` со страницы.
- Produces: `PickerSections.firstRowInPanel(rows, panel, headerKinds) → number`;
  поле `row.panel` (постоянный ключ секции) на каждой строке списка;
  страничная переменная `activePanel`.

- [ ] **Step 1: Написать падающий тест на чистую функцию**

Дописать в `test/picker-sections.test.js`:

```js
test('сброс выбора встаёт на первую строку своей панели', () => {
  // Панель помнится ключом секции, а не номером: номер съезжает, стоит
  // соседней панели опустеть, и выбор уехал бы в чужую.
  const HEADERS = new Set(['section', 'snapshot-day']);
  const rows = [
    { kind: 'section', panel: 'live' },
    { kind: 'session', panel: 'live' },
    { kind: 'section', panel: 'projects' },
    { kind: 'project', panel: 'projects' },
    { kind: 'project', panel: 'projects' },
  ];
  assert.strictEqual(PickerSections.firstRowInPanel(rows, 'projects', HEADERS), 3);
  assert.strictEqual(PickerSections.firstRowInPanel(rows, 'live', HEADERS), 1);
});

test('панель без совпадений отдаёт выбор первой строке списка', () => {
  // Запрос может не оставить в прежней панели ни строки — тогда работает
  // прежнее умолчание, и заголовок оно по-прежнему пропускает.
  const HEADERS = new Set(['section', 'snapshot-day']);
  const rows = [
    { kind: 'section', panel: 'live' },
    { kind: 'session', panel: 'live' },
  ];
  assert.strictEqual(PickerSections.firstRowInPanel(rows, 'snapshots', HEADERS), 1);
  // Пустая память — то же умолчание: так ведёт себя свежепоказанное окно.
  assert.strictEqual(PickerSections.firstRowInPanel(rows, '', HEADERS), 1);
  // Список из одних заголовков не оставляет выбора вовсе.
  assert.strictEqual(PickerSections.firstRowInPanel([{ kind: 'section', panel: 'live' }], 'live', HEADERS), 0);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/picker-sections.test.js`
Expected: FAIL — `PickerSections.firstRowInPanel is not a function`.

- [ ] **Step 3: Написать функцию**

В `frontend-src/picker-sections.js`, рядом с `moveBetweenBlocks`:

```js
  /**
   * Куда встаёт выбор при сбросе: первая не-заголовок в названной панели.
   *
   * Панель называется ключом секции (`row.panel`), а не номером блока
   * (`row.block`): номер съезжает от появления и исчезновения соседей, а
   * помнить надо именно ту панель, в которой человек стоял. Не нашлось в ней
   * ничего — работает прежнее умолчание, первая не-заголовок во всём списке:
   * так же ведёт себя и свежепоказанное окно, где помнить нечего.
   */
  function firstRowInPanel(rows, panel, headerKinds) {
    const list = Array.isArray(rows) ? rows : [];
    const header = (row) => Boolean(headerKinds && headerKinds.has(row.kind));
    if (panel) {
      const inPanel = list.findIndex(row => row.panel === panel && !header(row));
      if (inPanel !== -1) return inPanel;
    }
    const first = list.findIndex(row => !header(row));
    return first === -1 ? 0 : first;
  }
```

и добавить `firstRowInPanel` в объект экспорта.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node --test test/picker-sections.test.js`
Expected: PASS

- [ ] **Step 5: Написать падающие текстовые сторожа на страницу**

Дописать в `test/row-contract.test.js`:

```js
test('панель строки проставляется одним местом на обе раскладки', () => {
  // itemsOfSection — единственный, кто знает и секцию, и добавленные ею
  // строки. Проставь панель renderWide, и в узком списке память была бы
  // пустой, а сброс — прежним.
  const source = pageFunctions('itemsOfSection(section, nowSec)');
  assert.match(source, /rows\[i\]\.panel = section\.key/,
    'itemsOfSection не проставляет row.panel');
});

test('память об активной панели пишется в paint, а не в render', () => {
  // Через paint проходят все смены выбора — стрелки, ←/→, клик, правая
  // кнопка и сам render. Записывай мы память в конце render, выбор,
  // наведённый стрелками за секунду до набора запроса, помнился бы прежним.
  const paint = pageFunctions('paint()');
  assert.match(paint, /activePanel = \(rows\[active\] \|\| \{\}\)\.panel \|\| ''/,
    'paint не запоминает панель активной строки');
  assert.match(SESSIONS_HTML, /firstRowInPanel\(rows, activePanel, HEADER_KINDS\)/,
    'сброс выбора не спрашивает запомненную панель');
});

test('показ окна забывает панель прошлого показа', () => {
  // Иначе выбор вставал бы на панель, которой на экране может уже не быть.
  const source = pageFunctions('beginShow()');
  assert.match(source, /activePanel = ''/, 'beginShow не чистит activePanel');
});
```

- [ ] **Step 6: Убедиться, что тесты падают**

Run: `node --test test/row-contract.test.js`
Expected: FAIL на всех трёх.

- [ ] **Step 7: Правка страницы**

Рядом с `let rows = [];` (`sessions.html:659`):

```js
  // Панель, в которой стояла выбранная строка. Помнится ключом секции и
  // переживает пересборку списка: по нему сброс выбора возвращается туда,
  // где человек стоял, а не в первую колонку.
  let activePanel = '';
```

В `itemsOfSection` — запомнить границы и проставить панель:

```js
  function itemsOfSection(section, nowSec) {
    const from = rows.length;
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
    // Панель — на каждой строке, которую добавила эта секция, и в обеих
    // раскладках. Поле рядом с `block`, который проставляет renderWide, и не
    // вместо него: `block` — номер для стрелок, съезжающий вместе с
    // соседями, `panel` — постоянный ключ, по которому память переживает
    // смену списка. Свёрнутая секция сюда не доходит — у неё строк нет.
    for (let i = from; i < rows.length; i++) rows[i].panel = section.key;
    return items;
  }
```

Обратите внимание: заголовок секции — тоже строка (`sectionItem` кладёт её в
`rows`), и панель ему проставляется той же петлёй. Это верно: `firstRowInPanel`
отсеивает заголовки по `kind`, а не по панели.

В `paint()`:

```js
  function paint() {
    const nodes = list.querySelectorAll('.row');
    nodes.forEach((node, i) => node.classList.toggle('active', i === active));
    // Одно место на все смены выбора: сюда приходят и стрелки, и ←/→, и оба
    // клика, и сам render. Пять обработчиков, помнящих панель каждый за
    // себя, разошлись бы, а забытый шестой дал бы прыжок через экран — ровно
    // тот, ради которого всё затевалось.
    activePanel = (rows[active] || {}).panel || '';
  }
```

Сброс выбора в `render()`:

```js
    if (selectionReset) {
      selectionReset = false;
      active = window.PickerSections.firstRowInPanel(rows, activePanel, HEADER_KINDS);
    }
```

В `beginShow()`, рядом с `active = 0;`:

```js
    // Панель прошлого показа забывается: её может уже не быть на экране, а
    // умолчание «первая не-заголовок» для свежего окна и есть верное.
    activePanel = '';
```

- [ ] **Step 8: Убедиться, что тесты проходят**

Run: `node --test test/row-contract.test.js test/picker-sections.test.js`
Expected: PASS

- [ ] **Step 9: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] **Широкий режим: набор запроса уводит выбор
из той панели, в которой он стоял.**` целиком.

```bash
git add frontend-src/picker-sections.js sessions.html test/picker-sections.test.js test/row-contract.test.js docs/TODO.md
git commit -m "fix(picker): сброс выбора остаётся в своей панели"
```

---

### Task 5: Буквы без Ctrl в меню `^K`

**Files:**
- Modify: `frontend-src/action-hotkey.js` (новая `menuKeys`, экспорт)
- Modify: `frontend-src/config-shape.js` (`normalizeActions` — поле `menuKey`)
- Modify: `sessions.html` — `renderMenu` (~2517), ветка `menuOpen` в keydown (~2888)
- Modify: `config.example.yml`, `README.md`
- Modify: `test/action-hotkey.test.js`, `test/config-shape.test.js`, `test/row-contract.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `BUILTIN_ACTION_KEYS` (`action-hotkey.js:23`), `menuActions` со страницы.
- Produces: `ActionHotkey.menuKeys(actions) → string[]` (буква на пункт, `''` где
  буквы нет), поле `menuKey` у записи `actions` в нормализованном конфиге,
  страничная переменная `menuKeysShown`.

- [ ] **Step 1: Написать падающий тест на `menuKeys`**

Дописать в `test/action-hotkey.test.js`:

```js
test('буквы пунктов меню: встроенные из таблицы, настроенные из menuKey', () => {
  // Вторая таблица тех же букв разошлась бы с первой, поэтому встроенные
  // берутся из BUILTIN_ACTION_KEYS, а не переписываются здесь.
  const keys = ActionHotkey.menuKeys([
    { id: 'new', label: 'New session' },
    { id: 'cursor', label: 'Open in Cursor', menuKey: 'o' },
    { id: 'info', label: 'Session info' },
  ]);
  assert.deepStrictEqual(keys, ['n', 'o', 'i']);
});

test('букву забирает первый сверху пункт', () => {
  // Порядок меню человек видит глазами; второй список приоритетов разошёлся
  // бы с ним, а молчащая буква хуже отсутствующей.
  const keys = ActionHotkey.menuKeys([
    { id: 'new', label: 'New session' },
    { id: 'note', label: 'Note', menuKey: 'n' },
  ]);
  assert.deepStrictEqual(keys, ['n', '']);
});

test('буквой бывает только латинская буква', () => {
  // Нажатие сверяется по e.code (`KeyO`), а кириллицу и знаки им не назвать
  // вовсе: подпись обещала бы клавишу, которой не нажать.
  const keys = ActionHotkey.menuKeys([
    { id: 'a', label: 'A', menuKey: 'щ' },
    { id: 'b', label: 'B', menuKey: '5' },
    { id: 'c', label: 'C', menuKey: 'X' },
    { id: 'd', label: 'D' },
  ]);
  assert.deepStrictEqual(keys, ['', '', 'x', '']);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/action-hotkey.test.js`
Expected: FAIL — `ActionHotkey.menuKeys is not a function`.

- [ ] **Step 3: Написать `menuKeys`**

В `frontend-src/action-hotkey.js`, после `BUILTIN_ACTION_KEYS`:

```js
  /**
   * Буква на пункт меню `^K` — в том же порядке, что и сами пункты.
   *
   * Одна функция на два дела: ею подписывают пункт и ею же находят пункт по
   * нажатой клавише. Два счёта разошлись бы ровно там, где это дороже всего —
   * меню обещало бы букву, которая ничего не делает.
   *
   * Встроенные берут букву из BUILTIN_ACTION_KEYS, настроенные — из своего
   * `menuKey`. Из Ctrl-хоткея настроенного действия букву взять нельзя:
   * ^O занят сортировкой, ^P/^L/^H/^S — режимами, то есть у «открыть в
   * Cursor» глобальной комбинации не бывает вовсе, а в меню `o` свободна. В
   * этом весь смысл буквы без Ctrl.
   *
   * Только латиница: нажатие сверяется по `e.code` (`KeyO`), и ни кириллицу,
   * ни цифру им не назвать.
   */
  function menuKeys(actions) {
    const used = new Set();
    return (Array.isArray(actions) ? actions : []).map((action) => {
      const a = action || {};
      const raw = BUILTIN_ACTION_KEYS[a.id] || a.menuKey || '';
      const key = String(raw).trim().toLowerCase();
      if (!/^[a-z]$/.test(key) || used.has(key)) return '';
      used.add(key);
      return key;
    });
  }
```

и добавить `menuKeys` в объект экспорта.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node --test test/action-hotkey.test.js`
Expected: PASS

- [ ] **Step 5: Написать падающий тест на конфиг**

Дописать в `test/config-shape.test.js`:

```js
test('menuKey у действия приводится к одной букве, мусор выбрасывается', () => {
  // Приводится здесь, а не при показе меню: разбирать одно и то же дважды —
  // тот самый второй список, за который в этом проекте уже платили.
  const cfg = ConfigShape.normalizeConfig({
    actions: [
      { id: 'cursor', label: 'Cursor', argv: ['cursor', '{localPath}'], menuKey: ' O ' },
      { id: 'plain', label: 'Plain', argv: ['echo'] },
    ],
  });
  assert.strictEqual(cfg.actions[0].menuKey, 'o');
  assert.strictEqual(cfg.actions[1].menuKey, '');
});
```

- [ ] **Step 6: Убедиться, что тест падает**

Run: `node --test test/config-shape.test.js`
Expected: FAIL — `menuKey` пока `undefined`.

- [ ] **Step 7: Правка `normalizeActions`**

В `frontend-src/config-shape.js`, в объект, который кладётся в `out`, после
`icon`:

```js
        // Буква пункта в меню ^K, без Ctrl. Пусто — пункт буквы не получает;
        // годность (одна латинская буква, никем не занятая) решает menuKeys в
        // action-hotkey.js, в одном месте на встроенные и настроенные.
        menuKey: nonEmpty(item.menuKey) ? item.menuKey.trim().toLowerCase() : '',
```

- [ ] **Step 8: Убедиться, что тест проходит**

Run: `node --test test/config-shape.test.js`
Expected: PASS

- [ ] **Step 9: Написать падающие сторожа на страницу**

Дописать в `test/row-contract.test.js`:

```js
test('меню подписывает пункты и слушает клавиши одним списком букв', () => {
  // Две копии счёта букв разошлись бы на первом же столкновении: подпись
  // обещала бы клавишу, которую обработчик отдал соседу.
  assert.match(SESSIONS_HTML, /menuKeysShown = window\.ActionHotkey\.menuKeys\(menuActions\)/,
    'renderMenu не считает буквы через ActionHotkey.menuKeys');
  assert.match(SESSIONS_HTML, /menuKeysShown\.indexOf\(letter\)/,
    'обработчик меню ищет букву не в том же списке');
});

test('буква в меню сверяется по e.code', () => {
  // e.key в русской раскладке приходит кириллицей, и меню перестало бы
  // слушаться ровно у того, кто набирает вслепую.
  assert.match(SESSIONS_HTML, /e\.code\.match\(\/\^Key\(\[A-Z\]\)\$\/\)/,
    'буква пункта меню разбирается не из e.code');
});
```

- [ ] **Step 10: Убедиться, что тесты падают**

Run: `node --test test/row-contract.test.js`
Expected: FAIL на обоих.

- [ ] **Step 11: Правка страницы — подпись пункта**

Рядом с `let menuActions = ...` завести:

```js
  // Буквы пунктов открытого меню, в порядке пунктов. Считаются один раз при
  // отрисовке: подпись и обработчик обязаны смотреть в один список.
  let menuKeysShown = [];
```

В `renderMenu`, перед сборкой `actionsList.innerHTML`:

```js
      menuKeysShown = window.ActionHotkey.menuKeys(menuActions);
```

и в самой сборке заменить вычисление подписи клавиши:

```js
        // Клавиша справа. В открытом меню пункт запускается голой буквой, и
        // подписана она так же — без `^`: Ctrl здесь не нажимают. Комбинация
        // из конфига остаётся запасной подписью для пунктов без буквы, а
        // `^N` для списка по-прежнему честен — он в справочнике F1.
        const letter = menuKeysShown[index];
        const shown = letter || formatHotkey(action.hotkey || '');
```

(строку `const key = ACTION_KEYS[action.id];` удалить — таблица теперь
спрашивается через `menuKeys`.)

- [ ] **Step 12: Правка страницы — обработчик**

В ветке `if (menuOpen)` заменить последний `else if`:

```js
      else if (!(e.ctrlKey || e.metaKey || e.altKey)) {
        // Простые клавиши меню и раньше глотало целиком — место было
        // свободно. Теперь буква запускает свой пункт; всё остальное
        // по-прежнему гасится, чтобы набор не проваливался в поле поиска
        // под меню.
        e.preventDefault();
        const code = e.code.match(/^Key([A-Z])$/);
        const letter = code ? code[1].toLowerCase() : '';
        const index = letter ? menuKeysShown.indexOf(letter) : -1;
        if (index !== -1) {
          menuActive = index;
          runMenuAction();
        }
      }
```

- [ ] **Step 13: Убедиться, что тесты проходят**

Run: `node --test test/row-contract.test.js`
Expected: PASS

- [ ] **Step 14: Описать поле человеку**

В `config.example.yml` пример с Cursor — как раз тот случай, ради которого поле
и заводится: `Ctrl+O` там обещан впустую, эту комбинацию пикер держит за
переключателем сортировки, и `normalizeActions` снимает её как занятую.
Заменить блок `cursor` (строки 175–178) на:

```yaml
#   - id: cursor
#     label: Open in Cursor
#     # Ctrl+O is the picker's own sort switch, so this action gets no global
#     # hotkey. In the Ctrl+K menu it answers to a bare `o`.
#     menuKey: o
#     argv: ['cursor', '{localPath}']
```

В `README.md`, в абзац про `actions` (строки 32–35), дописать предложение
после «команду и хоткей задаёте вы»:

> Пункт меню `^K` можно вдобавок повесить на голую букву — `menuKey`; она
> работает только при открытом меню, поэтому ей достаются и те буквы, которые
> пикер держит за собой под Ctrl.

- [ ] **Step 15: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] **В меню `Ctrl+K` буквы без Ctrl.**`

```bash
git add frontend-src/action-hotkey.js frontend-src/config-shape.js sessions.html config.example.yml README.md test/action-hotkey.test.js test/config-shape.test.js test/row-contract.test.js docs/TODO.md
git commit -m "feat(picker): пункт меню ^K запускается голой буквой"
```

---

### Task 6: Punto switcher в поиске

**Files:**
- Modify: `frontend-src/picker-filter.js` (таблица, `puntoRu`, `matchesText`, экспорт)
- Modify: `frontend-src/picker-snapshots.js:197`
- Modify: `test/picker-filter.test.js`, `test/picker-snapshots.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `searchableCwd` (там же).
- Produces: `PickerFilter.matchesText(text, q) → boolean` — единственный отбор
  по тексту на весь пикер.

- [ ] **Step 1: Написать падающий тест**

Дописать в `test/picker-filter.test.js`:

```js
const { matchesText } = require('../frontend-src/picker-filter');

test('запрос в русской раскладке находит латинское имя', () => {
  // Строка поиска сфокусирована всегда, и раскладка остаётся той, в которой
  // человек только что писал. Набранное вслепую не находило ничего и
  // выглядело пустым списком, а не промахом. `вуьщ` — это `demo`, набранное
  // на тех же клавишах.
  assert.deepStrictEqual(filterProjects(ROWS, 'вуьщ').map(r => r.label), ['demo']);
  assert.deepStrictEqual(
    filterSessions(GROUPS, 'вуьщ')[0].sessions.map(s => s.label), ['demo']);
});

test('верно набранное продолжает находить себя', () => {
  // Отбор идёт по «исходный ИЛИ переложенный»: перевод добавляет совпадения,
  // а не заменяет их.
  assert.deepStrictEqual(filterProjects(ROWS, 'demo').map(r => r.label), ['demo']);
});

test('строка без кириллицы второго варианта не получает', () => {
  assert.strictEqual(matchesText('demo', 'demo'), true);
  assert.strictEqual(matchesText('demo', 'zzz'), false);
});

test('id по кириллице не находится', () => {
  // matchesId сравнивает начало шестнадцатеричного id, и перевод туда не
  // идёт: `афсу` — это `face` на тех же клавишах, и переводи мы id, сессия
  // нашлась бы началом своего идентификатора по кириллическому запросу.
  const groups = [{
    title: 'Active sessions',
    sessions: [{ id: 'face1234-aaaa-bbbb-cccc-000000000003', label: 'zzz', cwd: '/home/user/zzz' }],
  }];
  assert.deepStrictEqual(filterSessions(groups, 'face').length, 1);
  assert.deepStrictEqual(filterSessions(groups, 'афсу'), []);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/picker-filter.test.js`
Expected: FAIL — `matchesText is not a function` и `вучщ` не находит `demo`.

- [ ] **Step 3: Написать таблицу и отбор**

В `frontend-src/picker-filter.js`, после `searchableCwd`:

```js
  /**
   * Раскладка ЙЦУКЕН → QWERTY, по позиции клавиши.
   *
   * Только буквы: знаки препинания сюда не входят намеренно. `.` → `/`
   * выглядит полезным для путей, но запрос из одной точки превратился бы в
   * запрос из одной косой черты — то есть нашёл бы каждый путь разом.
   */
  const PUNTO_RU = {
    й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p',
    ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l',
    я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm',
    ё: '`', ж: ';', э: "'", б: ',', ю: '.', х: '[', ъ: ']',
  };

  /**
   * Запрос, переложенный из русской раскладки в латинскую, — или пустая
   * строка, если кириллицы в нём нет вовсе.
   *
   * Переводится **запрос**, а не строки списка: запрос один, строк сотни, и
   * перевод обратим. Обратной половины (латиница → кириллица) нет: кириллицы
   * в именах сессий и путях не бывает, а заведённая «на всякий случай» она
   * давала бы ложные попадания.
   */
  function puntoRu(q) {
    let has = false;
    let out = '';
    for (const ch of String(q ?? '')) {
      const mapped = PUNTO_RU[ch];
      if (mapped) has = true;
      out += mapped || ch;
    }
    return has ? out : '';
  }

  /**
   * Единственный отбор по тексту на весь пикер: сессии, проекты и снимки.
   *
   * Совпадение по «исходный ИЛИ переложенный» — иначе `home`, набранное
   * верно, перестало бы находить само себя. Три копии `includes(q)` тут и
   * были причиной завести общую функцию: перевод, положенный в две из трёх,
   * дал бы поиск, который работает в сессиях и молчит в снимках.
   *
   * `q` приходит уже приведённым к нижнему регистру и обрезанным — так его
   * готовят все три звонящих.
   */
  function matchesText(text, q) {
    if (!q) return true;
    const hay = String(text ?? '').toLowerCase();
    if (hay.includes(q)) return true;
    const punto = puntoRu(q);
    return Boolean(punto) && hay.includes(punto);
  }
```

- [ ] **Step 4: Развести три отбора на общую функцию**

`filterSessions`:

```js
      .map(g => ({ ...g, sessions: g.sessions.filter(s =>
        matchesText(`${s.label} ${searchableCwd(s.cwd)}`, q)
        || matchesId(s.id, q)) }))
```

`filterProjects`:

```js
    return list.filter(r => matchesText(`${r.label} ${searchableCwd(r.cwd)}`, q));
```

Экспорт: `return { filterSessions, filterProjects, searchableCwd, matchesText };`

В `frontend-src/picker-snapshots.js:197` заменить ручной `includes` на общую
функцию:

```js
        // Через filterApi, а не своим includes: перевод раскладки живёт в
        // matchesText, и третий отбор, оставленный при своём, молчал бы в
        // снимках при работающем поиске в сессиях.
        .filter(r => filterApi.matchesText(`${r.label} ${filterApi.searchableCwd(r.cwd)}`, q))
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `node --test test/picker-filter.test.js test/picker-snapshots.test.js`
Expected: PASS

- [ ] **Step 6: Дописать тест на снимки**

Дописать в `test/picker-snapshots.test.js` (фикстура `SNAP` и помощник
`rowsUnderDays` в файле уже есть):

```js
test('снимки ищутся и в русской раскладке', () => {
  // Третий отбор был написан в этом файле руками и filterProjects не звал
  // вовсе: перевод, положенный в два места из трёх, дал бы поиск, который
  // работает в сессиях и молчит в снимках. `зшслук` — это `picker`,
  // набранный на тех же клавишах.
  const found = rowsUnderDays([SNAP], undefined, 'зшслук')
    .filter(r => r.kind === 'snapshot-session');
  assert.deepEqual(found.map(r => r.id), ['aaa']);
});
```

- [ ] **Step 7: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] **Punto switcher в поиске: `рщьу` находит
`home`.**` целиком.

```bash
git add frontend-src/picker-filter.js frontend-src/picker-snapshots.js test/picker-filter.test.js test/picker-snapshots.test.js docs/TODO.md
git commit -m "feat(picker): поиск понимает русскую раскладку"
```

---

### Task 7: До пяти колонок в широком режиме

**Files:**
- Modify: `frontend-src/ui-state.js:102` (значение и экспорт)
- Modify: `frontend-src/picker-panels.js:7` (брать из `UiState`)
- Modify: `sessions.html:1366` (`byColumn`), `sessions.html:2279` (`addDropZones`)
- Modify: `settings.html:469` (выпадашка колонки)
- Modify: `test/ui-state.test.js`, `test/picker-panels.test.js`, `test/row-contract.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Produces: `UiState.WIDE_COLUMNS` — единственное объявление числа колонок.
  `PickerPanels.WIDE_COLUMNS` остаётся в экспорте, но теперь это то же число.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/ui-state.test.js`:

```js
test('порядок разбирается на пять колонок', () => {
  // Панель, попавшая в пятую колонку, обязана оттуда читаться: разбор на три
  // молча терял бы её место при каждом сохранении.
  const ui = UiState.normalizeUiState({
    order: { wide: [['live'], [], [], ['past'], ['snapshots']] },
  }, {});
  assert.strictEqual(ui.order.wide.length, 5);
  assert.deepStrictEqual(ui.order.wide[3], ['past']);
  assert.deepStrictEqual(ui.order.wide[4], ['snapshots']);
});

test('число колонок объявлено и вывешено наружу', () => {
  assert.strictEqual(UiState.WIDE_COLUMNS, 5);
});
```

Дописать в `test/picker-panels.test.js`:

```js
test('колонку можно назначить пятой', () => {
  const order = PickerPanels.withColumn({ wide: [[], [], [], [], []] }, 'past', 5);
  assert.deepStrictEqual(order.wide[4], ['past']);
});

test('число колонок у настроек то же, что у разбора ui.json', () => {
  // Второе число разошлось бы с первым, и окно настроек предлагало бы
  // колонку, которой пикер не рисует, — или не предлагало бы ту, что рисует.
  assert.strictEqual(PickerPanels.WIDE_COLUMNS, UiState.WIDE_COLUMNS);
});
```

(в `test/picker-panels.test.js` добавить `const UiState = require('../frontend-src/ui-state');`,
если его там ещё нет.)

Дописать в `test/row-contract.test.js`:

```js
test('число колонок написано ровно один раз', () => {
  // Оно было написано пять раз: разбор ui.json, окно настроек, сборка
  // колонок, зоны перетаскивания и выпадашка. Поднятое в четырёх из пяти,
  // оно даёт панель, которая из файла читается, а на экране не рисуется, —
  // и молча.
  const files = ['frontend-src/ui-state.js', 'frontend-src/picker-panels.js',
    'sessions.html', 'settings.html'];
  const declarations = files.flatMap((rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    return (src.match(/WIDE_COLUMNS = \d/g) || []).map(m => `${rel}: ${m}`);
  });
  assert.deepStrictEqual(declarations, ['frontend-src/ui-state.js: WIDE_COLUMNS = 5']);
  // Литералы списков колонок — тоже объявление числа, просто другой формы.
  assert.ok(!/\[1, 2, 3\]/.test(SESSIONS_HTML), 'в sessions.html остался литерал [1, 2, 3]');
  assert.ok(!/\['1', '2', '3'\]/.test(SESSIONS_HTML), "в sessions.html остался литерал ['1', '2', '3']");
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/ui-state.test.js test/picker-panels.test.js test/row-contract.test.js`
Expected: FAIL — колонок три, `UiState.WIDE_COLUMNS` не экспортирован,
объявлений пять.

- [ ] **Step 3: Поднять число и вывесить его наружу**

В `frontend-src/ui-state.js` заменить объявление вместе с комментарием:

```js
  // Колонок в широкой раскладке пять, и это свойство раскладки, а не файла:
  // прочитай пикер длину из ui.json — номер колонки стал бы зависеть от
  // содержимого файла, который правят чем угодно.
  //
  // Умолчание при этом прежнее: buildSections раскладывает секции по смыслу в
  // первые три, а пустая колонка не рисуется вовсе. Четвёртая и пятая
  // появляются на экране только после того, как человек сам перетащил туда
  // панель, — и видны в момент перетаскивания, когда addDropZones дорисовывает
  // пустые колонки.
  const WIDE_COLUMNS = 5;
```

и добавить `WIDE_COLUMNS` в объект экспорта:

```js
  return { normalizeUiState, uiStateToSave, listColumns, WIDE_COLUMNS };
```

- [ ] **Step 4: Снять второе объявление**

В `frontend-src/picker-panels.js` заменить `const WIDE_COLUMNS = 3;` на шим,
такой же, каким `project-list.js` берёт соседний модуль:

```js
  // Число колонок — у ui-state: там оно и решает, сколько их разбирается из
  // ui.json. Второе такое же число здесь уже стояло и разошлось бы с первым
  // на первой же правке.
  const uiApi = typeof module === 'object' && module.exports
    ? require('./ui-state')
    : globalThis.UiState;
  const WIDE_COLUMNS = uiApi.WIDE_COLUMNS;
```

Порядок тегов это выдерживает: `settings.html` грузит `ui-state.js` (строка 66)
раньше `picker-panels.js` (строка 75), а `sessions.html` `picker-panels.js` не
грузит вовсе.

- [ ] **Step 5: Снять третье и четвёртое объявления**

В `sessions.html`, рядом с прочими константами страницы (около `HEADER_KINDS`):

```js
  // Число колонок широкой раскладки — оттуда же, откуда его берёт разбор
  // ui.json: два числа разъехались бы, и панель из пятой колонки читалась бы
  // из файла, но не рисовалась.
  const WIDE_COLUMNS = window.UiState.WIDE_COLUMNS;
```

В `renderWide`:

```js
      const byColumn = Array.from({ length: WIDE_COLUMNS }, (_, i) => i + 1)
        .map(column => sections.filter(s => s.column === column))
        .filter(column => column.length);
```

В `addDropZones`:

```js
    for (let n = 1; n <= WIDE_COLUMNS; n++) {
      const column = String(n);
      if (have.has(column)) continue;
```

(остальное тело цикла не меняется.)

- [ ] **Step 6: Снять пятое объявление**

В `settings.html:469`:

```js
    // Ноль — «колонку назначает смысл секции»; остальные номера — от одного
    // до числа колонок раскладки, и это то же число, которым живёт пикер.
    const columnNumbers = [0, ...Array.from(
      { length: window.PickerPanels.WIDE_COLUMNS }, (_, i) => i + 1)];
    const column = (row) => columnNumbers.map(n =>
```

- [ ] **Step 7: Убедиться, что тесты проходят**

Run: `node --test test/ui-state.test.js test/picker-panels.test.js test/row-contract.test.js`
Expected: PASS

- [ ] **Step 8: Померить вёрстку в обоих движках**

Собрать стенд из настоящего `<style>` страницы и настоящей разметки блоков
(как это уже делалось для широкой раскладки) и посмотреть **четыре** случая:
пять непустых колонок, три (умолчание), две и одну (`/p`). В Chromium — из кэша
puppeteer по CDP, в WebKit — `WebKit2` из `python3-gi` в `Gtk.OffscreenWindow`
под `xvfb-run`. Что проверяется: колонки делят ширину поровну, ни одна не
схлопывается в заголовок, полоса прокрутки живёт внутри `.block-rows`, а не у
`#list`.

Если WebKit покажет схлопывание — это тот же класс поломки, что уже был с
`max-height: max-content`; чинить в CSS блока, а не числом колонок.

- [ ] **Step 9: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] Разрешить в fullscreen до 5 колонок.`

```bash
git add frontend-src/ui-state.js frontend-src/picker-panels.js sessions.html settings.html test/ui-state.test.js test/picker-panels.test.js test/row-contract.test.js docs/TODO.md
git commit -m "feat(picker): широкая раскладка до пяти колонок"
```

---

### Task 8: Наведение на проект гасит остальное

**Files:**
- Modify: `sessions.html` — стили (рядом с `.row.stale`), `dimsForHover`,
  `paintProjectDim`, обработчики мыши, вызов в конце `render()`
- Modify: `test/row-contract.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `rows` и `HEADER_KINDS` страницы, `row.cwd` (есть и у сессии, и у
  проекта, и у строки снимка).
- Produces: страничные `hoverProjectCwd`, `dimsForHover(rows, cwd)`,
  `paintProjectDim()`; класс `.row.dim-other`.

- [ ] **Step 1: Написать падающий тест на чистую часть**

Дописать в `test/row-contract.test.js`:

```js
test('наведение на проект гасит строки с другим каталогом', () => {
  // Гаснут строки во всех панелях сразу — ради этого всё и затевалось:
  // сессии проекта разбросаны по своим живым, чужим, истории и снимкам.
  const source = pageFunctions('dimsForHover(rows, cwd)');
  const ctx = { HEADER_KINDS: new Set(['section', 'snapshot-day']) };
  vm.createContext(ctx);
  const rows = [
    { kind: 'section' },
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/b' },
    { kind: 'snapshot-session', cwd: '/home/user/b' },
  ];
  const dims = vm.runInContext(`${source}\ndimsForHover(${JSON.stringify(rows)}, '/home/user/a');`,
    ctx, { filename: 'sessions.html' });
  // Заголовок не гаснет: погашенный, он читался бы как свёрнутая панель.
  assert.deepStrictEqual(Array.from(dims), [false, false, false, true, true]);
});

test('без наведения не гаснет ничего', () => {
  const source = pageFunctions('dimsForHover(rows, cwd)');
  const ctx = { HEADER_KINDS: new Set(['section', 'snapshot-day']) };
  vm.createContext(ctx);
  const dims = vm.runInContext(
    `${source}\ndimsForHover([{ kind: 'session', cwd: '/home/user/b' }], '');`,
    ctx, { filename: 'sessions.html' });
  assert.deepStrictEqual(Array.from(dims), [false]);
});

test('подсветка восстанавливается после отрисовки', () => {
  // Подача тикает раз в секунду, и planListSync правит изменившиеся
  // элементы: без вызова из render класс исчезал бы на первом же такте — то
  // есть почти сразу и без всякой видимой причины.
  const source = pageFunctions('render()');
  assert.match(source, /paintProjectDim\(\)/, 'render не восстанавливает подсветку проекта');
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/row-contract.test.js`
Expected: FAIL — `dimsForHover(rows, cwd) не найден в sessions.html`.

- [ ] **Step 3: Стили**

В `sessions.html`, **после** правил `.row.stale` (то есть после правки из
Task 2):

```css
/* Гашение по наведённому проекту. Стоит после `.row.stale` намеренно: обе
   правки меняют opacity, и на строке с обоими классами они не складываются, а
   перекрывают друг друга по порядку в файле. Главнее здесь наведение — оно
   временное и отвечает на прямой жест человека. */
.row.dim-other { opacity: 0.3; }
```

- [ ] **Step 4: Логика и отрисовка**

Рядом с `activePanel` (Task 4) завести:

```js
  // Каталог проекта, на который наведена мышь. Пусто — не гасим ничего.
  let hoverProjectCwd = '';
```

Рядом с `paint()`:

```js
  /**
   * Какие строки гасить при наведении на проект: чистая часть, поэтому
   * отдельно от записи в DOM.
   *
   * Заголовки секций и дней не гаснут: погашенный заголовок читался бы как
   * свёрнутая панель. Подзаголовки машин в `rows` не попадают вовсе.
   */
  function dimsForHover(rows, cwd) {
    return rows.map(row => Boolean(cwd)
      && !HEADER_KINDS.has(row.kind)
      && row.cwd !== cwd);
  }

  /** Разложить решение dimsForHover по узлам списка. */
  function paintProjectDim() {
    const dims = dimsForHover(rows, hoverProjectCwd);
    const nodes = list.querySelectorAll('.row');
    nodes.forEach((node, i) => node.classList.toggle('dim-other', Boolean(dims[i])));
  }
```

В конце `render()`, сразу после `paint();`:

```js
    // Подсветка держится отдельно от разметки строки и потому переживает
    // planListSync только так — восстановлением после каждой отрисовки.
    paintProjectDim();
```

- [ ] **Step 5: Обработчики мыши**

Рядом с обработчиком `list.addEventListener('click', …)`:

```js
  // Наведение на строку проекта гасит строки с другим каталогом во всех
  // панелях. mouseover, а не mouseenter: первый всплывает, и один обработчик
  // на списке видит переход между строками. Уход мыши со строки проекта на
  // соседнюю строку списка гасит подсветку тем же событием — closest не
  // находит `.row.project`, и каталог становится пустым.
  list.addEventListener('mouseover', (e) => {
    const node = e.target.closest('.row.project');
    const cwd = node ? (rows[Number(node.dataset.index)] || {}).cwd || '' : '';
    if (cwd === hoverProjectCwd) return;
    hoverProjectCwd = cwd;
    paintProjectDim();
  });

  // Уход мыши из списка целиком: mouseover там уже не придёт.
  list.addEventListener('mouseleave', () => {
    if (!hoverProjectCwd) return;
    hoverProjectCwd = '';
    paintProjectDim();
  });
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `node --test test/row-contract.test.js`
Expected: PASS

- [ ] **Step 7: Прогнать всё и закоммитить**

```bash
npm test
```

В `docs/TODO.md` снять пункт `- [ ] При наведении на строку проекта
подсвечивать его сессии во всех остальных панелях…` целиком.

```bash
git add sessions.html test/row-contract.test.js docs/TODO.md
git commit -m "feat(picker): наведение на проект гасит чужие строки"
```

---

### Task 9: Двойники различимы — сперва машина, потом хвост id

**Files:**
- Modify: `frontend-src/session-groups.js:33-49` (`labelSessions` и её комментарий)
- Modify: `test/session-groups.test.js`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: `row.label` (уже проставлен из `title`), `row.cwd`, `row.windowHost`
  (пусто у своей машины — так его считает `foreignHost` в `session-list.js`),
  `row.id`.
- Produces: изменённый `label` у строк-двойников. Ключи строк (`s:<id>`), фокус
  и `seen.json` не затрагиваются — на `label` не завязано ничего, кроме показа
  и поиска.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `test/session-groups.test.js`:

```js
test('двойники разводятся именем машины окна', () => {
  // Одинаковые имя и каталог, окна на разных машинах. Своя машина названа
  // пустотой намеренно: имя пикера в каждой строке было бы шумом, а голая
  // строка рядом с «· mac» читается как «здесь».
  const rows = Groups.labelSessions([
    { id: 'f381b515', title: 'settings', cwd: '/home/user/p', windowHost: '' },
    { id: 'b4ed3029', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings', 'settings · mac']);
});

test('двойники на одной машине разводятся хвостом id', () => {
  // Пометка, одинаковая у всей пары, не различает ничего — и хвост достаётся
  // именно ей, а не приписывается поверх бесполезного имени машины.
  const rows = Groups.labelSessions([
    { id: 'f381b515', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
    { id: 'b4ed3029', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings · f381', 'settings · b4ed']);
});

test('тройке достаётся и машина, и хвост — но только тем, кому нужно', () => {
  const rows = Groups.labelSessions([
    { id: 'aaaa1111', title: 'settings', cwd: '/home/user/p', windowHost: '' },
    { id: 'bbbb2222', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
    { id: 'cccc3333', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label),
    ['settings', 'settings · mac · bbbb', 'settings · mac · cccc']);
});

test('одинокая строка и тёзка из другого каталога остаются как есть', () => {
  // Двойник — это совпадение имени И каталога. Одно имя на два проекта
  // различается путём, который и так виден в строке.
  const rows = Groups.labelSessions([
    { id: 'aaaa1111', title: 'settings', cwd: '/home/user/a', windowHost: '' },
    { id: 'bbbb2222', title: 'settings', cwd: '/home/user/b', windowHost: 'mac' },
    { id: 'cccc3333', title: 'other', cwd: '/home/user/a', windowHost: '' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings', 'settings', 'other']);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test test/session-groups.test.js`
Expected: FAIL — `labelSessions` пока отдаёт голый `title`.

- [ ] **Step 3: Написать разведение двойников**

В `frontend-src/session-groups.js` заменить `labelSessions` вместе с её
комментарием:

```js
  // Знак между именем и пометкой. Один на обе пометки: два разных читались бы
  // как два разных вида строки.
  const TWIN_MARK = ' · ';

  function twinKey(s) {
    return JSON.stringify([s.label, s.cwd || '']);
  }

  /**
   * Приписать пометку тем строкам, у которых совпали имя и каталог.
   *
   * Пометка, одинаковая у всей группы, пропускается: она не отвечает на
   * вопрос «которая из двух», а место в строке занимает. Пустая пометка —
   * тоже ответ: своя машина названа пустотой, и голая строка рядом с
   * помеченной читается как «здесь».
   */
  function withTwinMarks(list, markOf) {
    const groups = new Map();
    list.forEach((s, i) => {
      const key = twinKey(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const out = list.slice();
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      const marks = indexes.map(i => String(markOf(list[i]) || '').trim());
      if (new Set(marks).size < 2) continue;
      indexes.forEach((i, n) => {
        if (!marks[n]) return;
        out[i] = { ...list[i], label: `${list[i].label}${TWIN_MARK}${marks[n]}` };
      });
    }
    return out;
  }

  /**
   * Имя, под которым сессию видно везде: строка списка, поиск, заголовок
   * диалога.
   *
   * Хвост из четырёх знаков id отсюда однажды уже убирали — у короткого id
   * появилась своя колонка, и хвост стал вторым способом показать то же самое.
   * Возвращается он не целиком, а ровно двойникам, и это не отмена того
   * решения, а его сужение: колонка id по умолчанию выключена, и две строки с
   * дословно одинаковыми именем и каталогом не различались в списке ничем.
   * Поймано на живой паре — работающая сессия и простаивающая тёзка, — и
   * человек видел только одну.
   *
   * Пометок две, и порядок между ними не случаен. Сперва имя машины окна: оно
   * отвечает на вопрос, который и задают («а эта где?»), и уже есть в строке
   * как колонка. Хвост id достаётся тем, кого имя машины не развело, — двум
   * окнам на одной машине.
   *
   * Считается по уже отсеянному списку (`onlyLive`/`onlyWindow` работают
   * выше): пометка нужна там, где обе строки видны рядом. Отбор по запросу
   * идёт позже, на странице, и пометка у найденной строки остаётся — так она
   * не мигает от набора.
   *
   * Ничего, кроме показа и поиска, на label не завязано: строки списка
   * узнаются по `s:<id>`, фокус уходит тоже по id.
   */
  function labelSessions(sessions) {
    const named = (Array.isArray(sessions) ? sessions : [])
      .map(s => ({ ...s, label: s.title }));
    const byHost = withTwinMarks(named, s => s.windowHost);
    return withTwinMarks(byHost, s => String(s.id || '').slice(0, 4));
  }
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `node --test test/session-groups.test.js`
Expected: PASS

- [ ] **Step 5: Прогнать всё и закоммитить**

```bash
npm test
```

Если упадёт что-то в `test/row-contract.test.js` или `test/session-list.test.js`
— смотреть, не ждёт ли тест голого `title` у строк, которые фикстура сделала
двойниками; такой тест правится вместе с поведением (это правило проекта, а не
поблажка).

В `docs/TODO.md` снять пункт `- [ ] **Из двух одноимённых живых сессий видно
старую, а работающую — нет.**` целиком.

```bash
git add frontend-src/session-groups.js test/session-groups.test.js docs/TODO.md
git commit -m "fix(picker): одноимённые сессии различимы по машине и id"
```

---

### Task 10: Вкладка настроек называется Window popup

**Files:**
- Modify: `frontend-src/settings-form.js:104` (`title` страницы `window`)
- Modify: `test/settings-page.test.js:637` (список вкладок), `test/settings-form.test.js:219-222`
  (имя теста и комментарий над ним)

**Interfaces:**
- Consumes: `PAGES` из `settings-form.js`.
- Produces: ничего — меняется только видимая подпись.

Просьба владельца, в очереди её не было. Идентификатор страницы (`id: 'window'`)
не трогается: по нему ходят `renderPage` и сохранение, а человеку он не виден.

- [ ] **Step 1: Поправить сторож — он сверяет подписи дословно**

В `test/settings-page.test.js`, в тесте «вкладки называются по спеке и
Integrations нет», заменить `'Window size'` на `'Window popup'`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/settings-page.test.js`
Expected: FAIL — в `PAGES` пока `Window size`.

- [ ] **Step 3: Переименовать**

В `frontend-src/settings-form.js:104`: `title: 'Window popup'`.

- [ ] **Step 4: Догнать соседний тест**

В `test/settings-form.test.js` заменить `Window size` на `Window popup` в имени
теста (строка 222) и в комментарии над ним (строка 219): тест, сверяющийся с
видимой строкой, правится вместе с ней.

- [ ] **Step 5: Прогнать всё и закоммитить**

```bash
npm test
```

```bash
git add frontend-src/settings-form.js test/settings-page.test.js test/settings-form.test.js
git commit -m "feat(settings): вкладка называется Window popup"
```

---

### Task 11: Разложить остаток очереди по репозиториям

**Files:**
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: спека, раздел «Зачем» — там уже перечислено, что куда уезжает.
- Produces: `# next` без задач, невыполнимых в этом репозитории.

- [ ] **Step 1: Проверить, что девять пунктов действительно сняты**

```bash
grep -n "^- \[ \]" docs/TODO.md | head -40
```

Ожидается: в `# next` не осталось ни одного из девяти закрытых пунктов; если
остался — снять его тем коммитом, к которому он относится, а не здесь.

- [ ] **Step 2: Перенести шесть задач в `# future`**

Перенести из `# next` в `# future` целиком, с их текстом, дописав каждой первой
строкой, кто её держит:

| задача | пометка |
|---|---|
| Одна сессия открыта на двух машинах | `Держит агрегатор `ccfzf`.` |
| У сессии должен быть размер | `Держит windows11-manager (перехват статуслайна).` |
| Счётчики `docs/TODO.md` в features list | `Держит агрегатор `ccfzf` (новое поле в ответе).` |
| Спеки и планы в списке, как PR | `Держит агрегатор `ccfzf` (новое поле в ответе).` |
| Place cascade | `Держит windows11-manager (расстановка окон).` |
| Комментарий к сессии | `Нужна синхронизация между хостами — своё хранилище.` |

Задачу «Выяснить, откуда берётся дата recent у проекта» заменить на уже
разобранную формулировку и тоже отправить в `# future`:

```markdown
- [ ] **Возраст проекта считается по mtime файла, а не по разговору.** Держит
  агрегатор `ccfzf`. Наверх всплывают проекты с открытыми окнами, где
  активности не было часами: `read_projects` берёт `max(mtime)` новейшего
  транскрипта, а mtime двигают служебные записи — про это сам агрегатор пишет
  в комментарии к `fresh_ids`. Чинится там же переходом на возраст
  содержимого (`last_message_at`), которым уже меряется живость.
```

- [ ] **Step 3: Убрать закрытую галку из `# future`**

Пункт `- [x] **Выбранный в пикере терминал обязан главенствовать…**` удалить
целиком: он закрыт и лежит в истории PR #14.

- [ ] **Step 4: Проверить и закоммитить**

```bash
npm test
```

(`test/no-private-data.test.js` читает и `docs/`, поэтому прогон обязателен: имя
машины, попавшее в текст задачи, уронит его.)

```bash
git add docs/TODO.md
git commit -m "task: очередь разложена по репозиториям"
```

---

## Что проверить руками перед PR

Тесты не видят ни одной из этих вещей — они про экран.

1. **Пять колонок.** `^F`, перетащить панель в четвёртую и пятую колонки,
   закрыть и открыть пикер: панели остались на местах. Пустые колонки не
   рисуются, а во время перетаскивания видны все пять.
2. **Затемнение.** Старая сессия первой строкой — тусклая; наведение мышью
   делает её яркой; галка `dim stale` в статуслайне гасит и включает
   затемнение сразу, не дожидаясь ответа агрегатора (проверять на скрытом
   окне не нужно, достаточно нажать дважды подряд).
3. **Панель при наборе.** Широкий режим, выбрать строку в `Projects`, начать
   печатать: выбор остаётся в проектах. Стереть запрос до конца — выбор
   по-прежнему в проектах. `^K` на строке, Esc, снова печатать.
4. **Меню.** `^K` на сессии: у пунктов стоят голые буквы; нажатие буквы
   запускает пункт; буква, которой нет, ничего не делает и не проваливается в
   поиск.
5. **Раскладка.** Набрать `вучщ` вслепую — находится `demo`; `рщьу` — `home`.
   Проверить и в режиме снимков (`^S`).
6. **Наведение на проект.** В широком режиме навести мышь на строку проекта:
   его сессии видны, остальные строки гаснут во всех панелях. Увести мышь за
   пределы списка — всё возвращается.
7. **Двойники.** Две сессии с одним именем в одном каталоге: в строке видно,
   чем они различаются.

## Self-review

- **Покрытие спеки.** A1 → Task 1, A2 → Task 2, A3 → Task 3, B4 → Task 4,
  B5 → Task 5, B6 → Task 6, C7 → Task 7, C8 → Task 8, C9 → Task 9; раздел
  «Зачем» (шесть чужих задач) → Task 11. Требование спеки «померить широкую
  раскладку в обоих движках» — Task 7, Step 8. Task 10 в спеке не описан: это
  просьба владельца, пришедшая после её написания, и на остальные задачи она
  не влияет.
- **Имена.** `firstRowInPanel`, `menuKeys`, `matchesText`, `staleSettings`,
  `toggleDefaults`, `dimsForHover`, `paintProjectDim`, `withTwinMarks`,
  `WIDE_COLUMNS` — каждое объявлено ровно в одной задаче и в ней же
  используется; `row.panel` заводит Task 4 и больше никто не трогает.
- **Порядок.** Task 8 правит стили сразу после `.row.stale`, то есть зависит от
  правки Task 2 — единственная зависимость в плане; остальные восемь
  независимы и могут идти в любом порядке.
