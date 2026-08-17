const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UiState = require('../frontend-src/ui-state');

// ── save() из settings.html не затирает то, что писал пикер ─────────────────
//
// Ревью нашло: окно настроек читает ui.json один раз при загрузке, а
// `open_settings` переиспользует уже созданное окно и страницу не
// перезагружает. Пикер тем временем пишет тот же файл своим saveUi() и
// настройкам об этом не сообщает — событие `ui-changed` идёт только в одну
// сторону. Сохранение снимком откатывало бы чужую правку, да ещё и рассылало
// пикеру приказ перечитать этот откат.
//
// save() живёт прямо в странице, требовать его через require неоткуда —
// поэтому он вычитывается из settings.html и выполняется в vm, тем же приёмом,
// что renderProjects и saveUi в row-contract.test.js. Копия сохранения в тесте
// разошлась бы с настоящим молча.
const SETTINGS_HTML = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

function sourceOf(re, what) {
  const found = SETTINGS_HTML.match(re);
  assert.ok(found, `${what} не найден в settings.html — тест сторожит не то`);
  return found[0];
}

/**
 * Прогнать настоящий save() на вкладке UI.
 *
 * `onDisk` — то, что лежит в ui.json к моменту нажатия «Сохранить» (обычно уже
 * с правками пикера). `snapshot` — что окно прочитало при загрузке. `dirty` —
 * ключи и оси, которые правили в самом окне.
 */
async function saveUiTab({ onDisk, snapshot, dirty }) {
  const defaultsSrc = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const saveSrc = sourceOf(/\n {2}async function save\(\) \{[\s\S]*?\n {2}\}\n/, 'save');

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
    current: 'ui',
    ui: snapshot,
    dirtyAxes,
    renderPage: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${defaultsSrc}\n${saveSrc}\nvar done = save();`, ctx, { filename: 'settings.html' });
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
  const src = ['TOGGLE_LABELS', 'FILTER_LABELS', 'AXIS_HINTS']
    .map(name => sourceOf(new RegExp(`\\n {2}const ${name} = \\{[\\s\\S]*?\\n?(?: {2})?\\};\\n`), name))
    .join('\n')
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

test('у каждой галки осей есть подсказка', () => {
  const html = axesHtml();
  const boxes = html.match(/<input type="checkbox"[^>]*>/g) || [];
  assert.ok(boxes.length > 0, 'галок не нашлось — тест сторожит не то');
  for (const box of boxes) {
    assert.match(box, /title="[^"]+"/, `галка без подсказки: ${box}`);
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

/** Прогнать настоящий save() на вкладке Panels. */
async function savePanelsTab({ onDisk, snapshot, dirty }) {
  const defaultsSrc = sourceOf(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/, 'UI_DEFAULTS');
  const saveSrc = sourceOf(/\n {2}async function save\(\) \{[\s\S]*?\n {2}\}\n/, 'save');
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
  vm.runInContext(`${defaultsSrc}\n${saveSrc}\nvar done = save();`, ctx, { filename: 'settings.html' });
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

// Значение, которого в списке нет, дописывается пунктом, а не теряется:
// config.yaml правят и руками, а `<select>` без совпадения показал бы первый
// пункт — то есть соврал бы, что размер встроенный. Та же цена и та же
// причина, что у «Custom» в выпадашке терминалов.
test('размер, вписанный руками, виден в выпадашке', () => {
  const { PAGES } = require('../frontend-src/settings-form');
  const src = sourceOf(/\n {2}function fieldHtml\(field\) \{[\s\S]*?\n {2}\}\n/, 'fieldHtml');
  const field = PAGES.flatMap(p => p.fields).find(f => f.type === 'choice');
  assert.ok(field, 'поля-выпадашки в PAGES нет — тест сторожит не то');

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
  assert.match(known, /<option value="80" selected>/);
  assert.strictEqual((known.match(/<option/g) || []).length, field.options.length,
    'известное значение лишнего пункта не заводит');

  const handmade = html(70);
  assert.match(handmade, /<option value="70" selected>70% of screen<\/option>/);
  assert.strictEqual((handmade.match(/<option/g) || []).length, field.options.length + 1);
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
