const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SessionWindows = require('../frontend-src/session-windows');
const { canFocusRow, trackerHere, trackerHosts, focusPid, openManager, windowsOf, windowOf, focusWindowOf, mqttBaseFor, unreadTargets } = SessionWindows;

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

// Адрес прямой просьбы — свойство машины, и берётся он из записи машины, а не
// окна: в записи окна его нет вовсе (см. read_window_sources в ccfzf). Дорога
// поэтому двухшаговая — окно называет host, host находится в windowHosts.
test('httpFor находит адрес по машине окна', () => {
  const state = {
    windowHosts: [
      { host: 'windows-box', pid: 9, canFocus: true, openSession: true, mqttBase: '', http: { port: 9722 } },
      { host: 'mac-host', pid: 7, canFocus: true, openSession: false, mqttBase: 'home/mac/windows', http: null },
    ],
  };
  const row = { id: 'aaa', window: { host: 'windows-box' } };
  assert.equal(SessionWindows.httpFor(row, state, 'windows-box'), 'windows-box:9722');
});

// Трекер прежней версии поля не пишет — пустая строка значит «иди прежней
// дорогой, через MQTT». Молчаливого отката тут нет: MQTT и был единственным
// транспортом, а не запасным.
test('httpFor пуст, когда машина адреса не назвала', () => {
  const state = {
    windowHosts: [{ host: 'mac-host', pid: 7, canFocus: true, openSession: true, mqttBase: '', http: null }],
  };
  const row = { id: 'aaa', window: { host: 'mac-host' } };
  assert.equal(SessionWindows.httpFor(row, state, 'mac-host'), '');
});

// Отмотать «просмотрено» надо у каждого трекера сессии, и транспорт у каждого
// свой: у одной машины http, у другой MQTT. Пара едет вместе, иначе адрес и
// база разъехались бы по индексам массивов.
test('unreadTargets даёт паре машин свой транспорт каждой', () => {
  const state = {
    windowHosts: [
      { host: 'windows-box', pid: 9, canFocus: true, openSession: true, mqttBase: '', http: { port: 9722 } },
      { host: 'mac-host', pid: 7, canFocus: true, openSession: true, mqttBase: 'home/mac/windows', http: null },
    ],
  };
  const row = {
    id: 'aaa',
    sessionWindows: [{ host: 'windows-box', mqttBase: '' }, { host: 'mac-host', mqttBase: 'home/mac/windows' }],
  };
  assert.deepEqual(SessionWindows.unreadTargets(row, state), [
    { base: '', http: 'windows-box:9722' },
    { base: 'home/mac/windows', http: '' },
  ]);
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

test('unreadTargets называет базу каждого окна, без повторов', () => {
  // Отметка складывается по максимуму всех окон, значит отмотать надо у
  // каждого трекера: иначе второй вернёт «просмотрено» следующим же опросом.
  // Транспорт у всех троих окон пуст — state не называет ни одного трекера, —
  // и дедупликация тогда работает как раньше, по одной базе.
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box', mqttBase: 'home/pc/windows' },
    { host: 'other-box', mqttBase: 'home/pc/windows' },
  ] };
  assert.deepStrictEqual(unreadTargets(row, {}), [
    { base: 'home/mac/windows', http: '' },
    { base: 'home/pc/windows', http: '' },
  ]);
});

test('строка без окон баз не называет — просьба уйдёт по своей', () => {
  assert.deepStrictEqual(unreadTargets({}, {}), []);
});

test('unreadTargets читает sessionWindows карточки, а не её собственное окно', () => {
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
  assert.deepStrictEqual(unreadTargets(row, {}), [
    { base: 'home/mac/windows', http: '' },
    { base: 'home/pc/windows', http: '' },
  ]);
});

test('unreadTargets без sessionWindows откатывается на windowsOf(row, state)', () => {
  // Строки, собранные не buildSessionList (старые вызовы в тестах, чужие
  // источники строк), поля sessionWindows не несут вовсе.
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box', mqttBase: 'home/pc/windows' },
  ] };
  assert.deepStrictEqual(unreadTargets(row, {}), [
    { base: 'home/mac/windows', http: '' },
    { base: 'home/pc/windows', http: '' },
  ]);
});

test('окно без адреса просит отмотку по своей базе, а не пропускается', () => {
  // windows11-manager поля mqttBase не пишет вовсе, и агрегатор приписывает
  // такому окну пустую строку. Выбрось её unreadTargets — и просьба до этого
  // трекера не доедет никогда: Rust трактует '' как «спроси свой конфиг»
  // (resolve_base), а пропуск это переводит в «трекера тут нет».
  const row = { windows: [
    { host: 'mac-host', mqttBase: 'home/mac/windows' },
    { host: 'windows-box' },
  ] };
  assert.deepStrictEqual(unreadTargets(row, {}), [
    { base: 'home/mac/windows', http: '' },
    { base: '', http: '' },
  ]);
});

// ---- placeIds: порядок для просьбы о раскладке ----------------------------

test('placeIds отдаёт id строк своей машины в порядке списка', () => {
  // Порядок и есть смысл поля: на стороне трекера его не восстановить, а
  // список знает только тот, кто его показывает.
  const rows = [
    { kind: 'session', id: 'aaa', ...rowOn('desktop-box') },
    { kind: 'session', id: 'bbb', ...rowOn('desktop-box') },
  ];
  assert.deepStrictEqual(SessionWindows.placeIds(rows, STATE, 'desktop-box'), ['aaa', 'bbb']);
});

test('placeIds не берёт окна чужих машин', () => {
  // Раскладка осмысленна там, где человек смотрит на экран. Окно соседней
  // машины в список порядка попасть не должно — трекер этой машины его всё
  // равно не ведёт, а порядок бы сдвинуло.
  const rows = [
    { kind: 'session', id: 'aaa', ...rowOn('macbook') },
    { kind: 'session', id: 'bbb', ...rowOn('desktop-box') },
  ];
  assert.deepStrictEqual(SessionWindows.placeIds(rows, STATE, 'desktop-box'), ['bbb']);
});

test('placeIds не берёт строки без окна', () => {
  // Заголовок секции, строка проекта, снимок и просто сессия без окна: окна
  // нет — раскладывать нечего.
  const rows = [
    { kind: 'section', id: undefined },
    { kind: 'project', id: 'proj', cwd: '/home/user/x' },
    { kind: 'session', id: 'aaa' },
    { kind: 'session', id: 'bbb', ...rowOn('desktop-box') },
  ];
  assert.deepStrictEqual(SessionWindows.placeIds(rows, STATE, 'desktop-box'), ['bbb']);
});

test('placeIds не повторяет id сессии с двумя карточками', () => {
  // Карточка — на окно, и у сессии, открытой дважды на одной машине, их две.
  // Повторённый id приёмник посчитал бы за два окна и сдвинул бы раскладку.
  const rows = [
    { kind: 'session', id: 'aaa', ...rowOn('desktop-box') },
    { kind: 'session', id: 'aaa', ...rowOn('desktop-box') },
  ];
  assert.deepStrictEqual(SessionWindows.placeIds(rows, STATE, 'desktop-box'), ['aaa']);
});

test('placeIds без имени своей машины отдаёт пустой список', () => {
  // Пустой windowHost в конфиге значит «фокуса не бывает» — то же умолчание,
  // что у canFocusRow. Пустой список Rust прочитал бы как «разложи всё», и
  // просьба ушла бы шире, чем спрашивали, — поэтому пункты меню при таком
  // конфиге не появляются вовсе (rowCanFocus), а список тут честно пуст.
  const rows = [{ kind: 'session', id: 'aaa', ...rowOn('desktop-box') }];
  assert.deepStrictEqual(SessionWindows.placeIds(rows, STATE, ''), []);
});

// ---- minimizedHere и отсев stale из раскладки ------------------------------

const NOW = 2_000_000;
const STALE = { enabled: true, sessionHours: 2, projectHours: 24, opacity: 0.5 };

test('minimizedHere спрашивает про окно своей машины', () => {
  // Свёрнутое окно соседней машины к этому экрану не относится вовсе: её
  // окна эта машина не раскладывает и в списке их не гасит.
  const mine = { windows: [{ host: 'desktop-box', pid: 1, minimized: true }] };
  const theirs = { windows: [{ host: 'macbook', pid: 1, minimized: true }] };
  assert.strictEqual(SessionWindows.minimizedHere(mine, STATE, 'desktop-box'), true);
  assert.strictEqual(SessionWindows.minimizedHere(theirs, STATE, 'desktop-box'), false);
});

test('строка с развёрнутым окном здесь свёрнутой не считается', () => {
  // Сессию открывали на этой машине дважды. Одно окно на экране стоит —
  // гасить строку не за что.
  const row = { windows: [
    { host: 'desktop-box', pid: 1, minimized: true },
    { host: 'desktop-box', pid: 1, minimized: false },
  ] };
  assert.strictEqual(SessionWindows.minimizedHere(row, STATE, 'desktop-box'), false);
});

test('без своих окон и без признака строка не свёрнута', () => {
  // Нет окна — раскладывать нечего, но и прятать нечего. А агрегатор прежней
  // версии поля не пропускает вовсе, и строка обязана вести себя как раньше.
  assert.strictEqual(SessionWindows.minimizedHere({ windows: [] }, STATE, 'desktop-box'), false);
  assert.strictEqual(
    SessionWindows.minimizedHere(rowOn('desktop-box'), STATE, 'desktop-box'),
    false,
  );
});

test('placeIds не зовёт в раскладку то, что пикер погасил', () => {
  // Клетка сетки, отданная свёрнутому или давно молчащему окну, ужимает те,
  // на которые человек смотрит.
  const rows = [
    { kind: 'session', id: 'fresh', lastActivity: NOW - 10, ...rowOn('desktop-box') },
    { kind: 'session', id: 'old', lastActivity: NOW - 7200, ...rowOn('desktop-box') },
    {
      kind: 'session',
      id: 'hidden',
      lastActivity: NOW - 10,
      ...rowOn('desktop-box', { minimized: true }),
    },
  ];
  assert.deepStrictEqual(
    SessionWindows.placeIds(rows, STATE, 'desktop-box', { nowSec: NOW, stale: STALE }),
    ['fresh'],
  );
});

test('снятая галка dim stale возвращает в раскладку всех', () => {
  // Тот же довод, что у затемнения: галка гасит правило целиком, и раскладка,
  // продолжающая отсеивать вопреки ей, выглядела бы поломкой.
  const rows = [
    { kind: 'session', id: 'old', lastActivity: NOW - 7200, ...rowOn('desktop-box') },
    {
      kind: 'session',
      id: 'hidden',
      lastActivity: NOW - 10,
      ...rowOn('desktop-box', { minimized: true }),
    },
  ];
  assert.deepStrictEqual(
    SessionWindows.placeIds(rows, STATE, 'desktop-box', {
      nowSec: NOW,
      stale: { ...STALE, enabled: false },
    }),
    ['old', 'hidden'],
  );
});

test('placeIds без настройки stale отсева не делает', () => {
  // Так он вёл себя до появления отсева, и зовущий, который про него не
  // знает, обязан получать прежний порядок.
  const rows = [
    { kind: 'session', id: 'old', lastActivity: NOW - 999_999, ...rowOn('desktop-box') },
    {
      kind: 'session',
      id: 'hidden',
      lastActivity: NOW - 10,
      ...rowOn('desktop-box', { minimized: true }),
    },
  ];
  assert.deepStrictEqual(SessionWindows.placeIds(rows, STATE, 'desktop-box'), ['old', 'hidden']);
});
