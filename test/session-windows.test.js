const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SessionWindows = require('../frontend-src/session-windows');
const { canFocusRow, trackerHere, trackerHosts, focusPid, openManager } = SessionWindows;

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

test('normHost определён ровно один раз на весь frontend-src', () => {
  // Копий было три — дословных и разъехаться не успевших. Сторож стоит не
  // из-за случившейся поломки, а потому что цена её тихая: разойдись правила
  // приведения, одна и та же машина считалась бы своей в одном месте и чужой
  // в соседнем, а на глаз это выглядело бы отказом фокуса без причины.
  const dir = path.join(__dirname, '..', 'frontend-src');
  const found = fs.readdirSync(dir)
    .filter(name => name.endsWith('.js'))
    .filter(name => /function\s+normHost\s*\(/.test(fs.readFileSync(path.join(dir, name), 'utf8')));
  assert.deepStrictEqual(found, ['session-windows.js'],
    'нужна одна копия, и живёт она там, где решается «чья это машина»');
});

test('trackerHosts отсеивает записи без имени машины', () => {
  // Файл трекера пишет чужая машина, и доверия его содержимому нет. Пустой
  // объект проходил `.filter(Boolean)` и доезжал до openManager, где
  // запасное `|| able[0]` могло назначить менеджером именно его — просьба
  // ушла бы с пустым mqttBase, то есть в никуда и молча.
  const state = {
    windowHosts: [
      {},
      null,
      { host: '   ' },
      { host: 42 },
      { host: 'desktop-box', pid: 7 },
    ],
  };
  assert.deepStrictEqual(trackerHosts(state), [{ host: 'desktop-box', pid: 7 }]);
});

test('trackerHosts не выдаёт безымянную запись за менеджера', () => {
  // Тот же мусор, но спрошенный через openManager: своей машины в списке нет,
  // и раньше менеджером становился пустой объект.
  const state = { windowHosts: [{}, { host: 'mac-host', mqttBase: 'home/mac/windows' }] };
  assert.deepStrictEqual(openManager(state, 'desktop-box'),
    { host: 'mac-host', mqttBase: 'home/mac/windows' });
});

test('focusPid отдаёт ноль всему, что не положительное число', () => {
  assert.strictEqual(focusPid({ pid: 4242 }), 4242);
  assert.strictEqual(focusPid({ windowPid: 4242 }), 4242);
  for (const src of [{ pid: 0 }, { pid: -1 }, { pid: '4242' }, {}, null]) {
    assert.strictEqual(focusPid(src), 0, JSON.stringify(src));
  }
});

test('адрес подъёма берётся у машины окна, а не у верхнего поля', () => {
  // Трекеров несколько, и адрес у каждого свой. Верхнее поле называет одну
  // машину — по нему просьба уехала бы поднимать окно на чужом экране.
  const state = {
    windowHost: 'windows-box',
    windowHosts: [{ host: 'windows-box', mqttBase: 'home/room/pc/windows' },
                  { host: 'mac-host', mqttBase: 'home/room/mac/windows' }],
  };
  const row = { window: { host: 'mac-host', pid: 7, canFocus: true, mqttBase: 'home/room/mac/windows' } };
  assert.equal(SessionWindows.mqttBaseFor(row, state), 'home/room/mac/windows');
});

test('строка без окна адреса не называет', () => {
  assert.equal(SessionWindows.mqttBaseFor({}, {}), '');
});

test('старый агрегатор адреса не даёт, и это пустая строка, а не поломка', () => {
  // Пустая строка значит «спроси свой конфиг» — так пикер вёл себя до
  // появления поля, и так он обязан вести себя со старым агрегатором.
  const state = { windowHost: 'windows-box', windowPid: 42 };
  assert.equal(SessionWindows.mqttBaseFor({ window: { title: 'ccfzf' } }, state), '');
});

test('менеджером берётся свой трекер, если он умеет открывать сессии', () => {
  const state = {
    windowHosts: [{ host: 'mac-host', pid: 7, openSession: false, mqttBase: 'home/room/mac/windows' },
                  { host: 'windows-box', pid: 42, mqttBase: 'home/room/pc/windows' }],
  };
  assert.equal(SessionWindows.openManager(state, 'windows-box').host, 'windows-box');
});

test('свой трекер, не берущийся открывать сессии, менеджером не считается', () => {
  // Иначе пикер на маке увёл бы просьбу к маку, где её никто не разбирает, —
  // и Enter замолчал бы. Молчащий Enter хуже открытого терминала.
  const state = {
    windowHosts: [{ host: 'mac-host', pid: 7, openSession: false, mqttBase: 'home/room/mac/windows' },
                  { host: 'windows-box', pid: 42, mqttBase: 'home/room/pc/windows' }],
  };
  assert.equal(SessionWindows.openManager(state, 'mac-host').host, 'windows-box');
});

test('свой трекер важнее чужого', () => {
  const state = {
    windowHosts: [{ host: 'windows-box', pid: 42 }, { host: 'other-box', pid: 43 }],
  };
  assert.equal(SessionWindows.openManager(state, 'windows-box').host, 'windows-box');
});

test('без трекеров менеджера нет', () => {
  assert.equal(SessionWindows.openManager({}, 'mac-host'), null);
});

test('старый агрегатор называет одну машину, и она же менеджер', () => {
  // Одного трекера хватало всегда, и пикер новее агрегатора обязан вести себя
  // как прежде, а не терять ветку менеджера.
  const state = { windowHost: 'windows-box', windowPid: 42 };
  assert.equal(SessionWindows.openManager(state, 'windows-box').host, 'windows-box');
});
