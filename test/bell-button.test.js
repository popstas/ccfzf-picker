// Кнопка звука звонка WezTerm в статуслайне: три режима по кругу.
//
// Режим живёт в флаг-файлах (`~/.wezterm-bell-off`, `~/.wezterm-bell-children-off`,
// src-tauri/src/wezterm_bell.rs), и страница обязана красить кнопку по ответу
// Rust, а не по собственной догадке: переверни она копию сама — и после того,
// как человек снял файл руками, кнопка врала бы.
//
// Проверяется настоящий код страницы: функции вычитываются из sessions.html и
// исполняются в vm — тем же приёмом, что и в wide-button.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

/** Кнопка-заглушка: ровно те поля, что трогает paintToggles. */
function fakeButton() {
  const classes = new Set();
  return {
    hidden: true,
    title: '',
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
  };
}

const PAGE_FUNCTIONS = ['bellModeOf', 'nextBellMode', 'refreshBell', 'toggleBell', 'paintToggles'];

/**
 * Прогнать названную функцию страницы.
 * `answer` — что ответит Rust на любую команду.
 */
async function run(fn, { bellMode = null, answer } = {}) {
  const calls = [];
  const ctx = {
    bellMode,
    bellButton: fakeButton(),
    wideButton: fakeButton(),
    treeButton: fakeButton(),
    menuHint: { textContent: '' },
    toggleInputs: new Map(),
    toggles: {},
    fullscreen: false,
    tree: false,
    error: '',
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(answer); },
    render: () => { calls.push(['render']); },
  };
  vm.createContext(ctx);
  vm.runInContext(PAGE_FUNCTIONS.map(sourceOf).join('\n'), ctx, { filename: 'sessions.html' });
  await vm.runInContext(`${fn}()`, ctx);
  return { ctx, calls, names: calls.map(c => c[0]) };
}

/** Кнопка после ответа Rust `mode` на чтение. */
async function painted(mode) {
  return (await run('refreshBell', { answer: mode })).ctx.bellButton;
}

test('клик идёт по кругу all → noChildren → off → all', async () => {
  for (const [from, to] of [['all', 'noChildren'], ['noChildren', 'off'], ['off', 'all']]) {
    const { calls } = await run('toggleBell', { bellMode: from, answer: to });
    const call = calls.find(c => c[0] === 'set_wezterm_bell');
    assert.ok(call, `set_wezterm_bell не позван из ${from}`);
    assert.deepStrictEqual({ ...call[1] }, { mode: to }, `из ${from} попросили не тот режим`);
  }
});

test('состояние берётся из ответа Rust, а не из просьбы', async () => {
  // Просили noChildren, а на диске вышло all (флаг не лёг или снят тут же):
  // кнопка обязана показать то, что есть.
  const { ctx } = await run('toggleBell', { bellMode: 'all', answer: 'all' });
  assert.strictEqual(ctx.bellMode, 'all');
  assert.ok(!ctx.bellButton.classList.contains('children-off'), 'кнопка показала режим, которого нет на диске');
});

test('all: обе волны, подсветка, подпись называет режим и следующий шаг', async () => {
  const b = await painted('all');
  assert.strictEqual(b.hidden, false);
  assert.ok(b.classList.contains('on'));
  assert.ok(!b.classList.contains('children-off'));
  assert.ok(!b.classList.contains('muted'));
  assert.match(b.title, /all sessions/);
  assert.match(b.title, /click to mute child sessions/);
});

test('noChildren: одна волна, подсветка остаётся — звук ещё есть', async () => {
  const b = await painted('noChildren');
  assert.strictEqual(b.hidden, false);
  assert.ok(b.classList.contains('on'), 'звонят обычные сессии — кнопка не должна выглядеть выключенной');
  assert.ok(b.classList.contains('children-off'));
  assert.ok(!b.classList.contains('muted'));
  assert.match(b.title, /child sessions muted/);
  assert.match(b.title, /click to mute all/);
});

test('off: перечёркнутый рисунок, без подсветки, подпись с состоянием', async () => {
  const b = await painted('off');
  assert.strictEqual(b.hidden, false);
  assert.ok(b.classList.contains('muted'));
  assert.ok(!b.classList.contains('on'));
  assert.ok(!b.classList.contains('children-off'));
  assert.match(b.title, /off/);
  assert.match(b.title, /click to turn on/);
});

test('у трёх режимов три разные подписи', async () => {
  const titles = new Set();
  for (const mode of ['all', 'noChildren', 'off']) titles.add((await painted(mode)).title);
  assert.strictEqual(titles.size, 3);
});

test('нет выключателя на машине или непонятный ответ — кнопка скрыта', async () => {
  // Rust вне Windows отвечает null; без Tauri invoke отвечает undefined;
  // прежний бинарь отвечал булевым — его слов страница уже не знает.
  for (const answer of [null, undefined, true, false, 'on', 'children']) {
    const { ctx } = await run('refreshBell', { bellMode: 'all', answer });
    assert.strictEqual(ctx.bellMode, null, `ответ ${answer} принят за режим`);
    assert.strictEqual(ctx.bellButton.hidden, true, `кнопка видна при ответе ${answer}`);
  }
});

test('скрытая кнопка ничего не шлёт', async () => {
  const { names } = await run('toggleBell', { bellMode: null, answer: 'all' });
  assert.ok(!names.includes('set_wezterm_bell'), 'выключатель позван там, где его нет');
});

test('чтение спрашивает Rust и красит кнопку', async () => {
  const { ctx, names } = await run('refreshBell', { bellMode: null, answer: 'off' });
  assert.ok(names.includes('wezterm_bell'));
  assert.strictEqual(ctx.bellButton.hidden, false);
  assert.ok(ctx.bellButton.classList.contains('muted'));
});

test('отказ Rust уходит в строку ошибки', async () => {
  const ctx = {
    bellMode: 'all', error: '',
    invoke: () => Promise.reject(new Error('cannot write')),
    render: () => {},
    paintToggles: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(['nextBellMode', 'bellModeOf', 'toggleBell'].map(sourceOf).join('\n'), ctx);
  await vm.runInContext('toggleBell()', ctx);
  assert.match(ctx.error, /cannot write/);
  assert.strictEqual(ctx.bellMode, 'all', 'состояние сменилось при отказе');
});

test('рисунок: дальняя волна отдельной линией, гаснет в noChildren', () => {
  // Глиф — инлайн-SVG, не символ шрифта: квадратика-заглушки быть не может.
  assert.match(SESSIONS_HTML, /<path class="bell-on bell-near" d="[^"]+"\/>/, 'ближней волны нет');
  assert.match(SESSIONS_HTML, /<path class="bell-on bell-far" d="[^"]+"\/>/, 'дальней волны нет');
  assert.match(SESSIONS_HTML, /#bell-button\.children-off \.bell-far \{ display: none; \}/,
    'в noChildren рисунок не отличается от all');
});

test('состояние перечитывается на старте и на каждом показе', () => {
  assert.match(SESSIONS_HTML, /function beginShow\(\) \{[\s\S]*?refreshBell\(\);[\s\S]*?\n {2}\}\n/,
    'beginShow не перечитывает флаг — кнопка врёт после правки файла руками');
  assert.match(SESSIONS_HTML, /async function start\(\) \{[\s\S]*?paintToggles\(\);\s*refreshBell\(\);/,
    'start не читает флаг');
  assert.match(SESSIONS_HTML, /bellButton\.addEventListener\('click'[\s\S]{0,200}?toggleBell\(\)/,
    'кнопка не зовёт toggleBell');
});

test('кнопка стоит между ? и широким режимом и скрыта в разметке', () => {
  const keys = SESSIONS_HTML.indexOf('<span id="keys-button"');
  const bell = SESSIONS_HTML.indexOf('<span id="bell-button"');
  const wide = SESSIONS_HTML.indexOf('<span id="wide-button"');
  assert.ok(keys > 0 && keys < bell && bell < wide, 'кнопка звука не между ? и ⛶');
  assert.match(SESSIONS_HTML, /<span id="bell-button" class="icon-button" hidden>/,
    'до ответа Rust кнопка видна — на маке мигнула бы и пропала');
});
