const { test } = require('node:test');
const assert = require('node:assert');
const { availableActions, prNumber } = require('../frontend-src/session-actions');
const { prBadgeHtml } = require('../frontend-src/session-glyph');

test('информация о сессии есть всегда', () => {
  const ids = availableActions({ id: 'a' }).map(a => a.id);
  assert.deepStrictEqual(ids, ['info']);
});

test('PR предлагается, когда ссылка разбирается в номер', () => {
  const actions = availableActions({ id: 'a', pr_url: 'https://github.com/o/r/pull/42' });
  const pr = actions.find(a => a.id === 'pr');
  assert.strictEqual(pr.label, 'Open PR #42');
});

test('мусор вместо ссылки на PR пункта не даёт', () => {
  const ids = availableActions({ id: 'a', pr_url: 'не ссылка' }).map(a => a.id);
  assert.ok(!ids.includes('pr'));
});

// «Читали» на маке — это agentSeen: отметку ставит открытие сессии, и она же
// гасит кружок. Возврат в непрочитанное бессмыслен и без записи агента
// (lastActivity === 0: нечего отматывать), и у строки, которая и так непрочитана.
test('вернуть в непрочитанное можно только то, что читали', () => {
  const unread = row => availableActions(row).some(x => x.id === 'unread');
  assert.ok(unread({ id: 'a', agentSeen: true, lastActivity: 5 }));
  assert.ok(!unread({ id: 'a', agentSeen: false, lastActivity: 5 }));
  assert.ok(!unread({ id: 'a', agentSeen: true, lastActivity: 0 }));
});

// Пункт меню и бейдж в строке разбирают одну и ту же ссылку. Пока номер им даёт
// одна функция, разойтись они не могут — тест сторожит именно это: ссылка,
// которая дала бейдж, обязана дать и пункт меню, и наоборот.
test('пункт меню и бейдж PR судят по ссылке одинаково', () => {
  const links = [
    'https://github.com/o/r/pull/3',
    'https://github.com/o/r/pull/3/files',
    'https://github.com/o/r/pull/',
    'http://github.com/o/r/pull/3',
    'https://github.com/o/r/issues/3',
    '',
  ];
  for (const pr_url of links) {
    const inMenu = availableActions({ id: 'a', pr_url }).some(x => x.id === 'pr');
    const inRow = prBadgeHtml({ pr_url }) !== '';
    assert.strictEqual(inMenu, inRow, `расходятся на ${pr_url || '(пусто)'}`);
    assert.strictEqual(inMenu, prNumber(pr_url) !== '');
  }
});
