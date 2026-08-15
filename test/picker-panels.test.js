const { test } = require('node:test');
const assert = require('node:assert');
const { KNOWN_PANELS, panelRows, withColumn, columnOf, labelForUnknown } =
  require('../frontend-src/picker-panels');
const { normalizeUiState } = require('../frontend-src/ui-state');

const EMPTY = normalizeUiState({}, { toggles: {} });

function ui(raw) {
  return normalizeUiState(raw, { toggles: {} });
}

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
