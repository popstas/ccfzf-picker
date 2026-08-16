# Stale Settings Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put stale-dimming controls on their own Settings tab, replace the project threshold with a 24-hour `projectHours` setting, and render opacity as a live-labelled slider.

**Architecture:** Keep configuration normalization in `config-shape.js`, age classification in `stale-items.js`, and table-driven field metadata in `settings-form.js`. Add one explicit `range` renderer and a small DOM updater in `settings.html`; the existing Save path continues to create a minimal config patch.

**Tech Stack:** Plain JavaScript UMD modules, HTML/CSS, Node.js built-in test runner, Tauri's existing config bridge.

## Global Constraints

- Stale dimming remains disabled by default.
- Defaults are exactly `sessionHours: 2`, `projectHours: 24`, and `opacity: 0.5`.
- `stale.projectDays` is unsupported and ignored; do not migrate, convert, validate, display, or write it.
- Valid age thresholds are finite numbers greater than zero.
- Valid opacity is a finite number in the inclusive range `0.1..1.0`.
- The opacity range uses `min="0.1"`, `max="1"`, and `step="0.1"` and immediately updates `Current: <value>` on input.
- Every stale ordinary session is dimmed regardless of `live`, agent state, group, or window presence.
- Every project uses the one global `projectHours` threshold.
- Missing, zero, non-numeric, or future `lastActivity` never dims a row.
- Section headers, snapshots, snapshot sessions, and Zellij rows remain outside stale dimming.
- Hover and keyboard-selected `.active` rows remain at opacity `1`.
- User-visible labels and validation errors are English; code comments and test explanations are Russian.
- Add no dependency and change no Rust code.
- Do not modify or commit the user-owned unstaged `docs/TODO.md` in the original checkout.

---

### Task 1: Replace the project-age contract with hours

**Files:**
- Modify: `frontend-src/config-shape.js:88,180-205`
- Modify: `frontend-src/stale-items.js:14-27`
- Modify: `test/config-shape.test.js:255-307`
- Modify: `test/stale-items.test.js:1-55`
- Modify: `test/frontend-load.test.js:45-55`
- Modify: `test/row-contract.test.js:393,1443,1715`

**Interfaces:**
- Consumes: raw `config.stale` passed to `ConfigShape.normalizeConfig(raw)` and normalized stale settings passed to `StaleItems.isStale(row, nowSec, stale, kind)`.
- Produces: normalized `stale: { enabled: boolean, sessionHours: number, projectHours: number, opacity: number }`; project age is measured in hours by `isStale`.

- [ ] **Step 1: Write failing normalization tests for the new key and ignored old key**

Replace the stale config assertions in `test/config-shape.test.js` so they include these exact cases:

```js
test('stale по умолчанию выключен и несёт часовые пороги с opacity', () => {
  assert.deepStrictEqual(normalizeConfig({}).stale, {
    enabled: false,
    sessionHours: 2,
    projectHours: 24,
    opacity: 0.5,
  });
});

test('корректные stale-настройки проходят числами', () => {
  assert.deepStrictEqual(normalizeConfig({
    stale: { enabled: true, sessionHours: '3.5', projectHours: '36', opacity: '0.7' },
  }).stale, {
    enabled: true,
    sessionHours: 3.5,
    projectHours: 36,
    opacity: 0.7,
  });
});

test('старый projectDays полностью игнорируется', () => {
  const stale = normalizeConfig({ stale: { projectDays: 30 } }).stale;
  assert.strictEqual(stale.projectHours, 24);
  assert.ok(!Object.hasOwn(stale, 'projectDays'));
});

test('испорченное stale-поле сбрасывает только себя', () => {
  assert.deepStrictEqual(normalizeConfig({
    stale: { enabled: 'yes', sessionHours: 0, projectHours: 10, opacity: 2 },
  }).stale, {
    enabled: false,
    sessionHours: 2,
    projectHours: 10,
    opacity: 0.5,
  });
  assert.deepStrictEqual(normalizeConfig({ stale: null }).stale, {
    enabled: false,
    sessionHours: 2,
    projectHours: 24,
    opacity: 0.5,
  });
});
```

In the existing non-coercion table, replace `['projectDays', 14, 7]` with `['projectHours', 36, 24]`.

- [ ] **Step 2: Write failing hourly project-boundary tests**

In `test/stale-items.test.js`, change the shared fixture and project tests to:

```js
const STALE = { enabled: true, sessionHours: 2, projectHours: 24, opacity: 0.5 };

test('проект становится stale на часовом пороге включительно', () => {
  assert.strictEqual(
    isStale({ lastActivity: NOW - 24 * 3600 + 1 }, NOW, STALE, 'project'),
    false,
  );
  assert.strictEqual(
    isStale({ lastActivity: NOW - 24 * 3600 }, NOW, STALE, 'project'),
    true,
  );
});
```

Keep the existing session, disabled-mode, malformed-activity, Zellij, and numeric-type tests unchanged except for replacing fixture property `projectDays` with `projectHours`.

- [ ] **Step 3: Run the focused tests and verify the new assertions fail**

Run:

```bash
node --test test/config-shape.test.js test/stale-items.test.js
```

Expected: FAIL because normalization still emits `projectDays: 7` and project classification still multiplies the project value by days.

- [ ] **Step 4: Normalize only `projectHours`**

In `frontend-src/config-shape.js`, replace the stale default with:

```js
    stale: { enabled: false, sessionHours: 2, projectHours: 24, opacity: 0.5 },
```

In `normalizeStale(raw)`, replace only the project property in the returned object:

```js
      projectHours: positive(src.projectHours, DEFAULTS.stale.projectHours),
```

Do not inspect `src.projectDays`. This makes an old-only config take the 24-hour default and ensures `projectDays` cannot leak into normalized output.

- [ ] **Step 5: Classify project age in hours**

In `frontend-src/stale-items.js`, replace the threshold amount and seconds calculation with:

```js
    const amount = Number(kind === 'project' ? stale.projectHours : stale.sessionHours);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const threshold = amount * 3600;
```

Keep the existing strict numeric `lastActivity`, supported-kind, enabled, and future-time guards unchanged.

- [ ] **Step 6: Update integration fixtures to the produced interface**

Replace `projectDays: 7` with `projectHours: 24` in the stale fixture objects in:

- `test/frontend-load.test.js`
- both default fixtures and the explicit stale fixture in `test/row-contract.test.js`

Do not change the existing opacity/class/hover assertions; they guard behavior that this task must preserve.

- [ ] **Step 7: Run all contract and renderer tests**

Run:

```bash
node --test test/config-shape.test.js test/stale-items.test.js test/frontend-load.test.js test/row-contract.test.js
```

Expected: all tests in all four files PASS.

- [ ] **Step 8: Confirm the removed runtime key has no accidental consumers**

Run:

```bash
rg -n "projectDays" frontend-src sessions.html settings.html test
```

Expected: only the explicit `projectDays is ignored` regression test mentions the old key.

- [ ] **Step 9: Commit the hourly configuration contract**

```bash
git add frontend-src/config-shape.js frontend-src/stale-items.js test/config-shape.test.js test/stale-items.test.js test/frontend-load.test.js test/row-contract.test.js
git commit -m "feat(config): use hourly project staleness"
```

---

### Task 2: Move stale controls to their own tab

**Files:**
- Modify: `frontend-src/settings-form.js:50-108,139,178-225,300-320`
- Modify: `test/settings-form.test.js:7-14,205-285`

**Interfaces:**
- Consumes: normalized `config.stale` from Task 1 through existing `configToFields(config)` and raw DOM-shaped field values through `fieldsToPatch(fields, original)` and `validate(fields)`.
- Produces: `PAGES` with `{ id: 'stale', title: 'Dim stale sessions' }` immediately after General; fields `stale.enabled`, `stale.sessionHours`, `stale.projectHours`, and `stale.opacity`, where opacity metadata has type `range`, min `0.1`, max `1`, and step `0.1`.

- [ ] **Step 1: Write failing page-placement and field-metadata tests**

In `test/settings-form.test.js`, update the page-order assertion and stale tests to include:

```js
assert.deepStrictEqual(PAGES.map(p => p.id),
  ['general', 'stale', 'window', 'ui', 'panels', 'hotkeys', 'integrations']);

test('stale-настройки находятся только на отдельной вкладке', () => {
  const general = PAGES.find(page => page.id === 'general');
  const stale = PAGES.find(page => page.id === 'stale');
  assert.strictEqual(stale.title, 'Dim stale sessions');
  assert.deepStrictEqual(stale.fields.map(field => field.id), [
    'stale.enabled',
    'stale.sessionHours',
    'stale.projectHours',
    'stale.opacity',
  ]);
  assert.ok(!general.fields.some(field => field.id.startsWith('stale.')));

  const opacity = stale.fields.find(field => field.id === 'stale.opacity');
  assert.deepStrictEqual(
    { type: opacity.type, min: opacity.min, max: opacity.max, step: opacity.step },
    { type: 'range', min: 0.1, max: 1, step: 0.1 },
  );
});
```

Update the default and minimal-patch assertions to expect:

```js
assert.strictEqual(fields['stale.projectHours'], 24);

const original = {
  stale: { enabled: true, sessionHours: 2, projectHours: 24, opacity: 0.5 },
};
assert.deepStrictEqual(
  fieldsToPatch({ ...fields, 'stale.projectHours': '36' }, original),
  { stale: { projectHours: 36 } },
);
```

Also assert that `configToFields({ stale: { projectDays: 30 } })` returns `24` for `stale.projectHours`, has no `stale.projectDays` field, and `fieldsToPatch` never writes that old key.

- [ ] **Step 2: Update failing validation tests for project hours**

Replace every `stale.projectDays` validation case with `stale.projectHours`; use `36` as a valid value and `-1` as an invalid value. Keep the existing malformed-type loop and opacity boundary cases.

- [ ] **Step 3: Run the focused form tests and verify failure**

Run:

```bash
node --test test/settings-form.test.js
```

Expected: FAIL because there is no `stale` page or `range` field, the form still exposes `projectDays`, and range values are not converted as numbers.

- [ ] **Step 4: Define the dedicated stale page**

Remove all four stale entries from General. Immediately after the General page object, insert:

```js
    {
      id: 'stale',
      title: 'Dim stale sessions',
      fields: [
        { id: 'stale.enabled', label: 'Dim stale sessions and projects',
          type: 'bool', default: false },
        { id: 'stale.sessionHours', label: 'Sessions become stale after, hours',
          type: 'number', default: 2 },
        { id: 'stale.projectHours', label: 'Projects become stale after, hours',
          type: 'number', default: 24 },
        { id: 'stale.opacity', label: 'Stale opacity', type: 'range', default: 0.5,
          min: 0.1, max: 1, step: 0.1,
          hint: 'From 0.1 (very dim) to 1.0 (fully opaque).' },
      ],
    },
```

- [ ] **Step 5: Give range fields the same numeric round trip as number fields**

In both `emptyFor(field)` and `fromField(field, value)`, make the numeric branch accept both types:

```js
    if (field.type === 'number' || field.type === 'range') {
```

Keep the existing empty-string guard and finite-number conversion inside `fromField`; it prevents `Number('')` from writing zero.

- [ ] **Step 6: Validate only the new project key**

Replace the project validation call with:

```js
    validNumber('stale.projectHours', Number.MIN_VALUE, Infinity, 'must be greater than 0');
```

Do not add a `projectDays` validation call. The old key is absent from `FIELDS`, so the form neither reads nor writes it.

- [ ] **Step 7: Run the focused form tests**

Run:

```bash
node --test test/settings-form.test.js
```

Expected: all tests in the file PASS.

- [ ] **Step 8: Commit the tab and field contract**

```bash
git add frontend-src/settings-form.js test/settings-form.test.js
git commit -m "feat(settings): add stale dimming tab"
```

---

### Task 3: Render opacity as a live-labelled slider

**Files:**
- Modify: `settings.html:8-35,127-177,273-333`
- Modify: `test/settings-page.test.js:380-430`

**Interfaces:**
- Consumes: the Task 2 range field `{ id, label, type: 'range', default, min, max, step, hint }` and the existing mutable `fields` object.
- Produces: `fieldHtml(field)` range markup with `data-field="stale.opacity"` and `data-range-current`; `updateRangeCurrent(input)` updates the sibling label to `Current: ${input.value}` during the existing `input` event.

- [ ] **Step 1: Add failing renderer tests for exact range attributes**

In `test/settings-page.test.js`, add a helper that extracts the real `fieldHtml` function and evaluates it with the opacity field from `PAGES`, following the existing `choice` renderer test pattern. Add:

```js
test('opacity рисуется range с шагом 0.1 и текущим значением', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  const field = PAGES.find(page => page.id === 'stale').fields
    .find(item => item.id === 'stale.opacity');
  const src = sourceOf(/\n {2}function fieldHtml\(field\) \{[\s\S]*?\n {2}\}\n/, 'fieldHtml');
  const ctx = {
    fields: { 'stale.opacity': 0.5 },
    esc: value => String(value),
    window: {},
  };
  vm.createContext(ctx);
  const html = vm.runInContext(`${src}\nfieldHtml(${JSON.stringify(field)});`, ctx,
    { filename: 'settings.html' });

  assert.match(html, /type="range"/);
  assert.match(html, /min="0\.1"/);
  assert.match(html, /max="1"/);
  assert.match(html, /step="0\.1"/);
  assert.match(html, /Current: 0\.5/);
});
```

The existing `у каждого типа поля есть своя ветка отрисовки` test must continue to pass and will independently require an explicit `field.type === 'range'` branch.

- [ ] **Step 2: Add a failing immediate-update test using the real updater**

Add:

```js
test('подпись opacity обновляется сразу при движении range', () => {
  const src = sourceOf(
    /\n {2}function updateRangeCurrent\(input\) \{[\s\S]*?\n {2}\}\n/,
    'updateRangeCurrent',
  );
  const output = { textContent: 'Current: 0.5' };
  const input = {
    type: 'range',
    value: '0.7',
    parentElement: { querySelector: () => output },
  };
  const ctx = { input, output };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nupdateRangeCurrent(input);`, ctx, { filename: 'settings.html' });
  assert.strictEqual(output.textContent, 'Current: 0.7');
});
```

- [ ] **Step 3: Run page tests and verify failure**

Run:

```bash
node --test test/settings-page.test.js
```

Expected: FAIL because `fieldHtml` has no range branch and `updateRangeCurrent` does not exist.

- [ ] **Step 4: Add compact range layout styles**

In the page `<style>`, add:

```css
  .range-row { display: flex; align-items: center; gap: 10px; }
  .range-row input[type=range] { flex: 1; }
  .range-current { white-space: nowrap; color: #bbb; }
```

- [ ] **Step 5: Render range metadata and current value**

In `fieldHtml(field)`, before the `bool` branch, add:

```js
    if (field.type === 'range') {
      return `<div class="field"><label>${esc(field.label)}</label>`
        + '<div class="range-row">'
        + `<input type="range" data-field="${field.id}" value="${esc(value)}"`
        + ` min="${esc(field.min)}" max="${esc(field.max)}" step="${esc(field.step)}">`
        + `<span class="range-current" data-range-current>Current: ${esc(value)}</span>`
        + `</div>${hint}</div>`;
    }
```

The slider uses the same `data-field` hook as other fields, so saving continues through the existing listener and `fieldsToPatch` path.

- [ ] **Step 6: Update the label inside the existing input event**

Add this function before `renderPage()`:

```js
  function updateRangeCurrent(input) {
    if (input.type !== 'range') return;
    const output = input.parentElement.querySelector('[data-range-current]');
    if (output) output.textContent = `Current: ${input.value}`;
  }
```

Call it in the existing `[data-field]` input handler immediately after updating `fields`:

```js
        updateRangeCurrent(input);
```

Do not call `save()` from the input handler; Save remains explicit.

- [ ] **Step 7: Run Settings tests**

Run:

```bash
node --test test/settings-form.test.js test/settings-page.test.js
```

Expected: all tests in both files PASS.

- [ ] **Step 8: Commit the slider UI**

```bash
git add settings.html test/settings-page.test.js
git commit -m "feat(settings): add stale opacity slider"
```

---

### Task 4: Verify and deploy the branch to Windows

**Files:**
- Verify only: all changed JavaScript, HTML, and test files from Tasks 1-3
- External script: `/home/popstas/projects/js/ccfzf-picker/data/scripts/deploy-win.sh` (ignored by git; run from the original checkout)

**Interfaces:**
- Consumes: committed branch `feat/stale-settings-tab`; Windows deployment pulls this branch from `origin` before building.
- Produces: a release-built `ccfzf-picker.exe` running in the interactive Windows Console session with the new settings tab.

- [ ] **Step 1: Run the complete JavaScript test suite**

Run in the implementation worktree:

```bash
npm test -- --test-reporter=dot
```

Expected: exit code 0 with no failed tests. One pre-existing skipped test is acceptable.

- [ ] **Step 2: Check scope and removed key**

Run:

```bash
git diff --check origin/master...HEAD
git status --short
rg -n "projectDays" frontend-src sessions.html settings.html test
```

Expected: clean worktree, no diff errors, and only the explicit ignored-old-key regression tests mention `projectDays`.

- [ ] **Step 3: Perform the required whole-branch review**

Use `superpowers:requesting-code-review` against `origin/master...HEAD`. Review spec compliance first and code quality second. If findings exist, use `superpowers:receiving-code-review`, fix them in a fresh fix round, rerun focused tests plus full `npm test`, and commit the fix separately before repeating review.

- [ ] **Step 4: Finish the development branch**

Use `superpowers:finishing-a-development-branch`. Do not merge or squash without a new explicit user request. The already-authorized Windows preview deployment does allow pushing this feature branch because the deploy script pulls from `origin`.

- [ ] **Step 5: Push the exact tested branch**

Run:

```bash
git push -u origin feat/stale-settings-tab
```

Expected: `origin/feat/stale-settings-tab` points at the reviewed `HEAD`.

- [ ] **Step 6: Deploy that pushed branch**

Run from `/home/popstas/projects/js/ccfzf-picker`, where the ignored script exists:

```bash
BRANCH=feat/stale-settings-tab ./data/scripts/deploy-win.sh
```

Expected: the script prints the same commit as local `HEAD`, prepares frontend assets, completes `cargo build --release`, prints `EXE_OK`, restarts through `schtasks`, and shows a `ccfzf-picker.exe` PID in the interactive session.

- [ ] **Step 7: Report what is ready to inspect**

Tell the user the deployed commit hash and that Settings now contains `Dim stale sessions`. Ask them to inspect the tab, `Projects become stale after, hours` defaulting to `24`, and the opacity slider whose `Current: 0.5` changes while dragging.
