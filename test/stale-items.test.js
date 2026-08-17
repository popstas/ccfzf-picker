const { test } = require('node:test');
const assert = require('node:assert');
const { isStale, staleClass } = require('../frontend-src/stale-items');

const NOW = 2_000_000;
const STALE = { enabled: true, sessionHours: 2, projectHours: 24, opacity: 0.5 };

test('сессия становится старой ровно на пороге', () => {
  assert.strictEqual(isStale({ lastActivity: NOW - 7199 }, NOW, STALE, 'session'), false);
  assert.strictEqual(isStale({ lastActivity: NOW - 7200 }, NOW, STALE, 'session'), true);
  assert.strictEqual(staleClass({ lastActivity: NOW - 7200 }, NOW, STALE, 'session'), ' stale');
});

test('live и window не дают исключений старой сессии', () => {
  for (const row of [
    { lastActivity: NOW - 7200, live: true, window: { id: 1 } },
    { lastActivity: NOW - 7200, live: true },
    { lastActivity: NOW - 7200, live: false, window: { id: 1 } },
    { lastActivity: NOW - 7200, live: false },
  ]) {
    assert.strictEqual(isStale(row, NOW, STALE, 'session'), true, JSON.stringify(row));
  }
});

test('проект становится stale на часовом пороге включительно', () => {
  assert.strictEqual(
    isStale({ lastActivity: NOW - 24 * 3600 + 1 }, NOW, STALE, 'project'),
    false,
  );
  assert.strictEqual(
    isStale({ lastActivity: NOW - 24 * 3600 }, NOW, STALE, 'project'),
    true,
  );
});

test('выключенный режим и неизвестный возраст не затемняют', () => {
  assert.strictEqual(
    isStale({ lastActivity: NOW - 999999 }, NOW, { ...STALE, enabled: false }, 'session'),
    false,
  );
  for (const lastActivity of [undefined, null, 0, 'bad', NOW + 1]) {
    assert.strictEqual(isStale({ lastActivity }, NOW, STALE, 'session'), false);
  }
  assert.strictEqual(isStale({ lastActivity: NOW - 999999 }, NOW, STALE, 'zellij'), false);
  assert.strictEqual(staleClass({}, NOW, STALE, 'session'), '');
});

test('логический и строковый lastActivity не считаются возрастом', () => {
  for (const lastActivity of [true, false, String(NOW - 7200)]) {
    assert.strictEqual(isStale({ lastActivity }, NOW, STALE, 'session'), false);
  }
});
