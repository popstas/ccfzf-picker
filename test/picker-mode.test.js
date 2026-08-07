const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, withProjectPrefix } = require('../frontend-src/picker-mode');

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
