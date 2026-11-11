const { test } = require('node:test');
const assert = require('node:assert');
const { nestByHead, INDENT_PX } = require('../frontend-src/session-tree');

const ids = rows => rows.map(r => r.id || r.key);
const depths = rows => rows.map(r => r.treeDepth);

test('дети стоят непосредственно перед родителем, в своём порядке', () => {
  const rows = [
    { id: 'p', title: 'lead' },
    { id: 'x', title: 'other' },
    { id: 'c1', title: 'lead-a', head: 'lead', headId: 'p' },
    { id: 'c2', title: 'lead-b', head: 'lead', headId: 'p' },
  ];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out), ['c1', 'c2', 'p', 'x']);
  assert.deepStrictEqual(depths(out), [1, 1, 0, 0]);
});

test('родитель ищется по headId раньше имени: переименование его не сбивает', () => {
  const rows = [
    { id: 'p-old-name', title: 'lead' },
    { id: 'p', title: 'renamed' },
    { id: 'c', title: 'lead-a', head: 'lead', headId: 'p' },
  ];
  assert.deepStrictEqual(ids(nestByHead(rows)), ['p-old-name', 'c', 'p']);
});

test('без headId родитель ищется по имени строки и по имени окна', () => {
  const byTitle = nestByHead([{ id: 'p', title: 'lead' }, { id: 'c', head: 'lead' }]);
  assert.deepStrictEqual(ids(byTitle), ['c', 'p']);
  const byWindow = nestByHead([{ id: 'p', title: 'esm', windowTitle: 'lead' }, { id: 'c', head: 'lead' }]);
  assert.deepStrictEqual(ids(byWindow), ['c', 'p']);
  // headId назван, но такой строки нет — запасной ход по имени.
  const fallback = nestByHead([{ id: 'p', title: 'lead' }, { id: 'c', head: 'lead', headId: 'gone' }]);
  assert.deepStrictEqual(ids(fallback), ['c', 'p']);
});

test('ребёнок без родителя на участке стоит где стоял, с глубиной 0', () => {
  const rows = [{ id: 'a', title: 'a' }, { id: 'c', head: 'lead', headId: 'p' }, { id: 'b', title: 'b' }];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out), ['a', 'c', 'b']);
  assert.deepStrictEqual(depths(out), [0, 0, 0]);
});

test('внуки стоят перед своим ребёнком, отступ на уровень', () => {
  const rows = [
    { id: 'p', title: 'lead' },
    { id: 'c', title: 'lead-a', headId: 'p' },
    { id: 'g', title: 'lead-a-x', headId: 'c' },
  ];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out), ['g', 'c', 'p']);
  assert.deepStrictEqual(depths(out), [2, 1, 0]);
});

test('карточки одной сессии ходят вместе, дети — перед первой', () => {
  const rows = [
    { id: 'p', title: 'lead', window: { host: 'a' } },
    { id: 'x', title: 'other' },
    { id: 'p', title: 'lead', window: { host: 'b' } },
    { id: 'c', headId: 'p' },
  ];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out), ['c', 'p', 'p', 'x']);
  assert.deepStrictEqual(out.slice(1, 3).map(r => r.window.host), ['a', 'b']);
});

test('цикл в данных разрывается, а не теряет строки', () => {
  const out = nestByHead([{ id: 'a', headId: 'b' }, { id: 'b', headId: 'a' }]);
  assert.deepStrictEqual(ids(out).sort(), ['a', 'b']);
  // Сама на себя не ссылается: строка не может быть своим родителем.
  assert.deepStrictEqual(depths(nestByHead([{ id: 'a', headId: 'a' }])), [0]);
});

test('подзаголовок машины делит участки: родитель с другой машины не годится', () => {
  const rows = [
    { kind: 'block-subhead', key: 'sub:box-a' },
    { id: 'p', title: 'lead' },
    { kind: 'block-subhead', key: 'sub:box-b' },
    { id: 'c', headId: 'p' },
  ];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out), ['sub:box-a', 'p', 'sub:box-b', 'c']);
  assert.strictEqual(out[3].treeDepth, 0);
  // Подзаголовок проходит как есть, без поля глубины.
  assert.strictEqual(out[0], rows[0]);
});

test('строки не мутируются, строки без id остаются на месте', () => {
  const rows = [{ id: 'p', title: 'lead' }, { kind: 'zellij', title: 'home' }, { id: 'c', headId: 'p' }];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out).map(String), ['c', 'p', 'undefined']);
  assert.strictEqual(rows[0].treeDepth, undefined);
  assert.deepStrictEqual(nestByHead(null), []);
});

test('отступ одного уровня — в пределах, названных владельцем', () => {
  assert.ok(INDENT_PX >= 15 && INDENT_PX <= 30, INDENT_PX);
});

// Вкладки Windows Terminal делят один процесс, и `window.pid` у сессий разных
// вкладок общий. Родитель — строго строка с id == headId, где бы она ни стояла
// и с кем бы ни делила процесс; окно в поиске не участвует вовсе.
test('сессии одного процесса терминала не путаются: родитель — по id, не по окну', () => {
  const tab = pid => ({ host: 'box-a', pid, desktop: 1 });
  const rows = [
    { id: 'n1', title: 'neighbour-a', window: tab(30956) },
    { id: 'p', title: 'lead', window: tab(30956) },
    { id: 'n2', title: 'neighbour-b', window: tab(30956) },
    { id: 'c1', title: 'kid-a', headId: 'p', window: tab(30956) },
    { id: 'c2', title: 'kid-b', headId: 'p', window: tab(30956) },
  ];
  const out = nestByHead(rows);
  assert.deepStrictEqual(ids(out), ['n1', 'c1', 'c2', 'p', 'n2']);
  assert.deepStrictEqual(depths(out), [0, 1, 1, 0, 0]);
});
