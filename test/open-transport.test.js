const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseOpenTransport, canOpenRemote, chooseEnterAction } = require('../frontend-src/open-transport');

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

// chooseEnterAction: что делает Enter на строке сессии. Раньше эти условия
// стояли прямо в sessions.html, и проверить их было нечем — отсюда все три
// поломки ниже.

// Окно у сессии открыто: агрегатор приписывает поле `window` ровно тем
// сессиям, которые трекер видит на экране.
const WINDOWED = { kind: 'interactive', id: 's1', window: { title: 'proj', desktop: 1 } };
// Той же сессии окна нет — значит, и в файле трекера её нет, и слота у неё
// может не быть вовсе.
const WINDOWLESS = { kind: 'interactive', id: 's1' };

// Fix 1: подъём уже открытого окна обязан идти прежней дорогой. Только она
// гасит пикер до публикации и выдаёт трекеру право на передний план; ветка
// менеджера не делает ни того, ни другого, и подъём отчитался бы об успехе
// при мигнувшей кнопке на таскбаре.
test('окно открыто и пикер умеет его поднять — фокус, а не менеджер', () => {
  assert.equal(
    chooseEnterAction(WINDOWED, 'focus', THIS_HOST_STATE, CONFIG_HOST, true),
    'focus',
  );
});

test('окно открыто, но трекер на чужой машине — фокус решает стратегия, транспорт не вмешивается', () => {
  // На маке стратегия до 'focus' не доходит (canFocus ложен), и Enter обязан
  // открыть терминал сам, как и раньше.
  assert.equal(
    chooseEnterAction(WINDOWED, 'resume', OTHER_HOST_STATE, CONFIG_HOST, true),
    'local',
  );
});

// Fix 2: список пикера — надмножество того, что знает трекер: ccfzf отдаёт все
// сессии ssh-хоста, а менеджер ищет их среди своих слотов. Незнакомой сессии
// он ответит `unknown session` в свой лог, и Enter окажется нажатым впустую.
test('трекер не знает сессию (окна нет) — открываем локально, как до этой ветки', () => {
  assert.equal(
    chooseEnterAction(WINDOWLESS, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction({ ...WINDOWLESS, window: null }, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
    'local',
  );
});

test('трекер знает сессию, но поднять окно пикер не может — просим менеджер', () => {
  // Стратегия не 'focus' (например, у ответа агрегатора нет windowPid, и
  // право на передний план выдать некому) — поднимать окно самим нечем, а
  // менеджер умеет и открыть терминал с профилем проекта.
  assert.equal(
    chooseEnterAction(WINDOWED, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
    'manager',
  );
});

test('свой хост, но брокера нет — локально: просьбе некуда уйти', () => {
  assert.equal(
    chooseEnterAction(WINDOWED, 'resume', THIS_HOST_STATE, CONFIG_HOST, false),
    'local',
  );
});

// Fix 3: тот же позитивный список, что и у пункта меню. Сегодня строки других
// видов до openSession не доходят — их разводит choose(), — но список затем и
// позитивный, чтобы следующий вид строки не уехал в claude-session-open с
// чужим id.
test('строка не сессии — локально, даже с полем window и на своём хосте', () => {
  for (const kind of NON_SESSION_ROW_KINDS) {
    assert.equal(
      chooseEnterAction({ ...WINDOWED, kind }, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
      'local',
      kind,
    );
  }
});

test('незнакомый вид строки (или вовсе без kind) — локально', () => {
  assert.equal(
    chooseEnterAction({ ...WINDOWED, kind: 'something-new' }, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction({ id: 's1', window: {} }, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
    'local',
  );
});

test('сессия из снимка с открытым окном — тот же вид строки, что и обычная', () => {
  assert.equal(
    chooseEnterAction({ ...WINDOWED, kind: 'snapshot-session' }, 'resume', THIS_HOST_STATE, CONFIG_HOST, true),
    'manager',
  );
});

test('строки нет вовсе — локально', () => {
  assert.equal(chooseEnterAction(null, 'resume', THIS_HOST_STATE, CONFIG_HOST, true), 'local');
  // 'focus' до строки не добирается: стратегию посчитали по ней же, и без
  // строки её не бывает.
  assert.equal(chooseEnterAction(undefined, 'resume', THIS_HOST_STATE, CONFIG_HOST, true), 'local');
});

test('трекера нет вовсе — локально', () => {
  assert.equal(chooseEnterAction(WINDOWED, 'resume', {}, CONFIG_HOST, true), 'local');
  assert.equal(chooseEnterAction(WINDOWED, 'resume', null, CONFIG_HOST, true), 'local');
});
