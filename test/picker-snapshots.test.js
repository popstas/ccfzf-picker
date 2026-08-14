const test = require('node:test');
const assert = require('node:assert');

const { buildSnapshotRows, openIdsFromState, formatSnapshotTime, snapshotsHere, snapshotBase } =
  require('../frontend-src/picker-snapshots.js');

const SNAP = {
  id: 'snap-1',
  created: 1754640660,
  sessions: [
    { id: 'aaa', cwd: '/home/user/projects/js/ccfzf-picker', title: 'picker' },
    { id: 'bbb', cwd: '/home/user/projects/js/windows-mqtt', title: 'mqtt' },
  ],
};

test('openIdsFromState берёт сессии с окном', () => {
  // Отдельного openSessionIds возить неоткуда: всё уже в том же ответе.
  const ids = openIdsFromState({
    sessions: [
      { id: 'aaa', window: { title: 'x' } },
      { id: 'bbb' },
      { id: 'ccc', window: null },
    ],
  });
  assert.deepEqual([...ids].sort(), ['aaa']);
});

test('openIdsFromState на пустом ответе — пустое множество', () => {
  assert.equal(openIdsFromState({}).size, 0);
  assert.equal(openIdsFromState(null).size, 0);
});

test('заголовок снимка считает, скольких не хватает', () => {
  const rows = buildSnapshotRows([SNAP], new Set(['aaa']), '');
  assert.equal(rows[0].kind, 'snapshot');
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].missing, 1);
});

test('строки сессий помечены открытостью', () => {
  const rows = buildSnapshotRows([SNAP], new Set(['aaa']), '');
  const sessions = rows.filter(r => r.kind === 'snapshot-session');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'aaa');
  assert.equal(sessions[0].open, true);
  assert.equal(sessions[1].open, false);
});

test('ключи строк разведены и стабильны', () => {
  // picker-list-sync правит только отличающиеся строки, и совпавший ключ
  // заголовка с ключом сессии подменял бы одну строку другой.
  const rows = buildSnapshotRows([SNAP], new Set(), '');
  assert.deepEqual(rows.map(r => r.key),
    ['g:snap:snap-1', 'snap:snap-1:aaa', 'snap:snap-1:bbb']);
});

test('имя строки сессии — basename каталога', () => {
  const rows = buildSnapshotRows([SNAP], new Set(), '');
  assert.equal(rows[1].label, 'ccfzf-picker');
});

test('без cwd имя берётся из заголовка', () => {
  const rows = buildSnapshotRows(
    [{ id: 's', created: 1, sessions: [{ id: 'x', cwd: '', title: 'заголовок' }] }],
    new Set(), '');
  assert.equal(rows[1].label, 'заголовок');
});

test('фильтр уносит снимок вместе с заголовком', () => {
  // Снимок без подошедших сессий не должен оставлять на экране пустую группу.
  const rows = buildSnapshotRows([SNAP], new Set(), 'mqtt');
  assert.deepEqual(rows.map(r => r.key), ['g:snap:snap-1', 'snap:snap-1:bbb']);
  assert.deepEqual(buildSnapshotRows([SNAP], new Set(), 'ничего'), []);
});

test('пустой список снимков — пустой список строк', () => {
  assert.deepEqual(buildSnapshotRows([], new Set(), ''), []);
  assert.deepEqual(buildSnapshotRows(undefined, new Set(), ''), []);
});

test('снимок без сессий не даёт даже заголовка', () => {
  // Восстанавливать в нём нечего, а строка обещала бы обратное.
  assert.deepEqual(buildSnapshotRows([{ id: 's', created: 1, sessions: [] }], new Set(), ''), []);
});

test('время снимка — час и дата', () => {
  const text = formatSnapshotTime({ created: 1754640660 });
  assert.match(text, /^\d{2}:\d{2} · \d{4}-\d{2}-\d{2}$/);
});

test('снимок без времени показывает id вместо даты', () => {
  assert.equal(formatSnapshotTime({ id: 'snap-1' }), 'snap-1');
});

test('снимки отбираются по своей машине', () => {
  // Снимок соседней машины в этом списке не помог бы ничем: восстановить
  // раскладку на чужом экране человеку нечего.
  const state = {
    snapshots: [
      { id: 'a', host: 'windows-box', sessions: [] },
      { id: 'b', host: 'mac-host', mqttBase: 'home/room/mac/windows', sessions: [] },
    ],
  };
  assert.deepEqual(snapshotsHere(state, 'mac-host').map(s => s.id), ['b']);
});

test('снимок без машины считается своим', () => {
  // Старый агрегатор владельца не пишет, а трекер тогда был один — и все
  // снимки были его. Отбрось мы такие, режим опустел бы там, где работал.
  const state = { windowHost: 'windows-box', snapshots: [{ id: 'a', sessions: [] }] };
  assert.deepEqual(snapshotsHere(state, 'windows-box').map(s => s.id), ['a']);
});

test('имя машины сравнивается без учёта регистра и пробелов', () => {
  const state = { snapshots: [{ id: 'a', host: 'Mac-Host ', sessions: [] }] };
  assert.equal(snapshotsHere(state, ' mac-host').length, 1);
});

test('без снимков — пустой список, а не поломка', () => {
  assert.deepEqual(snapshotsHere({}, 'mac-host'), []);
  assert.deepEqual(snapshotsHere({ snapshots: 'нет' }, 'mac-host'), []);
});

test('адрес снимка берётся у снимка, а не у конфига', () => {
  assert.equal(
    snapshotBase({ id: 'b', mqttBase: 'home/room/mac/windows' }),
    'home/room/mac/windows',
  );
});

test('снимок старого агрегатора адреса не называет, и это пустая строка', () => {
  // Пустая строка значит «спроси свой конфиг» — так пикер вёл себя до
  // появления поля.
  assert.equal(snapshotBase({ id: 'a' }), '');
  assert.equal(snapshotBase(null), '');
});
