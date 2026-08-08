const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseOpenTransport, canOpenRemote } = require('../frontend-src/open-transport');

test('свой хост, брокер настроен — открываем через менеджер', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'pc-win', true), 'manager');
});

test('свой хост, брокер НЕ настроен — открываем локально', () => {
  // Без брокера просьбе некуда уйти: 'manager' здесь означает публикацию в
  // MQTT, и на машине без mqtt: в конфиге Enter обязан остаться прежним —
  // wt.exe, а не ошибка «mqtt не настроен» там, где раньше всё работало.
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'pc-win', false), 'local');
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'pc-win', undefined), 'local');
});

test('регистр и пробелы не мешают', () => {
  assert.equal(chooseOpenTransport({ windowHost: ' pc-win ' }, 'PC-Win', true), 'manager');
});

test('чужой хост — открываем локально независимо от брокера', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'macbook', true), 'local');
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, 'macbook', false), 'local');
});

test('пустой windowHost в конфиге — локально', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, '', true), 'local');
  assert.equal(chooseOpenTransport({ windowHost: 'PC-WIN' }, undefined, true), 'local');
});

test('нет ответа агрегатора — локально', () => {
  assert.equal(chooseOpenTransport(null, 'pc-win', true), 'local');
  assert.equal(chooseOpenTransport({}, 'pc-win', true), 'local');
});

test('pid трекера на выбор не влияет', () => {
  assert.equal(chooseOpenTransport({ windowHost: 'pc-win', windowPid: 0 }, 'pc-win', true), 'manager');
});

// canOpenRemote: применимость пункта «Open on <host>» — на каждый вид
// строки, который реально существует в приложении (session-list.js,
// project-list.js, picker-snapshots.js), и на все четыре состояния трекера.
// Без этой сетки инлайновая проверка в sessions.html однажды пропустила
// заголовок снимка — тот же id, что и у сессии, по форме, но не по смыслу.

const OTHER_HOST_STATE = { windowHost: 'DESKTOP-BOX' };
const THIS_HOST_STATE = { windowHost: 'pc-win' };
const CONFIG_HOST = 'pc-win';
// Единственные виды строк, у которых id — это id настоящей сессии.
const SESSION_ROW_KINDS = ['interactive', 'snapshot-session'];
// Виды строк, у которых id — что-то другое (путь проекта, id снимка).
const NON_SESSION_ROW_KINDS = ['project', 'snapshot'];

test('обычная сессия и сессия из снимка — трекер на чужой машине, брокер настроен — да', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(
      canOpenRemote({ kind, id: 's1' }, OTHER_HOST_STATE, CONFIG_HOST, true),
      true,
      kind,
    );
  }
});

// Fix 3: без брокера пункт меню вёл бы прямиком в «mqtt не настроен» из
// main.rs — тот же случай, что и с Enter на своей машине без mqtt: строка
// глазами выглядит как рабочее действие, а срабатывает отказом.
test('брокер НЕ настроен — нет, даже на чужой машине с настоящей сессией', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(
      canOpenRemote({ kind, id: 's1' }, OTHER_HOST_STATE, CONFIG_HOST, false),
      false,
      kind,
    );
  }
});

test('заголовок снимка и строка проекта — трекер на чужой машине — всё равно нет', () => {
  // Ровно тот случай, который пропустила прежняя проверка `kind !== 'project'`:
  // у заголовка снимка `id` — id снимка, findSession на приёме его не найдёт.
  for (const kind of NON_SESSION_ROW_KINDS) {
    assert.equal(
      canOpenRemote({ kind, id: 'snap-or-path' }, OTHER_HOST_STATE, CONFIG_HOST, true),
      false,
      kind,
    );
  }
});

test('незнакомый вид строки (или вовсе без kind) — по умолчанию нет', () => {
  // Позитивный список: новый вид строки, про который эта функция не знает,
  // остаётся без пункта меню сам по себе, а не только пока кто-то помнит его
  // сюда дописать.
  assert.equal(canOpenRemote({ kind: 'something-new', id: 's1' }, OTHER_HOST_STATE, CONFIG_HOST, true), false);
  assert.equal(canOpenRemote({ id: 's1' }, OTHER_HOST_STATE, CONFIG_HOST, true), false);
});

test('трекера нет вовсе — нет, ни для одного вида строки', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(canOpenRemote({ kind, id: 's1' }, {}, CONFIG_HOST, true), false, kind);
    assert.equal(canOpenRemote({ kind, id: 's1' }, null, CONFIG_HOST, true), false, kind);
  }
});

test('трекер на этой же машине — нет, это делает Enter напрямую', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(canOpenRemote({ kind, id: 's1' }, THIS_HOST_STATE, CONFIG_HOST, true), false, kind);
  }
});

test('lastState ещё {} (ответ агрегатора не пришёл) — нет', () => {
  assert.equal(canOpenRemote({ kind: 'interactive', id: 's1' }, {}, CONFIG_HOST, true), false);
});

test('строки нет вовсе — нет', () => {
  assert.equal(canOpenRemote(null, OTHER_HOST_STATE, CONFIG_HOST, true), false);
  assert.equal(canOpenRemote(undefined, OTHER_HOST_STATE, CONFIG_HOST, true), false);
});
