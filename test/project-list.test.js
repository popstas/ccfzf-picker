const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildProjectList, markHotkeysTaken, hotkeysTakenMessage,
} = require('../frontend-src/project-list');

const STATE = {
  projects: [
    { path: '/home/user/projects/ccfzf', name: 'ccfzf', mark: true, sessions: 12, live: 2, mtime: 1786045860 },
    { path: '/home/user/projects/empty', name: 'empty', mark: true, sessions: 0, live: 0, mtime: 0 },
  ],
};

test('строка проекта несёт всё, что рисует список', () => {
  const [a, b] = buildProjectList(STATE);
  assert.strictEqual(a.kind, 'project');
  assert.strictEqual(a.id, '/home/user/projects/ccfzf');
  assert.strictEqual(a.cwd, '/home/user/projects/ccfzf');
  assert.strictEqual(a.label, 'ccfzf');
  assert.strictEqual(a.mark, true);
  assert.strictEqual(a.sessionCount, 12);
  assert.strictEqual(a.liveCount, 2);
  assert.strictEqual(a.lastActivity, 1786045860);
  // Проект без единой сессии — ровно то, ради чего режим и заводится.
  assert.strictEqual(b.sessionCount, 0);
});

test('счётчик живых не зовётся live', () => {
  // У строки сессии live — булево, и render вешает по нему класс closed.
  // Счётчик под тем же именем молча превратил бы «две живые» в «живая».
  assert.strictEqual('live' in buildProjectList(STATE)[0], false);
});

test('пустой или отсутствующий список — не поломка', () => {
  assert.deepStrictEqual(buildProjectList({}), []);
  assert.deepStrictEqual(buildProjectList(), []);
  assert.deepStrictEqual(buildProjectList({ projects: null }), []);
});

test('хоткей переезжает в строку под тем же именем, что читает колонка hk', () => {
  const rows = buildProjectList({
    projects: [{ path: '/p/one', name: 'one', sessions: 0, live: 0, mtime: 0,
      hotkey: 'Ctrl+F11' }],
  });
  assert.equal(rows[0].hotkey, 'Ctrl+F11');
});

// Пустая строка, а не undefined: hotkeyHtml подставляет значение в разметку, и
// «undefined» доехало бы до экрана словом.
test('без хоткея поле пустое, а не отсутствует', () => {
  const rows = buildProjectList({
    projects: [{ path: '/p/one', name: 'one', sessions: 0, live: 0, mtime: 0 }],
  });
  assert.equal(rows[0].hotkey, '');
});

test('запись без пути выбрасывается, безымянная берёт путь именем', () => {
  const rows = buildProjectList({ projects: [
    { path: '', name: 'нет пути' },
    { path: '/p/x' },
  ] });
  assert.deepStrictEqual(rows.map(r => r.label), ['/p/x']);
});

// Хоткей у менеджера пишет человек, и пробелы вокруг него — обычное дело.
// Rust их снимает при разборе ответа, а строка списка — нет: разойдись эти
// два вида, пометка «клавиша не встала» промахнулась бы мимо строки молча,
// потому что сверяется она с тем, что приехало от Rust.
test('хоткей приезжает в строку без пробелов по краям', () => {
  const rows = buildProjectList({
    projects: [{ path: '/p/one', name: 'one', sessions: 0, live: 0, mtime: 0,
      hotkey: ' Ctrl+F12 ' }],
  });
  assert.equal(rows[0].hotkey, 'Ctrl+F12');
});

// markHotkeysTaken — общий помощник для события project-hotkeys и разового
// опроса project_hotkeys_taken на старте страницы: обе ветки применяют один и
// тот же список к строкам одним и тем же способом.
//
// Помечается строка по каталогу, а не по комбинации: у внутреннего
// столкновения комбинация общая, и пометка по ней гасила бы и победителя —
// того, у кого клавиша как раз работает.
test('markHotkeysTaken помечает строку проигравшего, а не всех с той же клавишей', () => {
  const rows = [
    { cwd: '/p/one', hotkey: 'Ctrl+F11' },
    { cwd: '/p/two', hotkey: 'Ctrl+F11' },
    { cwd: '/p/three', hotkey: '' },
  ];
  markHotkeysTaken(rows, [{ cwd: '/p/two', hotkey: 'Ctrl+F11', reason: 'duplicate' }]);
  assert.deepStrictEqual(rows.map(r => r.hotkeyTaken), [false, true, false]);
});

test('markHotkeysTaken на пустом списке занятых снимает пометку со всех', () => {
  const rows = [{ cwd: '/p/one', hotkey: 'Ctrl+F11', hotkeyTaken: true }];
  markHotkeysTaken(rows, []);
  assert.strictEqual(rows[0].hotkeyTaken, false);
});

test('markHotkeysTaken переживает мусор вместо списка', () => {
  const rows = [{ cwd: '/p/one', hotkey: 'Ctrl+F11', hotkeyTaken: true }];
  markHotkeysTaken(rows, undefined);
  assert.strictEqual(rows[0].hotkeyTaken, false);
});

// Строка в статуслайне — единственное место, где человек узнаёт об отказе, и
// назвать в ней надо настоящую причину: отправить искать чужое приложение
// там, где хоткей просто назван дважды, — час впустую.
test('каждая причина отказа говорит человеку своё', () => {
  const one = r => hotkeysTakenMessage([{ cwd: '/p/one', hotkey: 'Ctrl+F11', reason: r }]);
  assert.match(one('system'), /another app/);
  assert.match(one('duplicate'), /more than one project/);
  assert.match(one('reserved'), /picker/);
  assert.match(one('unparsable'), /not a valid hotkey/);
  // Причины сведены в одну строку по группам, а не свалены в кучу.
  const both = hotkeysTakenMessage([
    { cwd: '/p/one', hotkey: 'Ctrl+F11', reason: 'system' },
    { cwd: '/p/two', hotkey: 'Ctrl+F12', reason: 'duplicate' },
  ]);
  assert.ok(both.includes('Ctrl+F11') && both.includes('Ctrl+F12'), both);
  assert.match(both, /another app/);
  assert.match(both, /more than one project/);
});

// «Ctrl+F11, Ctrl+F12 is taken» — то, что выходило раньше на любом втором
// отказе: одна формулировка на любое число клавиш.
test('число клавиш и число в сказуемом сходятся', () => {
  const single = hotkeysTakenMessage([{ cwd: '/p/one', hotkey: 'Ctrl+F11', reason: 'system' }]);
  assert.match(single, /^Ctrl\+F11 is taken by another app$/);
  const many = hotkeysTakenMessage([
    { cwd: '/p/one', hotkey: 'Ctrl+F11', reason: 'system' },
    { cwd: '/p/two', hotkey: 'Ctrl+F12', reason: 'system' },
  ]);
  assert.match(many, /^Ctrl\+F11, Ctrl\+F12 are taken by another app$/);
});

// Дважды названная клавиша приезжает записью на каждого проигравшего: три
// проекта на одном Ctrl+F11 дали бы «Ctrl+F11, Ctrl+F11 are…».
test('одна и та же комбинация называется в строке один раз', () => {
  const message = hotkeysTakenMessage([
    { cwd: '/p/two', hotkey: 'Ctrl+F11', reason: 'duplicate' },
    { cwd: '/p/three', hotkey: 'Ctrl+F11', reason: 'duplicate' },
  ]);
  assert.match(message, /^Ctrl\+F11 is set on more than one project$/);
});

test('пустой список занятых — пустая строка, а не пустое обещание', () => {
  assert.strictEqual(hotkeysTakenMessage([]), '');
  assert.strictEqual(hotkeysTakenMessage(undefined), '');
});
