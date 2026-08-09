const { test } = require('node:test');
const assert = require('node:assert');
const { uniqueSessionName } = require('../frontend-src/session-name');

test('свободное имя берётся как есть', () => {
  assert.strictEqual(uniqueSessionName('ccfzf-picker', []), 'ccfzf-picker');
  assert.strictEqual(uniqueSessionName('ccfzf-picker', ['другая']), 'ccfzf-picker');
});

test('занятое имя получает -2, следующее -3', () => {
  assert.strictEqual(uniqueSessionName('api', ['api']), 'api-2');
  assert.strictEqual(uniqueSessionName('api', ['api', 'api-2']), 'api-3');
  // Дыра в середине занимается, а не перепрыгивается: номер — не счётчик
  // сессий, а первое свободное имя.
  assert.strictEqual(uniqueSessionName('api', ['api', 'api-3']), 'api-2');
});

test('нумерация начинается с двух, а не с единицы', () => {
  // `api-1` человеку читается как «первая из многих», а первая называется
  // просто `api` — иначе имена разъезжаются с тем, что уже открыто.
  assert.notStrictEqual(uniqueSessionName('api', ['api']), 'api-1');
});

test('мусор в списке занятых не мешает', () => {
  // Список собирается из ответа агрегатора: там бывают и пустые заголовки, и
  // не строки вовсе. Уронить на этом выбор имени нельзя — пикер остался бы
  // без новой сессии.
  assert.strictEqual(uniqueSessionName('api', [null, 42, '', '  ', 'api']), 'api-2');
  assert.strictEqual(uniqueSessionName('api', null), 'api');
  assert.strictEqual(uniqueSessionName('api', 'строка'), 'api');
});

test('пустое базовое имя остаётся пустым', () => {
  // Суффикс к пустоте дал бы имя `-2`, и оно ничего не значит. Пустое имя —
  // забота вызывающего: он и решает, запускать ли такую сессию.
  assert.strictEqual(uniqueSessionName('', ['']), '');
  assert.strictEqual(uniqueSessionName(null, []), '');
});

test('лишние пробелы в занятых не создают ложной свободы', () => {
  // Заголовок окна приезжает с той стороны и мог быть записан с пробелом.
  assert.strictEqual(uniqueSessionName('api', [' api ']), 'api-2');
});
