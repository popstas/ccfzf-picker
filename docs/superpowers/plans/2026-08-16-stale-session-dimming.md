# Stale Session Dimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Settings mode that dims every stale ordinary session and stale project using separately configurable age thresholds and one configurable opacity.

**Architecture:** Normalize the new `stale` config group at the existing `ConfigShape` boundary, expose the same group through the existing table-driven Settings form, and keep age classification in a new dependency-free frontend module. The page renderer adds only a `stale` class; CSS receives the normalized opacity through one custom property and restores full opacity for hover and keyboard selection.

**Tech Stack:** Plain JavaScript UMD modules, HTML/CSS, Node.js built-in test runner, Tauri's existing config bridge.

## Global Constraints

- The feature is disabled by default.
- Defaults are exactly `sessionHours: 2`, `projectDays: 7`, and `opacity: 0.5`.
- Valid age thresholds are finite numbers greater than zero.
- Valid opacity is a finite number in the inclusive range `0.1..1.0`.
- Every ordinary session is classified only by age, regardless of `live`, agent state, group, or window presence.
- Projects use the one global `projectDays` override; there is no per-project setting.
- Missing, zero, non-numeric, or future `lastActivity` never dims a row.
- Section headers, snapshots, snapshot sessions, and Zellij rows are outside the feature.
- Hover and keyboard-selected `.active` rows always render at opacity `1`.
- User-visible labels and validation errors are English; code comments and test explanations are Russian.
- Add no dependency and change no Rust code.
- Keep the user's existing unstaged `docs/TODO.md` changes untouched and out of every commit.

---

### Task 1: Normalize the stale configuration contract

**Files:**
- Modify: `frontend-src/config-shape.js:12`
- Modify: `frontend-src/config-shape.js:176`
- Test: `test/config-shape.test.js:10`

**Interfaces:**
- Consumes: raw `config.yaml` object passed to `normalizeConfig(raw)`.
- Produces: `DEFAULTS.stale` and normalized `config.stale: { enabled: boolean, sessionHours: number, projectDays: number, opacity: number }`.

- [ ] **Step 1: Write failing normalization tests**

Append these tests to `test/config-shape.test.js`:

```js
// ── Затемнение старых строк ────────────────────────────────────────────────

test('stale по умолчанию выключен и несёт оба порога с opacity', () => {
  assert.deepStrictEqual(normalizeConfig({}).stale, {
    enabled: false,
    sessionHours: 2,
    projectDays: 7,
    opacity: 0.5,
  });
});

test('корректные stale-настройки проходят числами', () => {
  assert.deepStrictEqual(normalizeConfig({
    stale: { enabled: true, sessionHours: '3.5', projectDays: 14, opacity: '0.7' },
  }).stale, {
    enabled: true,
    sessionHours: 3.5,
    projectDays: 14,
    opacity: 0.7,
  });
});

test('испорченное stale-поле сбрасывает только себя', () => {
  assert.deepStrictEqual(normalizeConfig({
    stale: { enabled: 'yes', sessionHours: 0, projectDays: 10, opacity: 2 },
  }).stale, {
    enabled: false,
    sessionHours: 2,
    projectDays: 10,
    opacity: 0.5,
  });
  assert.deepStrictEqual(normalizeConfig({ stale: null }).stale, {
    enabled: false,
    sessionHours: 2,
    projectDays: 7,
    opacity: 0.5,
  });
});
```

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run:

```bash
node --test test/config-shape.test.js
```

Expected: FAIL because `normalizeConfig({}).stale` is `undefined`.

- [ ] **Step 3: Add defaults and a field-by-field normalizer**

Add this property inside `DEFAULTS` in `frontend-src/config-shape.js`:

```js
    // Визуальное приглушение старых строк выключено, пока человек сам его не
    // попросил. Пороги остаются в конфиге и при выключенной галке.
    stale: { enabled: false, sessionHours: 2, projectDays: 7, opacity: 0.5 },
```

Add this helper before `normalizeConfig`:

```js
  /**
   * Пороги старых строк и их прозрачность.
   *
   * Каждое поле нормализуется отдельно: опечатка в opacity не должна стирать
   * выбранный человеком недельный порог проектов.
   */
  function normalizeStale(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const positive = (value, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : fallback;
    };
    const opacity = Number(src.opacity);
    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.stale.enabled,
      sessionHours: positive(src.sessionHours, DEFAULTS.stale.sessionHours),
      projectDays: positive(src.projectDays, DEFAULTS.stale.projectDays),
      opacity: Number.isFinite(opacity) && opacity >= 0.1 && opacity <= 1
        ? opacity
        : DEFAULTS.stale.opacity,
    };
  }
```

Add `stale: normalizeStale(src.stale)` to the object returned by `normalizeConfig`, next to the other visual configuration such as `pickerSize`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --test test/config-shape.test.js
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit only the configuration contract**

```bash
git add frontend-src/config-shape.js test/config-shape.test.js
git commit -m "feat(config): normalize stale row settings"
```

---

### Task 2: Expose stale settings in General

**Files:**
- Modify: `frontend-src/settings-form.js:54`
- Modify: `frontend-src/settings-form.js:155`
- Modify: `frontend-src/settings-form.js:275`
- Test: `test/settings-form.test.js:11`

**Interfaces:**
- Consumes: raw nested config paths through existing `at`, `put`, `configToFields`, and `fieldsToPatch`.
- Produces: fields `stale.enabled`, `stale.sessionHours`, `stale.projectDays`, and `stale.opacity`; `validate(fields)` returns English errors for invalid values.

- [ ] **Step 1: Write failing form round-trip and validation tests**

Append to `test/settings-form.test.js`:

```js
// ── Затемнение старых строк ────────────────────────────────────────────────

test('stale-настройки находятся в General и показывают defaults', () => {
  const ids = PAGES.find(page => page.id === 'general').fields.map(field => field.id);
  assert.ok(ids.includes('stale.enabled'), ids);
  assert.ok(ids.includes('stale.sessionHours'), ids);
  assert.ok(ids.includes('stale.projectDays'), ids);
  assert.ok(ids.includes('stale.opacity'), ids);

  const fields = configToFields({});
  assert.strictEqual(fields['stale.enabled'], false);
  assert.strictEqual(fields['stale.sessionHours'], 2);
  assert.strictEqual(fields['stale.projectDays'], 7);
  assert.strictEqual(fields['stale.opacity'], 0.5);
  assert.deepStrictEqual(fieldsToPatch(fields, {}), {});
});

test('stale-настройка уезжает точечным числовым патчем', () => {
  const original = { stale: { enabled: true, sessionHours: 2, projectDays: 7, opacity: 0.5 } };
  const fields = configToFields(original);
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, 'stale.opacity': '0.7' }, original),
    { stale: { opacity: 0.7 } },
  );
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, 'stale.projectDays': '14' }, original),
    { stale: { projectDays: 14 } },
  );
});

test('форма отвергает плохие stale-пороги и opacity', () => {
  const valid = { ...configToFields({}), sshHost: 'host' };
  assert.deepStrictEqual(validate(valid), []);

  for (const [id, value] of [
    ['stale.sessionHours', ''],
    ['stale.sessionHours', 0],
    ['stale.projectDays', -1],
    ['stale.opacity', 0.09],
    ['stale.opacity', 1.01],
    ['stale.opacity', 'none'],
  ]) {
    const problems = validate({ ...valid, [id]: value });
    assert.ok(problems.some(problem => problem.includes(id)), `${id}=${value}: ${problems}`);
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test test/settings-form.test.js
```

Expected: FAIL because the four fields do not exist and number defaults currently become an empty string.

- [ ] **Step 3: Add the four table-driven General fields**

Add these entries after `backgroundRefresh` in the General page's `fields` array:

```js
        { id: 'stale.enabled', label: 'Dim stale sessions and projects',
          type: 'bool', default: false },
        { id: 'stale.sessionHours', label: 'Sessions become stale after, hours',
          type: 'number', default: 2 },
        { id: 'stale.projectDays', label: 'Projects become stale after, days',
          type: 'number', default: 7 },
        { id: 'stale.opacity', label: 'Stale opacity', type: 'number', default: 0.5,
          hint: 'From 0.1 (very dim) to 1.0 (fully opaque).' },
```

Change the number branch in `emptyFor(field)` so a declared numeric default is shown, while `mqtt.port` still stays empty:

```js
    if (field.type === 'number') return field.default === undefined ? '' : field.default;
```

- [ ] **Step 4: Add exact validation without breaking partial callers**

Inside `validate(fields)`, before `return problems`, add:

```js
    const validNumber = (id, min, max, message) => {
      // Частичные вызовы validate в тестах старых полей не обязаны знать про
      // новое поле; настоящая форма всегда передаёт все четыре stale-ключа.
      if (fields[id] === undefined) return;
      const value = Number(fields[id]);
      if (!Number.isFinite(value) || value < min || value > max) {
        problems.push(`${id} ${message}`);
      }
    };
    validNumber('stale.sessionHours', Number.MIN_VALUE, Infinity, 'must be greater than 0');
    validNumber('stale.projectDays', Number.MIN_VALUE, Infinity, 'must be greater than 0');
    validNumber('stale.opacity', 0.1, 1, 'must be between 0.1 and 1.0');
```

Do not condition validation on `stale.enabled`: disabling the effect preserves the fields, and saving malformed preserved values would make later re-enabling surprising.

- [ ] **Step 5: Run Settings tests and verify they pass**

Run:

```bash
node --test test/settings-form.test.js test/settings-page.test.js
```

Expected: all tests in both files PASS. `settings.html` needs no new renderer branch because `number` is already a supported field type.

- [ ] **Step 6: Commit only Settings form behavior**

```bash
git add frontend-src/settings-form.js test/settings-form.test.js
git commit -m "feat(settings): add stale row controls"
```

---

### Task 3: Classify stale rows in a focused module

**Files:**
- Create: `frontend-src/stale-items.js`
- Create: `test/stale-items.test.js`

**Interfaces:**
- Consumes: `row.lastActivity`, epoch `nowSec`, normalized `stale` settings, and kind `'session' | 'project'`.
- Produces: `StaleItems.isStale(row, nowSec, stale, kind): boolean` and `StaleItems.staleClass(...): '' | ' stale'`.

- [ ] **Step 1: Write the failing unit tests**

Create `test/stale-items.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isStale, staleClass } = require('../frontend-src/stale-items');

const NOW = 2_000_000;
const STALE = { enabled: true, sessionHours: 2, projectDays: 7, opacity: 0.5 };

test('сессия становится старой ровно на пороге', () => {
  assert.strictEqual(isStale({ lastActivity: NOW - 7199 }, NOW, STALE, 'session'), false);
  assert.strictEqual(isStale({ lastActivity: NOW - 7200 }, NOW, STALE, 'session'), true);
  assert.strictEqual(staleClass({ lastActivity: NOW - 7200 }, NOW, STALE, 'session'), ' stale');
});

test('live и window не дают исключений старой сессии', () => {
  for (const row of [
    { lastActivity: NOW - 7200, live: true, window: { id: 1 } },
    { lastActivity: NOW - 7200, live: true },
    { lastActivity: NOW - 7200, live: false, window: { id: 1 } },
    { lastActivity: NOW - 7200, live: false },
  ]) {
    assert.strictEqual(isStale(row, NOW, STALE, 'session'), true, JSON.stringify(row));
  }
});

test('проект пользуется своим недельным порогом', () => {
  assert.strictEqual(
    isStale({ lastActivity: NOW - 2 * 86400 }, NOW, STALE, 'project'),
    false,
  );
  assert.strictEqual(
    isStale({ lastActivity: NOW - 7 * 86400 }, NOW, STALE, 'project'),
    true,
  );
});

test('выключенный режим и неизвестный возраст не затемняют', () => {
  assert.strictEqual(
    isStale({ lastActivity: NOW - 999999 }, NOW, { ...STALE, enabled: false }, 'session'),
    false,
  );
  for (const lastActivity of [undefined, null, 0, 'bad', NOW + 1]) {
    assert.strictEqual(isStale({ lastActivity }, NOW, STALE, 'session'), false);
  }
  assert.strictEqual(isStale({ lastActivity: NOW - 999999 }, NOW, STALE, 'zellij'), false);
  assert.strictEqual(staleClass({}, NOW, STALE, 'session'), '');
});
```

- [ ] **Step 2: Run the new test and verify module loading fails**

Run:

```bash
node --test test/stale-items.test.js
```

Expected: FAIL with `Cannot find module '../frontend-src/stale-items'`.

- [ ] **Step 3: Create the dependency-free UMD helper**

Create `frontend-src/stale-items.js`:

```js
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaleItems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SECONDS = { session: 3600, project: 86400 };

  /**
   * Достигла ли обычная сессия или проект своего порога старости.
   *
   * Нулевое и будущее время — неизвестное, а не старое. Неизвестный вид строки
   * тоже не затемняется: снимки и Zellij имеют другой смысл возраста.
   */
  function isStale(row, nowSec, stale, kind) {
    if (!stale || stale.enabled !== true || !SECONDS[kind]) return false;
    const lastActivity = Number(row && row.lastActivity);
    const now = Number(nowSec);
    const amount = Number(kind === 'project' ? stale.projectDays : stale.sessionHours);
    const threshold = amount * SECONDS[kind];
    return Number.isFinite(lastActivity)
      && lastActivity > 0
      && Number.isFinite(now)
      && now >= lastActivity
      && Number.isFinite(threshold)
      && threshold > 0
      && now - lastActivity >= threshold;
  }

  function staleClass(row, nowSec, stale, kind) {
    return isStale(row, nowSec, stale, kind) ? ' stale' : '';
  }

  return { isStale, staleClass };
});
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run:

```bash
node --test test/stale-items.test.js
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the isolated classifier**

```bash
git add frontend-src/stale-items.js test/stale-items.test.js
git commit -m "feat(picker): classify stale rows"
```

---

### Task 4: Apply stale classes and configurable opacity in the picker

**Files:**
- Modify: `sessions.html:256`
- Modify: `sessions.html:621`
- Modify: `sessions.html:657`
- Modify: `sessions.html:1010`
- Modify: `sessions.html:1118`
- Modify: `sessions.html:3111`
- Modify: `sessions.html:3235`
- Modify: `scripts/prepare-frontend.js:8`
- Modify: `test/frontend-load.test.js:25`
- Modify: `test/row-contract.test.js:14`
- Modify: `test/row-contract.test.js:365`
- Modify: `test/row-contract.test.js:1415`

**Interfaces:**
- Consumes: `window.StaleItems.staleClass(row, nowSec, CONFIG.stale, kind)` from Task 3 and normalized `CONFIG.stale.opacity` from Task 1.
- Produces: `stale` on ordinary session/project row roots and CSS property `--stale-opacity` on `#list`.

- [ ] **Step 1: Add failing renderer and CSS contract tests**

At the imports in `test/row-contract.test.js`, add:

```js
const StaleItems = require('../frontend-src/stale-items');
```

Extend both VM contexts used by `renderProjectRows` and `renderSessionRows` with:

```js
    window: {
      // Keep the context's existing window members too.
      StaleItems,
    },
    CONFIG: {
      stale: stale || { enabled: false, sessionHours: 2, projectDays: 7, opacity: 0.5 },
    },
```

To make that snippet concrete without disturbing existing callers:

- change `renderProjectRows(projects, query, toggles, taken)` to
  `renderProjectRows(projects, query, toggles, taken, stale)`;
- add `StaleItems` to its existing `window: { PickerSections }`;
- change `renderSessionRows(state, query, toggles)` to
  `renderSessionRows(state, query, toggles, stale)`;
- add `StaleItems` beside its existing `SessionActions` and
  `PickerSections` members.

Append these tests:

```js
test('старые обычные сессии и проекты получают stale, а Zellij нет', () => {
  const stale = { enabled: true, sessionHours: 2, projectDays: 7, opacity: 0.4 };
  const { items: sessions } = renderSessionRows({
    ok: true,
    sessions: [aggregatorSession({
      live: false,
      window: null,
      // buildSessionList берёт lastActivity из agent.updated, не из mtime.
      agent: { updated: NOW - 7200 },
    })],
  }, '', undefined, stale);
  const session = sessions.find(item => item.key.startsWith('s:'));
  assert.match(session.html, /class="row session[^"]*\bstale\b/);

  const { items: projects } = renderProjectRows([{
    path: '/p/old', name: 'old', sessions: 1, live: 0,
    mtime: PROJECTS_NOW - 7 * 86400,
  }], '', undefined, undefined, stale);
  assert.match(projects[0].html, /class="row project stale"/);

  const { items: zellij } = renderSessionRows({
    ok: true,
    sessions: [],
    zellij: [{ name: 'home', created: NOW - 999999, agents: 0 }],
  }, '', undefined, stale);
  assert.ok(!zellij.find(item => item.key.startsWith('s:')).html.includes(' stale'));
});

test('stale CSS затемняет, но hover и active возвращают opacity 1', () => {
  assert.match(SESSIONS_HTML, /\.row\.stale\s*\{[^}]*var\(--stale-opacity,\s*0\.5\)/);
  assert.match(SESSIONS_HTML, /\.row\.stale:hover[\s\S]*?opacity:\s*1/);
  assert.match(SESSIONS_HTML, /\.row\.stale\.active[\s\S]*?opacity:\s*1/);
});

test('настроенная stale opacity записывается в CSS property', () => {
  const source = pageFunctions('applyStaleOpacity()');
  const calls = [];
  const ctx = {
    CONFIG: { stale: { opacity: 0.4 } },
    list: { style: { setProperty: (key, value) => calls.push([key, value]) } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${source}\napplyStaleOpacity();`, ctx, { filename: 'sessions.html' });
  assert.deepStrictEqual(calls, [['--stale-opacity', '0.4']]);
});
```

Run:

```bash
node --test test/row-contract.test.js
```

Expected: FAIL because `applyStaleOpacity`, the `stale` classes, and CSS rules do not exist.

- [ ] **Step 2: Load and package the new browser module**

In `sessions.html`, add this tag immediately after `config-shape.js`:

```html
<script src="stale-items.js"></script>
```

In `scripts/prepare-frontend.js`, add this entry immediately after
`frontend-src/config-shape.js`:

```js
  'frontend-src/stale-items.js',
```

In the first test of `test/frontend-load.test.js`, add:

```js
  assert.strictEqual(
    ctx.StaleItems.isStale(
      { lastActivity: 1 }, 7201,
      { enabled: true, sessionHours: 2, projectDays: 7, opacity: 0.5 },
      'session',
    ),
    true,
  );
```

- [ ] **Step 3: Add the CSS contract and opacity bridge**

Near the existing `.row:hover` and `.row.active` rules in `sessions.html`, add:

```css
        .row.stale { opacity: var(--stale-opacity, 0.5); }
        .row.stale:hover,
        .row.stale.active { opacity: 1; }
```

After `const list = document.getElementById('list');`, add:

```js
  /** Передать одно нормализованное значение всем stale-строкам через CSS. */
  function applyStaleOpacity() {
    list.style.setProperty('--stale-opacity', String(CONFIG.stale.opacity));
  }
```

Call `applyStaleOpacity()`:

1. immediately after the initial `load_config` try/catch in `start()`, so the default is also applied when loading fails;
2. immediately after the `load_config` try/catch in the `config-changed` listener, before `regroup()`.

- [ ] **Step 4: Add the class to project and ordinary-session roots**

In `projectItem(project, nowSec)`, calculate:

```js
    const stale = window.StaleItems.staleClass(project, nowSec, CONFIG.stale, 'project');
```

Change its root from:

```js
    const html = `<div class="row project" data-index="${index}"${titleAttr(project)}>` +
```

to:

```js
    const html = `<div class="row project${stale}" data-index="${index}"${titleAttr(project)}>` +
```

In `sessionItem(session, nowSec)`, immediately after `rowKind`, calculate:

```js
    const stale = window.StaleItems.staleClass(session, nowSec, CONFIG.stale, rowKind);
```

Append `${stale}` after the existing `closed` and `markable` class fragments.
Passing `rowKind` is deliberate: the helper accepts `session` but rejects
`zellij`, so the pseudo-session cannot be dimmed accidentally.

- [ ] **Step 5: Run focused integration tests**

Run:

```bash
node --test test/stale-items.test.js test/row-contract.test.js test/frontend-load.test.js
```

Expected: all tests PASS. The existing script-copy test must also confirm that
`stale-items.js` is both tagged and copied.

- [ ] **Step 6: Run the complete frontend suite**

Run:

```bash
npm test
```

Expected: the entire suite PASS with zero failures.

- [ ] **Step 7: Inspect the final scoped diff**

Run:

```bash
git status --short
git diff --check
git diff -- frontend-src/config-shape.js frontend-src/settings-form.js frontend-src/stale-items.js sessions.html scripts/prepare-frontend.js test/config-shape.test.js test/settings-form.test.js test/stale-items.test.js test/frontend-load.test.js test/row-contract.test.js
```

Expected: no whitespace errors; only the listed feature files differ. The pre-existing unstaged `docs/TODO.md` remains unstaged and is not added.

- [ ] **Step 8: Commit the renderer integration**

```bash
git add sessions.html scripts/prepare-frontend.js test/frontend-load.test.js test/row-contract.test.js
git commit -m "feat(picker): dim stale sessions and projects"
```
