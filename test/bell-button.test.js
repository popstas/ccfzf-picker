// Кнопка звука звонка WezTerm в статуслайне.
//
// Состояние живёт в флаг-файле (`~/.wezterm-bell-off`, src-tauri/src/wezterm_bell.rs),
// и страница обязана красить кнопку по ответу Rust, а не по собственной
// догадке: переверни она копию сама — и после того, как человек снял файл
// руками, кнопка врала бы ровно наоборот.
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

/**
 * Прогнать названную функцию страницы.
 * `answer` — что ответит Rust на любую команду.
 */
async function run(fn, { bellMuted = null, answer } = {}) {
  const calls = [];
  const ctx = {
    bellMuted,
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
  const code = ['refreshBell', 'toggleBell', 'paintToggles'].map(sourceOf).join('\n');
  vm.runInContext(code, ctx, { filename: 'sessions.html' });
  await vm.runInContext(`${fn}()`, ctx);
  return { ctx, calls, names: calls.map(c => c[0]) };
}

test('клик просит обратное текущему', async () => {
  const off = await run('toggleBell', { bellMuted: false, answer: true });
  const call = off.calls.find(c => c[0] === 'set_wezterm_bell');
  assert.ok(call, 'set_wezterm_bell не позван');
  assert.strictEqual(call[1].muted, true);
  const on = await run('toggleBell', { bellMuted: true, answer: false });
  assert.strictEqual(on.calls.find(c => c[0] === 'set_wezterm_bell')[1].muted, false);
});

test('состояние берётся из ответа Rust, а не из просьбы', async () => {
  // Просили выключить, а на диске флаг не лёг (или лёг и тут же снят):
  // кнопка обязана показать то, что есть, — звук включён.
  const { ctx } = await run('toggleBell', { bellMuted: false, answer: false });
  assert.strictEqual(ctx.bellMuted, false);
  assert.ok(ctx.bellButton.classList.contains('on'), 'кнопка погасла, хотя звук остался');
  assert.ok(!ctx.bellButton.classList.contains('muted'));
});

test('выключенный звук: перечёркнутый рисунок, без подсветки, подпись с состоянием', async () => {
  const { ctx } = await run('toggleBell', { bellMuted: false, answer: true });
  assert.strictEqual(ctx.bellButton.hidden, false);
  assert.ok(ctx.bellButton.classList.contains('muted'));
  assert.ok(!ctx.bellButton.classList.contains('on'));
  assert.match(ctx.bellButton.title, /off/);
});

test('нет выключателя на машине — кнопка скрыта', async () => {
  // Rust вне Windows отвечает null; без Tauri invoke отвечает undefined.
  for (const answer of [null, undefined]) {
    const { ctx } = await run('refreshBell', { bellMuted: false, answer });
    assert.strictEqual(ctx.bellMuted, null);
    assert.strictEqual(ctx.bellButton.hidden, true, `кнопка видна при ответе ${answer}`);
  }
});

test('скрытая кнопка ничего не шлёт', async () => {
  const { names } = await run('toggleBell', { bellMuted: null, answer: true });
  assert.ok(!names.includes('set_wezterm_bell'), 'выключатель позван там, где его нет');
});

test('чтение спрашивает Rust и красит кнопку', async () => {
  const { ctx, names } = await run('refreshBell', { bellMuted: null, answer: true });
  assert.ok(names.includes('wezterm_bell'));
  assert.strictEqual(ctx.bellButton.hidden, false);
  assert.ok(ctx.bellButton.classList.contains('muted'));
});

test('отказ Rust уходит в строку ошибки', async () => {
  const ctx = {
    bellMuted: false, error: '',
    invoke: () => Promise.reject(new Error('cannot write')),
    render: () => {},
    paintToggles: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceOf('toggleBell'), ctx);
  await vm.runInContext('toggleBell()', ctx);
  assert.match(ctx.error, /cannot write/);
  assert.strictEqual(ctx.bellMuted, false, 'состояние сменилось при отказе');
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
