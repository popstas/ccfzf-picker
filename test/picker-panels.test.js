const { test } = require('node:test');
const assert = require('node:assert');
const {
  KNOWN_PANELS, knownPanelsFor, panelRows, withColumn, columnOf, labelForUnknown,
  defaultCollapsedFor,
} = require('../frontend-src/picker-panels');
const { normalizeUiState } = require('../frontend-src/ui-state');
const { buildSections } = require('../frontend-src/picker-sections');

const EMPTY = normalizeUiState({}, { toggles: {} });

function ui(raw) {
  return normalizeUiState(raw, { toggles: {} });
}

// ── узкий список ────────────────────────────────────────────────────────────

test('в узком списке нет строки «Remote sessions»', () => {
  // Постоянный ключ `remote` заводит только широкая раскладка: там чужие
  // группы склеиваются в один блок, потому что блок занимает колонку. В узком
  // каждая машина идёт своим `remote:<host>`, и строка `remote` предлагала бы
  // настройку панели, которой на экране не бывает.
  const keys = panelRows(EMPTY, 'narrow').map(r => r.key);
  assert.deepStrictEqual(keys, ['live', 'past', 'zellij', 'projects', 'snapshots']);
  assert.deepStrictEqual(knownPanelsFor('narrow').map(p => p.key), keys);
  // А в широком — есть, и список там прежний.
  assert.deepStrictEqual(knownPanelsFor('wide').map(p => p.key),
    KNOWN_PANELS.map(p => p.key));
});

test('у узкой строки нет колонки вовсе, а не ноль', () => {
  // Ноль значит «колонка по умолчанию», то есть обещал бы выбор; колонок в
  // узком списке нет, и обещать нечего.
  for (const row of panelRows(EMPTY, 'narrow')) {
    assert.ok(!('column' in row), `${row.key}: ${JSON.stringify(row)}`);
  }
  assert.strictEqual(panelRows(EMPTY, 'wide')[0].column, 0);
});

test('узкие половинки ui.json читаются, а широкие в них не подмешиваются', () => {
  const state = ui({
    collapsed: { narrow: { live: true }, wide: { projects: true } },
    hidden: { narrow: { snapshots: true }, wide: { zellij: true } },
  });
  const rows = panelRows(state, 'narrow');
  const at = (key) => rows.find(r => r.key === key);
  assert.strictEqual(at('live').collapsed, true);
  assert.strictEqual(at('snapshots').hidden, true);
  // Спрятанное в широком режиме про узкий не говорит ничего.
  assert.strictEqual(at('zellij').hidden, false);
});

test('машина попадает в узкий список, только если её уже трогали', () => {
  // Цена выбранного устройства, и она известна: набор узких панелей зависит
  // от того, что приехало от агрегатора, а окно настроек ответа не видит.
  // Ключи берутся из ui.json — значит, спрятать машину можно после того, как
  // её хоть раз свернули или перетащили в пикере.
  assert.ok(!panelRows(EMPTY, 'narrow').some(r => r.key.startsWith('remote:')));
  const state = ui({ order: { narrow: ['remote:alpha-host', 'live'] } });
  const row = panelRows(state, 'narrow').find(r => r.key === 'remote:alpha-host');
  assert.ok(row, 'машины из узкого порядка нет в списке');
  assert.strictEqual(row.label, 'Remote: alpha-host');
  // Узкий порядок — плоский список ключей, широкий — список колонок; разбор
  // half'ов один, и на плоском он не должен спотыкаться.
  assert.ok(!panelRows(state, 'wide').some(r => r.key === 'remote:alpha-host'));
});

test('умолчание свёрнутости в узком списке — не «развёрнута»', () => {
  // История оттесняет вниз то, что работает сейчас, а проекты и снимки —
  // справочники: все три приходят свёрнутыми. Нарисуй окно настроек галку
  // «expanded» без оглядки на это, и она врала бы про три строки из пяти.
  const rows = panelRows(EMPTY, 'narrow');
  const collapsed = rows.filter(r => r.collapsed).map(r => r.key);
  assert.deepStrictEqual(collapsed, ['past', 'projects', 'snapshots']);
  // В широком у каждой своя колонка, и оттеснять там некого.
  assert.deepStrictEqual(panelRows(EMPTY, 'wide').filter(r => r.collapsed), []);
});

test('умолчание свёрнутости совпадает с тем, по которому живёт пикер', () => {
  // Считается оно тут от ключа, а в picker-sections.js — от собранной секции:
  // секций окно настроек не видит. Второй источник правды неизбежен, поэтому
  // он сверяется явно — разойдись они, галка показывала бы одно, а пикер
  // рисовал другое, и поймать это можно было бы только глазами.
  const groups = [
    { key: 'live', label: 'Active sessions', sessions: [], remote: false },
    { key: 'remote:alpha-host', label: 'Active on alpha-host', sessions: [], remote: true, host: 'alpha-host' },
    { key: 'past', label: 'Not running', past: true, sessions: [] },
    { key: 'past:2', label: 'Not running - desktop 2', past: true, sessions: [] },
    { key: 'zellij', label: 'Zellij', sessions: [] },
  ];
  for (const layout of ['narrow', 'wide']) {
    const sections = buildSections({
      groups, projects: [{ id: 'p1', kind: 'project', label: 'x', cwd: '/x' }],
      snapshots: [{ key: 'sn:1', kind: 'snapshot', label: 'w', total: 1 }],
      mode: 'sessions', query: '', trackerHere: true, collapsed: {}, layout,
    });
    assert.ok(sections.length >= 5, `${layout}: секций мало`);
    for (const section of sections) {
      assert.strictEqual(section.collapsed, defaultCollapsedFor(section.key, layout),
        `${layout}/${section.key}`);
    }
  }
});

test('в списке есть все известные панели, даже пустые сейчас', () => {
  // Пустая история не повод прятать её настройку: спрятанную панель иначе
  // нечем было бы вернуть.
  const keys = panelRows(EMPTY).map(r => r.key);
  assert.deepStrictEqual(keys, KNOWN_PANELS.map(p => p.key));
  assert.ok(keys.includes('past'), keys.join(' '));
  assert.ok(keys.includes('snapshots'), keys.join(' '));
});

test('нетронутая панель показана с умолчаниями', () => {
  const row = panelRows(EMPTY).find(r => r.key === 'past');
  // Ноль — «как по умолчанию», а не первая колонка: подставь окно единицу, и
  // все панели съехали бы в первую колонку записью в файл, которой человек
  // не делал.
  assert.strictEqual(row.column, 0);
  assert.strictEqual(row.collapsed, false);
  assert.strictEqual(row.hidden, false);
});

test('назначенная колонка и состояния читаются обратно', () => {
  const state = ui({
    order: { wide: [['past'], [], []] },
    collapsed: { wide: { past: true } },
    hidden: { wide: { snapshots: true } },
  });
  const rows = panelRows(state);
  const past = rows.find(r => r.key === 'past');
  assert.strictEqual(past.column, 1);
  assert.strictEqual(past.collapsed, true);
  assert.strictEqual(past.hidden, false);
  assert.strictEqual(rows.find(r => r.key === 'snapshots').hidden, true);
});

test('незнакомые ключи из файла показаны под понятным именем', () => {
  // История умеет делиться по рабочим столам, а чужие машины в узком списке
  // идут своими ключами. Промолчать о них значило бы показать список, из
  // которого не видно, откуда взялась настройка.
  const state = ui({ hidden: { wide: { 'past:2': true, 'remote:mac-host': true } } });
  const rows = panelRows(state);
  const desktop = rows.find(r => r.key === 'past:2');
  assert.ok(desktop, rows.map(r => r.key).join(' '));
  assert.strictEqual(desktop.label, 'Not running: desktop 2');
  assert.strictEqual(rows.find(r => r.key === 'remote:mac-host').label, 'Remote: mac-host');
  // И идут они после известных, а не вперемешку.
  assert.ok(rows.findIndex(r => r.key === 'past:2') >= KNOWN_PANELS.length);
});

test('незнакомый ключ без разбора остаётся собой', () => {
  assert.strictEqual(labelForUnknown('что-то'), 'что-то');
});

test('перестановка в колонку вынимает ключ из прежней', () => {
  // Секция одна, и в двух колонках сразу стоять не может.
  const order = withColumn({ narrow: [], wide: [['past'], [], []] }, 'past', 3);
  assert.deepStrictEqual(order.wide, [[], [], ['past']]);
});

test('колонка ноль возвращает панель к умолчанию', () => {
  // Ключ уходит из порядка вовсе, и колонку снова назначает смысл секции.
  // Без этого выбор «по умолчанию» в окне настроек нечем было бы выразить.
  const order = withColumn({ narrow: [], wide: [[], ['past'], []] }, 'past', 0);
  assert.deepStrictEqual(order.wide, [[], [], []]);
  assert.strictEqual(columnOf({ order }, 'past'), 0);
});

test('внутри колонки панель встаёт в конец', () => {
  // Место внутри колонки задаётся перетаскиванием, и подставлять сюда номер
  // значило бы решать за человека то, о чём он не спрашивал.
  const order = withColumn({ narrow: [], wide: [[], ['remote', 'projects'], []] }, 'past', 2);
  assert.deepStrictEqual(order.wide[1], ['remote', 'projects', 'past']);
});

test('соседние колонки перестановка не трогает', () => {
  const order = withColumn(
    { narrow: ['live'], wide: [['live'], ['remote'], ['snapshots']] }, 'past', 1);
  assert.deepStrictEqual(order.wide, [['live', 'past'], ['remote'], ['snapshots']]);
  // Узкая половинка — не её дело: вкладка правит только широкий режим.
  assert.deepStrictEqual(order.narrow, ['live']);
});

test('негодный номер колонки не роняет порядок', () => {
  for (const bad of [4, -1, 'два', null, undefined, 1.5]) {
    const order = withColumn({ narrow: [], wide: [['past'], [], []] }, 'past', bad);
    assert.deepStrictEqual(order.wide, [[], [], []], String(bad));
  }
});

test('мусор вместо ui не роняет список панелей', () => {
  for (const bad of [undefined, null, 'нет', 42, { order: 'нет', hidden: 7 }]) {
    const rows = panelRows(bad);
    assert.strictEqual(rows.length, KNOWN_PANELS.length, JSON.stringify(bad));
  }
});
