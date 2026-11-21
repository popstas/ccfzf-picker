const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, withPrefix } = require('../frontend-src/picker-mode');

test('без префикса это поиск по сессиям', () => {
  assert.deepStrictEqual(parseQuery('ccfzf'), { mode: 'sessions', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery(''), { mode: 'sessions', query: '' });
  assert.deepStrictEqual(parseQuery(null), { mode: 'sessions', query: '' });
});

test('префикс переключает на проекты и в запрос не попадает', () => {
  assert.deepStrictEqual(parseQuery('/p ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/projects ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/p'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/projects'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/P ccfzf'), { mode: 'projects', query: 'ccfzf' });
});

test('похожее на префикс, но не он, остаётся поиском по сессиям', () => {
  // Иначе человек, ищущий сессию со словом «/api» в пути, молча оказался бы
  // в другом списке.
  assert.deepStrictEqual(parseQuery('/al'), { mode: 'sessions', query: '/al' });
  assert.deepStrictEqual(parseQuery('/api'), { mode: 'sessions', query: '/api' });
  assert.deepStrictEqual(parseQuery('a ccfzf'), { mode: 'sessions', query: 'a ccfzf' });
});

test('вставка префикса не задваивает его', () => {
  assert.strictEqual(withPrefix('', 'projects'), '/p ');
  assert.strictEqual(withPrefix('ccfzf', 'projects'), '/p ccfzf');
  assert.strictEqual(withPrefix('/p ccfzf', 'projects'), '/p ccfzf');
  assert.strictEqual(withPrefix('/projects ccfzf', 'projects'), '/projects ccfzf');
});

test('пробел перед префиксом ничего не меняет', () => {
  // `^P` отдаёт сюда строку поиска как есть, вместе с пробелом, который человек
  // успел набрать. Раньше такая строка получала второй префикс — `/p /p ccfzf`,
  // — и список проектов искал по слову `/p`.
  assert.strictEqual(withPrefix(' /p ccfzf', 'projects'), ' /p ccfzf');
  assert.deepStrictEqual(parseQuery(' /p ccfzf'), { mode: 'projects', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('  /projects'), { mode: 'projects', query: '' });
});

test('/s и /snapshots уводят в режим снимков', () => {
  assert.deepEqual(parseQuery('/s'), { mode: 'snapshots', query: '' });
  assert.deepEqual(parseQuery('/snapshots picker'), { mode: 'snapshots', query: 'picker' });
  assert.deepEqual(parseQuery('  /s  picker '), { mode: 'snapshots', query: 'picker' });
});

test('/src и /session режимом не считаются', () => {
  // Человек, ищущий сессию со словом /src в пути, не должен молча оказаться
  // в другом списке. То же правило, что уберегло /p от /path.
  assert.deepEqual(parseQuery('/src'), { mode: 'sessions', query: '/src' });
  assert.deepEqual(parseQuery('/session'), { mode: 'sessions', query: '/session' });
});

test('withPrefix ставит префикс снимков и не удваивает его', () => {
  assert.equal(withPrefix('picker', 'snapshots'), '/s picker');
  assert.equal(withPrefix('/s picker', 'snapshots'), '/s picker');
  assert.equal(withPrefix('', 'snapshots'), '/s ');
});

test('хоткей одного режима стирает префикс другого, а не приписывается к нему', () => {
  // Пока режим был один, случая не было. Теперь `^P` и `^S` подряд — обычное
  // дело, и без снятия чужого префикса получалось `/s /p picker`: режим тот,
  // запрос — «/p picker», совпадений ноль и ни слова о причине.
  assert.equal(withPrefix('/p picker', 'snapshots'), '/s picker');
  assert.equal(withPrefix('/projects picker', 'snapshots'), '/s picker');
  assert.equal(withPrefix('/s picker', 'projects'), '/p picker');
  assert.equal(withPrefix('/snapshots picker', 'projects'), '/p picker');
  // И режим после подмены — тот, чей хоткей нажали последним.
  assert.deepStrictEqual(parseQuery(withPrefix('/p picker', 'snapshots')),
    { mode: 'snapshots', query: 'picker' });
  assert.deepStrictEqual(parseQuery(withPrefix('/s picker', 'projects')),
    { mode: 'projects', query: 'picker' });
  // Голый чужой префикс без запроса — тоже подмена, а не склейка.
  assert.equal(withPrefix('/p', 'snapshots'), '/s ');
  assert.equal(withPrefix('/s', 'projects'), '/p ');
});

test('все пять префиксов разбираются', () => {
  assert.deepStrictEqual(parseQuery('/l ccfzf'), { mode: 'local', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/local ccfzf'), { mode: 'local', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/r ccfzf'), { mode: 'remote', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/remote'), { mode: 'remote', query: '' });
  assert.deepStrictEqual(parseQuery('/h'), { mode: 'history', query: '' });
  assert.deepStrictEqual(parseQuery('/history ccfzf'), { mode: 'history', query: 'ccfzf' });
  assert.deepStrictEqual(parseQuery('/p'), { mode: 'projects', query: '' });
  assert.deepStrictEqual(parseQuery('/s'), { mode: 'snapshots', query: '' });
});

test('слово, начинающееся как префикс, префиксом не является', () => {
  // Хвост `(\s+|$)` в каждой записи таблицы — ради этого и только этого:
  // человек, ищущий сессию со словом `/lib` или `/home` в пути, не должен
  // молча оказаться в другом списке.
  for (const word of ['/lib', '/home', '/root', '/path', '/pr', '/api', '/src', '/session']) {
    assert.deepStrictEqual(parseQuery(word), { mode: 'sessions', query: word }, word);
  }
});

test('вставка префикса поверх чужого заменяет его, а не приписывает второй', () => {
  // Без этого `^L` на строке `/p picker` дал бы `/l /p picker` — режим с
  // запросом, которому ничем не соответствовать, то есть пустой список без
  // единого слова о причине.
  assert.strictEqual(withPrefix('/p picker', 'local'), '/l picker');
  assert.strictEqual(withPrefix('/s work', 'history'), '/h work');
  assert.strictEqual(withPrefix(' /h old', 'projects'), '/p old');
  assert.strictEqual(withPrefix('/l a', 'local'), '/l a');
  assert.strictEqual(withPrefix('', 'remote'), '/r ');
});

// ─── `/p <проект> <промпт>` ───────────────────────────────────────────────
const { projectPrompt, projectToken } = require('../frontend-src/picker-mode');

const PROJECTS = [
  { kind: 'project', id: '/p/ccfzf', cwd: '/p/ccfzf', label: 'ccfzf', source: 's' },
  { kind: 'project', id: '/p/ccfzf-picker', cwd: '/p/ccfzf-picker', label: 'ccfzf-picker', source: 's' },
  { kind: 'project', id: '/p/windows11-manager', cwd: '/p/windows11-manager', label: 'windows11-manager', source: 's' },
  { kind: 'project', id: '/p/my notes', cwd: '/p/my notes', label: 'my notes', source: 's' },
];

test('однозначный кусок имени и хвост — промпт этому проекту', () => {
  const hit = projectPrompt('picker fix the bug', PROJECTS);
  assert.strictEqual(hit.project.cwd, '/p/ccfzf-picker');
  assert.strictEqual(hit.prompt, 'fix the bug');
});

test('точное совпадение побеждает кусок чужого имени', () => {
  // `ccfzf` — кусок и `ccfzf-picker`, но имя `ccfzf` названо целиком.
  assert.strictEqual(projectPrompt('ccfzf hi', PROJECTS).project.cwd, '/p/ccfzf');
  // Регистр не важен и для точного.
  assert.strictEqual(projectPrompt('CCFZF hi', PROJECTS).project.cwd, '/p/ccfzf');
});

test('неоднозначный кусок — не промпт, а прежний фильтр', () => {
  // `cc` есть в двух именах: гадать, кому отдать промпт, нельзя.
  assert.strictEqual(projectPrompt('cc hello', PROJECTS), null);
});

test('без хвоста и без совпадения — прежний режим', () => {
  assert.strictEqual(projectPrompt('picker', PROJECTS), null);
  assert.strictEqual(projectPrompt('picker   ', PROJECTS), null);
  assert.strictEqual(projectPrompt('nothing here', PROJECTS), null);
  assert.strictEqual(projectPrompt('', PROJECTS), null);
  assert.strictEqual(projectPrompt('picker hi', []), null);
});

test('промпт берётся как есть: переводы строк, кавычки, кириллица', () => {
  const text = `fix "it"; don't $HOME\nвторая строка`;
  assert.strictEqual(projectPrompt(`windows ${text}`, PROJECTS).prompt, text);
});

test('путь каталога целиком — тоже точное имя', () => {
  // Им Tab называет проект, у которого имя с пробелом или с тёзкой.
  assert.strictEqual(projectPrompt('/p/my notes x', PROJECTS), null);
  assert.strictEqual(projectPrompt('/p/ccfzf hi', PROJECTS).project.cwd, '/p/ccfzf');
});

test('тёзки с разных машин — точное имя неоднозначно, различает путь', () => {
  const twins = [
    { kind: 'project', cwd: '/srv/one/site', label: 'site', source: 'one' },
    { kind: 'project', cwd: '/srv/site', label: 'site', source: 'two' },
  ];
  assert.strictEqual(projectPrompt('site hi', twins), null);
  assert.strictEqual(projectPrompt('/srv/site hi', twins).project.source, 'two');
  assert.strictEqual(projectToken(twins[1], twins), '/srv/site');
});

test('Tab называет проект тем словом, которое к нему же и разберётся', () => {
  assert.strictEqual(projectToken(PROJECTS[0], PROJECTS), 'ccfzf');
  assert.strictEqual(projectToken(PROJECTS[1], PROJECTS), 'ccfzf-picker');
  // Имя с пробелом словом не стать: берётся кусок без пробела, если он однозначен.
  assert.strictEqual(projectToken(PROJECTS[3], PROJECTS), 'notes');
  for (const p of PROJECTS) {
    const token = projectToken(p, PROJECTS);
    assert.strictEqual(projectPrompt(`${token} x`, PROJECTS).project, p, token);
  }
});

test('не разобрать никак — пустая строка', () => {
  const same = [
    { kind: 'project', cwd: '/a/x y', label: 'x y', source: 'one' },
    { kind: 'project', cwd: '/b/x y', label: 'x y', source: 'two' },
  ];
  assert.strictEqual(projectToken(same[0], same), '');
});
