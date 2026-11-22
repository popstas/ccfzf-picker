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
  // Секция, которой ещё нет в сохранённом порядке, — обычное дело: в файл
  // попадает только то, что человек когда-то двигал или видел при переносе.
  assert.deepStrictEqual(moveBlockKey(['live'], 'past', 0), ['past', 'live']);
});

// ── mergeOrder: невидимые ключи сохранённого порядка остаются на местах ────

const { mergeOrder, buildSections } = require('../frontend-src/picker-sections');

test('mergeOrder: отсутствующий ключ остаётся за своим соседом сверху', () => {
  // Сохранено [live, remote, past, projects], машины сейчас нет — на экране
  // live, past, projects. Человек поднял projects наверх.
  assert.deepStrictEqual(
    mergeOrder(['live', 'remote', 'past', 'projects'], ['projects', 'live', 'past'], 'projects'),
    ['projects', 'live', 'remote', 'past']);
});

test('mergeOrder: отсутствующий без соседа сверху встаёт в начало', () => {
  assert.deepStrictEqual(
    mergeOrder(['snapshots', 'live', 'past'], ['past', 'live'], 'past'),
    ['snapshots', 'past', 'live']);
});

test('mergeOrder: два отсутствующих подряд держатся цепочкой', () => {
  assert.deepStrictEqual(
    mergeOrder(['live', 'remote', 'snapshots', 'past', 'projects'], ['live', 'projects', 'past'], 'projects'),
    ['live', 'remote', 'snapshots', 'projects', 'past']);
});

test('mergeOrder: переносимая секция якорем не служит — сосед не уезжает следом', () => {
  // Якорем remote был бы live, и уйди live в конец — remote уехал бы за ним,
  // хотя его никто не трогал. Место remote — перед past, как и было.
  assert.deepStrictEqual(
    mergeOrder(['live', 'remote', 'past', 'projects'], ['past', 'projects', 'live'], 'live'),
    ['remote', 'past', 'projects', 'live']);
});

test('mergeOrder: без сохранённого порядка — ровно видимый', () => {
  assert.deepStrictEqual(mergeOrder([], ['past', 'live'], 'past'), ['past', 'live']);
  assert.deepStrictEqual(mergeOrder(undefined, ['past', 'live'], 'past'), ['past', 'live']);
});

test('mergeOrder: видимые ключи идут в видимом порядке, а не в сохранённом', () => {
  // Сохранённый порядок колонки может расходиться с видимым (свёрнутая
  // опущена в низ колонки) — главным для видимых остаётся то, что на экране.
  assert.deepStrictEqual(
    mergeOrder(['past', 'snapshots', 'projects'], ['projects', 'past'], 'projects'),
    ['projects', 'past', 'snapshots']);
});

test('секция, которой нет на экране, сохраняет место в order после перетаскивания соседей', () => {
  // Узкая: сохранено [live, remote, past, projects], чужой машины сейчас нет.
  // projects перетащили наверх — remote в файле остаётся между live и past.
  const headers = ['live', 'past', 'projects'].map(key => ({ key }));
  const narrow = commitWith({
    fullscreen: false, drag: { key: 'projects' },
    order: { narrow: ['live', 'remote', 'past', 'projects'], wide: [] },
    narrowHeaders: () => headers, sectionKeyOf: n => n.key, dropIndexOf: () => 0,
  });
  assert.deepStrictEqual(narrow.order.narrow, ['projects', 'live', 'remote', 'past']);

  // Широкая: во второй колонке сохранено [remote, projects], машины нет —
  // видна только projects. В колонку перетащили past над projects.
  const wide = commitWith({
    fullscreen: true, drag: { key: 'past' },
    order: { narrow: [], wide: [['live'], ['remote', 'projects'], ['past', 'snapshots']] },
    wideDropTarget: () => ({ column: 2, at: 0, keys: ['projects'] }),
  });
  assert.deepStrictEqual(wide.order.wide, [['live'], ['remote', 'past', 'projects'], ['snapshots']]);
});

test('вернувшаяся секция встаёт на прежнее место, а не в конец', () => {
  // Круговая проверка: слитый порядок отдаётся настоящей сборке секций, и
  // вернувшаяся машина встаёт между live и past, как стояла до своего ухода.
  const headers = ['live', 'past', 'projects'].map(key => ({ key }));
  const { order } = commitWith({
    fullscreen: false, drag: { key: 'projects' },
    order: { narrow: ['live', 'remote', 'past', 'projects'], wide: [] },
    narrowHeaders: () => headers, sectionKeyOf: n => n.key, dropIndexOf: () => 0,
  });
  const session = id => ({ id, label: id, cwd: `/home/user/${id}`, live: true });
  const groups = [
    { key: 'live', label: 'Active local sessions', sessions: [session('a')], remote: false },
    { key: 'remote:box-host', label: 'Active on box-host', sessions: [session('b')], remote: true, host: 'box-host' },
    { key: 'past', label: 'History', past: true, sessions: [{ ...session('c'), live: false }] },
  ];
  const sections = buildSections({
    groups, projects: [{ id: 'p', kind: 'project', label: 'p', cwd: '/home/user/p' }],
    snapshots: [], mode: 'sessions', query: '', trackerHere: true, collapsed: {},
    hidden: { snapshots: true }, layout: 'narrow', order: order.narrow,
  });
  assert.deepStrictEqual(sections.map(s => s.key), ['projects', 'live', 'remote', 'past']);
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

// ── typeDrop: перенос типовой секции внутри блока меняет порядок типов ─────

test('typeDrop: внутри блока — новый порядок имён типов', () => {
  const { typeDrop } = require('../frontend-src/picker-sections');
  const keys = ['projects', 'type:work', 'type:home', 'type:untyped', 'past'];
  // home на место work (позиция 1 — над первой типовой).
  assert.deepStrictEqual(typeDrop(keys, 'type:home', 1), ['home', 'work', 'untyped']);
  // work за последнюю типовую (позиция 4 — сразу под блоком).
  assert.deepStrictEqual(typeDrop(keys, 'type:work', 4), ['home', 'untyped', 'work']);
});

test('typeDrop: вне блока и для нетиповой секции — null, переносится блок', () => {
  const { typeDrop } = require('../frontend-src/picker-sections');
  const keys = ['projects', 'type:work', 'type:home', 'past'];
  assert.strictEqual(typeDrop(keys, 'type:home', 0), null);
  assert.strictEqual(typeDrop(keys, 'type:home', 4), null);
  assert.strictEqual(typeDrop(keys, 'past', 2), null);
  // Колонка без блока (широкая, перенос в соседнюю) — тоже блок.
  assert.strictEqual(typeDrop(['projects'], 'type:home', 0), null);
});

test('узкая: перенос типовой внутри блока пишет order.types, а narrow не трогает', () => {
  const headers = ['type:work', 'type:home', 'type:untyped', 'past'].map(key => ({ key }));
  const { order, saved } = commitWith({
    fullscreen: false, drag: { key: 'type:home' }, order: { narrow: ['live', 'past'], wide: [], types: [] },
    narrowHeaders: () => headers, sectionKeyOf: n => n.key, dropIndexOf: () => 0,
  });
  assert.deepStrictEqual(order.types, ['home', 'work', 'untyped']);
  assert.deepStrictEqual(order.narrow, ['live', 'past']);
  assert.strictEqual(saved, 1);
});

test('широкая: перенос внутри блока своей колонки пишет order.types, колонки не трогает', () => {
  const { order } = commitWith({
    fullscreen: true, drag: { key: 'type:untyped' },
    order: { narrow: [], wide: [['live', 'past'], ['projects']], types: ['work', 'home', 'untyped', 'gone'] },
    wideDropTarget: () => ({ column: 1, at: 0, keys: ['type:work', 'type:home', 'type:untyped', 'past'] }),
  });
  // Отсутствующий сейчас `gone` остаётся за своим соседом (mergeOrder).
  assert.deepStrictEqual(order.types, ['untyped', 'work', 'home', 'gone']);
  assert.deepStrictEqual(order.wide, [['live', 'past'], ['projects']]);
});

function endDragWith(ctx) {
  const calls = [];
  const full = {
    dropLine: { classList: { remove: () => {} } }, clearDropZones: () => {},
    applyState: () => calls.push('applyState'), regroup: () => calls.push('regroup'),
    render: () => calls.push('render'), heldState: null, ...ctx,
  };
  vm.createContext(full);
  vm.runInContext(`${sourceOf('endDrag')}\nendDrag();`, full, { filename: 'sessions.html' });
  return calls;
}

test('после переноса внутри блока список перегруппировывается, а не только перерисовывается', () => {
  // Порядок типов решает groupSessions — одна перерисовка показала бы старый.
  assert.deepStrictEqual(endDragWith({ drag: { moved: true, regroup: true } }), ['regroup']);
});

test('перегруппировка после переноса типа — и когда такт был придержан', () => {
  // Перенос длится дольше секунды, такт почти всегда придержан. applyState
  // доходит до regroup не на всяком ответе (отказ, кривая форма) — поэтому
  // endDrag зовёт его сам.
  assert.deepStrictEqual(endDragWith({ drag: { moved: true, regroup: true }, heldState: { state: null } }),
    ['applyState', 'regroup']);
  // Обычный перенос без типов — прежнее поведение.
  assert.deepStrictEqual(endDragWith({ drag: { moved: true }, heldState: { state: null } }), ['applyState']);
  assert.deepStrictEqual(endDragWith({ drag: { moved: true } }), ['render']);
});
