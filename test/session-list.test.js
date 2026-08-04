const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionList } = require('../frontend-src/session-list');

function state(extra) {
  return Object.assign({
    id: 'a', cwd: '/home/user/x', title: 'Тема', gist: '', doing: '',
    mtime: 100, live: false, frozen: false, kind: 'interactive', parent: '',
    pid: 0, tty: '', tmux: null, agent: null,
  }, extra || {});
}

test('строка собирается из сессии и её записи агента', () => {
  const rows = buildSessionList({
    sessions: [state({ agent: {
      state: 'question', event: 'stop', summary: 'Готово', lastSummary: '',
      prompt: 'сделай', branch: 'feat/x', pr_url: 'https://github.com/o/r/pull/3',
      costUsd: 2, contextPct: 10, updated: 500,
    } })],
    seen: {},
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].summary, 'Готово');
  assert.strictEqual(rows[0].branch, 'feat/x');
  assert.strictEqual(rows[0].prUrl, 'https://github.com/o/r/pull/3');
  assert.strictEqual(rows[0].cost, 2);
  assert.strictEqual(rows[0].contextPct, 10);
  assert.strictEqual(rows[0].updated, 500);
});

test('фоновые агенты не занимают своей строки', () => {
  const rows = buildSessionList({
    sessions: [
      state({ id: 'p', agent: { updated: 100, summary: 'ушёл в фон' } }),
      state({ id: 'c', kind: 'background', parent: 'p',
              agent: { updated: 200, summary: 'работаю' } }),
    ],
    seen: {},
  });
  assert.deepStrictEqual(rows.map(r => r.id), ['p']);
  assert.strictEqual(rows[0].summary, 'работаю');
  assert.strictEqual(rows[0].background, true);
  assert.strictEqual(rows[0].agentSessionId, 'c');
});

test('непрочитанность считается по отметке открытия', () => {
  const sessions = [state({ id: 'a', agent: { updated: 500, summary: 'ответ' } })];
  assert.strictEqual(buildSessionList({ sessions, seen: {} })[0].unread, true);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 499 } })[0].unread, true);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 500 } })[0].unread, false);
});

test('сессия без записи агента не бывает непрочитанной', () => {
  const rows = buildSessionList({ sessions: [state({ agent: null })], seen: {} });
  assert.strictEqual(rows[0].unread, false);
  assert.strictEqual(rows[0].summary, '');
});

test('поля процесса переносятся как есть', () => {
  const rows = buildSessionList({
    sessions: [state({ live: true, pid: 42, tty: '/dev/pts/1', tmux: 'work:2.0' })],
    seen: {},
  });
  assert.strictEqual(rows[0].live, true);
  assert.strictEqual(rows[0].pid, 42);
  assert.strictEqual(rows[0].tty, '/dev/pts/1');
  assert.strictEqual(rows[0].tmux, 'work:2.0');
});

test('пустой список сессий даёт пустой список строк', () => {
  assert.deepStrictEqual(buildSessionList({ sessions: [], seen: {} }), []);
  assert.deepStrictEqual(buildSessionList({}), []);
});
