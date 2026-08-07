const { test } = require('node:test');
const assert = require('node:assert');
const { availableActions, prNumber } = require('../frontend-src/session-actions');
const { prBadgeHtml } = require('../frontend-src/session-glyph');

// Конфиг с одним настроенным действием открытия. UNC вместо буквы диска — см.
// комментарий в test/path-map.test.js.
const CONFIGURED = {
  pathMap: { remote: '/home/user', local: '\\\\nas\\home' },
  actions: [{ id: 'explorer', label: 'Open in Explorer', hotkey: 'Ctrl+Shift+E', argv: ['x'] }],
};

test('информация о сессии есть всегда', () => {
  const ids = availableActions({ id: 'a' }).map(a => a.id);
  assert.deepStrictEqual(ids, ['info']);
});

test('без конфига список действий прежний', () => {
  // Второй аргумент необязателен: вызов остаётся годным там, где конфига под
  // рукой нет.
  const row = { id: 'a', cwd: '/home/user/x' };
  assert.deepStrictEqual(availableActions(row).map(a => a.id), ['new', 'info']);
  assert.deepStrictEqual(availableActions(row, {}).map(a => a.id), ['new', 'info']);
});

test('настроенные действия идут первыми, когда путь переводится', () => {
  const ids = availableActions({ id: 'a', cwd: '/home/user/x' }, CONFIGURED).map(a => a.id);
  assert.deepStrictEqual(ids, ['explorer', 'new', 'info']);
});

test('сессия вне общего дерева настроенных действий не получает', () => {
  // Пункт, открывающий несуществующую папку, хуже отсутствующего.
  const ids = availableActions({ id: 'a', cwd: '/etc/nginx' }, CONFIGURED).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'info']);
});

test('настроенное действие доносит до меню свою подпись и клавишу', () => {
  const [action] = availableActions({ id: 'a', cwd: '/home/user/x' }, CONFIGURED);
  assert.strictEqual(action.label, 'Open in Explorer');
  assert.strictEqual(action.hotkey, 'Ctrl+Shift+E');
});

test('переклейку предлагают только живой сессии с pid', () => {
  const attach = row => availableActions(row).find(a => a.id === 'attach');
  assert.strictEqual(attach({ id: 'a', live: true, pid: 42 }).label, 'Copy reptyr command');
  // Мёртвой тянуть нечего, даже если pid откуда-то остался.
  assert.ok(!attach({ id: 'a', live: false, pid: 42 }));
  assert.ok(!attach({ id: 'a', live: true, pid: 0 }));
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

test('новая сессия предлагается и сессии, и проекту', () => {
  const forSession = availableActions({ id: 'a', cwd: '/p', live: true, pid: 42 })
    .map(a => a.id);
  assert.ok(forSession.includes('new'), forSession);

  const forProject = availableActions({ kind: 'project', id: '/p', cwd: '/p' })
    .map(a => a.id);
  assert.deepStrictEqual(forProject, ['new']);
});

test('строке проекта не предлагают того, чему нужна сессия', () => {
  // PR, «прочитано» и reptyr держатся за запись агента и за pid — у каталога
  // нет ни того, ни другого. Карточка сессии у проекта тоже пуста.
  const ids = availableActions({
    kind: 'project', id: '/p', cwd: '/p',
    pr_url: 'https://github.com/o/r/pull/3', live: true, pid: 42,
    lastActivity: 1, agentSeen: true,
  }).map(a => a.id);
  assert.deepStrictEqual(ids, ['new']);
});

test('у проекта есть действия папки, когда путь переводится', () => {
  const ids = availableActions(
    { kind: 'project', id: '/remote/p', cwd: '/remote/p' },
    { pathMap: { remote: '/remote', local: '/local' },
      actions: [{ id: 'explorer', label: 'Open in Explorer', hotkey: 'Ctrl+Shift+E' }] },
  ).map(a => a.id);
  assert.deepStrictEqual(ids, ['new', 'explorer']);
});
