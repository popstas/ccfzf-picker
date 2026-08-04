const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionInfoRows } = require('../frontend-src/session-info');

const session = {
  id: 'abc-123',
  label: 'ccfzf',
  cwd: '/home/user/projects/shell/ccfzf',
  live: true,
  agentState: 'review',
  agentEvent: 'stop',
  agentMessage: '',
  agentPrompt: 'почини сборку',
  agentDescription: 'Готово — сборка зелёная',
  agentCostUsd: 3,
  agentContextPct: 41,
  agentStarted: 1000,
  agentBackground: false,
  agentSessionId: 'abc-123',
  lastActivity: 3400,
  focusedAt: 3000,
  agentSeen: false,
  branch: 'feat/x',
  pr_url: 'https://github.com/popstas/ccfzf/pull/3',
};

function valueOf(rows, label) {
  return rows.find(r => r.label === label)?.value;
}

test('buildSessionInfoRows shows the fields a row cannot fit', () => {
  const rows = buildSessionInfoRows(session, 3460);
  assert.strictEqual(valueOf(rows, 'id'), 'abc-123');
  assert.strictEqual(valueOf(rows, 'event'), 'stop');
  assert.strictEqual(valueOf(rows, 'branch'), 'feat/x');
  assert.strictEqual(valueOf(rows, 'pr_url'), 'https://github.com/popstas/ccfzf/pull/3');
});

// На маке нет окон — карточка описывает процесс, а не окно: "process: live"
// вместо "window: open · hwnd N". См. session-glyph.js о том же сдвиге
// смысла для statusDotHtml/stateText.
test('buildSessionInfoRows describes the process instead of a window', () => {
  assert.strictEqual(valueOf(buildSessionInfoRows(session, 3460), 'process'), 'live');
  assert.strictEqual(
    valueOf(buildSessionInfoRows({ ...session, live: false }, 3460), 'process'),
    'not running',
  );
});

test('buildSessionInfoRows prints timestamps as clock plus age', () => {
  const rows = buildSessionInfoRows(session, 3460);
  // 3400 — минута назад относительно 3460.
  assert.match(valueOf(rows, 'last activity'), /^\d{2}:\d{2} · 1m$/);
});

test('buildSessionInfoRows skips fields the session does not have', () => {
  const rows = buildSessionInfoRows(
    { id: 'x', label: 'x', cwd: '', live: false },
    100,
  );
  const labels = rows.map(r => r.label);
  assert.ok(!labels.includes('pr_url'));
  assert.ok(!labels.includes('branch'));
  assert.ok(labels.includes('id'));
});

test('buildSessionInfoRows names the background agent that answers for the session', () => {
  const rows = buildSessionInfoRows(
    { ...session, agentBackground: true, agentSessionId: 'fork-9' },
    3460,
  );
  assert.strictEqual(valueOf(rows, 'agent'), 'background · fork-9');
});

test('buildSessionInfoRows reports whether the state was seen', () => {
  assert.strictEqual(valueOf(buildSessionInfoRows(session, 3460), 'seen'), 'no');
  assert.strictEqual(
    valueOf(buildSessionInfoRows({ ...session, agentSeen: true }, 3460), 'seen'),
    'yes',
  );
});

test('buildSessionInfoRows spells recent activity in seconds', () => {
  const rows = buildSessionInfoRows(
    { ...session, lastActivity: 3459 }, // 1 сек назад
    3460,
  );
  assert.match(valueOf(rows, 'last activity'), /^\d{2}:\d{2} · 1s$/);
});

test('buildSessionInfoRows skips zero timestamps', () => {
  const rows = buildSessionInfoRows(
    {
      id: 'x',
      label: 'x',
      cwd: '/p',
      live: false,
      agentStarted: 0,
      lastActivity: 0,
      focusedAt: 0,
    },
    100,
  );
  const labels = rows.map(r => r.label);
  assert.ok(!labels.includes('started'));
  assert.ok(!labels.includes('last activity'));
  assert.ok(!labels.includes('focused'));
});

test('buildSessionInfoRows omits agent field when background is true but sessionId is missing', () => {
  const rows = buildSessionInfoRows(
    { ...session, agentBackground: true, agentSessionId: undefined },
    3460,
  );
  const labels = rows.map(r => r.label);
  assert.ok(!labels.includes('agent'));
});
