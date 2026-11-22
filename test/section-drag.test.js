// Перетаскивание заголовков секций: помощники страницы и придержанный такт.
//
// Проверяется настоящий код sessions.html, вычитанный и исполненный в vm, —
// тем же приёмом, что saveUi в row-contract.test.js и ветки открытия в
// hide-before-request.test.js. Копия разъехалась бы молча, а сторож остался
// бы зелёным.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
// Перестановка ключа живёт в picker-sections.js (moveBlockKey): блок типов
// проекта переносится там одним ключом `live`, а без типов правило прежнее.
const { moveBlockKey } = require('../frontend-src/picker-sections');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

/**
 * Прогнать чистый помощник страницы.
 *
 * Массив раскладывается в свой: у значений из vm-контекста другие прототипы, и
 * deepStrictEqual сравнивает в том числе их.
 */
function run(names, expr, ctx = {}) {
  vm.createContext(ctx);
  vm.runInContext(`${names.map(sourceOf).join('\n')}\nresult = ${expr};`, ctx,
    { filename: 'sessions.html' });
  return Array.isArray(ctx.result) ? [...ctx.result] : ctx.result;
}

// ── moveBlockKey: перестановка ключа по номеру из видимого списка ───────────

test('перенос вниз считается по списку, где секция ещё на месте', () => {
  // Номер приходит из видимого списка, в котором перетаскиваемая секция
  // стоит на своём месте. Убери её раньше, чем поправлен номер, — и всякий
  // перенос вниз промахивался бы ровно на единицу.
  const keys = ['live', 'remote', 'past', 'projects'];
  assert.deepStrictEqual(moveBlockKey(keys, 'live', 2),
    ['remote', 'live', 'past', 'projects']);
  assert.deepStrictEqual(moveBlockKey(keys, 'live', 4),
    ['remote', 'past', 'projects', 'live']);
});

test('перенос вверх номера не сдвигает', () => {
  const keys = ['live', 'remote', 'past'];
  assert.deepStrictEqual(moveBlockKey(keys, 'past', 0),
    ['past', 'live', 'remote']);
  assert.deepStrictEqual(moveBlockKey(keys, 'past', 1),
    ['live', 'past', 'remote']);
});

test('перенос на своё же место ничего не меняет', () => {
  // Иначе дрогнувшая рука тасовала бы список без просьбы.
  const keys = ['live', 'remote', 'past'];
  assert.deepStrictEqual(moveBlockKey(keys, 'remote', 1), keys);
  assert.deepStrictEqual(moveBlockKey(keys, 'remote', 2), keys);
});

test('номер за краями списка упирается в края', () => {
  const keys = ['live', 'remote'];
  assert.deepStrictEqual(moveBlockKey(keys, 'live', 99),
    ['remote', 'live']);
  assert.deepStrictEqual(moveBlockKey(keys, 'remote', -5),
    ['remote', 'live']);
});

test('незнакомый ключ добавляется, а не теряется', () => {
  // Секция, которой ещё нет в сохранённом порядке, — обычное дело: порядок
  // пишется только по видимому списку.
  assert.deepStrictEqual(moveBlockKey(['live'], 'past', 0), ['past', 'live']);
});

// ── dropIndexOf: позиция вставки по указателю ──────────────────────────────

/** Заголовки как их видит dropIndexOf: только getBoundingClientRect. */
function headers(tops) {
  return tops.map(top => ({ getBoundingClientRect: () => ({ top, height: 20 }) }));
}

test('позиция вставки — это число заголовков выше указателя', () => {
  const ctx = { nodes: headers([0, 100, 200]) };
  // Выше первого — в самое начало.
  assert.strictEqual(run(['dropIndexOf'], 'dropIndexOf(nodes, 5)', { ...ctx }), 0);
  // Через середину первого — уже за ним.
  assert.strictEqual(run(['dropIndexOf'], 'dropIndexOf(nodes, 15)', { ...ctx }), 1);
  assert.strictEqual(run(['dropIndexOf'], 'dropIndexOf(nodes, 115)', { ...ctx }), 2);
  // Ниже всех — в конец.
  assert.strictEqual(run(['dropIndexOf'], 'dropIndexOf(nodes, 999)', { ...ctx }), 3);
});

test('пустой список даёт нулевую позицию, а не падение', () => {
  assert.strictEqual(run(['dropIndexOf'], 'dropIndexOf([], 42)', {}), 0);
});

// ── такт придерживается на время перетаскивания ────────────────────────────

test('ответ агрегатора придерживается, пока тащат заголовок', () => {
  // Подача тикает раз в секунду, planListSync правит изменившиеся элементы —
  // перетаскиваемый узел подменился бы под указателем прямо в движении. В
  // широкой раскладке вдобавок пересобрался бы каркас блоков целиком, а это
  // обязано случиться после отпускания, а не во время.
  const source = SESSIONS_HTML.match(/\n {2}function applyState\(payload\) \{\n([\s\S]*?)\n {4}const state/);
  assert.ok(source, 'applyState не найдена в sessions.html — тест сторожит не то');
  assert.ok(/if \(drag\) \{ heldState = payload; return; \}/.test(source[1]),
    'applyState не придерживает ответ на время перетаскивания');
});

test('придержанный ответ применяется после отпускания', () => {
  // Иначе список замирал бы навсегда: такт придержан, а применить придержанное
  // некому.
  const source = sourceOf('endDrag');
  assert.ok(/heldState = null;[\s\S]*applyState\(payload\)/.test(source),
    'endDrag не применяет придержанный ответ');
});

test('клик после настоящего перетаскивания не сворачивает секцию', () => {
  // Клик приходит следом за pointerup, и без этой развилки перенос заодно
  // сворачивал бы перенесённую секцию.
  assert.ok(/if \(suppressClick\) \{ suppressClick = false; return; \}/.test(SESSIONS_HTML),
    'клик после перетаскивания не гасится');
});

test('перетаскивание своё, а не HTML5 drag-and-drop', () => {
  // У вебвью Tauri dragDropEnabled по умолчанию true, и системный обработчик
  // файлового перетаскивания съедает события страницы на Windows.
  for (const evt of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(SESSIONS_HTML.includes(`list.addEventListener('${evt}'`), `нет обработчика ${evt}`);
  }
  assert.ok(/setPointerCapture/.test(SESSIONS_HTML), 'нет захвата указателя');
  assert.ok(!/addEventListener\('dragstart'/.test(SESSIONS_HTML),
    'заведён HTML5 drag-and-drop — на Windows он не работает');
});

test('порог перетаскивания есть, иначе клик станет переносом', () => {
  // Без порога любой клик по заголовку становился бы переносом на ноль
  // позиций, и свернуть секцию мышью стало бы нечем.
  assert.ok(/DRAG_THRESHOLD = \d+/.test(SESSIONS_HTML), 'порога нет');
});

// ── commitDrag: блок типов проекта переносится ключом live ─────────────────

function commitWith(ctx) {
  const PickerSections = require('../frontend-src/picker-sections');
  let saved = 0;
  const full = { window: { PickerSections }, saveUi: () => { saved++; }, ...ctx };
  vm.createContext(full);
  vm.runInContext(`${sourceOf('commitDrag')}\ncommitDrag(0, 0);`, full, { filename: 'sessions.html' });
  return { order: JSON.parse(JSON.stringify(full.order)), saved };
}

test('узкая: перенос типовой секции пишет в порядок live, а не type:*', () => {
  const headers = ['type:work', 'type:home', 'type:untyped', 'nowindow', 'past', 'projects'].map(key => ({ key }));
  const { order, saved } = commitWith({
    fullscreen: false, drag: { key: 'type:home' }, order: { narrow: [], wide: [] },
    narrowHeaders: () => headers, sectionKeyOf: n => n.key, dropIndexOf: () => 5,
  });
  assert.deepStrictEqual(order.narrow, ['nowindow', 'past', 'live', 'projects']);
  assert.strictEqual(saved, 1);
});

test('широкая: блок типов уезжает в другую колонку ключом live, из прежней вынут', () => {
  const { order } = commitWith({
    fullscreen: true, drag: { key: 'type:work' }, order: { narrow: [], wide: [['live', 'past'], ['projects']] },
    wideDropTarget: () => ({ column: 2, at: 1, keys: ['projects'] }),
  });
  assert.deepStrictEqual(order.wide, [['past'], ['projects', 'live']]);
});

// ── wideColumnHtml: блок типов — одна обёртка с одним скроллом ─────────────

test('типовые секции подряд — в одной .block-stack, прочие блоки — сами по себе', () => {
  const column = [
    { key: 'type:work', typeBlock: true, collapsed: false },
    { key: 'type:home', typeBlock: true, collapsed: true },
    { key: 'nowindow', collapsed: false },
    { key: 'past', collapsed: false },
  ];
  const escapeHtml = s => String(s);
  const html = run(['blockCellHtml', 'wideColumnHtml'], `wideColumnHtml(${JSON.stringify(column)})`, { escapeHtml });
  assert.strictEqual(html,
    '<div class="block-stack">'
    + '<div class="block" data-block="type:work"><div class="block-rows"></div></div>'
    + '<div class="block collapsed" data-block="type:home"><div class="block-rows"></div></div>'
    + '</div>'
    + '<div class="block" data-block="nowindow"><div class="block-rows"></div></div>'
    + '<div class="block" data-block="past"><div class="block-rows"></div></div>');
  // Без типовых секций разметка прежняя: блок на секцию, обёртки нет.
  const plain = run(['blockCellHtml', 'wideColumnHtml'], `wideColumnHtml(${JSON.stringify(column.slice(2))})`, { escapeHtml });
  assert.ok(!plain.includes('block-stack'), plain);
});
