const { test } = require('node:test');
const assert = require('node:assert');
const { PAGES, configToFields, fieldsToPatch } = require('../frontend-src/settings-form');

test('страницы перечисляют поля без повторов', () => {
  // Одно поле на двух страницах означало бы два источника правды для одного
  // ключа: сохранив одну страницу, человек молча откатил бы вторую.
  const ids = PAGES.flatMap(p => p.fields.map(f => f.id));
  assert.deepStrictEqual([...new Set(ids)], ids);
  assert.deepStrictEqual(PAGES.map(p => p.id), ['general', 'ui', 'hotkeys', 'integrations']);
});

test('конфиг раскладывается по полям формы', () => {
  const fields = configToFields({
    sshHost: 'host',
    terminal: { file: '/usr/bin/wt', args: ['-w', '0'] },
    onlyLive: false,
    mqtt: { host: 'broker', port: 1883, base: 'home/room/pc', password: 'secret' },
  });
  assert.strictEqual(fields.sshHost, 'host');
  assert.strictEqual(fields['terminal.file'], '/usr/bin/wt');
  // Аргументы редактируются строкой по одному на строку: массив в поле ввода
  // не положить, а запятая встречается в самих аргументах.
  assert.strictEqual(fields['terminal.args'], '-w\n0');
  assert.strictEqual(fields.onlyLive, false);
  assert.strictEqual(fields['mqtt.port'], 1883);
  // Пароль в форму не кладётся вовсе: он ездил бы через мост в webview на
  // каждое открытие настроек, а показывать его незачем.
  assert.strictEqual(fields['mqtt.password'], '');
});

test('в патч уходит только изменённое', () => {
  const original = { sshHost: 'host', onlyLive: true };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, sshHost: 'other' }, original),
    { sshHost: 'other' },
  );
});

test('пустой пароль не уезжает в патч', () => {
  // Иначе первое же сохранение стёрло бы настроенный пароль брокера — а
  // заметить это можно только по молчащему Enter на чужой машине.
  const original = { mqtt: { host: 'broker', base: 'home/room/pc' } };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  const patch = fieldsToPatch({ ...fields, 'mqtt.password': 'новый' }, original);
  assert.deepStrictEqual(patch, { mqtt: { password: 'новый' } });
});

test('строка аргументов возвращается массивом', () => {
  const original = { terminal: { file: '/usr/bin/wt', args: [] } };
  const patch = fieldsToPatch({ ...configToFields(original), 'terminal.args': '-w\n0' }, original);
  assert.deepStrictEqual(patch, { terminal: { args: ['-w', '0'] } });
});

test('проекты редактируются списком', () => {
  const original = { projects: [{ path: '/a', hotkey: 'Cmd+Shift+1' }] };
  const fields = configToFields(original);
  assert.deepStrictEqual(fields.projects, [{ path: '/a', hotkey: 'Cmd+Shift+1' }]);
  const patch = fieldsToPatch({ ...fields, projects: [{ path: '/b', hotkey: '' }] }, original);
  assert.deepStrictEqual(patch, { projects: [{ path: '/b', hotkey: '' }] });
});
