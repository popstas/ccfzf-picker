const { test } = require('node:test');
const assert = require('node:assert');
const { canFocus, focusPid } = require('../frontend-src/session-windows');

const STATE = { windowHost: 'desktop-box', windowPid: 4242, sessions: [] };

test('окна на этой же машине — окно поднимается', () => {
  assert.strictEqual(canFocus(STATE, 'desktop-box'), true);
});

test('имя машины сверяется без оглядки на регистр и пробелы', () => {
  // Одну сторону пишет os.hostname(), другую — человек в yaml. Регистр в именах
  // машин Windows не значит ничего, а пробел по краям не виден вовсе.
  assert.strictEqual(canFocus(STATE, 'Desktop-Box'), true);
  assert.strictEqual(canFocus(STATE, '  desktop-box  '), true);
  assert.strictEqual(canFocus({ ...STATE, windowHost: 'DESKTOP-BOX' }, 'desktop-box'), true);
});

test('окна на чужой машине — Enter остаётся открытием терминала', () => {
  // Здесь и проходит граница. Ошибка в эту сторону отняла бы у Enter открытие
  // терминала на маке, ничего не дав взамен: окно поднялось бы на том экране,
  // на который человек не смотрит.
  assert.strictEqual(canFocus(STATE, 'macbook'), false);
});

test('пустой хост в конфиге запрещает фокус', () => {
  // Умолчание. Пикер, которому не сказали, на какой он машине, обязан вести
  // себя как до появления всей этой затеи.
  for (const mine of ['', '   ', undefined, null, 42]) {
    assert.strictEqual(canFocus(STATE, mine), false, String(mine));
  }
});

test('пустой хост в ответе тоже запрещает фокус', () => {
  // Оконного трекера нет, файл просрочен или его никто не пишет. Совпадение
  // двух пустот совпадением не считается.
  for (const host of ['', undefined, null, 7]) {
    assert.strictEqual(canFocus({ ...STATE, windowHost: host }, ''), false, String(host));
  }
});

test('без pid фокуса не бывает даже на своей машине', () => {
  // Право на передний план выдаётся по pid. Без него подъём отчитался бы об
  // успехе, а на экране мигнула бы кнопка на таскбаре: молча не сработавший
  // Enter хуже прежнего поведения.
  for (const pid of [0, -1, undefined, null, '4242', NaN]) {
    assert.strictEqual(canFocus({ ...STATE, windowPid: pid }, 'desktop-box'), false, String(pid));
  }
});

test('ответа нет вовсе — фокуса нет', () => {
  for (const state of [null, undefined, {}, 'мусор']) {
    assert.strictEqual(canFocus(state, 'desktop-box'), false, String(state));
  }
});

test('focusPid отдаёт ноль всему, что не положительное число', () => {
  assert.strictEqual(focusPid(STATE), 4242);
  for (const state of [null, {}, { windowPid: 0 }, { windowPid: '9' }, { windowPid: -3 }]) {
    assert.strictEqual(focusPid(state), 0, JSON.stringify(state));
  }
});
