const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UiState = require('../frontend-src/ui-state');

// ── persist() из settings.html не затирает то, что писал пикер ──────────────
//
// Ревью нашло: окно настроек читает ui.json один раз при загрузке, а
// `open_settings` переиспользует уже созданное окно и страницу не
// перезагружает. Пикер тем временем пишет тот же файл своим saveUi() и
// настройкам об этом не сообщает — событие `ui-changed` идёт только в одну
// сторону. Сохранение снимком откатывало бы чужую правку, да ещё и рассылало
// пикеру приказ перечитать этот откат.
//
// persist() живёт прямо в странице, требовать его через require неоткуда —
// поэтому он вычитывается из settings.html и выполняется в vm, тем же приёмом,
// что renderProjects и saveUi в row-contract.test.js. Копия сохранения в тесте
// разошлась бы с настоящим молча. Save зовёт его же — кнопка и автосохранение
// делят один обработчик (task 6).
const SETTINGS_HTML = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

function sourceOf(re, what) {
  const found = SETTINGS_HTML.match(re);
  assert.ok(found, `${what} не найден в settings.html — тест сторожит не то`);
  return found[0];
}

/**
 * Общий кусок settings.html, нужный любому вызову persist(): guard-обвязка
 * (persisting/persistPending), оба оверлея dirty-состояния и сама persistOnce.
 *
 * Одна функция на все три вкладки — иначе набор извлекаемых кусков
 * разошёлся бы между хелперами теста молча, как только persistOnce попросит
 * что-то ещё.
 */
function persistCoreSrc() {
  return sourceOf(/\n {2}let persisting = false;\n {2}let persistPending = false;\n/, 'persisting/persistPending')
    + sourceOf(/\n {2}function overlayDirtyPanels\(fresh\) \{[\s\S]*?\n {2}\}\n/, 'overlayDirtyPanels')
    + sourceOf(/\n {2}function overlayDirtyToggles\(fresh\) \{[\s\S]*?\n {2}\}\n/, 'overlayDirtyToggles')
    + sourceOf(/\n {2}async function persist\(\) \{[\s\S]*?\n {2}\}\n/, 'persist')
    + sourceOf(/\n {2}async function persistOnce\(\) \{[\s\S]*?\n {2}\}\n/, 'persistOnce');
}

/**
 * Прогнать настоящий persist() на вкладке UI.
 *
 * `onDisk` — то, что лежит в ui.json к моменту нажатия «Сохранить» (обычно уже
 * с правками пикера). `snapshot` — что окно прочитало при загрузке. `dirty` —
 * ключи и оси, которые правили в самом окне.
 */
async function saveUiTab({ onDisk, snapshot, dirty }) {
  const defaultsSrc = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const saveSrc = persistCoreSrc();

  const calls = [];
  const dirtyAxes = new Map();
  for (const [key, axes] of Object.entries(dirty || {})) dirtyAxes.set(key, new Set(axes));
  const status = { className: '', textContent: '' };
  const ctx = {
    window: { UiState },
    document: { getElementById: () => status },
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(cmd === 'load_ui' ? onDisk : undefined);
    },
    current: 'columns',
    ui: snapshot,
    dirtyAxes,
    renderPage: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${defaultsSrc}\n${saveSrc}\nvar done = persist();`, ctx, { filename: 'settings.html' });
  await ctx.done;
  const saved = calls.find(c => c.cmd === 'save_ui');
  assert.ok(saved, 'save_ui не позван');
  return { saved: saved.args.ui, status, ui: ctx.ui, dirtyAxes };
}

// Снимок «как было при загрузке окна»: умолчания страницы, прочитанные из неё
// же, чтобы тест не заводил третьей копии таблицы галок.
function defaults() {
  return UiState.normalizeUiState({}, defaultsFromPage());
}

function defaultsFromPage() {
  const src = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nvar out = UI_DEFAULTS;`, ctx, { filename: 'settings.html' });
  return ctx.out;
}

// ── таблица осей объясняет себя и отделена от таблицы колонок ───────────────
//
// Тем же приёмом, что и save(): настоящий axesTableHtml вычитывается из
// страницы и выполняется в vm — копия разметки в тесте разошлась бы молча.
function axesHtml() {
  const src = ['TOGGLE_LABELS', 'FILTER_LABELS', 'AXIS_HINTS', 'COLUMN_ICONS', 'COLUMN_HINTS']
    .map(name => sourceOf(new RegExp(`\\n {2}const ${name} = \\{[\\s\\S]*?\\n?(?: {2})?\\};\\n`), name))
    .join('\n')
    // RECOMMENDED_KEYS — не объектный литерал, а выражение над TOGGLE_LABELS,
    // поэтому вычитывается своим шаблоном, до первого `;\n` на отступе в два
    // пробела, а не фигурными скобками, как остальные константы выше.
    + sourceOf(/\n {2}const RECOMMENDED_KEYS = [\s\S]*?;\n/, 'RECOMMENDED_KEYS')
    // axesTableHtml зовёт recommendedListState для checked заголовка
    // Recommended — без неё вызов упал бы ReferenceError, а не молча дал
    // неверную разметку.
    + sourceOf(/\n {2}function recommendedListState\(toggles\) \{[\s\S]*?\n {2}\}\n/, 'recommendedListState')
    + sourceOf(/\n {2}function axesTableHtml\(\) \{[\s\S]*?\n {2}\}\n/, 'axesTableHtml');
  const ctx = {
    esc: s => String(s).replace(/[&<>"]/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    ui: defaults(),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nvar out = axesTableHtml();`, ctx, { filename: 'settings.html' });
  return ctx.out;
}

// ── чекбокс recommended-all: тройное состояние и эффект клика ───────────────
//
// axesHtml() выше проверяет только разметку — что чекбокс на месте и что он
// красится каким-то title'ом. Контракт задачи («включён, когда все Recommended
// list=true; выключен, когда ни один; неопределён на смеси; клик решает по
// текущему состоянию, а не по input.checked; трогает только list; метит
// dirtyAxes») живёт в двух чистых функциях, recommendedListState и
// applyRecommendedToggle, и вычитывается тем же приёмом, что и markToggleId в
// row-contract.test.js — извлечённая ссылка на функцию зовётся прямо из
// теста, минуя DOM и renderPage целиком.
function recommendedLogic() {
  const src = sourceOf(/\n {2}const TOGGLE_LABELS = \{[\s\S]*?\n {2}\};\n/, 'TOGGLE_LABELS')
    + sourceOf(/\n {2}const RECOMMENDED_KEYS = [\s\S]*?;\n/, 'RECOMMENDED_KEYS')
    + sourceOf(/\n {2}function recommendedListState\(toggles\) \{[\s\S]*?\n {2}\}\n/, 'recommendedListState')
    + sourceOf(
      /\n {2}function applyRecommendedToggle\(toggles, dirtyAxes\) \{[\s\S]*?\n {2}\}\n/,
      'applyRecommendedToggle',
    );
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `${src}\nvar state = recommendedListState;\nvar apply = applyRecommendedToggle;`
    + `\nvar keys = RECOMMENDED_KEYS;`,
    ctx, { filename: 'settings.html' },
  );
  return {
    recommendedListState: ctx.state,
    applyRecommendedToggle: ctx.apply,
    RECOMMENDED_KEYS: Array.from(ctx.keys),
  };
}

// Полный набор осей на все ключи TOGGLE_LABELS — умолчания страницы, чтобы не
// заводить третью копию таблицы галок прямо в тесте.
function allToggles() {
  return { ...defaults().toggles };
}

test('recommended-all отмечен, когда у всех Recommended list=true', () => {
  const { recommendedListState, RECOMMENDED_KEYS } = recommendedLogic();
  const toggles = allToggles();
  for (const key of RECOMMENDED_KEYS) toggles[key] = { ...toggles[key], list: true };
  const state = recommendedListState(toggles);
  assert.strictEqual(state.checked, true);
  assert.strictEqual(state.indeterminate, false);
});

test('recommended-all снят, когда ни у одного Recommended list не включён', () => {
  const { recommendedListState, RECOMMENDED_KEYS } = recommendedLogic();
  const toggles = allToggles();
  for (const key of RECOMMENDED_KEYS) toggles[key] = { ...toggles[key], list: false };
  const state = recommendedListState(toggles);
  assert.strictEqual(state.checked, false);
  assert.strictEqual(state.indeterminate, false);
});

test('recommended-all в неопределённом состоянии на смеси', () => {
  const { recommendedListState, RECOMMENDED_KEYS } = recommendedLogic();
  const toggles = allToggles();
  RECOMMENDED_KEYS.forEach((key, i) => { toggles[key] = { ...toggles[key], list: i === 0 }; });
  const state = recommendedListState(toggles);
  assert.strictEqual(state.checked, false);
  assert.strictEqual(state.indeterminate, true);
});

test('клик на смеси включает list у всех Recommended и метит их dirty', () => {
  const { applyRecommendedToggle, RECOMMENDED_KEYS } = recommendedLogic();
  const toggles = allToggles();
  // Смешанное состояние по list, вперемешку с включённой statusline — она
  // не должна дрогнуть.
  RECOMMENDED_KEYS.forEach((key, i) => {
    toggles[key] = { ...toggles[key], list: i === 0, statusline: true };
  });
  const before = JSON.parse(JSON.stringify(toggles));
  const dirtyAxes = new Map();
  const next = applyRecommendedToggle(toggles, dirtyAxes);
  for (const key of RECOMMENDED_KEYS) {
    assert.strictEqual(next[key].list, true, `${key}.list`);
    assert.strictEqual(next[key].statusline, before[key].statusline, `${key}.statusline`);
    assert.ok(dirtyAxes.has(key), `${key} не помечен dirty`);
    assert.deepStrictEqual([...dirtyAxes.get(key)], ['list'], `${key} помечен не только по list`);
  }
  // Other-строки (showEvent, showCost, showTerminalIcon) клик не касается
  // вовсе — ни по значению, ни по dirty-отметке.
  for (const key of Object.keys(toggles)) {
    if (RECOMMENDED_KEYS.includes(key)) continue;
    assert.deepStrictEqual(next[key], before[key], key);
    assert.ok(!dirtyAxes.has(key), `${key} помечен dirty, а это не Recommended`);
  }
});

test('клик, когда все Recommended включены, выключает их все и тоже метит dirty', () => {
  const { applyRecommendedToggle, RECOMMENDED_KEYS } = recommendedLogic();
  const toggles = allToggles();
  RECOMMENDED_KEYS.forEach((key) => {
    toggles[key] = { ...toggles[key], list: true, statusline: true };
  });
  const before = JSON.parse(JSON.stringify(toggles));
  const dirtyAxes = new Map();
  const next = applyRecommendedToggle(toggles, dirtyAxes);
  for (const key of RECOMMENDED_KEYS) {
    assert.strictEqual(next[key].list, false, `${key}.list`);
    assert.strictEqual(next[key].statusline, before[key].statusline, `${key}.statusline`);
    assert.ok(dirtyAxes.get(key).has('list'), `${key} не помечен dirty`);
  }
  for (const key of Object.keys(toggles)) {
    if (RECOMMENDED_KEYS.includes(key)) continue;
    assert.deepStrictEqual(next[key], before[key], key);
    assert.ok(!dirtyAxes.has(key), `${key} помечен dirty, а это не Recommended`);
  }
});

test('у каждой галки осей есть подсказка', () => {
  const html = axesHtml();
  const boxes = html.match(/<input type="checkbox"[^>]*>/g) || [];
  assert.ok(boxes.length > 0, 'галок не нашлось — тест сторожит не то');
  for (const box of boxes) {
    assert.match(box, /title="[^"]+"/, `галка без подсказки: ${box}`);
  }
});

// Ревью финальной волны: `showTerminalIcon` — ось про глиф в колонке окна
// (`side: 'glyph'` в sessions.html), и `renderChecks` там безусловно выкидывает
// такие ключи из статуслайна (`side !== 'glyph'`). Чекбокс statusline у этой
// строки писал бы в ui.json и не рисовал бы ничего внизу списка никогда —
// мёртвый чекбокс, ровно то правило CLAUDE.md.
test('у terminal icon нет чекбокса statusline — это мёртвая ось', () => {
  const html = axesHtml();
  const rowStart = html.split('<tr>').find(chunk => chunk.includes('data-key="showTerminalIcon"'));
  assert.ok(rowStart, 'строка terminal icon не найдена');
  const row = `<tr>${rowStart.split('</tr>')[0]}</tr>`;
  assert.doesNotMatch(row, /data-axis="statusline" data-key="showTerminalIcon"/,
    `чекбокс statusline не должен существовать — renderChecks выкидывает glyph-ключи безусловно: ${row}`);
  assert.match(row, /<\/td><td><\/td><\/tr>$/,
    `ячейка statusline обязана остаться пустой, но присутствовать: ${row}`);
});

// Подсказка перечисляет буквы терминалов, а таблица этих букв живёт в
// session-glyph.js — то есть список здесь второй по счёту. Второму источнику
// правды в этом проекте полагается сторож: разойдись они, настройки обещали бы
// человеку букву, которой список не рисует, и заметить это можно было бы
// только глазами на живом окне с открытым терминалом.
test('подсказка terminal icon называет каждый терминал из таблицы глифов', () => {
  const { TERMINAL_GLYPHS } = require('../frontend-src/session-glyph');
  const src = sourceOf(/\n {2}const COLUMN_HINTS = \{[\s\S]*?\n {2}\};\n/, 'COLUMN_HINTS');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\nvar out = COLUMN_HINTS;`, ctx, { filename: 'settings.html' });
  const hint = ctx.out.showTerminalIcon;
  assert.ok(hint, 'у terminal icon нет подсказки');
  for (const terminal of TERMINAL_GLYPHS) {
    assert.ok(hint.includes(`${terminal.glyph} ${terminal.name}`),
      `подсказка не называет ${terminal.glyph} ${terminal.name}: ${hint}`);
  }
});

test('второй столбец фильтров объяснён иначе, чем у колонок', () => {
  // Поле под ним то же самое (`list`), а значит разное: у колонки — «показывать
  // колонку», у фильтра — «фильтр включён». Одинаковая подсказка врала бы.
  const html = axesHtml();
  const [columns, filters] = html.split('Filters');
  const hintOf = part => (part.match(/data-axis="list"[^>]*title="([^"]+)"/) || [])[1];
  assert.ok(hintOf(columns), 'подсказка у колонок не найдена');
  assert.ok(hintOf(filters), 'подсказка у фильтров не найдена');
  assert.notStrictEqual(hintOf(filters), hintOf(columns));
});

test('блок фильтров отбит от таблицы колонок', () => {
  // Без отступа шапка второй таблицы читалась последней строкой первой — то
  // есть колонкой `window`.
  assert.match(axesHtml(), /class="field axes-group"/);
});

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

test('правка пикера переживает сохранение настроек', async () => {
  const snapshot = defaults();
  // Пикер, пока окно настроек было открыто: снял showId со статуслайна и
  // перекрутил сортировку.
  const onDisk = defaults();
  onDisk.toggles.showId = { list: false, statusline: false };
  onDisk.sort = 'name';
  // В самом окне тронули другую ось у другого ключа.
  snapshot.toggles.showCost = { list: true, statusline: false };

  const { saved } = await saveUiTab({ onDisk, snapshot, dirty: { showCost: ['list'] } });

  assert.strictEqual(saved.toggles.showId.statusline, false, 'галка пикера не воскресает');
  assert.strictEqual(saved.toggles.showCost.list, true, 'правка окна записана');
  assert.strictEqual(saved.sort, 'name', 'сортировкой распоряжается пикер, не настройки');
});

test('режим окна переживает сохранение настроек', async () => {
  // То же правило, что и у сортировки: широким режимом распоряжается пикер
  // (`^F`), окно настроек про него не знает вовсе и обязано вернуть в файл
  // прочитанное. Не верни — и первое же сохранение вкладки UI забыло бы режим,
  // а пикер получил бы по `ui-changed` узкую раскладку внутри широкой рамы.
  const onDisk = defaults();
  onDisk.fullscreen = true;
  const { saved } = await saveUiTab({ onDisk, snapshot: defaults(), dirty: {} });
  assert.strictEqual(saved.fullscreen, true);
});

test('нетронутая ось берётся из файла, а не из снимка загрузки', async () => {
  const snapshot = defaults();
  const onDisk = defaults();
  // Пикер включил колонку showEvent, окно настроек об этом не знает.
  onDisk.toggles.showEvent = { list: true, statusline: true };
  // В окне правили только вторую ось того же ключа.
  snapshot.toggles.showEvent = { list: false, statusline: true };

  const { saved } = await saveUiTab({ onDisk, snapshot, dirty: { showEvent: ['statusline'] } });

  assert.strictEqual(saved.toggles.showEvent.list, true, 'ось, которую не трогали, из файла');
  assert.strictEqual(saved.toggles.showEvent.statusline, true, 'тронутая ось — из окна');
});

test('сохранение без правок ничего не меняет', async () => {
  const onDisk = defaults();
  onDisk.toggles.showPaths = { list: false, statusline: false };
  onDisk.sort = 'cost';
  const { saved, ui, dirtyAxes } = await saveUiTab({ onDisk, snapshot: defaults(), dirty: {} });

  assert.deepStrictEqual(saved, onDisk);
  // Записанное становится новым снимком, а счёт правок начинается заново:
  // иначе следующее сохранение снова наложило бы уже применённое.
  assert.deepStrictEqual(ui, onDisk);
  assert.strictEqual(dirtyAxes.size, 0);
});

test('вкладка UI возвращает в файл всё, чем распоряжается не она', () => {
  // Режимом окна, свёрнутостью и порядком секций окно настроек не
  // распоряжается — ими распоряжается пикер (`^F`, Enter на заголовке и
  // перетаскивание заголовка). Не верни их uiStateToSave третьим, четвёртым и
  // пятым аргументом, и первое же сохранение вкладки UI забыло бы и
  // раскладку, и свёрнутые секции, и их порядок.
  //
  // Мина срабатывала уже дважды — на `fullscreen` и на `collapsed`, — и
  // сторож поэтому сверяет список аргументов дословно: арность одна ничего не
  // ловит, аргументы можно переставить местами.
  const source = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  const call = source.match(/uiStateToSave\(([^)]*)\)/);
  assert.ok(call, 'вызов uiStateToSave не найден в settings.html — тест сторожит не то');
  const args = call[1].split(',').map(s => s.trim());
  assert.deepStrictEqual(args,
    ['fresh.sort', 'fresh.toggles', 'fresh.fullscreen', 'fresh.collapsed', 'fresh.order',
      'fresh.hidden']);
});

test('пикер тоже зовёт uiStateToSave всеми аргументами', () => {
  // Та же мина с другой стороны: страница пикера пишет ui.json чаще всех, и
  // забытый аргумент стирал бы поле при каждой смене сортировки.
  const source = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const call = source.match(/uiStateToSave\(([^)]*)\)/);
  assert.ok(call, 'вызов uiStateToSave не найден в sessions.html — тест сторожит не то');
  const args = call[1].split(',').map(s => s.trim());
  assert.deepStrictEqual(args,
    ['sortMode', 'uiToggles', 'fullscreen', 'collapsed', 'order', 'hidden']);
});

// ── вкладка Panels ─────────────────────────────────────────────────────────
//
// Та же мина, что и у вкладки UI: ui.json пишут двое, окно читает его один раз
// при загрузке, а пикер тем временем правит тот же файл перетаскиванием
// заголовков. Сохранение снимком откатывало бы чужую правку.

const PickerPanels = require('../frontend-src/picker-panels');

/** Прогнать настоящий persist() на вкладке Panels. */
async function savePanelsTab({ onDisk, snapshot, dirty }) {
  const defaultsSrc = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const saveSrc = persistCoreSrc();
  const calls = [];
  const status = { className: '', textContent: '' };
  const ctx = {
    window: { UiState, PickerPanels },
    document: { getElementById: () => status },
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(cmd === 'load_ui' ? onDisk : undefined);
    },
    current: 'panels',
    ui: snapshot,
    dirtyPanels: new Set(dirty || []),
    dirtyAxes: new Map(),
    renderPage: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${defaultsSrc}\n${saveSrc}\nvar done = persist();`, ctx, { filename: 'settings.html' });
  await ctx.done;
  const saved = calls.find(c => c.cmd === 'save_ui');
  assert.ok(saved, 'save_ui не позван');
  return { saved: saved.args.ui, ui: ctx.ui, dirtyPanels: ctx.dirtyPanels };
}

/** Настоящая разметка вкладки Panels — тем же приёмом, что и axesHtml. */
function panelsHtml(ui) {
  const src = sourceOf(/\n {2}function panelTableHtml\([\s\S]*?\n {2}\}\n/, 'panelTableHtml')
    + sourceOf(/\n {2}function panelsTableHtml\(\) \{[\s\S]*?\n {2}\}\n/, 'panelsTableHtml');
  const ctx = {
    esc: s => String(s).replace(/[&<>"]/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    window: { PickerPanels },
    ui: ui || defaults(),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nvar out = panelsTableHtml();`, ctx, { filename: 'settings.html' });
  return ctx.out;
}

test('вкладка Panels показывает обе раскладки', () => {
  const html = panelsHtml();
  assert.match(html, /Panels in the wide view/);
  assert.match(html, /Panels in the narrow view/);
  assert.ok(html.includes('data-layout="narrow"'), 'узких галок нет');
  assert.ok(html.includes('data-layout="wide"'), 'широких галок нет');
});

test('у узкой таблицы нет выбора колонки', () => {
  // Колонок в узком списке нет вовсе, и показанный выбор был бы выбором без
  // последствий — хуже, чем его отсутствие.
  const narrow = panelsHtml().split('Panels in the narrow view')[1];
  assert.ok(narrow, 'узкая таблица не нашлась');
  assert.ok(!narrow.includes('<select'), `в узкой таблице есть выпадашка: ${narrow}`);
  assert.ok(!narrow.includes('>column<'), 'в узкой таблице есть столбец колонки');
  // А в широкой — есть, и её не задело.
  const wide = panelsHtml().split('Panels in the narrow view')[0];
  assert.ok(wide.includes('data-prop="column"'), 'широкая потеряла выбор колонки');
});

test('у каждой галки панелей названа раскладка', () => {
  // Без неё правка узкой панели ушла бы в широкую половинку — туда, где
  // человек её не делал.
  const boxes = panelsHtml().match(/<input type="checkbox"[^>]*>/g) || [];
  assert.ok(boxes.length >= 11, `галок мало: ${boxes.length}`);
  for (const box of boxes) {
    assert.match(box, /data-layout="(narrow|wide)"/, `галка без раскладки: ${box}`);
  }
});

test('перетаскивание пикера переживает сохранение вкладки Panels', async () => {
  // Пикер, пока окно настроек было открыто, перетащил снимки в первую колонку.
  const onDisk = defaults();
  onDisk.order = { narrow: [], wide: [['snapshots'], [], []] };
  // В окне тронули другую панель — спрятали историю.
  const snapshot = defaults();
  snapshot.hidden = { narrow: {}, wide: { past: true } };

  const { saved } = await savePanelsTab({ onDisk, snapshot, dirty: ['wide:past'] });

  assert.strictEqual(saved.hidden.wide.past, true, 'правка окна записана');
  assert.deepStrictEqual(saved.order.wide[0], ['snapshots'],
    'перетаскивание пикера не откатилось');
});

test('нетронутая панель из файла, а не из снимка загрузки', async () => {
  const onDisk = defaults();
  onDisk.hidden = { narrow: {}, wide: { snapshots: true } };
  const snapshot = defaults();
  // Снимок про snapshots ничего не знает: окно загрузилось раньше.
  snapshot.collapsed = { narrow: {}, wide: { past: true } };

  const { saved } = await savePanelsTab({ onDisk, snapshot, dirty: ['wide:past'] });

  assert.strictEqual(saved.hidden.wide.snapshots, true, 'чужая правка пережила');
  assert.strictEqual(saved.collapsed.wide.past, true, 'своя правка записана');
});

test('узкая правка ложится в узкую половинку и не задевает широкую', async () => {
  // Половинки у панели свои: спрятанная в узком списке история ничего не
  // говорит про широкий, где у неё своя колонка и мешать некому.
  const onDisk = defaults();
  const snapshot = defaults();
  snapshot.hidden = { narrow: { past: true }, wide: {} };

  const { saved } = await savePanelsTab({ onDisk, snapshot, dirty: ['narrow:past'] });

  assert.strictEqual(saved.hidden.narrow.past, true);
  assert.strictEqual(saved.hidden.wide.past, undefined, 'широкая половинка не тронута');
});

test('ключ с двоеточием переживает пометку раскладкой', async () => {
  // Пометка — «раскладка:ключ», а в ключе своё двоеточие бывает
  // (`remote:<host>`, `past:2`). Режь его по первому разделителю — и настройка
  // ушла бы панели с именем `<host>`, которой не существует.
  const snapshot = defaults();
  snapshot.hidden = { narrow: { 'remote:alpha-host': true }, wide: {} };

  const { saved } = await savePanelsTab(
    { onDisk: defaults(), snapshot, dirty: ['narrow:remote:alpha-host'] });

  assert.strictEqual(saved.hidden.narrow['remote:alpha-host'], true);
});

test('узкая правка не заводит панели порядка: колонок там нет', async () => {
  // Порядком узкого списка распоряжается перетаскивание в пикере, и запись
  // отсюда откатывала бы его.
  const onDisk = defaults();
  onDisk.order = { narrow: ['snapshots', 'live'], wide: [[], [], []] };
  const snapshot = defaults();
  snapshot.collapsed = { narrow: { live: true }, wide: {} };

  const { saved } = await savePanelsTab({ onDisk, snapshot, dirty: ['narrow:live'] });

  assert.deepStrictEqual(saved.order.narrow, ['snapshots', 'live']);
});

test('сохранение вкладки Panels не трогает сортировку и режим окна', async () => {
  // Ими распоряжается пикер — то же правило, что и на вкладке UI.
  const onDisk = defaults();
  onDisk.sort = 'name';
  onDisk.fullscreen = true;
  const { saved } = await savePanelsTab({ onDisk, snapshot: defaults(), dirty: [] });
  assert.strictEqual(saved.sort, 'name');
  assert.strictEqual(saved.fullscreen, true);
});

test('счёт правок вкладки Panels начинается заново после сохранения', async () => {
  // Иначе следующее сохранение снова наложило бы уже применённое.
  const snapshot = defaults();
  snapshot.hidden = { narrow: {}, wide: { past: true } };
  const { dirtyPanels } = await savePanelsTab(
    { onDisk: defaults(), snapshot, dirty: ['wide:past'] });
  assert.strictEqual(dirtyPanels.size, 0);
});

// ── Новый тип поля не должен молча приезжать текстовым ──────────────────────
//
// `fieldHtml` кончается общей веткой `<input>`: тип, для которого ветки нет,
// рисуется полем ввода — и выглядит это работающим. Выпадашка размера,
// забытая здесь, дала бы текстовое поле, в которое человек вписывал бы
// проценты руками, а неверное число доехало бы до config.yaml.
//
// Сторож текстовый, потому что поймать это можно только глазами: разметка
// собирается верной, просто не той. Список типов спрашивается у PAGES, а не
// переписывается сюда вторым перечислением.
test('у каждого типа поля есть своя ветка отрисовки', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  const src = sourceOf(/\n {2}function fieldHtml\(field\) \{[\s\S]*?\n {2}\}\n/, 'fieldHtml');
  const types = new Set(PAGES.flatMap(p => p.fields.map(f => f.type)));
  assert.ok(types.size > 3, 'типов вышло слишком мало — тест сторожит не то');
  for (const type of types) {
    // `text` и есть общая ветка — своей у него нет и не нужно.
    if (type === 'text') continue;
    assert.ok(
      src.includes(`field.type === '${type}'`),
      `тип ${type} рисуется общей веткой — приедет текстовым полем`,
    );
  }
});

// Пять долей — фиксированный список радиокнопок ("Четыре доли, а не десять" —
// список, по которому надо водить глазами, хуже короткого; сам список теперь
// из пяти, но принцип тот же). Значение вне этого списка — пиксели, вписанные
// руками или подобранные раньше, — не теряется молча, а видно в соседнем
// числовом поле, а не как «совпавшая» радиокнопка, которой для него нет.
test('пиксельный размер виден в числовом поле, а не как радиокнопка', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  const src = sourceOf(/\n {2}function fieldHtml\(field\) \{[\s\S]*?\n {2}\}\n/, 'fieldHtml');
  const field = PAGES.flatMap(p => p.fields).find(f => f.type === 'size');
  assert.ok(field, 'поля-радио в PAGES нет — тест сторожит не то');

  const html = (value) => {
    const ctx = {
      fields: { [field.id]: value },
      esc: (s) => String(s),
      window: {},
    };
    vm.createContext(ctx);
    return vm.runInContext(`${src}\nfieldHtml(${JSON.stringify(field)});`, ctx,
      { filename: 'settings.html' });
  };

  const known = html(80);
  assert.match(known, /<input type="radio"[^>]*value="80"[^>]* checked>/);
  assert.strictEqual((known.match(/type="radio"/g) || []).length, field.options.length,
    'радиокнопок должно быть ровно по числу вариантов SIZE_CHOICES');
  // Известное значение в поле пикселей не утекает.
  assert.doesNotMatch(known, /data-px="[^"]*"[^>]*value="80"/);

  const handmade = html(1400);
  assert.doesNotMatch(handmade, /checked/, 'пиксели не должны совпасть ни с одной радиокнопкой');
  assert.match(handmade, /data-px="[^"]+"[^>]*value="1400"/);
});

// ── маршрутизация вкладок после переименования 'ui'/'integrations' ──────────
//
// Task 2 переименовал id страниц в PAGES (ui → columns, integrations исчезла,
// её поля ушли в mqtt и paths), а settings.html намеренно оставили нетронутым
// — эти тесты сторожат, что маршрутизация в renderPage/save её догнала.

test('вкладки называются по спеке и Integrations нет', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  // 'Dim stale sessions' сразу после General — восьмая вкладка, пришедшая из
  // #13 параллельно с этой перестройкой (см. docs/superpowers/specs/
  // 2026-08-17-stale-settings-tab-design.md); список из семи здесь был верен
  // только до слияния с той веткой.
  assert.deepStrictEqual(PAGES.map(p => p.title), [
    'General', 'Dim stale sessions', 'Window popup', 'Columns', 'Layout panels',
    'Hotkeys', 'MQTT', 'Paths',
  ]);
});

test('renderPage знает columns и paths, а не ui и integrations', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.match(src, /current === 'columns'/);
  assert.match(src, /current === 'paths'/);
  assert.doesNotMatch(src, /current === 'ui'/);
  assert.doesNotMatch(src, /current === 'integrations'/);
  assert.match(src, /Focus, snapshots, and opening a session through a window manager need MQTT/);
  assert.match(src, /<details/);
});

// ── <details> терминала открыт ровно когда пресет свой ──────────────────────
//
// Текстовый тест выше сторожит только наличие `<details` в файле — он остался
// бы зелёным, даже переверни кто-нибудь условие `open` или сломай пару
// terminal.file/terminal.args в generalBodyHtml. Здесь настоящие
// currentPreset/fieldHtml/generalBodyHtml вычитаны из страницы и прогнаны
// через настоящий TerminalPresets — как axesHtml/panelsHtml выше, но ещё и
// с реальным матчером, а не подставным: два вызова matchPreset, разошедшиеся
// местами, дали бы ложное совпадение здесь и остались бы незамеченными при
// подмене.
const TerminalPresets = require('../frontend-src/terminal-presets');
const { PAGES: FORM_PAGES, configToFields, validate, fieldsToPatch } = require('../frontend-src/settings-form');

function generalHtml(overrides) {
  const src = ['function platform', 'function linesToArgs', 'function currentPreset']
    .map(name => sourceOf(new RegExp(`\\n {2}${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`), name))
    .join('\n')
    + sourceOf(/\n {2}function fieldHtml\(field\) \{[\s\S]*?\n {2}\}\n/, 'fieldHtml')
    + sourceOf(/\n {2}function generalBodyHtml\(fieldsList\) \{[\s\S]*?\n {2}\}\n/, 'generalBodyHtml');
  const fields = { ...configToFields({}), ...overrides };
  const ctx = {
    esc: s => String(s).replace(/[&<>"]/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    window: { TerminalPresets },
    fields,
  };
  vm.createContext(ctx);
  const generalFields = FORM_PAGES.find(p => p.id === 'general').fields;
  return vm.runInContext(
    `${src}\ngeneralBodyHtml(${JSON.stringify(generalFields)});`, ctx, { filename: 'settings.html' });
}

test('свой путь без совпадения с пресетом открывает <details>', () => {
  // navigator в vm-контексте не задан — platform() отдаёт '', и osOf('') это
  // linux; ни один пресет linux не совпадает с выдуманным путём.
  const html = generalHtml({ 'terminal.file': '/opt/not-a-real-terminal', 'terminal.args': '' });
  assert.match(html, /<details open>/);
});

test('путь и аргументы, совпавшие с пресетом, оставляют <details> свёрнутым', () => {
  const preset = TerminalPresets.presetById('kitty-linux');
  const html = generalHtml({
    'terminal.file': preset.file,
    'terminal.args': preset.args.join('\n'),
  });
  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details open>/);
});

// ── Task 6: автосохранение и Save зовут одну persist ─────────────────────────
//
// Save-кнопка больше не единственный путь к записи: каждая правка планирует
// тот же persist() через общий таймер. Текстовый тест ниже сторожит форму —
// что persist существует, что таймер зовут именно его, что дебаунс 400 мс и
// что у кнопки появился отступ; поведенческие тесты после него проверяют, что
// дебаунс и правда общий на всё окно, а не по полю, и что ошибка validate
// глушит запись даже под таймером — тем же кодом, каким она глушит её и под
// ручным Save.

test('autosave и Save зовут одну persist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.match(src, /async function persist\(/);
  assert.match(src, /setTimeout\(\(\) => \{ saveTimer = null; persist\(\); \}, 400\)/);
  assert.match(src, /400/);
  assert.match(src, /#save \{[^}]*padding/);
});

/**
 * Настоящий scheduleAutosave, прогнанный на поддельных таймерах.
 *
 * Ни DOM, ни настоящий setTimeout не нужны: у дебаунса есть ровно один
 * контракт — второй вызов подряд отменяет первый таймер, а не заводит второй,
 * — и его целиком видно по паре clearTimeout/setTimeout. Настоящие таймеры
 * заставили бы тест либо спать 400 мс, либо гадать с фиктивным временем;
 * подставные fn-таймеры дают то же самое без ожидания.
 */
function runScheduleAutosaveTwice() {
  const src = sourceOf(/\n {2}let saveTimer = null;\n/, 'saveTimer')
    + sourceOf(/\n {2}function scheduleAutosave\(\) \{[\s\S]*?\n {2}\}\n/, 'scheduleAutosave');
  let persistCalls = 0;
  let nextId = 0;
  const pending = new Map();
  const ctx = {
    persist: () => { persistCalls += 1; },
    setTimeout: (fn, ms) => {
      assert.strictEqual(ms, 400, 'дебаунс обязан быть ровно 400 мс — как в брифе');
      nextId += 1;
      pending.set(nextId, fn);
      return nextId;
    },
    clearTimeout: (id) => { pending.delete(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nscheduleAutosave();\nscheduleAutosave();`, ctx, { filename: 'settings.html' });
  return { pending, fire: () => { for (const fn of pending.values()) fn(); }, persistCalls: () => persistCalls };
}

test('два быстрых события планируют один persist, а не два', () => {
  const run = runScheduleAutosaveTwice();
  assert.strictEqual(run.pending.size, 1,
    'второй вызов обязан отменить первый таймер — общий таймер на всё окно, не по полю');
  run.fire();
  assert.strictEqual(run.persistCalls(), 1, 'persist обязан сработать ровно один раз');
});

// ── Финальное ревью: смена вкладки не роняет ожидающий autosave ─────────────
//
// Раньше клик по вкладке менял `current` и перерисовывал страницу, не трогая
// `saveTimer`. Таймер доживал до клика сам, срабатывал уже на новой вкладке
// и уходил в persistOnce по её ветке — правка General писалась бы как
// `ui.json` вкладки Columns (или наоборот), печатая «saved» про то, чего не
// сохраняла. `flushPendingSave` (и вызов перед сменой `current`) чинят это;
// тем же приёмом, что и у остального файла, настоящий код вычитывается из
// страницы и прогоняется в vm — вторая копия в тесте разошлась бы молча.
function flushSrc() {
  return sourceOf(/\n {2}let saveTimer = null;\n/, 'saveTimer')
    + sourceOf(/\n {2}function scheduleAutosave\(\) \{[\s\S]*?\n {2}\}\n/, 'scheduleAutosave')
    + sourceOf(/\n {2}async function flushPendingSave\(\) \{[\s\S]*?\n {2}\}\n/, 'flushPendingSave');
}

test('flushPendingSave сохраняет правку старой вкладки, пока current ещё не сменился', async () => {
  const src = persistCoreSrc() + flushSrc();
  const calls = [];
  const status = { className: '', textContent: '' };
  const config = { sshHost: 'host' };
  const timers = new Map();
  let nextId = 0;
  const ctx = {
    document: { getElementById: () => status },
    window: {},
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(cmd === 'load_config' ? config : undefined);
    },
    current: 'general',
    validate,
    fieldsToPatch,
    configToFields,
    config,
    fields: { ...configToFields(config), sshHost: 'edited-host' },
    dirtyFields: new Set(['sshHost']),
    setTimeout: (fn, ms) => { nextId += 1; timers.set(nextId, fn); return nextId; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'settings.html' });
  // Правка в поле General планирует autosave — тем же вызовом, каким это
  // делает обработчик `input`.
  vm.runInContext('scheduleAutosave();', ctx, { filename: 'settings.html' });
  assert.strictEqual(timers.size, 1, 'дебаунс обязан был запланировать таймер');

  // Клик по другой вкладке случается внутри окна дебаунса — до того, как
  // таймер сам успел бы сработать.
  vm.runInContext('var flushed = flushPendingSave();', ctx, { filename: 'settings.html' });
  await ctx.flushed;

  assert.strictEqual(timers.size, 0,
    'ожидающий таймер обязан быть снят немедленно, а не просто дожить до своего часа');
  const saved = calls.find(c => c.cmd === 'save_config');
  assert.ok(saved, 'правка обязана была дойти до save_config, пока current ещё был general');
  assert.strictEqual(saved.args.patch.sshHost, 'edited-host');
  assert.strictEqual(status.textContent, 'saved');
});

test('flushPendingSave ничего не шлёт, если autosave не был запланирован', async () => {
  const src = persistCoreSrc() + flushSrc();
  const calls = [];
  const ctx = {
    document: { getElementById: () => ({ className: '', textContent: '' }) },
    window: {},
    invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(undefined); },
    current: 'general',
    validate,
    fieldsToPatch,
    configToFields,
    config: {},
    fields: {},
    dirtyFields: new Set(),
    setTimeout: () => { throw new Error('таймер не должен был понадобиться — нечего сбрасывать'); },
    clearTimeout: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'settings.html' });
  vm.runInContext('var flushed = flushPendingSave();', ctx, { filename: 'settings.html' });
  await ctx.flushed;
  assert.deepStrictEqual(calls, [],
    'клик по вкладке без ожидающей правки не обязан ничего сохранять — иначе каждый клик тихо переписывал бы config.yaml');
});

/** Прогнать настоящий persist() на обычной (yaml) вкладке. */
async function persistGeneralTab({ fields, config }) {
  const src = persistCoreSrc();
  const calls = [];
  const status = { className: '', textContent: '' };
  const ctx = {
    document: { getElementById: () => status },
    window: {},
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(cmd === 'load_config' ? config : undefined);
    },
    current: 'general',
    validate,
    fieldsToPatch,
    configToFields,
    config,
    fields,
    dirtyFields: new Set(),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nvar done = persist();`, ctx, { filename: 'settings.html' });
  await ctx.done;
  return { calls, status };
}

test('validate, провалившийся под автосохранением, ничего не пишет', async () => {
  // Спека говорит прямо: «autosave не пишет при ошибке validate». Проверяется
  // это на persist() напрямую — том же коде, что зовёт и таймер, и кнопка, —
  // поэтому одного теста хватает на оба пути.
  const { calls, status } = await persistGeneralTab({ fields: { sshHost: '' }, config: {} });
  assert.ok(!calls.some(c => c.cmd === 'save_config'), 'save_config не должен был позваться');
  assert.strictEqual(status.className, 'bad');
  assert.match(status.textContent, /no source/);
});

// ── нет стартового persist() при загрузке (ревью финальной волны) ───────────
//
// Раньше хвост IIFE после renderTabs()/renderPage() сам решал, нужен ли
// разовый persist() при отсутствующей высоте, — и писал config.yaml (с `.bak`
// и предупреждающей шапкой) без единого действия человека, только за то, что
// он открыл окно посмотреть. Обоснование («пикер и так уже занимает 65%
// экрана») к тому же было фактической ошибкой: `wanted_size` в main.rs при
// отсутствующем ключе берёт встроенный размер, а не долю. Запись 65
// по-прежнему происходит — но только вместе с первым настоящим autosave или
// Save, что и проверяют два теста ниже.
test('загрузка окна не пишет config.yaml сама по себе', () => {
  assert.doesNotMatch(SETTINGS_HTML, /if \(fieldsToPatch\(fields, config\)\.pickerSize\) persist\(\);/,
    'хвост загрузки не должен звать persist() без действия человека');
});

test('первый настоящий persist() всё равно пишет 65 для отсутствующей высоты', async () => {
  // Отсутствующая высота уже показана формой как 65 (configToFields) — так
  // выглядели бы fields сразу после загрузки окна, без единой правки
  // человека. Дальше persist() должен позвать что угодно ещё, лишь бы не при
  // загрузке, — здесь это обычное сохранение вкладки General.
  const config = { sshHost: 'host' };
  const fields = configToFields(config);
  const { calls } = await persistGeneralTab({ fields, config });
  const saved = calls.find(c => c.cmd === 'save_config');
  assert.ok(saved, 'save_config не был позван');
  assert.strictEqual(saved.args.patch.pickerSize.narrow.height, 65);
  assert.strictEqual(saved.args.patch.pickerSize.wide.height, 65);
});

test('повторное сохранение после записи 65 не патчит pickerSize снова', async () => {
  // Ключ в config.yaml уже есть (65, записанные предыдущим сохранением), и
  // подмена в configToFields не срабатывает: baseline и показанное
  // совпадают, patch.pickerSize не появляется — свойство то же, что раньше
  // сторожил тест на стартовом хвосте, только на настоящем сохранении, а не
  // на загрузке.
  const config = {
    sshHost: 'host',
    pickerSize: { narrow: { width: 0, height: 65 }, wide: { width: 0, height: 65 } },
  };
  const fields = configToFields(config);
  const { calls } = await persistGeneralTab({ fields, config });
  const saved = calls.find(c => c.cmd === 'save_config');
  assert.ok(saved, 'save_config всё равно вызывается — сохранение идёт, просто пустым патчем');
  assert.ok(!('pickerSize' in saved.args.patch),
    'pickerSize не должен был снова попасть в патч — высота уже записана');
});

// ── Ревью Task 8: отказ поля пикселей виден, стёртое не воскресает ──────────
//
// `setCustomValidity` сама по себе ничего не показывает без `reportValidity`
// или отправки формы — а тут нет ни того, ни другого. Отказ поэтому обязан
// быть виден через `#status`, ту же строку, которой отвечает `validate()`
// при сохранении. Проверяется настоящая проводка `[data-size]`/`[data-px]`
// из renderPage() — вычитана и прогнана в vm, как и остальные куски этого
// файла: вторая копия в тесте разошлась бы с настоящей молча.
function sizeWiringSrc() {
  const found = SETTINGS_HTML.match(
    /(\n {4}\/\/ Радиокнопки размера и поле пикселей рядом[\s\S]*?\n {4}\})\n {4}document\.getElementById\('save'\)/,
  );
  assert.ok(found, 'проводка [data-size]/[data-px] не найдена в settings.html — тест сторожит не то');
  return found[1];
}

/** Фиктивная строка размера: радиокнопки и поле пикселей внутри общего .field. */
function fakeSizeRow(id, radioValues, pxValue) {
  const radios = radioValues.map(v => ({
    dataset: { size: id },
    value: String(v),
    checked: false,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
  }));
  const px = {
    dataset: { px: id },
    value: pxValue || '',
    validity: '',
    listeners: {},
    setCustomValidity(msg) { this.validity = msg; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
  const container = {
    querySelectorAll: (sel) => (sel === 'input[type=radio]' ? radios : []),
    querySelector: (sel) => (sel === '[data-px]' ? px : null),
  };
  for (const r of radios) r.closest = () => container;
  px.closest = () => container;
  return { radios, px };
}

/** Прогнать настоящую проводку [data-size]/[data-px] на одной фиктивной строке. */
function runSizeWiring({ id, radioValues, pxValue, fields, dirtyFields }) {
  const row = fakeSizeRow(id, radioValues, pxValue);
  const status = { className: '', textContent: '' };
  const calls = { scheduleAutosave: 0 };
  const ctx = {
    page: {
      querySelectorAll: (sel) => (sel === '[data-size]' ? row.radios : sel === '[data-px]' ? [row.px] : []),
    },
    document: { getElementById: (elId) => (elId === 'status' ? status : null) },
    fields,
    dirtyFields,
    scheduleAutosave: () => { calls.scheduleAutosave += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(sizeWiringSrc(), ctx, { filename: 'settings.html' });
  return { row, status, calls };
}

test('пиксели 1–100 не пишутся и подсвечиваются статусной строкой', () => {
  const fields = { 'pickerSize.narrow.width': 0 };
  const dirtyFields = new Set();
  const { row, status, calls } = runSizeWiring({
    id: 'pickerSize.narrow.width', radioValues: [0, 50, 65, 80, 95, 100], fields, dirtyFields,
  });
  row.px.value = '50';
  row.px.listeners.input();
  assert.strictEqual(fields['pickerSize.narrow.width'], 0, 'значение не должно было записаться');
  assert.strictEqual(dirtyFields.has('pickerSize.narrow.width'), false);
  assert.strictEqual(status.className, 'bad');
  assert.strictEqual(status.textContent, 'must be at least 101 px');
  assert.strictEqual(calls.scheduleAutosave, 0, 'автосохранение не должно было планироваться на отказ');
});

test('пиксели ≥ 101 пишутся и снимают отказ', () => {
  const fields = { 'pickerSize.narrow.width': 0 };
  const dirtyFields = new Set();
  const { row, status, calls } = runSizeWiring({
    id: 'pickerSize.narrow.width', radioValues: [0, 50, 65, 80, 95, 100], fields, dirtyFields,
  });
  row.px.value = '50';
  row.px.listeners.input();
  row.px.value = '1400';
  row.px.listeners.input();
  assert.strictEqual(fields['pickerSize.narrow.width'], 1400);
  assert.ok(dirtyFields.has('pickerSize.narrow.width'));
  assert.strictEqual(status.className, '');
  assert.strictEqual(status.textContent, '');
  assert.strictEqual(calls.scheduleAutosave, 1, 'автосохранение обязано было запланироваться ровно на удачную правку');
  assert.ok(row.radios.every(r => r.checked === false), 'радиокнопки обязаны остаться пустыми у пикселей');
});

test('стёртое поле пикселей падает на Default, а не воскресает при сохранении', () => {
  // До фикса стёртое поле оставляло fields[id] прежним пиксельным числом —
  // человек стирал значение и видел его вернувшимся на следующем сохранении.
  const fields = { 'pickerSize.narrow.width': 1400 };
  const dirtyFields = new Set();
  const { row } = runSizeWiring({
    id: 'pickerSize.narrow.width', radioValues: [0, 50, 65, 80, 95, 100], pxValue: '1400', fields, dirtyFields,
  });
  row.px.value = '';
  row.px.listeners.input();
  assert.strictEqual(fields['pickerSize.narrow.width'], 0,
    'стёртое поле обязано стать Default, а не остаться прежним числом');
  assert.ok(dirtyFields.has('pickerSize.narrow.width'));
  const zero = row.radios.find(r => r.value === '0');
  assert.strictEqual(zero.checked, true, 'радиокнопка Default обязана закраситься при очистке поля');
});

test('радиокнопка снимает отказ поля пикселей рядом', () => {
  const fields = { 'pickerSize.narrow.width': 0 };
  const dirtyFields = new Set();
  const { row, status } = runSizeWiring({
    id: 'pickerSize.narrow.width', radioValues: [0, 50, 65, 80, 95, 100], fields, dirtyFields,
  });
  row.px.value = '50';
  row.px.listeners.input();
  assert.strictEqual(status.className, 'bad');
  row.radios.find(r => r.value === '80').listeners.change();
  assert.strictEqual(fields['pickerSize.narrow.width'], 80);
  assert.strictEqual(status.className, '', 'выбор радиокнопки обязан снять отказ поля пикселей рядом');
  assert.strictEqual(row.px.value, '');
});

// ── Ревью: реентерабельность persist() под автосохранением ──────────────────
//
// 400 мс дебаунса — это окно, в которое ручной клик почти никогда не попадал,
// а автосохранение попадает систематически: человек может продолжать
// печатать, пока предыдущий persist() ещё не долетел до диска (invoke —
// это IPC, не мгновенная операция). Без защиты это бьёт по двум свойствам
// сразу — второй persist() шлёт свой invoke параллельно с первым, и
// `fields = configToFields(config)` / `ui = fresh` в конце первого стирают
// то, что успело залететь на живой fields/ui, пока шёл обмен с диском.
//
// Ниже — не текстовые сторожа, а прогон настоящих persist()/persistOnce() с
// управляемым (deferred) invoke: тест сам решает, когда «диск» ответит, и
// успевает вмешаться в live fields/ui между вызовом и ответом — ровно та
// гонка, которую иначе пришлось бы ловить настоящими 400 мс ожидания или не
// поймать вовсе.

/** Обещание, которое разрешает вызывающий, а не таймер или другой промис. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** Слияние патча в фиктивный диск — тем же приёмом, каким merge_patch делает это в Rust, но проще: полей с точкой в этих тестах нет. */
function mergePatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergePatch({ ...(target[key] || {}) }, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

test('persist(): правка, залетевшая во время записи конфига, не пропадает и не шлётся вторым save_config параллельно', async () => {
  const src = persistCoreSrc();
  const calls = [];
  const status = { className: '', textContent: '' };
  let diskConfig = {};
  const gate = deferred();
  let inFlight = 0;
  let maxInFlight = 0;

  const ctx = {
    document: { getElementById: () => status },
    window: {},
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'save_config') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return gate.promise.then(() => {
          inFlight -= 1;
          diskConfig = mergePatch({ ...diskConfig }, args.patch);
          return {};
        });
      }
      if (cmd === 'load_config') return Promise.resolve({ ...diskConfig });
      return Promise.resolve(undefined);
    },
    current: 'general',
    validate,
    fieldsToPatch,
    configToFields,
    config: diskConfig,
    fields: { sshHost: 'first-host' },
    dirtyFields: new Set(),
  };
  vm.createContext(ctx);
  // Первый persist() доходит ровно до await invoke('save_config', …) и там
  // виснет на gate — синхронный хвост до первого await уже отработал к
  // моменту, когда runInContext вернёт управление.
  vm.runInContext(`${src}\nvar first = persist();`, ctx, { filename: 'settings.html' });
  assert.strictEqual(ctx.dirtyFields.size, 0, 'снимок «что шлём» обязан очистить dirtyFields до await');

  // Человек продолжает печатать, пока первая запись всё ещё в пути.
  ctx.fields.sshHost = 'second-host';
  ctx.dirtyFields.add('sshHost');

  // Дебаунс тем временем тоже стучится — второй persist(), пока первый ещё
  // не долетел.
  vm.runInContext('var second = persist();', ctx, { filename: 'settings.html' });

  gate.resolve();
  await ctx.first;
  await ctx.second;

  assert.strictEqual(maxInFlight, 1, 'save_config не должен был идти параллельно с самим собой');
  const saveConfigCalls = calls.filter(c => c.cmd === 'save_config');
  assert.ok(saveConfigCalls.length >= 2, 'правка, залетевшая во время записи, обязана дойти отдельной записью');
  assert.strictEqual(diskConfig.sshHost, 'second-host', 'правка обязана долететь до диска, а не потеряться');
  assert.strictEqual(ctx.fields.sshHost, 'second-host', 'in-memory fields не должны откатиться на старое значение');
});

/**
 * Дать очереди микрозадач полностью опустеть.
 *
 * `await invoke('load_ui')` в persistOnce виснет на своём собственном gate,
 * а её продолжение (overlayDirtyToggles + dirtyAxes.clear(), тоже
 * синхронные) должно успеть отработать ДО того, как тест вмешается в live
 * ui/dirtyAxes — иначе правка ниже случайно уедет в тот же, первый, а не во
 * второй прогон, и тест перестанет отличать «поймали» от «повезло». Тиков
 * await у одного `await` может быть больше одного, а setImmediate в Node
 * гарантированно откладывается до полного опустошения микроочереди.
 */
function flushMicrotasks() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

test('persist(): правка ui.toggles, залетевшая во время await save_ui, всё равно доходит до диска', async () => {
  const defaultsSrc = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const src = `${defaultsSrc}\n${persistCoreSrc()}`;
  const calls = [];
  const status = { className: '', textContent: '' };
  let diskUi = defaults();
  const loadGate = deferred();
  const saveGate = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const snapshot = defaults();

  const ctx = {
    document: { getElementById: () => status },
    window: { UiState },
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'load_ui') return loadGate.promise.then(() => diskUi);
      if (cmd === 'save_ui') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return saveGate.promise.then(() => {
          inFlight -= 1;
          diskUi = args.ui;
          return undefined;
        });
      }
      return Promise.resolve(undefined);
    },
    current: 'columns',
    ui: snapshot,
    dirtyAxes: new Map(),
    renderPage: () => {},
  };
  vm.createContext(ctx);
  // Первый persist() виснет на await invoke('load_ui', …) — своём gate.
  vm.runInContext(`${src}\nvar first = persist();`, ctx, { filename: 'settings.html' });

  // Пускаем load_ui и ждём, пока persistOnce дойдёт до своего собственного
  // await invoke('save_ui', …) — overlayDirtyToggles и dirtyAxes.clear() для
  // этого прогона к этому моменту уже отработали, оба синхронные.
  loadGate.resolve();
  await flushMicrotasks();
  assert.strictEqual(ctx.dirtyAxes.size, 0, 'снимок «что шлём» обязан очистить dirtyAxes до await save_ui');

  // Человек щёлкает галку showId, пока первая запись ещё в пути к диску.
  ctx.ui.toggles.showId = { ...ctx.ui.toggles.showId, list: true };
  ctx.dirtyAxes.set('showId', new Set(['list']));

  // И следом дебаунс подгоняет второй persist().
  vm.runInContext('var second = persist();', ctx, { filename: 'settings.html' });

  saveGate.resolve();
  await ctx.first;
  await ctx.second;

  assert.strictEqual(maxInFlight, 1, 'save_ui не должен был идти параллельно с самим собой');
  const saveUiCalls = calls.filter(c => c.cmd === 'save_ui');
  assert.ok(saveUiCalls.length >= 2, 'правка, залетевшая во время записи, обязана дойти отдельной записью');
  assert.strictEqual(diskUi.toggles.showId.list, true, 'правка обязана долететь до диска, а не потеряться');
  assert.strictEqual(ctx.ui.toggles.showId.list, true, 'in-memory ui не должен откатиться на старое значение');
});

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

// ── Ревью Task 3: умолчание dim stale не расходится с пикером ───────────────
//
// UI_DEFAULTS.toggles.dimStale.list в объявлении — заглушка true, только
// чтобы ключ существовал (см. комментарий рядом с ним). Настоящее значение
// пишет отдельная строка после загрузки config, тем же приёмом, что
// toggleDefaults() в sessions.html. Тест выше (`defaults()`/`allToggles()`)
// её не видит вовсе — он вычитывает только литерал UI_DEFAULTS, а не хвост
// загрузки окна, — и обе прежних правки (заведение галки и добавление её в
// settings.html) прошли бы мимо него молча: сторожа парности ключей
// (row-contract.test.js) сверяют только Object.keys, не значения умолчаний.
//
// Вычитывается настоящая строка присваивания, а не переписанная в тесте
// копия правила: разошедшийся литерал (например, снова true) обязан уронить
// именно этот тест.
function dimStaleDefaultFromConfig(configStale) {
  const uiDefaultsSrc = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const fixSrc = sourceOf(
    /\n {2}UI_DEFAULTS\.toggles\.dimStale\.list = [^\n]*;\n/,
    'вывод умолчания dimStale из config.stale.enabled',
  );
  const ctx = { config: { stale: configStale } };
  vm.createContext(ctx);
  vm.runInContext(`${uiDefaultsSrc}\n${fixSrc}\nvar out = UI_DEFAULTS.toggles.dimStale.list;`,
    ctx, { filename: 'settings.html' });
  return ctx.out;
}

test('умолчание dim stale в окне настроек берётся из config.stale.enabled, а не из литерала', () => {
  assert.strictEqual(dimStaleDefaultFromConfig({ enabled: false }), false,
    'на выключенном stale.enabled галка не должна показываться нажатой');
  assert.strictEqual(dimStaleDefaultFromConfig({ enabled: true }), true,
    'на включённом stale.enabled умолчание обязано включиться следом');
  assert.strictEqual(dimStaleDefaultFromConfig(undefined), false,
    'у свежей установки (config без секции stale) умолчание — false, как в config-shape.js');
});
