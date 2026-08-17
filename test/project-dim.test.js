// Гашение строк чужого проекта: чистые функции, проверяются прямым вызовом.
// Страничная половина (раскладка решения по узлам и то, что красит её
// `paint`, а не `render`) сторожится текстом в test/row-contract.test.js.
const test = require('node:test');
const assert = require('node:assert');

const { dimCwd, dimsForHover, NEVER_DIM } = require('../frontend-src/project-dim.js');

// Тот же список, что у страницы: секции и дни снимков. Заголовок снимка сюда
// не входит намеренно — он выбираемый, на нём Enter поднимает раскладку.
const HEADERS = new Set(['section', 'snapshot-day']);

test('наведение на проект гасит строки с другим каталогом', () => {
  const rows = [
    { kind: 'section' },
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/b' },
    { kind: 'snapshot-session', cwd: '/home/user/b' },
  ];
  assert.deepStrictEqual(
    dimsForHover(rows, '/home/user/a', HEADERS),
    [false, false, false, true, true],
  );
});

test('заголовок снимка не гаснет, хотя каталога у него нет', () => {
  // Своего `cwd` у него не бывает, поэтому под любой проект он не подходит и
  // без оговорки гас бы всегда — при наведении на что угодно, сколько бы
  // снимков ни лежало рядом. Выбор он при этом принимает, то есть в
  // HEADER_KINDS страницы ему нельзя: тот список решает, куда встаёт выбор
  // при сбросе, и заголовок снимка оттуда пропал бы для стрелок.
  const rows = [
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'snapshot' },
    { kind: 'snapshot-session', cwd: '/home/user/b' },
  ];
  assert.deepStrictEqual(
    dimsForHover(rows, '/home/user/a', HEADERS),
    [false, false, true],
  );
  assert.ok(NEVER_DIM.has('snapshot'), 'заголовок снимка выпал из списка негаснущих');
});

test('каталог, которого не несёт ни одна строка, ничего не гасит', () => {
  const rows = [
    { kind: 'session', cwd: '/home/user/b' },
    { kind: 'session', cwd: '/home/user/c' },
  ];
  assert.deepStrictEqual(dimsForHover(rows, '/home/user/stale', HEADERS), [false, false]);
});

test('без каталога не гаснет ничего', () => {
  assert.deepStrictEqual(dimsForHover([{ kind: 'session', cwd: '/home/user/b' }], '', HEADERS), [false]);
});

test('выключенная галка отменяет и наведение, и фокус', () => {
  const rows = [
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/b' },
  ];
  assert.equal(dimCwd(rows, 1, '/home/user/a', false, HEADERS), '');
  assert.equal(dimCwd(rows, 0, '', false, HEADERS), '');
});

test('наведение перебивает фокус', () => {
  const rows = [
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/b' },
  ];
  assert.equal(dimCwd(rows, 0, '/home/user/b', true, HEADERS), '/home/user/b');
});

test('фокус на строке проекта гасит остальное в смешанном списке', () => {
  const rows = [
    { kind: 'section' },
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/b' },
  ];
  assert.equal(dimCwd(rows, 1, '', true, HEADERS), '/home/user/a');
});

test('в списке из одних проектов фокус не гасит ничего', () => {
  // Так выглядит режим /p — и так же выглядит запрос, отобравший одни
  // проекты. Признак берётся у самого списка, а не у имени режима.
  const rows = [
    { kind: 'section' },
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'project', cwd: '/home/user/b' },
  ];
  assert.equal(dimCwd(rows, 1, '', true, HEADERS), '');
});

test('список из проектов и одних заголовков снимков — тоже не смешанный', () => {
  // Заголовок снимка не гаснет и потому не считается за «есть что отделять»:
  // иначе одна строка снимка рядом с проектами включала бы гашение,
  // которому нечего погасить.
  const rows = [
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'snapshot' },
    { kind: 'project', cwd: '/home/user/b' },
  ];
  assert.equal(dimCwd(rows, 0, '', true, HEADERS), '');
});

test('фокус на строке сессии не гасит ничего', () => {
  const rows = [
    { kind: 'project', cwd: '/home/user/a' },
    { kind: 'session', cwd: '/home/user/b' },
  ];
  assert.equal(dimCwd(rows, 1, '', true, HEADERS), '');
});
