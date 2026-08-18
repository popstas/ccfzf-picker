const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SessionWindows = require('../frontend-src/session-windows');
const { canFocusRow, trackerHere, trackerHosts, focusPid, openManager, windowsOf, windowOf, focusWindowOf, mqttBaseFor, unreadBases } = SessionWindows;

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

test('своё окно находится, даже когда главным названо чужое', () => {
  // Агрегатор ставит первым окно со свежайшим взглядом — оно может быть на
  // соседней машине. Поднимать при этом надо здешнее: подъём на чужом экране
  // человеку ничего не даёт.
  const row = { windows: [
    { host: 'mac-host', pid: 5, canFocus: true, mqttBase: 'home/mac/windows' },
    { host: 'windows-box', pid: 7, canFocus: true, mqttBase: 'home/pc/windows' },
  ] };
  assert.strictEqual(canFocusRow(row, {}, 'windows-box'), true);
  assert.strictEqual(focusWindowOf(row, {}, 'windows-box').host, 'windows-box');
  assert.strictEqual(mqttBaseFor(row, {}, 'windows-box'), 'home/pc/windows');
});

test('своего окна нет — фокуса нет, а база остаётся у главного окна', () => {
  const row = { windows: [{ host: 'mac-host', pid: 5, canFocus: true, mqttBase: 'home/mac/windows' }] };
  assert.strictEqual(canFocusRow(row, {}, 'windows-box'), false);
  assert.strictEqual(mqttBaseFor(row, {}, 'windows-box'), 'home/mac/windows');
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

test('windowsOf отдаёт все окна строки в порядке ответа', () => {
  const row = { windows: [{ host: 'mac-host', app: 'kitty' }, { host: 'windows-box' }] };
  assert.deepStrictEqual(windowsOf(row, {}).map(w => w.host), ['mac-host', 'windows-box']);
});

test('пустой windows при непустом window откатывается на window', () => {
  // Условие `Array.isArray(r.windows) && r.windows.length` несёт настоящую
  // работу ровно здесь: одного Array.isArray хватило бы, чтобы пустой список
  // победил непустое `window` и строка осталась вовсе без окон.
  const row = { windows: [], window: { host: 'mac-host' } };
  assert.deepStrictEqual(windowsOf(row, {}).map(w => w.host), ['mac-host']);
});

test('старый ответ понимается: одно окно становится списком из одного', () => {
  // Пикер новее агрегатора обязан вести себя как прежде, а не гасить пометки:
  // выкатываются они порознь, и порядок нам не подвластен.
  const row = { window: { host: 'mac-host' } };
  assert.deepStrictEqual(windowsOf(row, {}).map(w => w.host), ['mac-host']);
});

test('совсем старый ответ: машину называют верхние поля', () => {
  const row = { window: { title: 'ccfzf' } };
  const state = { windowHost: 'windows-box', windowPid: 7 };
  assert.deepStrictEqual(windowsOf(row, state).map(w => w.host), ['windows-box']);
  assert.strictEqual(windowsOf(row, state)[0].pid, 7);
});

test('строка без окон даёт пустой список, а windowOf — null', () => {
  assert.deepStrictEqual(windowsOf({}, {}), []);
  assert.strictEqual(windowOf({}, {}), null);
});

test('unreadBases называет базу каждого окна, без повторов', () => {
  // Отметка складывается по максимуму всех окон, значит отмотать надо у
  // каждого трекера: иначе второй вернёт «просмотрено» следующим же опросом.
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box', mqttBase: 'home/pc/windows' },
    { host: 'other-box', mqttBase: 'home/pc/windows' },
  ] };
  assert.deepStrictEqual(unreadBases(row, {}), ['home/mac/windows', 'home/pc/windows']);
});

test('строка без окон баз не называет — просьба уйдёт по своей', () => {
  assert.deepStrictEqual(unreadBases({}, {}), []);
});

test('unreadBases читает sessionWindows карточки, а не её собственное окно', () => {
  // Карточка теперь несёт одно окно (row.windows), а сессия открыта на двух
  // машинах сразу. Отмотать «просмотрено» надо у обоих трекеров — иначе
  // сосед, которого не тронули, вернёт «просмотрено» на следующем же опросе,
  // и кнопка будет выглядеть сломанной молча (у публикации в MQTT нет ответа).
  const row = {
    windows: [{ host: 'mac-host', mqttBase: 'home/mac/windows' }],
    sessionWindows: [
      { host: 'mac-host', mqttBase: 'home/mac/windows' },
      { host: 'windows-box', mqttBase: 'home/pc/windows' },
    ],
  };
  assert.deepStrictEqual(unreadBases(row, {}), ['home/mac/windows', 'home/pc/windows']);
});

test('unreadBases без sessionWindows откатывается на windowsOf(row, state)', () => {
  // Строки, собранные не buildSessionList (старые вызовы в тестах, чужие
  // источники строк), поля sessionWindows не несут вовсе.
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box', mqttBase: 'home/pc/windows' },
  ] };
  assert.deepStrictEqual(unreadBases(row, {}), ['home/mac/windows', 'home/pc/windows']);
});

test('окно без адреса просит отмотку по своей базе, а не пропускается', () => {
  // windows11-manager поля mqttBase не пишет вовсе, и агрегатор приписывает
  // такому окну пустую строку. Выбрось её unreadBases — и просьба до этого
  // трекера не доедет никогда: Rust трактует '' как «спроси свой конфиг»
  // (resolve_base), а пропуск это переводит в «трекера тут нет».
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box' },
  ] };
  assert.deepStrictEqual(unreadBases(row, {}), ['home/mac/windows', '']);
});
