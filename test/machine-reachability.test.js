// Достижимость машины считается по адресату просьбы, а не по машине
// менеджера. До этой правки три гейта (`trackerIsHere`, `rowCanFocus`,
// `markUnread`) спрашивали `managerReachable()` — а она отвечает про машину
// **менеджера**, не про ту, которой в итоге уходит просьба. На маке
// (`openSession: false`) `openManager` называет чужую, Windows-машину, и её
// достижимость включала бы Enter там, где у самого мака ни http, ни брокера
// нет: просьба уходила бы в `focus_window_mqtt` с пустым `http`, Rust выбирал
// бы MQTT и отвечал «mqtt is not configured» — там, где раньше Enter просто
// не подсвечивался. Тот же перекос гасил бы отметку «непросмотрено» на
// строке без окон красной строкой вместо тихого выхода.
//
// Проверяется настоящий код страницы: функции вычитываются из sessions.html
// и исполняются в vm с настоящим `SessionWindows` — тот же приём, что и в
// hide-before-request.test.js и restore-branches.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SessionWindows = require('../frontend-src/session-windows.js');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

// Ровно конфигурация, ради которой всё и делается: http есть у Windows-
// менеджера, а у мака — ни http, ни брокера. Мак трекер снимков держит
// (`canFocus: true`), но менеджера не объявляет (`openSession: false`).
const MAC_AND_REACHABLE_WINDOWS = {
  windowHosts: [
    { host: 'mac', pid: 11, canFocus: true, openSession: false },
    { host: 'pc-win', pid: 22, canFocus: true, http: { port: 9722 } },
  ],
};

const HELPERS = ['machineReachable', 'managerReachable', 'managerHttpHere', 'focusHttp']
  .map(sourceOf).join('\n');

function run(fnNames, script, ctx) {
  vm.createContext(ctx);
  vm.runInContext(`${HELPERS}\n${fnNames.map(sourceOf).join('\n')}\n${script}`, ctx);
  return ctx.result;
}

test('managerReachable достижим через чужого Windows-менеджера, trackerIsHere на маке — нет', () => {
  const ctx = { CONFIG: { windowHost: 'mac', mqtt: { configured: false } }, window: { SessionWindows },
    lastState: MAC_AND_REACHABLE_WINDOWS };
  assert.strictEqual(run(['trackerIsHere'], 'result = managerReachable();', ctx), true,
    'менеджер на pc-win достижим напрямую');
  assert.strictEqual(run(['trackerIsHere'], 'result = trackerIsHere();', ctx), false,
    'у мака нет ни своего http, ни брокера — чужая достижимость не должна включать режим снимков');
});

test('свой http делает trackerIsHere истинным без единого брокера', () => {
  const ctx = {
    CONFIG: { windowHost: 'mac', mqtt: { configured: false } },
    window: { SessionWindows },
    lastState: {
      windowHosts: [{ host: 'mac', pid: 11, canFocus: true, http: { port: 9001 } }],
    },
  };
  assert.strictEqual(run(['trackerIsHere'], 'result = trackerIsHere();', ctx), true);
});

test('rowCanFocus не включается достижимостью чужого менеджера', () => {
  // Окно строки стоит на маке — там же, где сама страница.
  const row = { id: 'a', windows: [{ host: 'mac', pid: 11, canFocus: true }] };
  const ctx = { CONFIG: { windowHost: 'mac', mqtt: { configured: false } }, window: { SessionWindows },
    lastState: MAC_AND_REACHABLE_WINDOWS, row };
  assert.strictEqual(
    run(['rowCanFocus'], 'result = rowCanFocus(row);', ctx), false,
    'мак недостижим напрямую и без брокера — Enter не должен уходить в focus_window_mqtt вслепую',
  );
});

test('rowCanFocus включается своим http, даже если брокер не настроен', () => {
  const row = { id: 'a', windows: [{ host: 'mac', pid: 11, canFocus: true }] };
  const ctx = {
    CONFIG: { windowHost: 'mac', mqtt: { configured: false } },
    window: { SessionWindows },
    lastState: {
      windowHosts: [{ host: 'mac', pid: 11, canFocus: true, http: { port: 9001 } }],
    },
    row,
  };
  assert.strictEqual(run(['rowCanFocus'], 'result = rowCanFocus(row);', ctx), true);
});

// markUnread: строка без окон не должна выйти на брокер, которого нет.
test('markUnread на строке без окон подставляет цель с адресом менеджера, а не пустой список', () => {
  const calls = [];
  const row = { id: 'no-windows', lastActivity: 1000 };
  const ctx = {
    CONFIG: { windowHost: 'mac', mqtt: { configured: false } },
    window: { SessionWindows },
    lastState: MAC_AND_REACHABLE_WINDOWS,
    row,
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(); },
    markSeen: () => Promise.resolve(),
    regroup: () => {},
    render: () => {},
    error: '',
  };
  run(['markUnread'], 'markUnread(row);', ctx);
  assert.strictEqual(calls.length, 1, 'unread_session_mqtt обязана уйти — менеджер достижим');
  const [cmd, args] = calls[0];
  assert.strictEqual(cmd, 'unread_session_mqtt');
  // Пустой unreadTargets() (строка без окон) не должен уехать пустым списком:
  // Rust на пустом списке требует брокер даже там, где просьбе есть куда
  // пойти напрямую. `deepStrictEqual` тут не годится: объект собран в vm,
  // и его конструктор — из другого реалма, сравнение падало бы на этом одном.
  assert.strictEqual(args.targets.length, 1);
  assert.strictEqual(args.targets[0].base, '');
  assert.strictEqual(args.targets[0].http, 'pc-win:9722');
});

test('markUnread молчит, если недостижим ни один транспорт', () => {
  const calls = [];
  const row = { id: 'no-windows', lastActivity: 1000 };
  const ctx = {
    CONFIG: { windowHost: 'mac', mqtt: { configured: false } },
    window: { SessionWindows },
    lastState: {},
    row,
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(); },
    markSeen: () => Promise.resolve(),
    regroup: () => {},
    render: () => {},
    error: '',
  };
  run(['markUnread'], 'markUnread(row);', ctx);
  assert.deepStrictEqual(calls, [], 'без единого транспорта просьба не должна уходить вовсе');
});

// placeWindows: `http` обязан называть машину раскладываемых окон
// (`focusHttp(row)`), а не машину менеджера (`managerHttpHere()`) — иначе на
// маке (`openSession: false`) просьба `place` с маковскими id уехала бы
// Windows-менеджеру: свои окна не разложились бы, а на чужом экране могла бы
// случиться лишняя перестановка. Тот же адрес, что берёт для той же просьбы
// Rust-сторона хоткея плитки — `place_order::tracker_http`.
test('placeWindows шлёт адрес машины окон, а не адрес менеджера', () => {
  const calls = [];
  const row = { id: 'a' };
  const ctx = {
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(); },
    window: { SessionWindows: { placeIds: () => ['a'] } },
    rows: [row],
    lastState: {},
    CONFIG: { windowHost: 'mac' },
    staleSettings: () => ({ enabled: false }),
    focusBase: () => 'windows/mac',
    // Разные значения — чтобы тест ловил именно подмену помощника, а не
    // случайное совпадение адресов.
    focusHttp: () => 'mac:9001',
    managerHttpHere: () => 'pc-win:9722',
    error: '',
    render: () => {},
    row,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${sourceOf('placeWindows')}\nresult = placeWindows(row, 'tile');`, ctx,
  );
  return ctx.result.then(() => {
    const call = calls.find(([cmd]) => cmd === 'place_windows_mqtt');
    assert.ok(call, `place_windows_mqtt не отправлена: ${calls.map(c => c[0]).join(', ')}`);
    assert.strictEqual(call[1].http, 'mac:9001',
      'http обязан называть машину окон (focusHttp), а не менеджера (managerHttpHere)');
  });
});
