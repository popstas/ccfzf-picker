const { test } = require('node:test');
const assert = require('node:assert');
const { filterProjects, filterSessions, matchesText } = require('../frontend-src/picker-filter');

const filterRows = (rows, q) =>
  (filterSessions([{ sessions: rows }], q)[0] || { sessions: [] }).sessions;

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

test('запрос в русской раскладке находит латинское имя', () => {
  // Строка поиска сфокусирована всегда, и раскладка остаётся той, в которой
  // человек только что писал. Набранное вслепую не находило ничего и
  // выглядело пустым списком, а не промахом. `вуьщ` — это `demo`, набранное
  // на тех же клавишах.
  assert.deepStrictEqual(filterProjects(ROWS, 'вуьщ').map(r => r.label), ['demo']);
  assert.deepStrictEqual(
    filterSessions(GROUPS, 'вуьщ')[0].sessions.map(s => s.label), ['demo']);
});

test('верно набранное продолжает находить себя', () => {
  // Отбор идёт по «исходный ИЛИ переложенный»: перевод добавляет совпадения,
  // а не заменяет их.
  assert.deepStrictEqual(filterProjects(ROWS, 'demo').map(r => r.label), ['demo']);
});

test('строка без кириллицы второго варианта не получает', () => {
  assert.strictEqual(matchesText('demo', 'demo'), true);
  assert.strictEqual(matchesText('demo', 'zzz'), false);
});

test('id по кириллице не находится', () => {
  // matchesId сравнивает начало шестнадцатеричного id, и перевод туда не
  // идёт: `афсу` — это `face` на тех же клавишах, и переводи мы id, сессия
  // нашлась бы началом своего идентификатора по кириллическому запросу.
  const groups = [{
    title: 'Active sessions',
    sessions: [{ id: 'face1234-aaaa-bbbb-cccc-000000000003', label: 'zzz', cwd: '/home/user/zzz' }],
  }];
  assert.deepStrictEqual(filterSessions(groups, 'face').length, 1);
  assert.deepStrictEqual(filterSessions(groups, 'афсу'), []);
});

test('сессия находится по имени своего окна, а не только по имени сессии', () => {
  // Имя окна — то, которым человек завёл сессию (`claude -n tray-build-time`),
  // а `label` приходит из заголовка транскрипта и с ним расходится: сессию,
  // названную человеком, поиск по её имени обязан находить.
  const groups = [{
    title: 'Active sessions',
    sessions: [{
      id: 'aaaa1111-aaaa-bbbb-cccc-000000000001',
      label: 'esm-migration', cwd: '/home/user/windows-mqtt',
      windowTitle: 'tray-build-time',
    }],
  }];
  assert.strictEqual(filterSessions(groups, 'tray-build').length, 1);
  assert.strictEqual(filterSessions(groups, 'tray-build')[0].sessions.length, 1);
});

test('строка без окна не находится по слову undefined', () => {
  // Стог собирается склейкой полей, и отсутствующее поле уехало бы в него
  // строкой `undefined`: запрос из этого слова нашёл бы разом все строки без
  // окна — то есть всю историю.
  const groups = [{
    title: 'Active sessions',
    sessions: [{ id: 'bbbb2222-aaaa-bbbb-cccc-000000000002', label: 'x', cwd: '/home/user/x' }],
  }];
  assert.deepStrictEqual(filterSessions(groups, 'undefined'), []);
});

test('поиск находит сессию по комментарию', () => {
  // Комментарий пишут своими словами — именно теми, по которым потом и ищут.
  // Четвёртый в стоге, рядом с именем, каталогом и именем окна.
  const rows = [
    { kind: 'session', label: 'esm-migration', cwd: '/p/a', comment: 'чинит окна' },
    { kind: 'session', label: 'other', cwd: '/p/b' },
  ];
  const got = filterRows(rows, 'окна');
  assert.deepStrictEqual(got.map(r => r.label), ['esm-migration']);
});
