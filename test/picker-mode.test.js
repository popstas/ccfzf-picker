const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, withProjectPrefix, withSnapshotPrefix } = require('../frontend-src/picker-mode');

test('без префикса это поиск по сессиям', () => {
  assert.deepStrictEqual(parseQuery('ccfzf'), { mode: 'sessions', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery(''), { mode: 'sessions', query: '' });
  assert.deepStrictEqual(parseQuery(null), { mode: 'sessions', query: '' });
});

test('префикс переключает на проекты и в запрос не попадает', () => {
  assert.deepStrictEqual(parseQuery('/a ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/all ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/a'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/all'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/A ccfzf'), { mode: 'projects', query: 'ccfzf' });
});

test('похожее на префикс, но не он, остаётся поиском по сессиям', () => {
  // Иначе человек, ищущий сессию со словом «/api» в пути, молча оказался бы
  // в другом списке.
  assert.deepStrictEqual(parseQuery('/al'), { mode: 'sessions', query: '/al' });
  assert.deepStrictEqual(parseQuery('/api'), { mode: 'sessions', query: '/api' });
  assert.deepStrictEqual(parseQuery('a ccfzf'), { mode: 'sessions', query: 'a ccfzf' });
});

test('вставка префикса не задваивает его', () => {
  assert.strictEqual(withProjectPrefix(''), '/a ');
  assert.strictEqual(withProjectPrefix('ccfzf'), '/a ccfzf');
  assert.strictEqual(withProjectPrefix('/a ccfzf'), '/a ccfzf');
  assert.strictEqual(withProjectPrefix('/all ccfzf'), '/all ccfzf');
});

test('пробел перед префиксом ничего не меняет', () => {
  // `^A` отдаёт сюда строку поиска как есть, вместе с пробелом, который человек
  // успел набрать. Раньше такая строка получала второй префикс — `/a /a ccfzf`,
  // — и список проектов искал по слову `/a`.
  assert.strictEqual(withProjectPrefix(' /a ccfzf'), ' /a ccfzf');
  assert.deepStrictEqual(parseQuery(' /a ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('  /all'), { mode: 'projects', query: '' });
});

test('/s и /snapshots уводят в режим снимков', () => {
  assert.deepEqual(parseQuery('/s'), { mode: 'snapshots', query: '' });
  assert.deepEqual(parseQuery('/snapshots picker'), { mode: 'snapshots', query: 'picker' });
  assert.deepEqual(parseQuery('  /s  picker '), { mode: 'snapshots', query: 'picker' });
});

test('/src и /session режимом не считаются', () => {
  // Человек, ищущий сессию со словом /src в пути, не должен молча оказаться
  // в другом списке. То же правило, что уберегло /a от /api.
  assert.deepEqual(parseQuery('/src'), { mode: 'sessions', query: '/src' });
  assert.deepEqual(parseQuery('/session'), { mode: 'sessions', query: '/session' });
});

test('/a по-прежнему уводит в проекты', () => {
  assert.deepEqual(parseQuery('/a picker'), { mode: 'projects', query: 'picker' });
});

test('withSnapshotPrefix ставит префикс и не удваивает его', () => {
  assert.equal(withSnapshotPrefix('picker'), '/s picker');
  assert.equal(withSnapshotPrefix('/s picker'), '/s picker');
  assert.equal(withSnapshotPrefix(''), '/s ');
});
