const test = require('node:test');
const assert = require('node:assert');

const {
  buildSnapshotRows, snapshotCount, openIdsFromState, formatSnapshotTime,
  snapshotDay, dayLabel, snapshotsHere, snapshotBase,
} = require('../frontend-src/picker-snapshots.js');

const SNAP = {
  id: 'snap-1',
  created: 1754640660,
  sessions: [
    { id: 'aaa', cwd: '/home/user/projects/js/ccfzf-picker', title: 'picker' },
    { id: 'bbb', cwd: '/home/user/projects/js/windows-mqtt', title: 'mqtt' },
  ],
};

/** Снимок в названный местный день и час — время берётся своими часами. */
function snapAt(id, y, m, d, hh, mm, sessions) {
  return {
    id,
    created: Math.floor(new Date(y, m - 1, d, hh, mm, 0).getTime() / 1000),
    sessions: sessions ?? [{ id: `${id}-s`, cwd: '/home/user/projects/js/ccfzf-picker' }],
  };
}

/** Строки без дней — то, чем список был до группировки. Так короче сверять. */
function rowsUnderDays(snapshots, open, query, collapsedDays) {
  return buildSnapshotRows(snapshots, open ?? new Set(), query ?? '', collapsedDays)
    .filter(r => r.kind !== 'snapshot-day');
}

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
  const rows = rowsUnderDays([SNAP], new Set(['aaa']));
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

test('строка сессии несёт источник снимка, а не своего id', () => {
  // Восстановление снимка идёт на ту машину, которая его сняла
  // (snapshotBase/openSession), и без метки транспорт откатился бы на
  // CONFIG.sshHost — то есть попытался бы поднять местный снимок по ssh.
  const rows = buildSnapshotRows(
    [{ ...SNAP, source: 'remote-host' }], new Set(), '');
  const sessions = rows.filter(r => r.kind === 'snapshot-session');
  assert.equal(sessions.length, 2);
  for (const row of sessions) assert.equal(row.source, 'remote-host');
});

test('ключи строк разведены и стабильны', () => {
  // picker-list-sync правит только отличающиеся строки, и совпавший ключ
  // заголовка с ключом сессии подменял бы одну строку другой. День — такой же
  // заголовок, и его ключ разведён с обоими.
  const rows = buildSnapshotRows([SNAP], new Set(), '');
  assert.deepEqual(rows.map(r => r.key),
    [`g:snapday:${snapshotDay(SNAP)}`, 'g:snap:snap-1', 'snap:snap-1:aaa', 'snap:snap-1:bbb']);
});

test('имя строки сессии — basename каталога', () => {
  const rows = rowsUnderDays([SNAP]);
  assert.equal(rows[1].label, 'ccfzf-picker');
});

test('без cwd имя берётся из заголовка', () => {
  const rows = rowsUnderDays(
    [{ id: 's', created: 1, sessions: [{ id: 'x', cwd: '', title: 'заголовок' }] }]);
  assert.equal(rows[1].label, 'заголовок');
});

test('фильтр уносит снимок вместе с заголовком', () => {
  // Снимок без подошедших сессий не должен оставлять на экране пустую группу.
  const rows = rowsUnderDays([SNAP], new Set(), 'mqtt');
  assert.deepEqual(rows.map(r => r.key), ['g:snap:snap-1', 'snap:snap-1:bbb']);
  assert.deepEqual(buildSnapshotRows([SNAP], new Set(), 'ничего'), []);
});

test('день, из которого ушли все снимки, не заводится вовсе', () => {
  // Заголовок дня без единого снимка — обещание, за которым ничего нет.
  const rows = buildSnapshotRows([
    snapAt('a', 2026, 8, 16, 14, 20, [{ id: 'a1', cwd: '/home/user/picker' }]),
    snapAt('b', 2026, 8, 15, 11, 3, [{ id: 'b1', cwd: '/home/user/mqtt' }]),
  ], new Set(), 'picker');
  assert.deepEqual(rows.filter(r => r.kind === 'snapshot-day').map(r => r.label), ['Aug 16']);
});

test('пустой список снимков — пустой список строк', () => {
  assert.deepEqual(buildSnapshotRows([], new Set(), ''), []);
  assert.deepEqual(buildSnapshotRows(undefined, new Set(), ''), []);
});

test('снимок без сессий не даёт даже заголовка', () => {
  // Восстанавливать в нём нечего, а строка обещала бы обратное.
  assert.deepEqual(buildSnapshotRows([{ id: 's', created: 1, sessions: [] }], new Set(), ''), []);
});

test('время снимка — только час: дату говорит заголовок дня', () => {
  const text = formatSnapshotTime({ created: 1754640660 });
  assert.match(text, /^\d{2}:\d{2}$/);
});

test('снимок без времени показывает id вместо даты', () => {
  assert.equal(formatSnapshotTime({ id: 'snap-1' }), 'snap-1');
});

// ── дни ─────────────────────────────────────────────────────────────────────

const THREE_DAYS = [
  snapAt('mid', 2026, 8, 16, 11, 3, [{ id: 'm1', cwd: '/home/user/a' }]),
  snapAt('old', 2026, 8, 14, 9, 30, [{ id: 'o1', cwd: '/home/user/b' }]),
  snapAt('new', 2026, 8, 16, 14, 20,
    [{ id: 'n1', cwd: '/home/user/c' }, { id: 'n2', cwd: '/home/user/d' }]),
];

test('дни идут свежим первым, и внутри дня свежий снимок первый', () => {
  // Порядок в ответе агрегатора неизвестен, а список перерисовывается раз в
  // секунду — устойчивый порядок обязателен.
  const rows = buildSnapshotRows(THREE_DAYS, new Set(), '', { '2026-08-14': false });
  assert.deepEqual(
    rows.filter(r => r.kind === 'snapshot-day').map(r => r.label), ['Aug 16', 'Aug 14']);
  assert.deepEqual(
    rows.filter(r => r.kind === 'snapshot').map(r => r.id), ['new', 'mid', 'old']);
});

test('по умолчанию развёрнут только самый свежий день', () => {
  const rows = buildSnapshotRows(THREE_DAYS, new Set(), '');
  const days = rows.filter(r => r.kind === 'snapshot-day');
  assert.deepEqual(days.map(r => r.collapsed), [false, true]);
  // Свёрнутый день не отдаёт ни снимков, ни сессий — только свой заголовок.
  assert.deepEqual(rows.filter(r => r.kind === 'snapshot').map(r => r.id), ['new', 'mid']);
});

test('отступление человека сильнее умолчания — в обе стороны', () => {
  // Карта — только отступления: чего в ней нет, то по умолчанию. Так
  // умолчание можно менять, не переписывая никому запомненное.
  const rows = buildSnapshotRows(THREE_DAYS, new Set(), '',
    { '2026-08-16': true, '2026-08-14': false });
  assert.deepEqual(rows.filter(r => r.kind === 'snapshot-day').map(r => r.collapsed),
    [true, false]);
  assert.deepEqual(rows.filter(r => r.kind === 'snapshot').map(r => r.id), ['old']);
});

test('в заголовке дня счёт снимков и счёт сессий', () => {
  const [day] = buildSnapshotRows(THREE_DAYS, new Set(), '');
  assert.equal(day.snapshots, 2);
  assert.equal(day.sessions, 3);
  assert.equal(day.meta, '2 snapshots · 3 sessions');
  // Единственное число — без «s»: «1 snapshots» читается как недоделка.
  const [alone] = buildSnapshotRows([THREE_DAYS[1]], new Set(), '');
  assert.equal(alone.meta, '1 snapshot · 1 session');
});

test('непустой запрос разворачивает все дни и снимает с них сворачивание', () => {
  // Искали снимок, а не счёт. А раз свёрнутость назначена сверху, Enter на
  // заголовке молчал бы — поэтому же он перестаёт быть переключателем.
  const rows = buildSnapshotRows(THREE_DAYS, new Set(), 'user', { '2026-08-16': true });
  const days = rows.filter(r => r.kind === 'snapshot-day');
  assert.deepEqual(days.map(r => r.collapsed), [false, false]);
  assert.deepEqual(days.map(r => r.foldable), [false, false]);
  assert.deepEqual(rows.filter(r => r.kind === 'snapshot').map(r => r.id), ['new', 'mid', 'old']);
});

test('снимок без отметки времени уходит в день «No date», и день этот последний', () => {
  const rows = buildSnapshotRows([
    { id: 'no-time', sessions: [{ id: 'x', cwd: '/home/user/a' }] },
    THREE_DAYS[0],
  ], new Set(), '');
  const days = rows.filter(r => r.kind === 'snapshot-day');
  assert.deepEqual(days.map(r => r.label), ['Aug 16', 'No date']);
  assert.deepEqual(days.map(r => r.key), ['g:snapday:2026-08-16', 'g:snapday:none']);
});

test('счёт секции снимков не зависит от того, что свёрнуто', () => {
  // Иначе «Snapshots - 3» превращалось бы в «Snapshots - 1» без единого
  // исчезнувшего снимка: строки свёрнутого дня в список не попадают вовсе.
  const open = buildSnapshotRows(THREE_DAYS, new Set(), '', { '2026-08-14': false });
  const shut = buildSnapshotRows(THREE_DAYS, new Set(), '', { '2026-08-16': true });
  assert.equal(snapshotCount(open), 3);
  assert.equal(snapshotCount(shut), 3);
  assert.equal(snapshotCount([]), 0);
});

test('подпись дня — английский месяц из своей таблицы', () => {
  // toLocaleDateString дал бы вид по локали системы, а всё видимое человеку у
  // нас английское.
  assert.equal(dayLabel('2026-08-16'), 'Aug 16');
  assert.equal(dayLabel('2026-01-01'), 'Jan 1');
  assert.equal(dayLabel(''), 'No date');
});

test('день считается местными часами', () => {
  // «Когда я это снимал» человек меряет своими часами — тот же довод, по
  // которому местной была дата в заголовке свёрнутой истории.
  const noon = Math.floor(new Date(2026, 7, 16, 12, 0, 0).getTime() / 1000);
  assert.equal(snapshotDay({ created: noon }), '2026-08-16');
  assert.equal(snapshotDay({}), '');
  assert.equal(snapshotDay({ created: 0 }), '');
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

test('строка сессии несёт имя сессии, а не один каталог', () => {
  // Имя проекта у строки — каталог, и сессий одного каталога в снимке бывает
  // несколько: имя сессии — то самое, чем они отличаются. Рисует его подписью
  // рядом snapshotNameHtml (session-glyph.js), решая заодно, расходятся ли
  // имена вовсе.
  const rows = buildSnapshotRows([SNAP], new Set(), '')
    .filter(r => r.kind === 'snapshot-session');
  assert.deepEqual(rows.map(r => r.title), ['picker', 'mqtt']);
});

test('сессия снимка без имени несёт пустую строку, а не undefined', () => {
  // Стог поиска склеивается из полей строки, и недостающее уехало бы в него
  // словом `undefined` — запрос из него нашёл бы разом весь снимок.
  const rows = buildSnapshotRows(
    [{ id: 's', created: SNAP.created, sessions: [{ id: 'a', cwd: '/home/user/projects/js/x' }] }],
    new Set(), '',
  ).filter(r => r.kind === 'snapshot-session');
  assert.deepEqual(rows.map(r => r.title), ['']);
});

test('снимок ищется и по имени сессии, а не только по каталогу', () => {
  // Показанное в строке обязано и находиться: иначе запрос по имени, которое
  // человек читает глазами, даёт ноль строк.
  const snap = {
    ...SNAP,
    sessions: [
      { id: 'aaa', cwd: '/home/user/projects/js/ccfzf-picker', title: 'tray-build-time' },
      { id: 'bbb', cwd: '/home/user/projects/js/windows-mqtt', title: 'mqtt' },
    ],
  };
  const found = rowsUnderDays([snap], undefined, 'tray-build')
    .filter(r => r.kind === 'snapshot-session');
  assert.deepEqual(found.map(r => r.id), ['aaa']);
});

test('снимки ищутся и в русской раскладке', () => {
  // Третий отбор был написан в этом файле руками и filterProjects не звал
  // вовсе: перевод, положенный в два места из трёх, дал бы поиск, который
  // работает в сессиях и молчит в снимках. `зшслук` — это `picker`,
  // набранный на тех же клавишах.
  const found = rowsUnderDays([SNAP], undefined, 'зшслук')
    .filter(r => r.kind === 'snapshot-session');
  assert.deepEqual(found.map(r => r.id), ['aaa']);
});
