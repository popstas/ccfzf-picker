const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeWindows, withWindows, isLoopback } = require('../frontend-src/session-windows');

const ANSWER = {
  running: true,
  pid: 4242,
  slots: [
    { id: 'aaa', title: 'ccfzf-picker', desktop: 2, lastSeen: 1000 },
    { id: 'bbb', title: 'shell', desktop: 0, lastSeen: 2000 },
  ],
};

test('ответ трекера становится справочником по id', () => {
  assert.deepStrictEqual(normalizeWindows(ANSWER), {
    aaa: { title: 'ccfzf-picker', desktop: 2, lastSeen: 1000 },
    bbb: { title: 'shell', desktop: 0, lastSeen: 2000 },
  });
});

test('ответа нет или он не той формы — справочник пустой', () => {
  // Трекер погашен, машина спит, кто-то подсунул html вместо json. Ни один из
  // этих случаев не должен стоить списка: пикер просто рисует его без пометок.
  for (const raw of [null, undefined, {}, 'мусор', { slots: 'мусор' }, { slots: null }]) {
    assert.deepStrictEqual(normalizeWindows(raw), {});
  }
});

test('слот без id выбрасывается целиком', () => {
  // По id идёт вся склейка. Слот, которому нечего склеивать, не пометит ничего,
  // зато занял бы ключ `undefined` и склеился бы с любой строкой без id.
  const raw = { slots: [{ title: 'нет id' }, { id: 42 }, { id: '' }, { id: 'ok', title: 'x' }] };
  assert.deepStrictEqual(normalizeWindows(raw), { ok: { title: 'x', desktop: null, lastSeen: 0 } });
});

test('нечисловые стол и отметка заменяются умолчанием', () => {
  const raw = { slots: [{ id: 'a', title: 'x', desktop: 'два', lastSeen: 'давно' }] };
  assert.deepStrictEqual(normalizeWindows(raw), { a: { title: 'x', desktop: null, lastSeen: 0 } });
});

test('строки получают своё окно, остальные — null', () => {
  const rows = [{ id: 'aaa', title: 'первая' }, { id: 'zzz', title: 'вторая' }];
  const out = withWindows(rows, normalizeWindows(ANSWER));
  assert.deepStrictEqual(out[0].window, { title: 'ccfzf-picker', desktop: 2, lastSeen: 1000 });
  assert.strictEqual(out[1].window, null);
  // Исходные строки не правятся на месте: их же держит lastSessions между
  // тиками, и пометка от прошлого ответа пережила бы погасший трекер.
  assert.strictEqual(rows[0].window, undefined);
});

test('без справочника у всех строк окна нет', () => {
  const rows = [{ id: 'aaa' }];
  assert.strictEqual(withWindows(rows, {})[0].window, null);
  assert.strictEqual(withWindows(rows, null)[0].window, null);
  assert.deepStrictEqual(withWindows(null, {}), []);
});

test('петлевой адрес узнаётся со схемой, портом и в скобках', () => {
  for (const url of [
    'http://localhost:9722',
    'http://127.0.0.1:9722',
    'http://localhost',
    'localhost:9722',
    'http://[::1]:9722',
    'http://127.0.0.1:9722/',
  ]) {
    assert.strictEqual(isLoopback(url), true, url);
  }
});

test('чужая машина петлевым адресом не считается', () => {
  // Здесь и проходит граница «поднимать окно по Enter или нет»: ошибка в эту
  // сторону отняла бы у Enter открытие терминала на маке.
  for (const url of [
    'http://desktop:9722',
    'http://192.168.1.10:9722',
    'http://[::2]:9722',
    'http://localhost.example.com:9722',
    '',
    null,
    42,
  ]) {
    assert.strictEqual(isLoopback(url), false, String(url));
  }
});
