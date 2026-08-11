const { test } = require('node:test');
const assert = require('node:assert');
const { PAGES, configToFields, fieldsToPatch, validate } = require('../frontend-src/settings-form');

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

test('галка без ключа в конфиге показывает своё умолчание, а не false', () => {
  // onlyLive, hideOnBlur и backgroundRefresh при отсутствии ключа считаются
  // включёнными — так их читают и DEFAULTS в config-shape.js, и Rust через
  // unwrap_or(true). Пустая галка показывала бы выключенным то, что работает
  // включённым, и проверить это можно было бы только по поведению пикера.
  const fields = configToFields({ sshHost: 'host' });
  for (const id of ['onlyLive', 'hideOnBlur', 'backgroundRefresh']) {
    assert.strictEqual(fields[id], true, id);
  }
  // А те, у кого умолчание false, остаются пустыми: незнание про ту сторону
  // ведёт к resume, а не к перехвату чужого процесса под сигналом.
  assert.strictEqual(fields['caps.reptyr'], false);
  assert.strictEqual(fields['caps.takeover'], false);
});

test('умолчание галки не уезжает в патч само по себе', () => {
  // Иначе первое же сохранение вписало бы человеку в config.yaml три ключа,
  // которых он не трогал, — а файл этот ведёт окно и комментарии в нём при
  // перезаписи теряются. Снятая галка при этом обязана дойти.
  const original = { sshHost: 'host' };
  const fields = configToFields(original);
  assert.deepStrictEqual(fieldsToPatch(fields, original), {});
  assert.deepStrictEqual(
    fieldsToPatch({ ...fields, hideOnBlur: false }, original),
    { hideOnBlur: false },
  );
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

test('стёртое числовое поле не превращается в 0', () => {
  // `Number('')` в JS даёт 0 — но стёртое поле порта значит «не трогали»,
  // а не «порт 0»: 0 — недопустимый порт брокера, и сохранить его молча
  // значит сломать mqtt так, что ни одна проверка формы этого не поймает.
  const original = { mqtt: { host: 'broker', port: 1883, base: 'home/room/pc' } };
  const fields = configToFields(original);
  assert.strictEqual(fields['mqtt.port'], 1883);
  const patch = fieldsToPatch({ ...fields, 'mqtt.port': '  ' }, original);
  assert.deepStrictEqual(patch, {});
});

test('число, отданное строкой из DOM, не считается изменением', () => {
  // Настоящий <input type="number"> (C6) всегда отдаёт value строкой.
  // Сравнение должно идти по приведённым значениям, иначе "1883" от DOM и
  // сохранённое число 1883 считались бы разным — и нетронутое поле порта
  // попадало бы в патч при каждом сохранении.
  const original = { mqtt: { host: 'broker', port: 1883, base: 'home/room/pc' } };
  const fields = configToFields(original);
  const patch = fieldsToPatch({ ...fields, 'mqtt.port': '1883' }, original);
  assert.deepStrictEqual(patch, {});
});

test('пустой хост — отказ, а не пустой список', () => {
  // Без sshHost список брать неоткуда, и сохранить такое молча значит отдать
  // человеку пикер, который не работает и не говорит почему.
  const problems = validate({ ...configToFields({}), sshHost: '  ' });
  assert.ok(problems.some(p => p.includes('sshHost')), problems.join('; '));
});

test('комбинация, занятая самим окном пикера, не проходит', () => {
  // Ctrl+K — меню сессии внутри окна. Настроенный на неё глобальный хоткей
  // молча не сработал бы: окно забирает нажатие себе.
  const problems = validate({ ...configToFields({ sshHost: 'h' }), hotkey: 'Ctrl+K' });
  assert.ok(problems.some(p => p.includes('Ctrl+K')), problems.join('; '));
});

test('исправная форма претензий не вызывает', () => {
  assert.deepStrictEqual(validate(configToFields({ sshHost: 'host' })), []);
});
