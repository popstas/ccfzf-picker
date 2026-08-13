const test = require('node:test');
const assert = require('node:assert');
const { canFocusRow, trackerHere, trackerHosts, focusPid } =
  require('../frontend-src/session-windows');

// Ответ нового агрегатора: две машины, у каждой свой трекер.
const STATE = {
  windowHost: 'desktop-box',
  windowPid: 4242,
  windowHosts: [
    { host: 'desktop-box', pid: 4242, canFocus: true },
    { host: 'macbook', pid: 77, canFocus: false },
  ],
};
const rowOn = (host, extra = {}) => ({
  window: { title: 'ccfzf', lastSeen: 1, focusedAt: 0, host, pid: 1, canFocus: true, ...extra },
});

test('окно на своей машине поднимается', () => {
  assert.strictEqual(canFocusRow(rowOn('desktop-box'), STATE, 'desktop-box'), true);
});

test('окно на чужой машине не поднимается', () => {
  // Пометка о таком окне полезна — сессия где-то открыта, — а подъём ничего не
  // дал бы человеку перед экраном и отнял бы у Enter привычное открытие.
  assert.strictEqual(canFocusRow(rowOn('macbook'), STATE, 'desktop-box'), false);
});

test('регистр и пробелы в именах машин не значат ничего', () => {
  // Одна сторона — hostname машины, другая — строка, набранная человеком.
  assert.strictEqual(canFocusRow(rowOn('DESKTOP-BOX'), STATE, '  desktop-box '), true);
});

test('трекер, не умеющий поднимать окна, не поднимает их и на своей машине', () => {
  // Это единственное, что отличает «мой хост» от «мой хост, и он правда
  // умеет». Без проверки Enter отправил бы просьбу, которую разберёт менеджер
  // на другой машине.
  assert.strictEqual(
    canFocusRow(rowOn('desktop-box', { canFocus: false }), STATE, 'desktop-box'), false);
});

test('строка без окна не поднимается ничем', () => {
  assert.strictEqual(canFocusRow({}, STATE, 'desktop-box'), false);
  assert.strictEqual(canFocusRow(null, STATE, 'desktop-box'), false);
});

test('пустое имя машины в конфиге значит «фокуса не бывает»', () => {
  // Умолчание: пикер, которому не сказали, на какой он машине, ведёт себя
  // как прежде.
  for (const mine of ['', '   ', undefined, null]) {
    assert.strictEqual(canFocusRow(rowOn('desktop-box'), STATE, mine), false, String(mine));
  }
});

test('нулевой pid у окна значит «трекера не слышно»', () => {
  for (const pid of [0, -1, undefined, 'x']) {
    assert.strictEqual(
      canFocusRow(rowOn('desktop-box', { pid }), STATE, 'desktop-box'), false, String(pid));
  }
});

test('старый агрегатор без полей у окна читается верхними полями ответа', () => {
  // Пикер и агрегатор обновляются порознь, и порядок нам не подвластен:
  // пикер новее агрегатора обязан вести себя как прежде, а не гаснуть.
  const old = { windowHost: 'desktop-box', windowPid: 4242 };
  const row = { window: { title: 'ccfzf', lastSeen: 1, focusedAt: 0 } };
  assert.strictEqual(canFocusRow(row, old, 'desktop-box'), true);
  assert.strictEqual(canFocusRow(row, old, 'macbook'), false);
});

test('trackerHere находит свою машину среди трекеров', () => {
  assert.deepStrictEqual(trackerHere(STATE, 'desktop-box'),
    { host: 'desktop-box', pid: 4242, canFocus: true });
});

test('trackerHere молчит про машину, чей трекер не умеет поднимать', () => {
  assert.strictEqual(trackerHere(STATE, 'macbook'), null);
});

test('trackerHere молчит, когда нашей машины среди трекеров нет', () => {
  assert.strictEqual(trackerHere(STATE, 'thinkpad'), null);
  assert.strictEqual(trackerHere(STATE, ''), null);
});

test('trackerHosts собирает список и из старого ответа', () => {
  // Старый агрегатор списка не отдаёт, но одну машину называет. Пустой список
  // на таком ответе выключил бы режим снимков там, где он работал.
  assert.deepStrictEqual(trackerHosts({ windowHost: 'desktop-box', windowPid: 7 }),
    [{ host: 'desktop-box', pid: 7, canFocus: true }]);
  assert.deepStrictEqual(trackerHosts({}), []);
});

test('focusPid отдаёт ноль всему, что не положительное число', () => {
  assert.strictEqual(focusPid({ pid: 4242 }), 4242);
  assert.strictEqual(focusPid({ windowPid: 4242 }), 4242);
  for (const src of [{ pid: 0 }, { pid: -1 }, { pid: '4242' }, {}, null]) {
    assert.strictEqual(focusPid(src), 0, JSON.stringify(src));
  }
});
