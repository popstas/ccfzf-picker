# Settings Overhaul and Project Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Settings (tabs, Columns table, autosave), let the picker size be chosen with radios plus optional pixels and an optional native desktop scrim, and show a grey project basename in the list instead of the full path when the name already contains it.

**Architecture:** Keep the table-driven `PAGES` in `settings-form.js` as the only source of yaml fields and tab order. Columns and Layout panels stay custom HTML in `settings.html`. Size numbers stay in `pickerSize` (`0` / `1..=100` / `≥101`). The scrim is a native OS window owned by the picker process, shown from existing `show_picker` / `hide_picker`. Project labels are a pure helper next to `shortPath`.

**Tech Stack:** Plain JavaScript UMD modules, `settings.html` / `sessions.html`, Node.js built-in test runner (`npm test`), Tauri 2 / Rust (`src-tauri/src/main.rs` plus a new `scrim.rs`).

**Spec:** [docs/superpowers/specs/2026-08-17-settings-and-project-label-design.md](../specs/2026-08-17-settings-and-project-label-design.md)

## Global Constraints

- User-visible labels, titles, hints, validation errors, tray and window copy are English; comments, test names and assert messages are Russian.
- No new npm dependencies. Rust may add `windows-sys` (Windows) and `objc2` / `objc2-app-kit` (macOS) only for the scrim.
- `showPaths` key stays; only its visible label becomes `project`.
- Explicit `pickerSize.*.height: 0` is Default (built-in size). Display-as-65% applies only when the height **key is absent** from the raw yaml, not when it is the number 0. Otherwise Default could not be saved.
- 100% is `scale_axis` = 100, never `set_fullscreen`.
- Scrim is not a second Tauri webview. Linux stores the flags and does not create a window.
- `npm test` after every frontend task. `cd src-tauri && cargo test` after every Rust task. Both before the next task.
- Do not commit `src-tauri/icons/favicon.png` or anything under `data/`.

## Files

- `frontend-src/config-shape.js` — `stale.projectHours`, `normalizePickerSize` pixels, `scrim`
- `frontend-src/stale-items.js` — project threshold in hours
- `frontend-src/settings-form.js` — `PAGES`, size radios, validate hours
- `frontend-src/session-glyph.js` — basename + word match
- `frontend-src/ui-state.js` — unknown toggle keys already defaulted; add `showTerminalIcon` only in page defaults
- `settings.html` — tabs, Columns table, autosave, details, MQTT copy
- `sessions.html` — labels, F1 header, cwd rendering, terminal glyph swap
- `src-tauri/src/main.rs` — `SETTINGS_SIZE`, `scale_axis`, `wanted_size`, scrim show/hide
- `src-tauri/src/scrim.rs` — native overlay (new)
- tests listed per task
- `docs/TODO.md` — check off the items this plan covers (last task)

---

### Task 1: `stale.projectHours`

**Files:**
- Modify: `frontend-src/config-shape.js` (`DEFAULTS.stale`, `normalizeStale`)
- Modify: `frontend-src/stale-items.js`
- Modify: `frontend-src/settings-form.js` (field id + `validNumber`)
- Test: `test/config-shape.test.js`, `test/stale-items.test.js`, `test/settings-form.test.js`, `test/frontend-load.test.js`, `test/row-contract.test.js`

**Interfaces:**
- Consumes: raw `stale.projectDays` and/or `stale.projectHours`
- Produces: `config.stale.projectHours: number` (default 168). No `projectDays` on the normalized object.

- [x] **Step 1: Rewrite the stale normalization tests**

In `test/config-shape.test.js` replace `projectDays: 7` defaults with `projectHours: 168`. Add:

```js
test('projectDays без projectHours переводится в часы', () => {
  assert.strictEqual(normalizeConfig({
    stale: { enabled: true, projectDays: 7 },
  }).stale.projectHours, 168);
});

test('projectHours главнее устаревшего projectDays', () => {
  assert.strictEqual(normalizeConfig({
    stale: { projectDays: 7, projectHours: 3 },
  }).stale.projectHours, 3);
});
```

Replace `stale.projectDays` in `test/settings-form.test.js` (field id, patch, validate) with `stale.projectHours`. Default shown is 168. In `stale-items.test.js` use `projectHours: 168` and a threshold of 2 hours for a project fixture that used 7 days.

- [x] **Step 2: Run focused tests — they fail**

```bash
npm test -- test/config-shape.test.js test/stale-items.test.js test/settings-form.test.js
```

Expected: FAIL because `projectHours` is undefined and `projectDays` is still the field id.

- [x] **Step 3: Implement**

`DEFAULTS.stale.projectHours = 168`. Delete `projectDays` from defaults. In `normalizeStale`:

```js
const fromDays = Number.isFinite(asNumber(src.projectDays)) && src.projectHours == null
  ? asNumber(src.projectDays) * 24
  : NaN;
projectHours: positive(
  src.projectHours != null ? src.projectHours : fromDays,
  DEFAULTS.stale.projectHours,
),
```

`stale-items.js`: `SECONDS.project = 3600`, read `stale.projectHours`. Settings field label: `Projects become stale after, hours`.

- [x] **Step 4: Run tests**

```bash
npm test
```

Expected: PASS. Fix remaining `projectDays` fixtures (`test/frontend-load.test.js`, `test/row-contract.test.js`).

- [x] **Step 5: Commit**

```bash
git add frontend-src/config-shape.js frontend-src/stale-items.js frontend-src/settings-form.js test
git commit -m "feat(settings): store project stale age in hours"
```

---

### Task 2: Tab table — split Integrations

**Files:**
- Modify: `frontend-src/settings-form.js` (`PAGES`)
- Test: `test/settings-form.test.js` (the `PAGES.map(p => p.id)` assertion)

**Interfaces:**
- Produces: `PAGES` ids `['general', 'window', 'columns', 'panels', 'hotkeys', 'mqtt', 'paths']`
- Titles: `General`, `Window size`, `Columns`, `Layout panels`, `Hotkeys`, `MQTT`, `Paths`
- `windowHost` moves to General. MQTT fields to `mqtt`. `pathMap.*` to `paths`. No `integrations` page.

- [x] **Step 1: Fail the id list test**

Change the expected array in `test/settings-form.test.js` to the seven ids above. Add:

```js
test('windowHost живёт на General, mqtt и pathMap — на своих вкладках', () => {
  const ids = (page) => PAGES.find(p => p.id === page).fields.map(f => f.id);
  assert.ok(ids('general').includes('windowHost'));
  assert.ok(ids('mqtt').some(id => id.startsWith('mqtt.')));
  assert.ok(ids('paths').some(id => id.startsWith('pathMap.')));
  assert.ok(!PAGES.some(p => p.id === 'integrations'));
  assert.ok(!PAGES.some(p => p.id === 'ui'));
});
```

- [x] **Step 2: Run `npm test -- test/settings-form.test.js`** — FAIL on id list.

- [x] **Step 3: Split `PAGES`**

Keep field objects, change page membership and titles. Window page id stays `window` (title `Window size`). Panels id stays `panels` (title `Layout panels`). New pages `mqtt` and `paths` with `fields: []` only for yaml keys (no custom HTML yet).

- [x] **Step 4: `npm test`** — PASS. `settings.html` still keys off `ui` / `integrations` and will mis-render until Task 3; do not open Settings yet.

- [x] **Step 5: Commit** `refactor(settings): split Integrations into MQTT and Paths`

---

### Task 3: Settings page routing, MQTT copy, terminal details, titles

**Files:**
- Modify: `settings.html` (`renderPage`, `fieldHtml` usage, `current === 'ui'` / `'integrations'`)
- Modify: `frontend-src/settings-form.js` (`fieldHtml` if it lives here — it lives in `settings.html`)

`fieldHtml` is in `settings.html`. Bool fields: set `title` from `field.hint`. Terminal `file` and `args`: wrap in `<details>` with `open` only when `window.TerminalPresets.matchPreset(fields) === 'custom'` (same matcher the preset select already uses).

**Interfaces:**
- Consumes: `PAGES` from Task 2
- Produces: `renderPage()` branches `current === 'columns'` and `current === 'panels'`; MQTT intro paragraph; actions list on `paths`.

- [x] **Step 1: Tests in `test/settings-page.test.js`**

Keep extracting functions from the page via `sourceOf`. Add:

```js
test('вкладки называются по спеке и Integrations нет', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  assert.deepStrictEqual(PAGES.map(p => p.title), [
    'General', 'Window size', 'Columns', 'Layout panels', 'Hotkeys', 'MQTT', 'Paths',
  ]);
});
```

Text-watch `settings.html`:

```js
test('renderPage знает columns и paths, а не ui и integrations', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.match(src, /current === 'columns'/);
  assert.match(src, /current === 'paths'/);
  assert.doesNotMatch(src, /current === 'ui'/);
  assert.doesNotMatch(src, /current === 'integrations'/);
  assert.match(src, /Focus, snapshots, and opening a session through a window manager need MQTT/);
  assert.match(src, /<details/);
});
```

The existing `axesHtml()` helper still looks up `axesTableHtml` — leave the function name, only the `renderPage` branch changes (`'ui'` → `'columns'`).

- [x] **Step 2: Run `npm test -- test/settings-page.test.js test/settings-form.test.js`** — FAIL.

- [x] **Step 3: Implement routing**

In `renderPage`:

```js
const body = current === 'columns' ? axesTableHtml()
  : current === 'panels' ? panelsTableHtml()
  : (current === 'mqtt' ? mqttIntroHtml() : '')
    + def.fields.map(fieldHtml).join('')
    + (current === 'paths' ? actionsListHtml() : '')
    + (current === 'general' ? '' : '');
```

`mqttIntroHtml()` returns the spec paragraph in a `.hint` (or `.field`) above the fields. For General, wrap consecutive `terminal.file` + `terminal.args` in `<details>`: if `matchPreset(fields)` is `'custom'`, add `open`. Every checkbox input gets `title="${esc(field.hint || field.label)}"`.

`let current = 'general'` stays.

- [x] **Step 4: `npm test`** — PASS.

- [x] **Step 5: Commit** `feat(settings): route new tabs and collapse terminal details`

---

### Task 4: Shrink the settings window

**Files:**
- Modify: `src-tauri/src/main.rs` (`SETTINGS_SIZE`)
- Test: existing `settings_window_fits_a_1080p_screen`

- [x] **Step 1: Change the constant to `(820.0, 720.0)`.** If a later Columns table still scrolls on 1080p, raise height until the longest tab fits, but keep it under 1080 so the existing fit test does not clamp.

- [x] **Step 2: `cd src-tauri && cargo test settings_window_fits_a_1080p_screen -- --nocapture`**

Expected: PASS with width unclamped. If the test asserts exact 1080 height, update the assertion to the new constant.

- [x] **Step 3: Commit** `fix(settings): shrink settings window to fit 1080p`

---

### Task 5: Columns table

**Files:**
- Modify: `settings.html` (`TOGGLE_LABELS`, `axesTableHtml`, `UI_DEFAULTS`)
- Modify: `sessions.html` (`TOGGLE_CHECKS` labels, `uiToggles` default for `showTerminalIcon`)
- Test: `test/settings-page.test.js` (`axesHtml`), `test/row-contract.test.js` (TOGGLE_CHECKS / TOGGLE_LABELS sync)

**Interfaces:**
- Produces: header order `Column | list | statusline`. Groups Recommended / Other. Master checkbox on Recommended. `TOGGLE_LABELS.showPaths = 'project'`. New `showTerminalIcon: 'terminal icon'`. Icons in a leading `<span class="col-icon">`. `title` on events / window / window host labels.

Recommended keys: every `TOGGLE_LABELS` key except `showEvent`, `showCost`, `showTerminalIcon`. Other: those three.

- [x] **Step 1: Failing tests**

```js
test('оси колонок идут list затем statusline', () => {
  const html = axesHtml();
  const head = html.split('Filters')[0];
  assert.ok(head.indexOf('>list<') < head.indexOf('>statusline<'));
});

test('Recommended и Other — отдельные таблицы', () => {
  const html = axesHtml();
  assert.match(html, /Recommended/);
  assert.match(html, /Other/);
  assert.match(html, /data-axis="list" data-key="recommended-all"/);
});

test('подпись paths стала project', () => {
  assert.match(axesHtml(), />project</);
  assert.doesNotMatch(axesHtml().split('Filters')[0], />paths</);
});
```

Update `test/row-contract.test.js` sync test: `TOGGLE_LABELS.showPaths` must equal `TOGGLE_CHECKS` label `project`. Include `showTerminalIcon` in both defaults.

Extend `axesHtml()` extractor to include any new constants (`COLUMN_ICONS`, `COLUMN_HINTS`, `RECOMMENDED_KEYS`).

- [x] **Step 2: Run tests — FAIL.**

- [x] **Step 3: Rebuild `axesTableHtml`**

Swap the two checkbox `<td>` so `data-axis="list"` is first. Split rows into two tables. Recommended header row: checkbox `data-key="recommended-all"` `data-axis="list"` with `indeterminate` set in `renderPage` after insert (property, not HTML attribute). Click handler: if every recommended key has `list`, set all to false; else set all to true; mark every key dirty on the list axis.

`COLUMN_ICONS` map key → one character (same style as `^K` menu). `COLUMN_HINTS` for `showEvent`, `showWindow`, `showWindowHost`.

`UI_DEFAULTS.toggles.showTerminalIcon = { list: false, statusline: false }`. Same in `sessions.html` `uiToggles`.

`paintToggles` / statusline: skip `showTerminalIcon` when building statusline checks (`side !== 'filter'` is not enough — either give it `side: 'list-only'` or filter the key out of `TOGGLE_CHECKS` statusline rendering). Spec: no extra statusline checkbox. Add `side: 'glyph'` and exclude it from `FILTER_KEYS` and from `shown` in `paintToggles`.

- [x] **Step 4: `npm test`** — PASS. Update any test that assumed header order `statusline` then `list`.

- [x] **Step 5: Commit** `feat(settings): regroup Columns with list first`

---

### Task 6: Autosave and Save padding

**Files:**
- Modify: `settings.html` (save bar CSS, `persist` function, input listeners)
- Test: `test/settings-page.test.js` (text-watch `persist` / debounce)

- [x] **Step 1: Fail a text test**

```js
test('autosave и Save зовут одну persist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.match(src, /async function persist\(/);
  assert.match(src, /setTimeout\(persist,/);
  assert.match(src, /400/);
  assert.match(src, /#save \{[^}]*padding/);
});
```

- [x] **Step 2: Run — FAIL.**

- [x] **Step 3: Extract `async function persist()`** from the current Save click handler (validate, `fieldsToPatch` + `save_config`, dirty ui.json). Save click calls `persist()`. Each `input`/`change` that already writes `fields[...]` also `clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400)`. Do not start the timer from `renderPage` itself.

`#save { padding: 8px 18px; }` (or equivalent larger padding).

- [x] **Step 4: `npm test`** — PASS.

- [x] **Step 5: Commit** `feat(settings): autosave after 400ms and keep Save`

---

### Task 7: F1 title becomes version + license

**Files:**
- Modify: `sessions.html` (`#keys-title`, `#keys-rows` footer)
- Modify: `src-tauri/src/main.rs` if version must be invoked; otherwise bake `ccfzf-picker v` + a small `invoke('app_version')` **or** read from an existing command. Prefer a page-side string from `invoke` only if one already exists. If not, add:

```rust
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

and register it next to other commands. Fill the title after load: `ccfzf-picker v${version}`. Subtitle: keep a `#keys-subtitle` with `Keyboard shortcuts`. Footer inside `#keys-rows` or after it: `MIT License` + `<a href="https://github.com/popstas/ccfzf-picker">github.com/popstas/ccfzf-picker</a>` (`spawn_detached` / `open` is not required; the webview may show the link as text if clicks are not wired — make it a clickable `https` link; if the webview cannot open it, still show the URL).

- [x] **Step 1: Tests in `test/keys-modal.test.js`**

```js
test('заголовок справочника — имя и версия, не Keyboard shortcuts', () => {
  assert.match(SESSIONS_HTML, /id="keys-title"/);
  assert.match(SESSIONS_HTML, /id="keys-subtitle"/);
  assert.match(SESSIONS_HTML, /MIT License/);
  assert.match(SESSIONS_HTML, /github.com\/popstas\/ccfzf-picker/);
  assert.doesNotMatch(
    SESSIONS_HTML.match(/id="keys-title"[^<]*</)[0],
    /Keyboard shortcuts/,
  );
});
```

- [x] **Step 2: FAIL, implement, `npm test`, `cd src-tauri && cargo test` if a command was added.**

- [x] **Step 3: Commit** `feat(picker): show version and license in the keys card`

---

### Task 8: Size radios, 100%, custom pixels, missing height 65%

**Files:**
- Modify: `frontend-src/settings-form.js` (`SIZE_CHOICES`, new type `size`, `toField`/`fromField`/`validate`/`fieldHtml` is in settings.html — type `size` must appear in `fieldHtml`)
- Modify: `frontend-src/config-shape.js` `normalizePickerSize` to accept `≥ 101`
- Modify: `settings.html` `fieldHtml`
- Test: `test/settings-form.test.js`, `test/settings-page.test.js` (`у каждого типа поля есть своя ветка`, replace `размер, вписанный руками, виден в выпадашке`), `test/config-shape.test.js` (pickerSize 1400 stays 1400; 80 stays 80; 0 stays 0)

**Interfaces:**
- `SIZE_CHOICES`: `{value:0,label:'Default'}`, 50, 65, 80, 95, **100**.
- Field type `size` for the four `pickerSize.*.width|height` ids (replace `choice`).
- `fieldHtml` for `size`: radio row + `<input type="number" min="101" data-px>` .
- Pixel input ≥ 101 sets the field value to that number and leaves radios unchecked. Radio click sets the value and clears the px box. Values 1–100 in the px box are not written (`fromField` returns undefined / validate error `must be at least 101 px`).
- `configToFields`: if `at(raw, 'pickerSize.narrow.height')` is `undefined` (key missing), show `65`. Same for `wide.height`. Widths stay 0. Because `fieldsToPatch` compares against `configToFields(original)`, a missing key vs displayed 65 **will** patch on persist. After load in `settings.html`, if `fieldsToPatch(fields, config)` contains pickerSize heights, call `persist()` once (the Task 6 timer is user-only).

- [x] **Step 1: Tests**

```js
test('SIZE_CHOICES содержит 100', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  const field = PAGES.flatMap(p => p.fields).find(f => f.id === 'pickerSize.narrow.height');
  assert.strictEqual(field.type, 'size');
  assert.ok(field.options.some(o => o.value === 100));
});

test('отсутствующая высота в форме — 65, явный ноль — Default', () => {
  const { configToFields } = require('../frontend-src/settings-form');
  assert.strictEqual(configToFields({}).['pickerSize.narrow.height'], 65);
  assert.strictEqual(configToFields({
    pickerSize: { narrow: { width: 0, height: 0 }, wide: { width: 0, height: 0 } },
  })['pickerSize.narrow.height'], 0);
});

test('пиксели ≥ 101 проходят нормализацию', () => {
  assert.strictEqual(
    require('../frontend-src/config-shape').normalizeConfig({
      pickerSize: { narrow: { width: 1400, height: 65 } },
    }).pickerSize.narrow.width,
    1400,
  );
});
```

Change `test/settings-page.test.js` «у каждого типа поля» — type `size` needs `field.type === 'size'` in `fieldHtml`. Replace the select-based «размер, вписанный руками» test: a value `1400` renders in the px input, not as a selected radio.

- [x] **Step 2: FAIL, implement `normalizePickerSize`:**

```js
return Number.isFinite(value) && (value === 0 || (value >= 1 && value <= 100) || value >= 101)
  ? value : 0;
```

Wait: `value === 0` should return 0; the current helper returns 0 for anything outside 1–100 already. Change to:

```js
if (!Number.isFinite(value) || value < 0) return 0;
if (value === 0) return 0;
if (value >= 1) return value; // 1..100 percent, ≥101 pixels
return 0;
```

Reject 0.5 as 0.

`validate`: `validNumber` for each size id allowing 0, 1–100, or ≥101.

- [x] **Step 3: `npm test`** — also update `границы доли те же, по которым судит Rust` in Task 9 together, or temporarily allow the JS side to accept ≥101 while Rust still rejects until Task 9. **Do Task 9 immediately after this task in the same sitting if tests would disagree.** Prefer finishing Task 9 before claiming Task 8 green if that watcher would fail.

- [x] **Step 4: Commit** `feat(settings): size radios, 100 percent, custom pixels`

---

### Task 9: Rust `scale_axis` and `wanted_size` for pixels

**Files:**
- Modify: `src-tauri/src/main.rs` (`scale_axis`, `wanted_size`, comments)
- Test: existing picker size tests in `main.rs`; `test/config-shape.test.js` watcher for `scale_axis` body

- [x] **Step 1: Update the JS watcher** in `test/config-shape.test.js`:

```js
assert.ok(fn[0].includes('(1.0..=100.0)') || fn[0].includes('1.0..=100.0'), 'percent branch missing');
assert.ok(fn[0].includes('101.0') || fn[0].includes(">= 101"), 'pixel branch missing');
```

Add a Rust unit test next to `big_screen_gives_the_wanted_size`:

```rust
#[test]
fn pixels_are_absolute_then_fitted() {
    let conf = serde_json::json!({"pickerSize": {"narrow": {"width": 1400.0, "height": 65.0}}});
    let scale = picker_scale(&conf);
    assert_eq!(scale.narrow.0, 1400.0);
    assert_eq!(scale.narrow.1, 65.0);
    let (w, h) = wanted_size(false, scale, Some((2560.0, 1440.0)));
    assert_eq!(w, 1400.0);
    assert_eq!(h, 1440.0 * 0.65);
}

#[test]
fn hundred_percent_is_the_screen_not_fullscreen() {
    let conf = serde_json::json!({"pickerSize": {"narrow": {"width": 100.0, "height": 100.0}}});
    let (w, h) = wanted_size(false, picker_scale(&conf), Some((1920.0, 1080.0)));
    assert_eq!((w, h), (1920.0, 1080.0));
}
```

Grep that `wanted_size` / `set_picker_size` never call `set_fullscreen`.

- [x] **Step 2: `cd src-tauri && cargo test` — FAIL** on new tests.

- [x] **Step 3: `scale_axis`**

```rust
if pct == 0.0 { return 0.0; }
if (1.0..=100.0).contains(&pct) || pct >= 101.0 {
    return pct;
}
eprintln!("ccfzf-picker: pickerSize.{name} = {pct} is outside 1..100 and below 101, using the built-in size");
0.0
```

`wanted_size` axis closure:

```rust
let axis = |fitted: f64, val: f64, screen: f64| {
    if val >= 101.0 && screen > 0.0 && !screen.is_nan() {
        return fit_axis(val, screen); // pixels, clamp like built-in wide
    }
    if val > 0.0 && val <= 100.0 && screen > 0.0 && !screen.is_nan() {
        return screen * val / 100.0; // percent, no SCREEN_FILL
    }
    fitted
};
```

- [x] **Step 4: `cargo test` and `npm test`.**

- [x] **Step 5: Commit** `feat(picker): accept pixel pickerSize values`

---

### Task 10: Scrim config + native overlay

**Files:**
- Create: `src-tauri/src/scrim.rs`
- Modify: `frontend-src/config-shape.js`, `frontend-src/settings-form.js` (two bools on Window size page), `src-tauri/src/main.rs` (`mod scrim`, `show_picker` / `hide_picker` / fullscreen toggle)
- Test: `test/config-shape.test.js`, `test/settings-form.test.js`, Rust tests for `scrim_visible(fullscreen, scrim) -> bool`, text test that no `WebviewWindowBuilder` / `"scrim"` webview label exists

**Interfaces:**
- `config.scrim = { narrow: bool, wide: bool }`, default both false
- English labels from the spec
- `scrim::set_visible(app, show: bool)` 
- `show = scrim_for(fullscreen, cfg)` where `fullscreen` is the picker layout flag

- [x] **Step 1: JS tests** for default scrim false and a patch of one flag. Rust:

```rust
fn scrim_wanted(fullscreen: bool, narrow: bool, wide: bool) -> bool {
    if fullscreen { wide } else { narrow }
}
```

Test all four combinations. Text test:

```js
test('scrim не второй webview', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'scrim.rs'), 'utf8');
  assert.doesNotMatch(src, /WebviewWindowBuilder/);
  assert.doesNotMatch(src, /label\(\s*"scrim"/);
});
```

(Place `scrim.rs` so the test file exists by Step 3.)

- [x] **Step 2: FAIL, then implement `normalizeScrim`.** Window size page gets two bool fields after the size radios: `scrim.narrow`, `scrim.wide`.

- [x] **Step 3: Native windows**

`scrim.rs`:

- **Windows (`#[cfg(windows)]`):** `CreateWindowExW` with `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT` optional — **do not** use `WS_EX_TRANSPARENT` if it would pass clicks through; clicks must hit the scrim so the picker loses focus. `WS_POPUP`, size = picker monitor work area or full monitor. `SetLayeredWindowAttributes(hwnd, 0, 115, LWA_ALPHA)` (~0.45). `SetWindowPos` HWND_TOPMOST then place the picker above it (picker is already alwaysOnTop). Show/hide with `ShowWindow`.
- **macOS (`#[cfg(target_os = "macos")]`):** borderless `NSWindow`, black `NSColor` with alpha 0.45, `setIgnoresMouseEvents(false)`, level below the picker (`NSPopUpMenuWindowLevel - 1` or `NSFloatingWindowLevel` while picker is `NSStatusWindowLevel` / Tauri alwaysOnTop — pick a pair so the picker stays above). `orderFront` / `orderOut`.
- **else:** `set_visible` is `Ok(())`.

Call `scrim::set_visible` from `show_picker` (after `show()`), `hide_picker` (before or after hide), and the size/fullscreen apply path so `^F` restyles visibility.

- [x] **Step 4: `npm test` and `cargo test`.** Manual note in Post-Completion.

- [x] **Step 5: Commit** `feat(picker): dim the desktop behind the picker`

---

### Task 11: Project basename in the list

**Files:**
- Modify: `frontend-src/session-glyph.js` (export `projectLabel`, `wordsMatch`)
- Modify: `sessions.html` (`sessionItem`, `projectItem`, snapshot-session cwd block)
- Test: `test/session-glyph.test.js`, `test/row-contract.test.js`

**Interfaces:**
- `function wordSet(text) -> Set<string>` — split `/[^a-zA-Z0-9]+/`, lower-case, drop empty
- `function hidesProject(name, cwd) -> boolean` — basename of `cwd` (last non-empty path segment, accept `/` and `\`), both sets non-empty, one is a subset of the other
- `function projectLine(name, cwd) -> string` — `''` if hidden, else basename (not `shortPath`)

- [x] **Step 1: Tests in `test/session-glyph.test.js`**

```js
test('ccfzf_picker совпадает с ccfzf-picker', () => {
  assert.strictEqual(hidesProject('ccfzf_picker', '/x/ccfzf-picker'), true);
  assert.strictEqual(projectLine('ccfzf_picker', '/x/ccfzf-picker'), '');
});

test('mac-wezterm показывает basename', () => {
  assert.strictEqual(hidesProject('mac-wezterm', '/x/projects/js/ccfzf-picker'), false);
  assert.strictEqual(projectLine('mac-wezterm', '/x/ccfzf-picker'), 'ccfzf-picker');
});

test('короткое picker гасит ccfzf-picker', () => {
  assert.strictEqual(hidesProject('picker', '/x/ccfzf-picker'), true);
});

test('пустые имя или cwd не гасят', () => {
  assert.strictEqual(hidesProject('', '/x/ccfzf-picker'), false);
  assert.strictEqual(hidesProject('n', ''), false);
});
```

Row contract: with `showPaths: true`, a project row whose `label` equals the directory name has no `<div class="cwd">`. A session `mac-wezterm` in `ccfzf-picker` has `<div class="cwd">ccfzf-picker</div>` and `title` still contains `shortPath`.

- [x] **Step 2: FAIL.**

- [x] **Step 3: Implement and switch the three `.cwd` interpolations** from `shortPath(...)` to `projectLine(name, cwd)` where `name` is the same string already used as the row title (`sessionName` / `project.label` / snapshot session name). Tooltip unchanged (`rowTitle` still uses `shortPath`).

Terminal icon: in `windowHtml` (or wherever the window glyph is built), if `toggles.showTerminalIcon.list` and `windowOf(row).app` or `.process` matches `/wezterm|kitty|ghostty|WindowsTerminal|wt|iTerm/i`, swap the glyph character. If no field, keep the current glyph. No tracker change in this task.

- [x] **Step 4: `npm test`.**

- [x] **Step 5: Commit** `feat(picker): show project basename unless named in the row`

---

### Task 12: Check off TODO items this plan delivered

**Files:**
- Modify: `docs/TODO.md`

Remove or check off: Settings tabs, Columns table, form chrome, Window size radios, overlay, «вместо пути показывать проект». Leave terminal registry, wide-mode selection jump, grey circle, and `## Нужен дизайн` untouched.

- [x] **Step 1: Edit `docs/TODO.md`.** No tests.

- [x] **Step 2: Commit** `task: check off settings overhaul items`

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| Tabs / Integrations split / MQTT copy / Paths / details / titles | 2, 3 |
| Settings height | 4 |
| Columns groups, icons, hints, list-first, terminal icon row, `project` label | 5, 11 |
| Autosave + Save padding | 6 |
| F1 version, MIT, GitHub | 7 |
| `projectHours` | 1 |
| Radios, 100%, px, missing height 65% | 8 |
| `scale_axis` / no fullscreen | 9 |
| Scrim native, flags, Linux no-op | 10 |
| Basename / word subset / tooltip / projects | 11 |
| bundle ids out of scope | — |

## Post-Completion

**Manual:** open Settings, confirm tabs, collapse terminal, change a checkbox and wait 400ms (yaml updates), Save still works. Window size: click 65% / 100% / type 1400. First open of a machine with no `pickerSize` writes height 65; a yaml with explicit `height: 0` stays Default. Toggle scrim on Windows and macOS; click the dimmed desktop — picker hides if `hideOnBlur`. List: `mac-wezterm` shows `ccfzf-picker`; a session named like the repo does not.

**Do not** ship a second webview for the scrim if the native path stalls — stop and ask; do not silently substitute.
