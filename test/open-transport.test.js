const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseOpenTransport } = require('../frontend-src/open-transport');

test('свой хост — открываем через менеджер', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'pc-win'), 'manager');
});

test('регистр и пробелы не мешают', () => {
  assert.equal(chooseOpenTransport({ windowHost: ' pc-win ' }, 'PC-Win'), 'manager');
});

test('чужой хост — открываем локально', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'macbook'), 'local');
});

test('пустой windowHost в конфиге — локально', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, ''), 'local');
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, undefined), 'local');
});

test('нет ответа агрегатора — локально', () => {
  assert.equal(chooseOpenTransport(null, 'pc-win'), 'local');
  assert.equal(chooseOpenTransport({}, 'pc-win'), 'local');
});

test('pid трекера на выбор не влияет', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'pc-win', windowPid: 0 }, 'pc-win'), 'manager');
});
