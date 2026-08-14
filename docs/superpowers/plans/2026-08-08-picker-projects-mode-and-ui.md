# Пикер: режим `/a`, новая сессия по `^N` и три правки в строке

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** искать по всем проектам ccfzf и начинать в них новые сессии прямо из
пикера; заодно привести подсказки хоткеев к одному виду, перестать прятать нули
в usage и расстаться со снимком агрегатора.

**Architecture:** префикс `/a` в строке поиска переключает список с сессий на
проекты — состояние живёт в тексте запроса, а не в скрытом флаге. Строки
проектов собирает новый чистый модуль, рисует их тот же `syncList()`. Новая
сессия становится обычным встроенным действием `new`, и потому одинаково
доступна с Enter, с `^N` и из меню `^K`.

**Tech Stack:** ES5-совместимый JS в UMD-шиме (без сборщика), `node --test` без
зависимостей, Tauri 2 (Rust не меняется).

## Global Constraints

- **Рабочий каталог — `~/projects/js/ccfzf-picker`.**
- **Зависит от плана агрегатора.** `docs/superpowers/plans/2026-08-08-ccfzf-state-projects-and-liveness.md`
  должен быть выполнен: без поля `projects` в `ccfzf --state` режим `/a` покажет
  пустой список. Задачи 1–6 от него не зависят и делаются в любом порядке.
- **Тесты гонять только `npm test`.** `node --test test/` на этих версиях Node
  не работает.
- **Порядок тегов `<script>` в `sessions.html` — часть контракта:** модуль
  берёт соседа из `globalThis` в момент загрузки. Каждый новый модуль надо
  добавить и в `scripts/prepare-frontend.js`; это сторожит
  `test/frontend-load.test.js`.
- **`;` в удалённой команде не ставить** — для Windows Terminal это разделитель
  панелей.
- **Все удалённые запуски агента идут через `OpenStrategy.inDir`** и кавычатся
  через `OpenStrategy.q`. Без интерактивного шелла не отрабатывает хук `chpwd`,
  и телеметрия уходит без `project=`.
- **Список не перерисовывается целиком:** запись в DOM только через `syncList()`.
  `list.innerHTML = html` на каждый тик роняет скролл и гасит hover.
- **Имена машин в репозиторий не возвращать** (`test/no-private-data.test.js`).
- **Комментарии объясняют «почему», а не «что»** — как в соседнем коде.

## Что выяснилось при планировании и чего нет в спеке

**Колонка `hk` сейчас ничем не заполняется.** `hotkeyHtml` читает
`session.hotkey`, но это поле не ставит никто: `CONFIG.projects` в
`sessions.html` не читается вовсе, хотя Rust проектные хоткеи регистрирует и
шлёт событие `project-hotkey` (`src-tauri/src/main.rs:534–553`). Поэтому
`formatHotkey` применяется **только** в меню `^K`, где содержимое есть. Само
открытие — в `docs/TODO.md`, задачей (Task 8); чинить его здесь значило бы
делать седьмую фичу вместо шести заказанных.

**`parseHotkey` не разбирает функциональные клавиши** — только буквы и цифры
(`frontend-src/action-hotkey.js:61–63`). Поэтому `formatHotkey` разбирает строку
сам, а не через `parseHotkey`: иначе `Ctrl+F12` остался бы неотформатированным.

---

## Файловая карта

| Файл | Что с ним |
|---|---|
| `frontend-src/picker-mode.js` | **создать** — разбор префикса `/a` и его вставка |
| `frontend-src/project-list.js` | **создать** — строки проектов из ответа агрегатора |
| `frontend-src/action-hotkey.js` | `formatHotkey`, `new: 'n'` в таблице, `KeyA` в занятых |
| `frontend-src/state-shape.js` | мягкая проверка `projects` |
| `frontend-src/picker-filter.js` | `filterProjects` |
| `frontend-src/session-actions.js` | действие `new`, ветка для строки проекта |
| `frontend-src/session-glyph.js` | нули в `usageHtml` |
| `frontend-src/session-info.js` | нули в карточке |
| `sessions.html` | теги, стили строки проекта, режимы в `render`, `newSession`, `^A` |
| `scripts/prepare-frontend.js` | два новых файла |
| `README.md`, `CLAUDE.md`, `docs/TODO.md` | снос упоминаний снимка |
| удалить | `vendor/`, `scripts/check-agent-of.py` |

---

## Task 1: `formatHotkey` — один вид у всех комбинаций

**Files:**
- Modify: `frontend-src/action-hotkey.js`, `sessions.html` (`renderMenu`, строка 815)
- Test: `test/action-hotkey.test.js`

**Interfaces:**
- Produces: `formatHotkey(str) -> string` — `'Ctrl+Shift+E'` → `'^⇧E'`,
  `'Cmd+Shift+1'` → `'⌘⇧1'`, `'Ctrl+F12'` → `'^F12'`. Неразобранная строка
  возвращается как есть (без пробелов по краям), пустая — пустой строкой.

- [ ] **Шаг 1: написать падающий тест**

Дописать в `test/action-hotkey.test.js`:

```js
const { formatHotkey } = require('../frontend-src/action-hotkey');

test('комбинация показывается символами, а не словами', () => {
  assert.strictEqual(formatHotkey('Ctrl+K'), '^K');
  assert.strictEqual(formatHotkey('Ctrl+Shift+E'), '^⇧E');
  assert.strictEqual(formatHotkey('Cmd+Shift+1'), '⌘⇧1');
  assert.strictEqual(formatHotkey('Alt+Shift+Q'), '⌥⇧Q');
});

test('порядок модификаторов не зависит от того, как их написали', () => {
  // Ctrl+Shift+E и Shift+Ctrl+E — одна и та же комбинация. Показывать её
  // двумя способами значит заставлять читателя сверять по буквам.
  assert.strictEqual(formatHotkey('Shift+Ctrl+E'), formatHotkey('Ctrl+Shift+E'));
});

test('функциональная клавиша доживает до подсказки', () => {
  // parseHotkey такую комбинацию не разбирает вовсе (только буквы и цифры), а
  // проектные хоткеи в конфиге — как раз Ctrl+F11/F12.
  assert.strictEqual(formatHotkey('Ctrl+F12'), '^F12');
});

test('непонятную строку formatHotkey отдаёт как есть', () => {
  // Конфиг правит человек, и опечатка не должна стирать подсказку целиком.
  assert.strictEqual(formatHotkey('Хрен+E'), 'Хрен+E');
  assert.strictEqual(formatHotkey('  Ctrl+  '), 'Ctrl+');
  assert.strictEqual(formatHotkey(''), '');
  assert.strictEqual(formatHotkey(null), '');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Run: `npm test`
Expected: `TypeError: formatHotkey is not a function`.

- [ ] **Шаг 3: написать функцию**

В `frontend-src/action-hotkey.js`, после `parseHotkey` (заканчивается строкой 66
`}`) и перед комментарием про `isReserved`:

```js
  /**
   * Комбинация — в подсказку: `Ctrl+Shift+E` → `^⇧E`.
   *
   * Порядок символов **фиксированный**, а не тот, что в конфиге: `Shift+Ctrl+E`
   * и `Ctrl+Shift+E` — одна комбинация, и два разных вида заставляли бы сверять
   * её по буквам. Это отменяет прежнее правило «показывать строку из конфига
   * как есть»; расхождение с написанием в файле выбрано сознательно, ради
   * единого вида по всему окну.
   *
   * `^` для Ctrl, а не `⌃`: встроенные подсказки (`^K`, `^R`) пишутся так с
   * самого начала, и вводить рядом второй знак того же смысла незачем.
   *
   * Разбор свой, а не через parseHotkey: тот принимает только буквы и цифры,
   * а проектные хоткеи в конфиге — F11 и F12. Неразобранная строка отдаётся
   * как есть: конфиг правит человек, и опечатка не должна стирать подсказку.
   */
  const MODIFIER_GLYPHS = [['meta', '⌘'], ['ctrl', '^'], ['alt', '⌥'], ['shift', '⇧']];

  function formatHotkey(str) {
    if (typeof str !== 'string' || !str.trim()) return '';
    const raw = str.trim();
    const parts = raw.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return raw;
    const key = parts[parts.length - 1];
    const flags = { ctrl: false, meta: false, alt: false, shift: false };
    for (const part of parts.slice(0, -1)) {
      const flag = MODIFIERS[part.toLowerCase()];
      if (!flag) return raw;
      flags[flag] = true;
    }
    const glyphs = MODIFIER_GLYPHS.filter(([f]) => flags[f]).map(([, g]) => g).join('');
    // Однобуквенная клавиша поднимается в верхний регистр, `F12` остаётся как
    // есть: у неё регистр — часть имени.
    return glyphs + (key.length === 1 ? key.toUpperCase() : key);
  }
```

и добавить в возврат модуля (строка 99):

```js
  return { BUILTIN_ACTION_KEYS, RESERVED_CODES, parseHotkey, formatHotkey, isReserved, matchesHotkey };
```

- [ ] **Шаг 4: применить в меню**

В `sessions.html` строка 397 (`const { BUILTIN_ACTION_KEYS: ACTION_KEYS, matchesHotkey } = window.ActionHotkey;`):

```js
  const { BUILTIN_ACTION_KEYS: ACTION_KEYS, matchesHotkey, formatHotkey } = window.ActionHotkey;
```

Строки 810–815, было:

```js
      // У настроенных действий клавиша своя и показывается строкой из конфига
      // как есть, а не пересобирается из разобранной комбинации: пересборка
      // разошлась бы с тем, что человек написал в файле.
      actionsList.innerHTML = menuActions.map((action, index) => {
        const key = ACTION_KEYS[action.id];
        const shown = key ? `^${key.toUpperCase()}` : (action.hotkey || '');
```

стало:

```js
      // Комбинация приводится к одному виду — formatHotkey (action-hotkey.js).
      // Раньше настроенное действие показывало строку из конфига как есть, и в
      // одном списке стояли `^K` и `Ctrl+Shift+E`. Встроенная клавиша идёт
      // через тот же форматтер: `Ctrl+K` он и даёт `^K`.
      actionsList.innerHTML = menuActions.map((action, index) => {
        const key = ACTION_KEYS[action.id];
        const shown = formatHotkey(key ? `Ctrl+${key}` : (action.hotkey || ''));
```

- [ ] **Шаг 5: убедиться, что тесты проходят**

Run: `npm test`
Expected: всё зелёное.

- [ ] **Шаг 6: коммит**

```bash
git add frontend-src/action-hotkey.js sessions.html test/action-hotkey.test.js
git commit -m "feat(picker): подсказки хоткеев пишутся символами, а не словами"
```

---

## Task 2: `$0` и `0%` перестают прятаться

**Files:**
- Modify: `frontend-src/session-glyph.js:200–228`, `frontend-src/session-info.js:49–50`
- Test: `test/session-glyph.test.js`, `test/row-contract.test.js`

**Interfaces:**
- Consumes/Produces: сигнатуры не меняются. Меняется только содержимое
  `usageHtml` при нулях.

- [ ] **Шаг 1: написать падающий тест**

Дописать в `test/session-glyph.test.js`:

```js
test('нули показываются, а не прячутся', () => {
  // Раньше ноль значил «данных нет»: перехват статуслайна стоит не у каждой
  // сессии, и колонка у такой строки была пуста. Решение поменялось — ноль
  // это ноль, а пустая колонка выглядела как поломка отрисовки.
  const html = usageHtml({ agentCostUsd: 0, agentContextPct: 0 });
  assert.match(html, /\$0/);
  assert.match(html, /0%/);
});

test('нулевой контекст не подсвечивается', () => {
  const html = usageHtml({ agentCostUsd: 0, agentContextPct: 0 });
  assert.doesNotMatch(html, /ctx warn|ctx hot/);
});

test('выключенный чекбокс по-прежнему убирает свою величину', () => {
  const noCost = usageHtml({ agentCostUsd: 0, agentContextPct: 0 }, { showCost: false });
  assert.doesNotMatch(noCost, /\$/);
  assert.match(noCost, /0%/);
  assert.strictEqual(usageHtml({}, { showCost: false, showContext: false }), '');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Run: `npm test`
Expected: `нули показываются` падает — в разметке нет ни `$0`, ни `0%`.

- [ ] **Шаг 3: поправить `usageHtml`**

В `frontend-src/session-glyph.js` заменить комментарий (строки 209–212) и две
строки условий (223–224).

Было:

```js
   * Ноль означает «данных нет», а не «ничего не потратила»: перехват
   * статуслайна стоит не у каждой сессии (см. claude-wt-statusline.sh). Такая
   * часть просто не показывается.
   */
```

стало:

```js
   * Ноль показывается как ноль. Раньше он значил «данных нет» — перехват
   * статуслайна стоит не у каждой сессии (см. claude-wt-statusline.sh), — и
   * такая часть просто не рисовалась. На глаз это читалось не как «неизвестно»,
   * а как поломка отрисовки: у соседних строк цифры есть, у этой пусто.
   * Различать два случая всё равно нечем, и «0%» честнее пустоты.
   */
```

Было:

```js
    if (showCost && cost > 0) parts.push(`<span class="cost">$${cost}</span>`);
    if (showContext && pct > 0) parts.push(`<span class="ctx${level ? ` ${level}` : ''}">${pct}%</span>`);
```

стало:

```js
    if (showCost) parts.push(`<span class="cost">$${cost}</span>`);
    if (showContext) parts.push(`<span class="ctx${level ? ` ${level}` : ''}">${pct}%</span>`);
```

- [ ] **Шаг 4: поправить карточку**

В `frontend-src/session-info.js` строки 49–50, было:

```js
      ['cost', s.agentCostUsd ? `$${s.agentCostUsd}` : ''],
      ['context', s.agentContextPct ? `${s.agentContextPct}%` : ''],
```

стало:

```js
      // Ноль печатается, как и в строке списка (usageHtml в session-glyph.js):
      // пустая клетка там читалась как поломка, а не как «данных нет».
      ['cost', `$${s.agentCostUsd || 0}`],
      ['context', `${s.agentContextPct || 0}%`],
```

- [ ] **Шаг 5: починить два теста, сторожившие прежнее поведение**

Падают ровно два места.

`test/session-glyph.test.js:306–313` — весь тест написан против нового
поведения, его посылку и заменяем:

```js
test('usageHtml leaves out what nobody measured, but keeps the column', () => {
  // Ноль — это «данных нет»: перехват статуслайна стоит не у каждой сессии, и
  // «$0» утверждало бы, что она обошлась бесплатно.
  assert.strictEqual(usageHtml({ agentContextPct: 0, agentCostUsd: 2 }),
    '<div class="usage"><span class="cost">$2</span></div>');
  assert.strictEqual(usageHtml({}), '<div class="usage"></div>');
  assert.strictEqual(usageHtml(undefined), '<div class="usage"></div>');
});
```

→

```js
test('usageHtml печатает ноль, а не прячет его', () => {
  // Раньше ноль значил «данных нет» и колонка у такой сессии пустовала. На
  // глаз это читалось как поломка отрисовки: у соседей цифры есть, тут пусто.
  // Различить «ноль» и «неизвестно» всё равно нечем, и «0%» честнее пустоты.
  assert.strictEqual(usageHtml({ agentContextPct: 0, agentCostUsd: 2 }),
    '<div class="usage"><span class="cost">$2</span> · <span class="ctx">0%</span></div>');
  assert.strictEqual(usageHtml({}),
    '<div class="usage"><span class="cost">$0</span> · <span class="ctx">0%</span></div>');
  assert.strictEqual(usageHtml(undefined),
    '<div class="usage"><span class="cost">$0</span> · <span class="ctx">0%</span></div>');
});
```

`test/row-contract.test.js:148–149`:

```js
  assert.strictEqual(Glyph.usageHtml(row, { showCost: true, showContext: true }),
    '<div class="usage"></div>');
```

→

```js
  assert.strictEqual(Glyph.usageHtml(row, { showCost: true, showContext: true }),
    '<div class="usage"><span class="cost">$0</span> · <span class="ctx">0%</span></div>');
```

Не трогать: `usageHtml puts the cost before the highlighted context`
(`session-glyph.test.js:296`) и `value('cost') === '$3'` / `value('context') ===
'41%'` (`row-contract.test.js:120–121`) — там числа непустые, и они обязаны
остаться зелёными без правок. `rows.length === 17` (`row-contract.test.js:128`)
тоже не меняется: у той сессии обе величины и раньше были непустыми.

Если падает что-то ещё — это регрессия, а не устаревший тест.

Run: `npm test`

- [ ] **Шаг 6: коммит**

```bash
git add frontend-src/session-glyph.js frontend-src/session-info.js test/
git commit -m "feat(picker): ноль в usage показывается, а не прячется"
```

---

## Task 3: `projects` в форме состояния

**Files:**
- Modify: `frontend-src/state-shape.js`
- Test: `test/state-shape.test.js`

**Interfaces:**
- Produces: `validateState(obj)` дополнительно проверяет `obj.projects`, если
  поле присутствует. Список ошибок — того же вида: `projects[0].path is not a string`.

- [ ] **Шаг 1: написать падающий тест**

Дописать в `test/state-shape.test.js`:

```js
test('проекты проверяются, когда они есть', () => {
  const bad = validateState({
    generated: 1, sessions: [],
    projects: [{ path: '/p', name: 'p', sessions: '3', live: 0, mtime: 0 }],
  });
  assert.deepStrictEqual(bad, ['projects[0].sessions is not a number']);

  const ok = validateState({
    generated: 1, sessions: [],
    projects: [{ path: '/p', name: 'p', sessions: 3, live: 1, mtime: 100 }],
  });
  assert.deepStrictEqual(ok, []);
});

test('ответ без проектов — рабочее состояние, а не поломка', () => {
  // Агрегатор живёт на другой машине и обновляется отдельно от пикера. Старый
  // ответ без projects обязан открывать список сессий как ни в чём не бывало:
  // уронить его значило бы лишить человека пикера из-за не приехавшей фичи.
  assert.deepStrictEqual(validateState({ generated: 1, sessions: [] }), []);
});

test('проекты не массивом — это поломка', () => {
  assert.deepStrictEqual(
    validateState({ generated: 1, sessions: [], projects: {} }),
    ['projects is not an array'],
  );
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Run: `npm test`
Expected: первый и третий тесты падают — `validateState` вернул `[]`.

- [ ] **Шаг 3: дописать проверку**

В `frontend-src/state-shape.js` после списка `SESSION_FIELDS` (строка 17):

```js
  // Проекты. Поля те же, что отдаёт project_rows на стороне агрегатора; `age`
  // среди них нет намеренно — возраст в строке считает пикер.
  const PROJECT_FIELDS = [
    ['path', 'string'],
    ['name', 'string'],
    ['sessions', 'number'],
    ['live', 'number'],
    ['mtime', 'number'],
  ];
```

и внутри `validateState`, перед `return out;`:

```js
    // Поля может не быть вовсе, и это не ошибка: агрегатор стоит на другой
    // машине и обновляется отдельно. Старый ответ без projects значит «режим
    // /a ничего не найдёт» — честный ответ, а не повод гасить весь список.
    if (obj.projects !== undefined) {
      if (!Array.isArray(obj.projects)) {
        out.push('projects is not an array');
      } else {
        obj.projects.forEach((p, i) => {
          for (const [key, type] of PROJECT_FIELDS) {
            if (typeof (p || {})[key] !== type) out.push(`projects[${i}].${key} is not a ${type}`);
          }
        });
      }
    }
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Run: `npm test`

- [ ] **Шаг 5: коммит**

```bash
git add frontend-src/state-shape.js test/state-shape.test.js
git commit -m "feat(picker): форма состояния знает про список проектов"
```

---

## Task 4: `picker-mode.js` — разбор префикса `/a`

**Files:**
- Create: `frontend-src/picker-mode.js`, `test/picker-mode.test.js`
- Modify: `scripts/prepare-frontend.js`, `sessions.html` (тег `<script>`)

**Interfaces:**
- Produces:
  - `parseQuery(raw) -> { mode: 'sessions'|'projects', query: string }`
  - `withProjectPrefix(raw) -> string` — добавляет `/a ` в начало, если его ещё нет
  - `PREFIX_TEXT` — строка `'/a '`

- [ ] **Шаг 1: написать падающий тест**

Создать `test/picker-mode.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, withProjectPrefix } = require('../frontend-src/picker-mode');

test('без префикса это поиск по сессиям', () => {
  assert.deepStrictEqual(parseQuery('ccfzf'), { mode: 'sessions', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery(''), { mode: 'sessions', query: '' });
  assert.deepStrictEqual(parseQuery(null), { mode: 'sessions', query: '' });
});

test('префикс переключает на проекты и в запрос не попадает', () => {
  assert.deepStrictEqual(parseQuery('/a ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/all ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/a'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/all'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/A ccfzf'), { mode: 'projects', query: 'ccfzf' });
});

test('похожее на префикс, но не он, остаётся поиском по сессиям', () => {
  // Иначе человек, ищущий сессию со словом «/api» в пути, молча оказался бы
  // в другом списке.
  assert.deepStrictEqual(parseQuery('/al'), { mode: 'sessions', query: '/al' });
  assert.deepStrictEqual(parseQuery('/api'), { mode: 'sessions', query: '/api' });
  assert.deepStrictEqual(parseQuery('a ccfzf'), { mode: 'sessions', query: 'a ccfzf' });
});

test('вставка префикса не задваивает его', () => {
  assert.strictEqual(withProjectPrefix(''), '/a ');
  assert.strictEqual(withProjectPrefix('ccfzf'), '/a ccfzf');
  assert.strictEqual(withProjectPrefix('/a ccfzf'), '/a ccfzf');
  assert.strictEqual(withProjectPrefix('/all ccfzf'), '/all ccfzf');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Run: `npm test`
Expected: `Cannot find module '../frontend-src/picker-mode'`.

- [ ] **Шаг 3: написать модуль**

Создать `frontend-src/picker-mode.js`:

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
   * `/al` и `/api` префиксом не считаются: человек, ищущий сессию со словом
   * `/api` в пути, не должен молча оказаться в другом списке.
   */
  const PREFIX = /^\/(all|a)(\s+|$)/i;
  const PREFIX_TEXT = '/a ';

  function parseQuery(raw) {
    const text = String(raw == null ? '' : raw);
    const m = text.match(PREFIX);
    if (!m) return { mode: 'sessions', query: text.trim() };
    return { mode: 'projects', query: text.slice(m[0].length).trim() };
  }

  /** Строка поиска с префиксом впереди — то, что делает `^A`. */
  function withProjectPrefix(raw) {
    const text = String(raw == null ? '' : raw);
    if (PREFIX.test(text)) return text;
    return PREFIX_TEXT + text.replace(/^\s+/, '');
  }

  return { parseQuery, withProjectPrefix, PREFIX_TEXT };
});
```

- [ ] **Шаг 4: подключить модуль**

В `sessions.html` рядом с остальными тегами (после `<script src="picker-filter.js"></script>`):

```html
<script src="picker-mode.js"></script>
```

В `scripts/prepare-frontend.js` в массив `FILES`, после `'frontend-src/picker-filter.js'`:

```js
  'frontend-src/picker-mode.js',
```

- [ ] **Шаг 5: убедиться, что тесты проходят**

Run: `npm test`
Expected: зелено, включая `каждый тег из sessions.html копируется в frontend/`.

- [ ] **Шаг 6: коммит**

```bash
git add frontend-src/picker-mode.js test/picker-mode.test.js sessions.html scripts/prepare-frontend.js
git commit -m "feat(picker): префикс /a в строке поиска разбирается отдельным модулем"
```

---

## Task 5: `project-list.js` и отбор проектов

**Files:**
- Create: `frontend-src/project-list.js`, `test/project-list.test.js`
- Modify: `frontend-src/picker-filter.js`, `test/picker-filter.test.js` (создать,
  если его нет), `scripts/prepare-frontend.js`, `sessions.html` (тег)

**Interfaces:**
- Produces: `buildProjectList({ projects }) -> row[]`, где row —
  `{ kind: 'project', id: string, cwd: string, label: string, mark: boolean,
  sessionCount: number, liveCount: number, lastActivity: number }`
- Produces: `filterProjects(rows, query) -> row[]` в `picker-filter.js`

**Почему `liveCount`, а не `live`.** У строки сессии `live` — булево, и
`render()` вешает по нему класс `closed`. У проекта это счётчик, и под тем же
именем любое ненулевое число молча означало бы «живая». Имена разные намеренно.

- [ ] **Шаг 1: написать падающий тест**

Создать `test/project-list.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildProjectList } = require('../frontend-src/project-list');

const STATE = {
  projects: [
    { path: '/home/user/projects/ccfzf', name: 'ccfzf', mark: true, sessions: 12, live: 2, mtime: 1786045860 },
    { path: '/home/user/projects/empty', name: 'empty', mark: true, sessions: 0, live: 0, mtime: 0 },
  ],
};

test('строка проекта несёт всё, что рисует список', () => {
  const [a, b] = buildProjectList(STATE);
  assert.strictEqual(a.kind, 'project');
  assert.strictEqual(a.id, '/home/user/projects/ccfzf');
  assert.strictEqual(a.cwd, '/home/user/projects/ccfzf');
  assert.strictEqual(a.label, 'ccfzf');
  assert.strictEqual(a.mark, true);
  assert.strictEqual(a.sessionCount, 12);
  assert.strictEqual(a.liveCount, 2);
  assert.strictEqual(a.lastActivity, 1786045860);
  // Проект без единой сессии — ровно то, ради чего режим и заводится.
  assert.strictEqual(b.sessionCount, 0);
});

test('счётчик живых не зовётся live', () => {
  // У строки сессии live — булево, и render вешает по нему класс closed.
  // Счётчик под тем же именем молча превратил бы «две живые» в «живая».
  assert.strictEqual('live' in buildProjectList(STATE)[0], false);
});

test('пустой или отсутствующий список — не поломка', () => {
  assert.deepStrictEqual(buildProjectList({}), []);
  assert.deepStrictEqual(buildProjectList(), []);
  assert.deepStrictEqual(buildProjectList({ projects: null }), []);
});

test('запись без пути выбрасывается, безымянная берёт путь именем', () => {
  const rows = buildProjectList({ projects: [
    { path: '', name: 'нет пути' },
    { path: '/p/x' },
  ] });
  assert.deepStrictEqual(rows.map(r => r.label), ['/p/x']);
});
```

Создать `test/picker-filter.test.js` (или дописать, если файл появился):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { filterProjects } = require('../frontend-src/picker-filter');

const ROWS = [
  { label: 'ccfzf', cwd: '/home/user/projects/shell/ccfzf' },
  { label: 'demo', cwd: '/home/user/projects/js/demo' },
];

test('проекты ищутся по имени и по пути', () => {
  assert.deepStrictEqual(filterProjects(ROWS, 'ccfzf').map(r => r.label), ['ccfzf']);
  assert.deepStrictEqual(filterProjects(ROWS, 'js/').map(r => r.label), ['demo']);
  assert.deepStrictEqual(filterProjects(ROWS, '').map(r => r.label), ['ccfzf', 'demo']);
});

test('префикс /home в поиске не участвует', () => {
  // Тот же searchableCwd, что и у сессий: иначе «home» совпадает со всем.
  assert.deepStrictEqual(filterProjects(ROWS, 'home'), []);
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Run: `npm test`
Expected: `Cannot find module '../frontend-src/project-list'` и
`filterProjects is not a function`.

- [ ] **Шаг 3: написать `project-list.js`**

Создать `frontend-src/project-list.js`:

```js
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProjectList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Строки проектов из ответа агрегатора.
   *
   * Проекты приезжают тем же `ccfzf --state`, что и сессии: там уже собраны и
   * каталоги, и живые id, а проект без единой сессии приходит из marks — по
   * cwd приехавших сессий такой не восстановить, и ради него режим и заведён.
   *
   * `cwd`, а не только `path`: под этим именем путь читают pathMap,
   * availableActions и поиск. Одно поле вместо двух — иначе строка проекта
   * пошла бы мимо половины уже написанного.
   *
   * `liveCount` и `sessionCount`, а не `live` и `sessions`: у строки сессии
   * `live` — булево, и отрисовка вешает по нему класс. Счётчик под тем же
   * именем молча означал бы «живая» при любом ненулевом числе.
   */
  function buildProjectList({ projects } = {}) {
    const list = Array.isArray(projects) ? projects : [];
    return list
      .filter(p => p && typeof p.path === 'string' && p.path)
      .map(p => ({
        kind: 'project',
        // id — ключ строки в DOM и то, по чему меню находит строку заново
        // после перерисовки. У проекта уникален путь, других id у него нет.
        id: p.path,
        cwd: p.path,
        label: (typeof p.name === 'string' && p.name) ? p.name : p.path,
        mark: Boolean(p.mark),
        sessionCount: Number(p.sessions) || 0,
        liveCount: Number(p.live) || 0,
        // Под тем же именем, что у сессии: колонку возраста рисует общая
        // ageHtml, и второе имя для того же смысла ей пришлось бы объяснять.
        lastActivity: Number(p.mtime) || 0,
      }));
  }

  return { buildProjectList };
});
```

- [ ] **Шаг 4: дописать `filterProjects`**

В `frontend-src/picker-filter.js` перед `return`:

```js
  /**
   * Отбор проектов. Тот же searchableCwd, что и у сессий: `/home` из пути
   * выброшен, иначе «home» совпадает со всем сразу.
   *
   * Плоский список, а не группы: у проектов группировки нет — их порядок задаёт
   * агрегатор (свежие сверху), и переставлять его здесь незачем.
   */
  function filterProjects(rows, query) {
    const list = Array.isArray(rows) ? rows : [];
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(r =>
      `${r.label} ${searchableCwd(r.cwd)}`.toLowerCase().includes(q));
  }
```

и в возврат: `return { filterSessions, filterProjects, searchableCwd };`

- [ ] **Шаг 5: подключить модуль**

`sessions.html`, после `<script src="picker-mode.js"></script>`:

```html
<script src="project-list.js"></script>
```

`scripts/prepare-frontend.js`, после `'frontend-src/picker-mode.js'`:

```js
  'frontend-src/project-list.js',
```

- [ ] **Шаг 6: убедиться, что тесты проходят**

Run: `npm test`

- [ ] **Шаг 7: коммит**

```bash
git add frontend-src/project-list.js frontend-src/picker-filter.js test/ sessions.html scripts/prepare-frontend.js
git commit -m "feat(picker): строки проектов и отбор по ним"
```

---

## Task 6: `new` — новая сессия как встроенное действие

**Files:**
- Modify: `frontend-src/action-hotkey.js` (таблица, занятые коды),
  `frontend-src/session-actions.js`, `sessions.html` (`newSession`, `runAction`)
- Test: `test/session-actions.test.js`, `test/open-strategy.test.js`

**Interfaces:**
- Consumes: `OpenStrategy.inDir(cwd, cmd)`, `OpenStrategy.q(s)`
- Produces: `newSessionCommand(cwd) -> string` в `open-strategy.js` — удалённая
  команда, поднимающая нового агента с именем по каталогу.
- Produces: действие с `id: 'new'` в `availableActions`, клавиша `n` в
  `BUILTIN_ACTION_KEYS`.

- [ ] **Шаг 1: написать падающий тест на команду**

Дописать в `test/open-strategy.test.js`:

```js
test('новая сессия называется по каталогу проекта', () => {
  // Имя не для красоты: по нему оконный трекер находит сессию в заголовке
  // окна, не дожидаясь /rename. Форма взята у ccfzf.
  assert.strictEqual(
    OpenStrategy.newSessionCommand('/home/user/projects/ccfzf'),
    `exec $SHELL -ic 'cd -- '\\''/home/user/projects/ccfzf'\\'' && claude -n '\\''ccfzf'\\'''`,
  );
});

test('имя новой сессии берётся у последнего сегмента пути', () => {
  const withSlash = OpenStrategy.newSessionCommand('/home/user/projects/ccfzf/');
  assert.match(withSlash, /claude -n '\\''ccfzf'\\''/);
});

test('кавычка в имени каталога не разваливает команду', () => {
  // Единственный барьер между придуманным человеком путём и чужим шеллом — q.
  const cmd = OpenStrategy.newSessionCommand("/home/user/pro'ject");
  assert.ok(!cmd.includes(";"), 'точка с запятой ломает Windows Terminal');
  assert.match(cmd, /claude -n /);
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Run: `npm test`
Expected: `OpenStrategy.newSessionCommand is not a function`.

- [ ] **Шаг 3: написать `newSessionCommand`**

В `frontend-src/open-strategy.js` после `resumeCommand` (строка 73):

```js
  /**
   * Поднять в каталоге нового агента, названного по каталогу.
   *
   * Имя ставится сразу, а не оставляется на `/rename`: по заголовку окна
   * оконный трекер привязывает сессию к слоту, и безымянная в его индексе не
   * находится вовсе. Форма взята у ccfzf — там `claude -n $(basename "$dir")`
   * ровно по этой причине.
   *
   * Через inDir, как и resume: `ssh host cmd` даёт неинтерактивный шелл, zsh
   * читает только `.zshenv`, и хук `chpwd` не ставит `project=` в
   * OTEL_RESOURCE_ATTRIBUTES — телеметрия уходит без имени проекта.
   */
  function newSessionCommand(cwd) {
    const path = String(cwd == null ? '' : cwd).replace(/\/+$/, '');
    const name = path.split('/').pop() || path;
    return inDir(path, `claude -n ${q(name)}`);
  }
```

и в возврат модуля добавить `newSessionCommand`.

- [ ] **Шаг 4: написать падающий тест на действие**

Дописать в `test/session-actions.test.js`:

```js
test('новая сессия предлагается и сессии, и проекту', () => {
  const forSession = availableActions({ id: 'a', cwd: '/p', live: true, pid: 42 })
    .map(a => a.id);
  assert.ok(forSession.includes('new'), forSession);

  const forProject = availableActions({ kind: 'project', id: '/p', cwd: '/p' })
    .map(a => a.id);
  assert.deepStrictEqual(forProject, ['new']);
});

test('строке проекта не предлагают того, чему нужна сессия', () => {
  // PR, «прочитано» и reptyr держатся за запись агента и за pid — у каталога
  // нет ни того, ни другого. Карточка сессии у проекта тоже пуста.
  const ids = availableActions({
    kind: 'project', id: '/p', cwd: '/p',
    pr_url: 'https://github.com/o/r/pull/3', live: true, pid: 42,
    lastActivity: 1, agentSeen: true,
  }).map(a => a.id);
  assert.deepStrictEqual(ids, ['new']);
});

test('у проекта есть действия папки, когда путь переводится', () => {
  const ids = availableActions(
    { kind: 'project', id: '/remote/p', cwd: '/remote/p' },
    { pathMap: { remote: '/remote', local: '/local' },
      actions: [{ id: 'explorer', label: 'Open in Explorer', hotkey: 'Ctrl+Shift+E' }] },
  ).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'explorer']);
});
```

- [ ] **Шаг 5: добавить действие**

В `frontend-src/action-hotkey.js` строка 16:

```js
  const BUILTIN_ACTION_KEYS = { new: 'n', pr: 'p', unread: 'u', attach: 'r', info: 'i' };
```

и строки 22–25:

```js
  const RESERVED_CODES = [
    ...Object.values(BUILTIN_ACTION_KEYS).map(k => `Key${k.toUpperCase()}`),
    'KeyK',
    // Не действие, а ярлык: ставит `/a ` в начало строки поиска. Клавишу он
    // всё равно занимает, и настроенному действию её отдавать нельзя. Цена
    // известна: `^A` в поле поиска перестал быть «выделить всё».
    'KeyA',
  ];
```

В `frontend-src/session-actions.js`, в начале `availableActions` (после
`const cfg = config || {};`):

```js
    // Строка проекта — это каталог, и всё, что держится за сессию, ей не
    // подходит: у неё нет ни записи агента, ни pid, ни истории. Ветка стоит
    // до всего остального, чтобы это правило было видно одним куском.
    if ((row || {}).kind === 'project') {
      const forProject = [{ id: 'new', label: 'New session' }];
      if (pathApi.mapPath(row.cwd, cfg.pathMap) !== null) {
        for (const a of cfg.actions || []) {
          forProject.push({ id: a.id, label: a.label, hotkey: a.hotkey });
        }
      }
      return forProject;
    }
```

и после блока настроенных действий (строка 49, `}`) — перед `const num = prNumber(...)`:

```js
    // Новая сессия в том же каталоге: «начать заново рядом» — обычный ход,
    // когда в текущей сессии кончился контекст. Только там, где каталог
    // известен: пункт, который ничего не сделает, хуже отсутствующего — то же
    // правило, что и у действий папки выше.
    if (row && row.cwd) actions.push({ id: 'new', label: 'New session' });
```

- [ ] **Шаг 6: научить `runAction` этому действию**

В `sessions.html` добавить функцию перед `runAction` (строка 848):

```js
  /**
   * Поднять новую сессию в каталоге строки.
   *
   * Один вход на три повода: Enter на строке проекта, `^N` на любой строке и
   * пункт меню. Разводить их значило бы завести три места, где собирается одна
   * и та же удалённая команда, — а собирать её мимо OpenStrategy нельзя вовсе.
   *
   * Отметки «просмотрено» здесь нет: смотреть ещё нечего, сессия только что
   * началась.
   */
  async function newSession(cwd) {
    if (!cwd || sshHostMissing()) return;
    const argv = [
      CONFIG.terminal.file, ...CONFIG.terminal.args,
      'ssh', '-t', CONFIG.sshHost,
      window.OpenStrategy.newSessionCommand(cwd),
    ];
    try {
      await invoke('spawn_detached', { argv });
    } catch (e) {
      error = String(e);
      render();
      return;
    }
    invoke('hide_picker');
  }
```

и ветку в `runAction`, сразу после проверки настроенных действий (перед
`if (id === 'pr')`):

```js
    if (id === 'new') {
      newSession(row.cwd);
      return;
    }
```

- [ ] **Шаг 7: перевести проектный хоткей на ту же функцию**

`sessions.html` строки 1085–1101, было:

```js
    // Проектный хоткей открывает новую сессию, а не продолжает старую:
    // продолжать нечего — сессии у него нет, есть только каталог.
    await listen('project-hotkey', (event) => {
      if (sshHostMissing()) return;
      const argv = [
        CONFIG.terminal.file, ...CONFIG.terminal.args,
        'ssh', '-t', CONFIG.sshHost,
        // Через ту же обёртку, что и открытие сессии: и кавычки вокруг пути из
        // конфига, и интерактивный шелл, без которого агент поднимается мимо
        // .zshrc — то есть без хука chpwd и без project= в телеметрии.
        window.OpenStrategy.inDir(event.payload, 'claude'),
      ];
      invoke('spawn_detached', { argv }).catch((e) => {
        error = String(e);
        render();
      });
    });
```

стало:

```js
    // Проектный хоткей открывает новую сессию, а не продолжает старую:
    // продолжать нечего — сессии у него нет, есть только каталог.
    //
    // Через ту же newSession, что Enter и ^N. Раньше здесь поднимался голый
    // `claude`, без имени: сессия проектного хоткея оставалась безымянной, и
    // оконный трекер не мог найти её по заголовку окна.
    await listen('project-hotkey', (event) => {
      newSession(event.payload);
    });
```

- [ ] **Шаг 8: починить три теста, перечисляющих состав меню**

`test/frontend-load.test.js:36–39` править **не надо**: там строка без `cwd`
(`{ id: 'a', live: true, pid: 42 }`), а `new` предлагается только при известном
каталоге — список остаётся `['attach', 'info']`. Это и есть причина, по которой
проверка на `row.cwd` стоит в Шаге 5: без неё пришлось бы править и сторож
порядка тегов, и половину соседних тестов.

В `test/session-actions.test.js` меняются три ожидания:

| Строка | Было | Стало |
|---|---|---|
| 22–23 | `['info']` | `['new', 'info']` |
| 28 | `['explorer', 'info']` | `['explorer', 'new', 'info']` |
| 34 | `['info']` | `['new', 'info']` |

`test/session-actions.test.js:14` (`availableActions({ id: 'a' })`) не меняется —
у той строки нет `cwd`.

- [ ] **Шаг 9: убедиться, что тесты проходят**

Run: `npm test`
Expected: зелено. Если падает что-то помимо трёх строк выше — смотреть, не
попал ли `new` в строку без каталога.

- [ ] **Шаг 10: коммит**

```bash
git add frontend-src/ sessions.html test/
git commit -m "feat(picker): ^N поднимает новую сессию с именем по каталогу"
```

---

## Task 7: режим проектов в окне

**Files:**
- Modify: `sessions.html` (стили, `render`, `choose`, обработчик клавиш,
  `refresh`, подсказка `#menu-hint`)
- Test: проверяется руками — это запись в DOM, её тесты проекта не покрывают

**Interfaces:**
- Consumes: `PickerMode.parseQuery`, `PickerMode.withProjectPrefix`,
  `ProjectList.buildProjectList`, `PickerFilter.filterProjects`,
  `SessionActions.availableActions` (ветка проекта), `newSession(cwd)`

- [ ] **Шаг 1: добавить стили**

В `sessions.html` после блока `.age { … }` (строка 152):

```css
        /* Сколько у проекта сессий и сколько из них живых. Рядом с возрастом,
           поэтому цифры моноширинные — колонки не должны разъезжаться. */
        .count {
            flex: 0 0 auto; padding-left: 10px; min-width: 48px; text-align: right;
            font-size: 11px; color: #7d838c; font-variant-numeric: tabular-nums;
        }
        /* Отметка проекта в ccfzf (★ в его собственном списке). */
        .mark { color: #d29922; }
```

- [ ] **Шаг 2: хранить проекты рядом с сессиями**

Найти объявление `lastSessions` и рядом добавить:

```js
  // Проекты последнего ответа, уже разложенные в строки. Отдельно от сессий:
  // они не группируются, не сортируются здесь и не фильтруются по onlyLive.
  let projectRows = [];
```

В `refresh()`, после `lastSessions = state.sessions;`:

```js
    // Поля может не быть — старый агрегатор на той стороне. Тогда режим /a
    // покажет пустой список, и это честный ответ, а не поломка.
    projectRows = window.ProjectList.buildProjectList(state);
```

- [ ] **Шаг 3: развести два режима в `render()`**

Тело цикла по группам вынести в функцию `renderSessions`, рядом положить
`renderProjects`, а `render()` оставить развилкой. Было (строки 460–470):

```js
  function render() {
    const nowSec = Math.floor(Date.now() / 1000);
    rows = [];
    const items = [];

    const visible = window.PickerFilter.filterSessions(groups, search.value);
```

стало:

```js
  /**
   * Строки проектов.
   *
   * Ни групп, ни сортировки: порядок задаёт агрегатор (свежие сверху), а
   * переключатель sort — про сессии. Правые колонки (usage, window, id, hk)
   * пусты не по недосмотру: у каталога нет ни записи агента, ни окна.
   */
  function renderProjects(query, items, nowSec) {
    for (const project of window.PickerFilter.filterProjects(projectRows, query)) {
      const index = rows.length;
      rows.push(project);
      // Зелёная точка у проекта, где кто-то работает прямо сейчас: тот же
      // словарь цветов, что и у сессии, и та же ширина левой колонки.
      const dot = project.liveCount ? 'active' : 'closed';
      const html = `<div class="row project" data-index="${index}" title="${escapeHtml(project.cwd)}">` +
        `<div class="dot ${dot}"></div>` +
        `<div class="text"><div class="name">` +
        (project.mark ? '<span class="mark">★</span> ' : '') +
        `${escapeHtml(project.label)}</div>` +
        (toggles.showPaths
          ? `<div class="cwd">${escapeHtml(shortPath(project.cwd))}</div>` : '') +
        `</div>` +
        `<div class="meta">` +
        `<div class="count">${project.sessionCount}` +
        (project.liveCount ? ` · ${project.liveCount}●` : '') +
        `</div>` +
        ageHtml(project, nowSec) +
        `</div></div>`;
      items.push({ key: `p:${project.id}`, html });
    }
  }

  function renderSessions(query, items, nowSec) {
    const visible = window.PickerFilter.filterSessions(groups, query);
```

Дальше — прежнее тело цикла по `visible` без изменений, до строки
`items.push({ key: \`s:${session.id}\`, html });` включительно, и закрывающая
скобка функции. После неё:

```js
  function render() {
    const nowSec = Math.floor(Date.now() / 1000);
    rows = [];
    const items = [];
    // Режим живёт в строке поиска, а не отдельным флагом: см. picker-mode.js.
    const { mode, query } = window.PickerMode.parseQuery(search.value);
    if (mode === 'projects') renderProjects(query, items, nowSec);
    else renderSessions(query, items, nowSec);
    syncList(items);
```

и дальше прежний хвост `render()` (блок про `notice`/`error`), но подпись пустого
списка развести по режиму:

```js
    } else {
      message.style.display = rows.length ? 'none' : 'block';
      if (!rows.length) {
        message.textContent = mode === 'projects'
          // Пустой список проектов почти всегда значит «агрегатор на той
          // стороне ещё не отдаёт projects», и молчать об этом нельзя: на вид
          // это не отличить от «ничего не нашлось».
          ? (projectRows.length ? 'Nothing matches.' : 'No projects — is ccfzf on the host up to date?')
          : (groups.length ? 'Nothing matches.' : 'No claude sessions yet.');
      }
    }
```

- [ ] **Шаг 4: Enter на строке проекта**

Заменить `choose()`:

```js
  function choose() {
    const row = rows[active];
    if (!row) return;
    // У строки проекта продолжать нечего — есть только каталог. Enter значит
    // здесь то же, что и на строке сессии: «открой мне терминал с агентом».
    if (row.kind === 'project') return newSession(row.cwd);
    return openSession(row);
  }
```

- [ ] **Шаг 5: `^A` — ярлык префикса**

В обработчике `keydown`, сразу после ветки `^K` (строки 950–954):

```js
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
      // Ставит `/a ` в начало строки поиска. Не режим и не переключатель:
      // состояние живёт в самом тексте, и стирание префикса возвращает к
      // сессиям. Цена — `^A` больше не «выделить всё» в поле поиска.
      e.preventDefault();
      search.value = window.PickerMode.withProjectPrefix(search.value);
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
      onSearchInput();
      return;
    }
```

- [ ] **Шаг 6: дописать подсказку**

`sessions.html:222`, было:

```html
<span id="menu-hint">^K - Session menu, ^R - copy reptyr command</span>
```

стало:

```html
<span id="menu-hint">^K - Session menu, ^N - new session, ^A - all projects</span>
```

- [ ] **Шаг 7: собрать статику и посмотреть глазами**

```bash
node scripts/prepare-frontend.js
npm test
cd src-tauri && cargo tauri build && cd ..
```

Проверить в живом окне:

- `/a` показывает проекты, среди них есть проект без сессий;
- `^A` ставит префикс, повторное нажатие не задваивает его;
- стирание префикса возвращает список сессий;
- Enter на проекте открывает терминал с `claude -n <имя>`;
- список не мигает раз в секунду (значит, `syncList` работает и на проектах).

- [ ] **Шаг 8: коммит**

```bash
git add sessions.html
git commit -m "feat(picker): /a показывает все проекты ccfzf, Enter начинает в них сессию"
```

---

## Task 8: расстаться со снимком агрегатора

**Files:**
- Delete: `vendor/`, `scripts/check-agent-of.py`
- Modify: `README.md`, `CLAUDE.md`, `docs/TODO.md`,
  `~/.claude/skills/claude-wt/модель-данных.md`,
  `~/.claude/skills/claude-wt/ccfzf-picker.md`

**Предусловие:** в репозитории агрегатора выполнен Task 4 плана
`2026-08-08-ccfzf-state-projects-and-liveness.md` — четыре проверки из
`scripts/check-agent-of.py` уже живут в `tests/test_agent_of.py`. Проверить:

```bash
git -C ~/projects/shell/ccfzf log --oneline -5
python3 ~/projects/shell/ccfzf/tests/test_agent_of.py
```

- [ ] **Шаг 1: удалить**

```bash
git rm -r vendor scripts/check-agent-of.py
```

- [ ] **Шаг 2: убедиться, что тесты проходят**

Run: `npm test`
Expected: зелено. `test/no-private-data.test.js` править не надо — он идёт по
`git ls-files`, и удалённый из индекса каталог сам перестаёт попадать в проверку.

- [ ] **Шаг 3: поправить `README.md`**

Строка 10, было:

```
Нужен Rust, Node 22+, `tauri-cli` (`cargo install tauri-cli`) и терминал на
локальной машине; на удалённой — `ccfzf` (снимок лежит в `vendor/ccfzf`).
```

стало:

```
Нужен Rust, Node 22+, `tauri-cli` (`cargo install tauri-cli`) и терминал на
локальной машине; на удалённой — `ccfzf`.
```

Удалить строки 51–56 целиком (пункты про `scripts/check-agent-of.py` и
`vendor/ccfzf`).

Строки 58–61, было:

```
Тесты — только `node --test`, без зависимостей. Запускать `npm test`;
`node --test test/` на этих версиях Node не работает. Питон внутри снимка
агрегатора этим не покрыт — для него есть `scripts/check-agent-of.py`,
он стоит отдельно и требует только стандартной библиотеки.
```

стало:

```
Тесты — только `node --test`, без зависимостей. Запускать `npm test`;
`node --test test/` на этих версиях Node не работает. Агрегатор здесь не
лежит и не проверяется: он живёт своим репозиторием со своими тестами, пути
выписаны в скилле `/claude-wt`.
```

- [ ] **Шаг 4: поправить `CLAUDE.md`**

Удалить пункт «**Перестать вендорить `ccfzf`…**», если он там появился, и
любые упоминания `vendor/ccfzf`. Проверить:

```bash
grep -rn "vendor" CLAUDE.md README.md docs/
```

- [ ] **Шаг 5: дописать карту путей в скилл**

В `~/.claude/skills/claude-wt/модель-данных.md`, в разделе «Карта хранилищ»,
после таблицы «Типичные пути в живой конфигурации» добавить:

```markdown
Где лежит код связки на машине с сессиями:

| Что | Путь |
|---|---|
| Агрегатор | `~/bin/ccfzf` → `~/projects/shell/ccfzf/ccfzf` (git-репозиторий) |
| Его тесты | `~/projects/shell/ccfzf/tests/` — `harness.py` (вырезает python-блок из скрипта), `test_agent_of.py`, `test_liveness.py`, `test_state_projects.py`, `test_windows_file.py`; запуск поштучно: `python3 tests/<файл>.py` |
| Хуки агента | `~/.claude/hooks/` — `wt-progress.sh`, `claude-wt-statusline.sh`, `claude-wt-agent-state.sh` |
| Состояния | `~/.claude/claude-wt/<id>.{state,status,meta}.json` |
| Транскрипты | `~/.claude/projects/<mangled-cwd>/<id>.jsonl` |
| Дампы | `~/.ccfzf.sessions.json`, `~/.ccfzf.projects.json` |
| Файл оконного трекера | путь из `CCFZF_WINDOWS_FILE`, кладёт его демон windows11-manager |
| Репозиторий пикера | `~/projects/js/ccfzf-picker` (сборка — отдельным клоном на macOS, `~/projects/ccfzf-picker`) |
| Конфиг пикера | `~/.config/ccfzf-picker/config.yaml`; на Windows — `%USERPROFILE%\.config\ccfzf-picker\config.yaml` |
```

В `~/.claude/skills/claude-wt/ccfzf-picker.md` заменить абзац (строки 19–21):

```markdown
**`vendor/ccfzf` в репозитории — снимок, не оригинал.** Агрегатор реально
живёт на машине с сессиями (`~/bin/ccfzf`); править нужно его, а копию в `vendor/ccfzf`
— только обновлять с оригинала.
```

на:

```markdown
**Агрегатора в репозитории пикера нет.** Снимок `vendor/ccfzf` убран
2026-08-08: его надо было не забывать обновлять, и проверки гонялись по
вчерашнему коду. Агрегатор живёт своим репозиторием со своими тестами —
`~/projects/shell/ccfzf`, пути выписаны в
[модель-данных.md](./модель-данных.md#карта-хранилищ).
```

- [ ] **Шаг 6: обновить `docs/TODO.md`**

Отметить сделанным всё, что закрыто этими двумя планами, и **дописать три
находки**:

```markdown
- [ ] **Колонка `hk` ничем не заполняется.** `hotkeyHtml`
  (`frontend-src/session-glyph.js:182`) читает `session.hotkey`, но это поле не
  ставит никто: `CONFIG.projects` в `sessions.html` не читается вовсе, хотя
  Rust проектные хоткеи регистрирует и шлёт `project-hotkey`
  (`src-tauri/src/main.rs:534–553`). То есть чекбокс `hotkeys` включает пустую
  колонку. Чинится тремя строками в `render()`: карта `cwd → hotkey` из
  `CONFIG.projects`, и через `formatHotkey` в строку.

- [ ] **Процесс без своего транскрипта всё ещё может забрать чужой.** Остаток
  задачи про живость: `fresh_ids()` в агрегаторе отсекает кандидатов по
  возрасту содержимого, но два процесса в одном `cwd` — один разговаривает,
  второй стоит на пустом приглашении — заберут два новейших файла, и второму
  достанется чужая свежая сессия. Честное правило: «файл не может принадлежать
  процессу, если последняя запись в нём старше запуска процесса». Машинерия:
  `starttime` из `/proc/<pid>/stat` уже читается (`proc_started`), но в тиках
  от загрузки — нужен `btime` из `/proc/stat` и `SC_CLK_TCK`, чтобы перевести
  в epoch.

- [ ] **`^A` больше не «выделить всё» в поле поиска.** Отдан под ярлык `/a`.
  Если это окажется неудобно, замена — `^/` или `Alt+A`: обе свободны.
```

- [ ] **Шаг 7: коммит**

```bash
git add -A
git commit -m "chore: снимок агрегатора убран, пути переехали в скилл claude-wt"
```

Правки в `~/.claude/skills/claude-wt/` под git не попадут — этот каталог не
репозиторий. Это ожидаемо, отдельного коммита им не нужно.

---

## Task 9: приёмка

- [ ] `npm test` — зелено целиком
- [ ] `cd src-tauri && cargo test` — зелено (Rust не менялся, это сторож)
- [ ] `node scripts/prepare-frontend.js && cargo tauri build` — собирается
- [ ] `grep -rn "vendor" README.md CLAUDE.md docs/ frontend-src/ sessions.html` — пусто
- [ ] `ccfzf --state | node scripts/check-state.js` — форма ответа принимается
- [ ] в живом окне пройти по списку ручных проверок ниже

## Technical Details

**Строка проекта против строки сессии.** Разводит их поле `kind`: у сессии оно
`interactive` или `background` (ставит `buildSessionList`), у проекта —
`project`. По нему ветвятся `availableActions` и `choose()`. Ключ в DOM тоже
разный: `p:<path>` против `s:<id>` и `g:<label>` — столкнуться они не могут,
и `planListSync` при смене режима честно пересоберёт список целиком.

**Что проекту не положено.** `pr`, `unread`, `attach`, `info` держатся за
запись агента и за pid. `usageHtml`, `windowHtml`, `sessionIdHtml`,
`hotkeyHtml` и `stateHtml` в строке проекта не зовутся вовсе — не пустыми
значениями, а отсутствием вызова: у каталога этих величин нет, и пустая колонка
обещала бы, что они бывают.

**Сортировка и `onlyLive` к проектам не применяются.** Порядок задаёт
агрегатор (`project_rows` сортирует по свежести), `onlyLive` — про сессии.
Переключатель `sort` в режиме проектов остаётся на экране, но ни на что не
влияет; прятать его — лишняя ветка в отрисовке ради полусекунды.

## Post-Completion

**Ручная проверка** (тесты этого не увидят — это запись в DOM и чужой шелл):

- `/a` и `^A` показывают проекты, в том числе без единой сессии
- стирание префикса возвращает список сессий, активная строка не «уезжает»
- Enter на строке проекта поднимает `claude -n <имя проекта>` в терминале
- `^N` на строке сессии поднимает новую сессию в её каталоге
- проектный хоткей (`Ctrl+F11`/`Ctrl+F12`) теперь даёт **именованную** сессию —
  проверить, что оконный трекер находит её по заголовку и строка появляется
  на панели openHASP
- действия папки (проводник / редактор) работают на строке проекта
- подписи в `^K` — символами: `^K`, `^N`, `^⇧E`
- `$0 · 0%` у сессии, где хук ни разу не сработал
- список не мигает и не дёргается раз в секунду ни в одном из режимов

**Внешние следствия**

- Деплой: `data/scripts/deploy-mac.sh` и `data/scripts/deploy-win.sh`
  (каталог `data/` под `.gitignore`). Интерфейс пикера вшит в бинарник —
  правки `sessions.html` и `frontend-src/` доезжают только полной пересборкой.
- На macOS тесты гонять так: `zsh -lc 'source ~/.nvm/nvm.sh && npm test'` —
  Node там из nvm и в неинтерактивном ssh не подхватывается.
- Скилл `/claude-wt` живёт вне git: правки из Task 8 нигде не зафиксируются,
  и если каталог переустановят, их придётся нанести заново.
