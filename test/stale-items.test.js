const { test } = require('node:test');
const assert = require('node:assert');
const { isStale, staleClass } = require('../frontend-src/stale-items');

const NOW = 2_000_000;
const STALE = { enabled: true, sessionHours: 2, projectHours: 168, opacity: 0.5 };

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

test('проект считается в часах, а не в днях', () => {
  // Порог 2 часа, а не унаследованные 7 суток: если бы SECONDS.project
  // остался 86400 или amount читался как дни, граница ушла бы далеко за эти
  // 7200 секунд.
  const stale = { ...STALE, projectHours: 2 };
  assert.strictEqual(
    isStale({ lastActivity: NOW - 7199 }, NOW, stale, 'project'),
    false,
  );
  assert.strictEqual(
    isStale({ lastActivity: NOW - 7200 }, NOW, stale, 'project'),
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
