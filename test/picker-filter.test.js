const { test } = require('node:test');
const assert = require('node:assert');
const { filterProjects } = require('../frontend-src/picker-filter');

const ROWS = [
  { label: 'ccfzf', cwd: '/home/user/projects/shell/ccfzf' },
  { label: 'demo', cwd: '/home/user/projects/js/demo' },
];

test('проекты ищутся по имени и по пути', () => {
  assert.deepStrictEqual(filterProjects(ROWS, 'ccfzf').map(r => r.label), ['ccfzf']);
  assert.deepStrictEqual(filterProjects(ROWS, 'js/').map(r => r.label), ['demo']);
  assert.deepStrictEqual(filterProjects(ROWS, '').map(r => r.label), ['ccfzf', 'demo']);
});

test('префикс /home в поиске не участвует', () => {
  // Тот же searchableCwd, что и у сессий: иначе «home» совпадает со всем.
  assert.deepStrictEqual(filterProjects(ROWS, 'home'), []);
});
