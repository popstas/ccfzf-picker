const { test } = require('node:test');
const assert = require('node:assert');
const { GLYPHS, iconSpecs, actionIcon } = require('../frontend-src/action-icons');
const { BUILTIN_ACTION_KEYS } = require('../frontend-src/action-hotkey');

// Сторож на будущее: новый встроенный пункт приедет в меню без значка, и
// заметить это можно только глазами на той машине, где пикер стоит.
// `open-remote` в BUILTIN_ACTION_KEYS нет — у него нет прямой клавиши, но
// строка в меню есть.
test('у каждого встроенного пункта есть глиф', () => {
  for (const id of [...Object.keys(BUILTIN_ACTION_KEYS), 'open-remote']) {
    assert.ok(GLYPHS[id], `нет глифа для встроенного пункта ${id}`);
  }
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
