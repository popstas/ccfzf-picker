// Развилка восстановления снимка: берётся ли менеджер этой машины за раскладку.
//
// Снимок мака и снимок Windows-машины в списке выглядят одинаково, а
// восстанавливаются по-разному: там просьба менеджеру, здесь — открытие сессий
// силами самого пикера. Ошибка тут молчащая: у публикации в MQTT нет ответа, и
// просьба, уехавшая в топик, который никто не слушает, выглядит как сработавший
// Enter.
//
// Проверяется настоящий код страницы: `snapshotOwner` вычитывается из
// sessions.html и исполняется в vm с настоящими `SessionWindows` и
// `PickerSnapshots` — тем же приёмом, что и в `hide-before-request.test.js`.
// Копия разъехалась бы молча, а сторож остался бы зелёным.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
const SessionWindows = require('../frontend-src/session-windows.js');
const PickerSnapshots = require('../frontend-src/picker-snapshots.js');
const { chooseOpenTransport } = require('../frontend-src/open-transport.js');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

const SNAP = { id: 'snap-1', mqttBase: 'home/room/mac/windows', sessions: [] };

/** Ответ `snapshotOwner` на машине `configHost` при таком списке трекеров. */
function ownerOf(configHost, windowHosts, snapshot = SNAP) {
  const ctx = {
    CONFIG: { windowHost: configHost, mqtt: { configured: true } },
    lastState: { windowHosts },
    snapshotRows: [snapshot],
    window: { SessionWindows, PickerSnapshots },
    result: null,
  };
  vm.runInNewContext(
    `${sourceOf('snapshotById')}\n${sourceOf('snapshotOwner')}\nresult = snapshotOwner('snap-1');`,
    ctx,
  );
  return ctx.result;
}

const MAC = { host: 'mac', pid: 11, canFocus: true, openSession: false };
const WIN = { host: 'pc-win', pid: 22, canFocus: true };

test('на маке снимок восстанавливается своими силами', () => {
  // Трекер мака объявляет `openSession: false` — менеджера там нет вовсе.
  // Возьми развилка машину прямо у снимка, вышло бы `manager`, и просьба
  // уехала бы в топик мака, который никто не слушает.
  const owner = ownerOf('mac', [MAC]);
  assert.equal(owner, null, 'машины, берущейся за раскладку, на маке нет');
  assert.equal(chooseOpenTransport(owner, 'mac', true), 'local');
});

test('живой Windows-трекер не делает мак машиной менеджера', () => {
  // Соседняя машина в списке есть, и `openManager` называет её — но это не
  // наша машина, и восстанавливать её силами нашу раскладку нечего.
  const owner = ownerOf('mac', [MAC, WIN]);
  assert.equal(chooseOpenTransport(owner, 'mac', true), 'local');
});

test('на машине с менеджером просьба уходит ему, адрес — от снимка', () => {
  const snap = { id: 'snap-1', mqttBase: 'home/room/pc/windows', sessions: [] };
  const owner = ownerOf('pc-win', [WIN], snap);
  assert.equal(chooseOpenTransport(owner, 'pc-win', true), 'manager');
  assert.equal(owner.mqttBase, 'home/room/pc/windows',
    'адрес называет снимок: у каждой машины свой префикс топиков');
});

test('снимок без адреса уводит просьбу на свой конфиг', () => {
  // Пустая строка значит «спроси свой конфиг» — так её читает `resolve_base`
  // в `src-tauri/src/mqtt.rs`. Старый трекер адреса не называет вовсе.
  const owner = ownerOf('pc-win', [WIN], { id: 'snap-1', sessions: [] });
  assert.equal(owner.mqttBase, '');
});
