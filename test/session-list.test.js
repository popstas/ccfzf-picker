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
  assert.strictEqual(rows[0].agentState, 'question');
  assert.strictEqual(rows[0].agentEvent, 'stop');
  assert.strictEqual(rows[0].agentDescription, 'Готово');
  assert.strictEqual(rows[0].agentPrompt, 'сделай');
  assert.strictEqual(rows[0].branch, 'feat/x');
  assert.strictEqual(rows[0].pr_url, 'https://github.com/o/r/pull/3');
  assert.strictEqual(rows[0].agentCostUsd, 2);
  assert.strictEqual(rows[0].agentContextPct, 10);
  assert.strictEqual(rows[0].lastActivity, 500);
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
  assert.strictEqual(rows[0].agentDescription, 'работаю');
  assert.strictEqual(rows[0].agentBackground, true);
  assert.strictEqual(rows[0].agentSessionId, 'c');
});

// agentSeen — «человек это видел», обратное прежнему unread. Полярность
// проверяется с обеих сторон: отметки нет и отметка старше записи — не видел,
// отметка той же секунды — видел (сравнение нестрогое, см. seenSinceUpdate).
test('agentSeen считается по отметке открытия и означает «видел»', () => {
  const sessions = [state({ id: 'a', agent: { updated: 500, summary: 'ответ' } })];
  assert.strictEqual(buildSessionList({ sessions, seen: {} })[0].agentSeen, false);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 499 } })[0].agentSeen, false);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 500 } })[0].agentSeen, true);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 900 } })[0].agentSeen, true);
});

test('отметка открытия попадает в строку', () => {
  const sessions = [state({ id: 'a', agent: { updated: 500 } })];
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 700 } })[0].focusedAt, 700);
  assert.strictEqual(buildSessionList({ sessions, seen: {} })[0].focusedAt, 0);
});

// Записи агента нет — сессия не считается ни просмотренной, ни зовущей: звать
// нечему, потому что и кружок, и текст статуса завязаны на пустой agentState
// (это проверяет test/row-contract.test.js на настоящих отрисовщиках).
test('сессия без записи агента не бывает ни просмотренной, ни зовущей', () => {
  const rows = buildSessionList({ sessions: [state({ agent: null })], seen: {} });
  assert.strictEqual(rows[0].agentSeen, false);
  assert.strictEqual(rows[0].agentState, '');
  assert.strictEqual(rows[0].agentEvent, '');
  assert.strictEqual(rows[0].agentDescription, '');
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

// Фоновый агент отвечает за turnAt/message/question/state — это его работа
// показывается в строке. Но started — про саму строку, а не про того, кто в
// ней сейчас работает: старт принадлежит сессии, и увод в форк его не меняет.
test('agentStarted берётся у самой сессии, а не у фонового агента', () => {
  const rows = buildSessionList({
    sessions: [
      state({ id: 'p', agent: { updated: 100, started: 50, turnAt: 40, summary: 'ушёл в фон' } }),
      state({ id: 'c', kind: 'background', parent: 'p',
              agent: { updated: 200, started: 999, turnAt: 150, summary: 'работаю' } }),
    ],
    seen: {},
  });
  assert.strictEqual(rows[0].agentStarted, 50);
  assert.strictEqual(rows[0].agentTurnAt, 150);
});

test('поля хода, старта и уведомления доезжают до строки', () => {
  const rows = buildSessionList({
    sessions: [state({ agent: {
      state: 'active', updated: 500, turnAt: 400, started: 100,
      message: 'Claude needs your permission to use Bash',
    } })],
    seen: {},
  });
  assert.strictEqual(rows[0].agentTurnAt, 400);
  assert.strictEqual(rows[0].agentStarted, 100);
  assert.strictEqual(rows[0].agentMessage, 'Claude needs your permission to use Bash');
});

// Сессия, поднятая до появления этих полей: ноль и пустая строка значат
// «данных нет», и каждый читатель это переживает — колонка возраста
// откатывается на lastActivity, строки карточки просто не печатаются.
test('без новых полей строка отдаёт умолчания, а не undefined', () => {
  const withAgent = buildSessionList({
    sessions: [state({ agent: { state: 'idle', updated: 500 } })], seen: {},
  })[0];
  assert.strictEqual(withAgent.agentTurnAt, 0);
  assert.strictEqual(withAgent.agentStarted, 0);
  assert.strictEqual(withAgent.agentMessage, '');

  const noAgent = buildSessionList({ sessions: [state({ agent: null })], seen: {} })[0];
  assert.strictEqual(noAgent.agentTurnAt, 0);
  assert.strictEqual(noAgent.agentStarted, 0);
  assert.strictEqual(noAgent.agentMessage, '');
});
