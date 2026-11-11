'use strict';
// Подсвеченная строка уходит в Rust: хоткей раскладки группы жмут при
// открытом пикере, а спросить страницу в этот момент Rust не может — обработчик
// клавиши живёт у него, и страница на скрытом окне вообще спит.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSelectionSync } = require('../frontend-src/picker-selection.js');

test('выбор уходит в Rust только при смене строки', () => {
  const sent = [];
  const s = createSelectionSync(id => sent.push(id));
  s.sync('a'); s.sync('a'); s.sync('b'); s.sync(undefined); s.sync('');
  assert.deepStrictEqual(sent, ['a', 'b', null]);
});

test('после гашения тот же выбор посылается заново', () => {
  // Rust забывает выбор на гашении окна; страница обязана прислать его снова
  // при следующем показе, даже если строка та же.
  const sent = [];
  const s = createSelectionSync(id => sent.push(id));
  s.sync('a'); s.reset(); s.sync('a');
  assert.deepStrictEqual(sent, ['a', 'a']);
});

test('страница шлёт выбор из paint и сбрасывает его на picker-hidden', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const paint = html.split('function paint() {')[1].split('\n  }\n')[0];
  assert.match(paint, /selectionSync\.sync\(\(rows\[active\] \|\| \{\}\)\.id\)/,
    'paint() — единственное место смены выбора, и синк обязан стоять в нём');
  const hidden = html.split("listen('picker-hidden'")[1].split('});')[0];
  assert.match(hidden, /selectionSync\.reset\(\)/);
  assert.match(html, /<script src="picker-selection\.js"><\/script>/);
  const prep = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-frontend.js'), 'utf8');
  assert.match(prep, /'frontend-src\/picker-selection\.js'/, 'без строки в FILES файл не доедет до бинаря');
});
