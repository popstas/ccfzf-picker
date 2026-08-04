const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeSort, cycleSort, groupSessions, SORT_MODES } = require('../frontend-src/session-groups');

function row(extra) {
  return Object.assign({
    id: 'a', title: 'T', cwd: '/home/user/x', live: false,
    cost: 0, updated: 0, unread: false,
  }, extra || {});
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
    row({ id: 'dead', live: false, updated: 200 }),
    row({ id: 'alive', live: true, updated: 100 }),
  ], 'newest');
  assert.strictEqual(groups[0].sessions[0].id, 'alive');
});

test('пустой список даёт пустой результат', () => {
  assert.deepStrictEqual(groupSessions([], 'cost'), []);
});
