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
