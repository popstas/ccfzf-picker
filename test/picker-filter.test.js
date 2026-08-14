const { test } = require('node:test');
const assert = require('node:assert');
const { filterProjects, filterSessions } = require('../frontend-src/picker-filter');

const ROWS = [
  { label: 'ccfzf', cwd: '/home/user/projects/shell/ccfzf' },
  { label: 'demo', cwd: '/home/user/projects/js/demo' },
];

const GROUPS = [
  {
    title: 'Active sessions',
    sessions: [
      { id: '4380f1c2-aaaa-bbbb-cccc-000000000001', label: 'macos-claude-setup', cwd: '/home/user/projects/js/picker' },
      { id: '9911aaaa-4380-bbbb-cccc-000000000002', label: 'demo', cwd: '/home/user/projects/js/demo' },
    ],
  },
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

const labels = groups => groups.flatMap(g => g.sessions.map(s => s.label));

test('сессии ищутся по имени и по пути', () => {
  assert.deepStrictEqual(labels(filterSessions(GROUPS, 'setup')), ['macos-claude-setup']);
  assert.deepStrictEqual(labels(filterSessions(GROUPS, 'js/demo')), ['demo']);
  assert.deepStrictEqual(labels(filterSessions(GROUPS, '')), ['macos-claude-setup', 'demo']);
});

test('сессия находится по первым знакам своего id', () => {
  assert.deepStrictEqual(labels(filterSessions(GROUPS, '4380')), ['macos-claude-setup']);
});

test('id совпадает только началом, а не серединой', () => {
  // Вторая сессия несёт «4380» в середине id: id длинный и случайный,
  // вхождение посередине давало бы ложные попадания.
  assert.deepStrictEqual(labels(filterSessions(GROUPS, 'aaaa')), []);
});

test('группа без совпавших сессий выпадает целиком', () => {
  assert.deepStrictEqual(filterSessions(GROUPS, 'нет такой'), []);
});
