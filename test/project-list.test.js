const { test } = require('node:test');
const assert = require('node:assert');
const { buildProjectList, markHotkeysTaken } = require('../frontend-src/project-list');

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

// markHotkeysTaken — общий помощник для события project-hotkeys и разового
// опроса project_hotkeys_taken на старте страницы: обе ветки применяют один и
// тот же список к строкам одним и тем же способом.
test('markHotkeysTaken помечает только те строки, чья клавиша не встала', () => {
  const rows = [{ hotkey: 'Ctrl+F11' }, { hotkey: 'Ctrl+F12' }, { hotkey: '' }];
  markHotkeysTaken(rows, new Set(['Ctrl+F11']));
  assert.deepStrictEqual(rows.map(r => r.hotkeyTaken), [true, false, false]);
});

test('markHotkeysTaken принимает обычный массив — не только Set', () => {
  // Событие приезжает массивом (JSON), а разовый опрос на старте — тем же
  // массивом из ответа Rust; заставлять вызывающего оборачивать его в Set
  // самому значило бы копию этой строки в двух местах.
  const rows = [{ hotkey: 'Ctrl+F11' }];
  markHotkeysTaken(rows, ['Ctrl+F11']);
  assert.strictEqual(rows[0].hotkeyTaken, true);
});

test('markHotkeysTaken на пустом списке занятых снимает пометку со всех', () => {
  const rows = [{ hotkey: 'Ctrl+F11', hotkeyTaken: true }];
  markHotkeysTaken(rows, []);
  assert.strictEqual(rows[0].hotkeyTaken, false);
});
