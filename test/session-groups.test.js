const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeSort, cycleSort, compareSessions, groupSessions, labelSessions, SORT_MODES,
} = require('../frontend-src/session-groups');

// Имена полей — те же, что кладёт buildSessionList (см. test/row-contract.test.js).
function row(extra) {
  return Object.assign({
    id: 'a', title: 'T', label: 'T', cwd: '/home/user/x', live: false,
    agentCostUsd: 0, lastActivity: 0, agentSeen: false,
  }, extra || {});
}

/** Порядок id после сортировки режимом `mode`. */
function order(rows, mode) {
  return [...rows].sort((a, b) => compareSessions(a, b, mode)).map(s => s.id);
}

test('незнакомый режим сортировки сводится к предусмотренному', () => {
  assert.strictEqual(normalizeSort('чепуха'), 'cost');
  assert.strictEqual(normalizeSort('newest'), 'newest');
});

test('перебор режимов зациклен', () => {
  // Раньше здесь `first` не участвовал в проверке, а утверждение сравнивало
  // значение само с собой — тест не мог упасть ни при каком поведении
  // cycleSort, включая функцию, которая просто возвращает свой аргумент.
  // Проверяем настоящее свойство цикла: ровно SORT_MODES.length шагов
  // возвращают в стартовую точку, и ни один из промежуточных шагов не стоит
  // на месте.
  const first = normalizeSort();
  let mode = first;
  const seen = [mode];
  for (let i = 0; i < SORT_MODES.length; i++) {
    mode = cycleSort(mode);
    seen.push(mode);
  }
  assert.strictEqual(mode, first, 'после SORT_MODES.length шагов должны вернуться в исходный режим');
  // Ни один шаг цикла не должен стоять на месте — иначе цикл не проходит все
  // режимы за отведённое число шагов.
  for (let i = 0; i < seen.length - 1; i++) {
    assert.notStrictEqual(seen[i], seen[i + 1], `шаг ${i} не должен повторять предыдущий режим`);
  }
});

test('живые сессии идут отдельной группой впереди', () => {
  const groups = groupSessions([
    row({ id: 'dead', live: false, lastActivity: 200 }),
    row({ id: 'alive', live: true, lastActivity: 100 }),
  ], 'newest');
  assert.strictEqual(groups[0].sessions[0].id, 'alive');
});

test('пустой список даёт пустой результат', () => {
  assert.deepStrictEqual(groupSessions([], 'cost'), []);
});

test('cost: дороже — выше', () => {
  const rows = [
    row({ id: 'mid', label: 'mid', agentCostUsd: 5 }),
    row({ id: 'rich', label: 'rich', agentCostUsd: 50 }),
    row({ id: 'cheap', label: 'cheap', agentCostUsd: 1 }),
  ];
  assert.deepStrictEqual(order(rows, 'cost'), ['rich', 'mid', 'cheap']);
});

test('recent: свежее — выше', () => {
  const rows = [
    row({ id: 'old', label: 'old', lastActivity: 100 }),
    row({ id: 'fresh', label: 'fresh', lastActivity: 900 }),
    row({ id: 'mid', label: 'mid', lastActivity: 500 }),
  ];
  assert.deepStrictEqual(order(rows, 'recent'), ['fresh', 'mid', 'old']);
});

test('newest и oldest — обратные друг другу порядки по началу сессии', () => {
  const rows = [
    row({ id: 'b', label: 'b', agentStarted: 200 }),
    row({ id: 'a', label: 'a', agentStarted: 100 }),
    row({ id: 'c', label: 'c', agentStarted: 300 }),
  ];
  assert.deepStrictEqual(order(rows, 'oldest'), ['a', 'b', 'c']);
  assert.deepStrictEqual(order(rows, 'newest'), ['c', 'b', 'a']);
});

test('name: по имени, а безымянная сессия зовётся заголовком', () => {
  const rows = [
    row({ id: '3', label: 'zed' }),
    row({ id: '1', label: 'alpha' }),
    // label не проставлен — имя берётся из title (см. nameOf).
    row({ id: '2', label: undefined, title: 'beta' }),
  ];
  assert.deepStrictEqual(order(rows, 'name'), ['1', '2', '3']);
});

test('пустые и нулевые значения тонут в конец при любом направлении', () => {
  // И в убывающем cost, и в возрастающем oldest: строка без данных не должна
  // всплывать наверх только потому, что её ноль меньше всех.
  const cost = [
    row({ id: 'none', label: 'none' }),                       // поля нет вовсе
    row({ id: 'zero', label: 'zero', agentCostUsd: 0 }),
    row({ id: 'some', label: 'some', agentCostUsd: 2 }),
  ];
  assert.deepStrictEqual(order(cost, 'cost'), ['some', 'none', 'zero']);

  const oldest = [
    row({ id: 'none', label: 'none' }),
    row({ id: 'late', label: 'late', agentStarted: 900 }),
    row({ id: 'early', label: 'early', agentStarted: 100 }),
  ];
  assert.deepStrictEqual(order(oldest, 'oldest'), ['early', 'late', 'none']);
});

test('поля без источника оставляют порядок устойчивым, а не случайным', () => {
  // agentStarted не отдаёт ни одна сторона (см. row-contract.test.js): oldest и
  // newest вырождаются в общий порядок по имени и id, но остаются порядком.
  const rows = [
    row({ id: 'y', label: 'b' }),
    row({ id: 'x', label: 'a' }),
    row({ id: 'z', label: 'a' }),
  ];
  assert.deepStrictEqual(order(rows, 'oldest'), ['x', 'z', 'y']);
  assert.deepStrictEqual(order(rows, 'newest'), ['x', 'z', 'y']);
});

test('равные значения разводятся именем, а одинаковые имена — id', () => {
  const rows = [
    row({ id: 'b2', label: 'same', agentCostUsd: 7 }),
    row({ id: 'a1', label: 'same', agentCostUsd: 7 }),
    row({ id: 'c3', label: 'aaa', agentCostUsd: 7 }),
  ];
  assert.deepStrictEqual(order(rows, 'cost'), ['c3', 'a1', 'b2']);
  // Полностью одинаковые ключи — 0, и порядок остаётся исходным.
  const twins = [row({ id: 'a', label: 'x' }), row({ id: 'a', label: 'x' })];
  assert.strictEqual(compareSessions(twins[0], twins[1], 'cost'), 0);
});

test('незнакомый режим сортирует как cost, а не как попало', () => {
  const rows = [
    row({ id: 'cheap', label: 'cheap', agentCostUsd: 1 }),
    row({ id: 'rich', label: 'rich', agentCostUsd: 9 }),
  ];
  assert.deepStrictEqual(order(rows, 'чепуха'), order(rows, 'cost'));
  assert.deepStrictEqual(order(rows, undefined), ['rich', 'cheap']);
});

test('режим сортировки действует внутри каждой группы', () => {
  const groups = groupSessions([
    row({ id: 'live-cheap', label: 'live-cheap', live: true, agentCostUsd: 1 }),
    row({ id: 'live-rich', label: 'live-rich', live: true, agentCostUsd: 9 }),
    row({ id: 'dead-cheap', label: 'dead-cheap', agentCostUsd: 2 }),
    row({ id: 'dead-rich', label: 'dead-rich', agentCostUsd: 8 }),
  ], 'cost');
  assert.deepStrictEqual(groups[0].sessions.map(s => s.id), ['live-rich', 'live-cheap']);
  assert.deepStrictEqual(groups[1].sessions.map(s => s.id), ['dead-rich', 'dead-cheap']);
});

test('labelSessions даёт имя каждой строке и не трогает остальные поля', () => {
  const [out] = labelSessions([row({ id: 'a', title: 'Тема', label: undefined, agentCostUsd: 3 })]);
  assert.strictEqual(out.label, 'Тема');
  assert.strictEqual(out.agentCostUsd, 3);
  assert.strictEqual(out.id, 'a');
});
