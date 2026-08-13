const { test } = require('node:test');
const assert = require('node:assert');
const { GLYPHS, iconSpecs, actionIcon } = require('../frontend-src/action-icons');
const { availableActions } = require('../frontend-src/session-actions');

// Сторож на будущее: новый встроенный пункт приедет в меню без значка, и
// заметить это можно только глазами на той машине, где пикер стоит. Список
// id берётся не из BUILTIN_ACTION_KEYS (там только те, у кого есть прямая
// клавиша — `open-remote` в неё уже пришлось дописывать руками), а прямым
// вызовом availableActions на строке, у которой есть всё сразу: живая сессия
// с pid (даёт attach), cwd (даёт new), pr_url с номером PR (даёт pr),
// lastActivity и agentSeen (даёт unread) — info в списке всегда.
test('у каждого встроенного пункта есть глиф', () => {
  const row = {
    kind: 'session',
    cwd: '/home/user/projects/ccfzf',
    live: true,
    pid: 4242,
    pr_url: 'https://github.com/popstas/ccfzf/pull/3',
    lastActivity: 1785870255,
    agentSeen: 1785870300,
  };
  const ids = availableActions(row).map(a => a.id);
  assert.ok(ids.length > 1, 'availableActions вернул слишком мало — тест сторожит не то');
  for (const id of ids) {
    assert.ok(GLYPHS[id], `нет глифа для встроенного пункта ${id}`);
  }
  // `open-remote` availableActions не отдаёт вовсе — этот пункт добавляет
  // страница (окно уже открыто на этой машине), а не сборка списка действий.
  // Дописан руками, потому и особый.
  assert.ok(GLYPHS['open-remote'], 'нет глифа для open-remote');
});

test('icon перевешивает argv[0], а без него берётся argv[0]', () => {
  const specs = iconSpecs({ actions: [
    { id: 'explorer', icon: '%SystemRoot%\\explorer.exe', argv: ['cmd', '/c', 'start'] },
    { id: 'cursor', icon: '', argv: ['Cursor.exe', '{localPath}'] },
  ] });
  assert.deepStrictEqual(
    specs.filter(s => s.id !== 'new'),
    [
      { id: 'explorer', path: '%SystemRoot%\\explorer.exe' },
      { id: 'cursor', path: 'Cursor.exe' },
    ],
  );
});

// Пункт `new` в конфиге не описан вовсе, а иконку у него взять есть откуда —
// у агента. На машине без агента запрос вернётся пустым, и встанет глиф.
test('new спрашивается всегда, даже с пустым конфигом', () => {
  assert.deepStrictEqual(iconSpecs(null), [{ id: 'new', path: 'claude.exe' }]);
});

test('действие без icon и без argv в запрос не попадает', () => {
  const specs = iconSpecs({ actions: [{ id: 'broken', icon: '', argv: [] }] });
  assert.deepStrictEqual(specs.map(s => s.id), ['new']);
});

test('картинка выигрывает у глифа, когда она есть', () => {
  const icon = actionIcon({ id: 'info' }, { info: 'data:image/png;base64,AAA' });
  assert.deepStrictEqual(icon, { kind: 'img', src: 'data:image/png;base64,AAA' });
});

test('без картинки встаёт глиф пункта, у неизвестного — запасной', () => {
  assert.deepStrictEqual(actionIcon({ id: 'info' }, {}), { kind: 'glyph', text: 'ⓘ', cls: '' });
  assert.deepStrictEqual(actionIcon({ id: 'unread' }, {}), { kind: 'glyph', text: '●', cls: 'unread' });
  assert.deepStrictEqual(actionIcon({ id: 'whatever' }, {}), { kind: 'glyph', text: '▸', cls: '' });
});
