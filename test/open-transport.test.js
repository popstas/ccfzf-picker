const test = require('node:test');
const assert = require('node:assert/strict');
const OpenTransport = require('../frontend-src/open-transport');
const {
  chooseOpenTransport, canOpenRemote, chooseEnterAction, rowProjectDir,
  chooseProjectOpenAction,
} = OpenTransport;

test('свой хост, брокер настроен — открываем через менеджер', () => {
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, 'pc-win', true), 'manager');
});

test('свой хост, брокер НЕ настроен — открываем локально', () => {
  // Без брокера просьбе некуда уйти: 'manager' здесь означает публикацию в
  // MQTT, и на машине без mqtt: в конфиге Enter обязан остаться прежним —
  // wt.exe, а не ошибка «mqtt не настроен» там, где раньше всё работало.
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, 'pc-win', false), 'local');
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, 'pc-win', undefined), 'local');
});

test('регистр и пробелы не мешают', () => {
  assert.equal(chooseOpenTransport({ host: ' pc-win ' }, 'PC-Win', true), 'manager');
});

test('чужой хост — открываем локально независимо от брокера', () => {
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, 'macbook', true), 'local');
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, 'macbook', false), 'local');
});

test('пустой windowHost в конфиге — локально', () => {
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, '', true), 'local');
  assert.equal(chooseOpenTransport({ host: 'PC-WIN' }, undefined, true), 'local');
});

test('менеджера нет или он без имени — локально', () => {
  // `null` — трекера нет; `{}` — имя машины не задано. В chooseOpenTransport
  // оба дают один результат — функция спрашивает только имя машины.
  // Развилка между ними живёт в canOpenRemote.
  assert.equal(chooseOpenTransport(null, 'pc-win', true), 'local');
  assert.equal(chooseOpenTransport({}, 'pc-win', true), 'local');
});

test('pid трекера на выбор не влияет', () => {
  assert.equal(chooseOpenTransport({ host: 'pc-win', pid: 0 }, 'pc-win', true), 'manager');
});

// canOpenRemote: применимость пункта «Open on <host>» — на каждый вид
// строки, который реально существует в приложении (session-list.js,
// project-list.js, picker-snapshots.js), и на все четыре состояния трекера.
// Без этой сетки инлайновая проверка в sessions.html однажды пропустила
// заголовок снимка — тот же id, что и у сессии, по форме, но не по смыслу.

const OTHER_HOST_MANAGER = { host: 'DESKTOP-BOX' };
const THIS_HOST_MANAGER = { host: 'pc-win' };
const CONFIG_HOST = 'pc-win';
// Единственные виды строк, у которых id — это id настоящей сессии.
const SESSION_ROW_KINDS = ['interactive', 'snapshot-session'];
// Виды строк, у которых id — что-то другое (путь проекта, id снимка, имя
// зелийной сессии с префиксом).
const NON_SESSION_ROW_KINDS = ['project', 'snapshot', 'zellij'];

test('обычная сессия и сессия из снимка — трекер на чужой машине, брокер настроен — да', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(
      canOpenRemote({ kind, id: 's1' }, OTHER_HOST_MANAGER, CONFIG_HOST, true),
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
      canOpenRemote({ kind, id: 's1' }, OTHER_HOST_MANAGER, CONFIG_HOST, false),
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
      canOpenRemote({ kind, id: 'snap-or-path' }, OTHER_HOST_MANAGER, CONFIG_HOST, true),
      false,
      kind,
    );
  }
});

test('незнакомый вид строки (или вовсе без kind) — по умолчанию нет', () => {
  // Позитивный список: новый вид строки, про который эта функция не знает,
  // остаётся без пункта меню сам по себе, а не только пока кто-то помнит его
  // сюда дописать.
  assert.equal(canOpenRemote({ kind: 'something-new', id: 's1' }, OTHER_HOST_MANAGER, CONFIG_HOST, true), false);
  assert.equal(canOpenRemote({ id: 's1' }, OTHER_HOST_MANAGER, CONFIG_HOST, true), false);
});

test('трекера нет вовсе — нет, ни для одного вида строки', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(canOpenRemote({ kind, id: 's1' }, null, CONFIG_HOST, true), false, kind);
  }
});

test('трекер на этой же машине — нет, это делает Enter напрямую', () => {
  for (const kind of SESSION_ROW_KINDS) {
    assert.equal(canOpenRemote({ kind, id: 's1' }, THIS_HOST_MANAGER, CONFIG_HOST, true), false, kind);
  }
});

test('менеджера ещё нет (ответ агрегатора не пришёл) — нет', () => {
  assert.equal(canOpenRemote({ kind: 'interactive', id: 's1' }, null, CONFIG_HOST, true), false);
});

test('строки нет вовсе — нет', () => {
  assert.equal(canOpenRemote(null, OTHER_HOST_MANAGER, CONFIG_HOST, true), false);
  assert.equal(canOpenRemote(undefined, OTHER_HOST_MANAGER, CONFIG_HOST, true), false);
});

// chooseEnterAction: что делает Enter на строке сессии. Раньше эти условия
// стояли прямо в sessions.html, и проверить их было нечем — отсюда все три
// поломки ниже.

// Окно у сессии открыто: агрегатор приписывает поле `window` ровно тем
// сессиям, которые трекер видит на экране.
const WINDOWED = { kind: 'interactive', id: 's1', window: { title: 'proj', desktop: 1 } };
// Той же сессии окна нет — значит, и в файле трекера её нет, и слота у неё
// может не быть вовсе. Каталога проекта здесь тоже нет: строка без обоих
// признаков — единственная, о которой менеджера просить не о чем.
const WINDOWLESS = { kind: 'interactive', id: 's1' };
// Окна нет, но каталог известен — по нему менеджер откроет терминал с
// профилем проекта, ничего про саму сессию не зная. `ccfzf --state` кладёт
// каталог в поле `cwd`, строка списка несёт его как есть.
const WINDOWLESS_WITH_CWD = { kind: 'interactive', id: 's1', cwd: '/p/site' };

// Fix 1: подъём уже открытого окна обязан идти прежней дорогой. Только она
// гасит пикер до публикации и выдаёт трекеру право на передний план; ветка
// менеджера не делает ни того, ни другого, и подъём отчитался бы об успехе
// при мигнувшей кнопке на таскбаре.
test('окно открыто и пикер умеет его поднять — фокус, а не менеджер', () => {
  assert.equal(
    chooseEnterAction(WINDOWED, 'focus', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'focus',
  );
});

test('окно открыто, но трекер на чужой машине — фокус решает стратегия, транспорт не вмешивается', () => {
  // На маке стратегия до 'focus' не доходит (canFocus ложен), и Enter обязан
  // открыть терминал сам, как и раньше.
  assert.equal(
    chooseEnterAction(WINDOWED, 'resume', OTHER_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
});

// Fix 2: список пикера — надмножество того, что знает трекер: ccfzf отдаёт все
// сессии ssh-хоста, а менеджер ищет их среди своих слотов. Просить его можно
// по одному из двух признаков: id, который он найдёт (о нём говорит `window`),
// либо каталог проекта, по которому он откроет терминал. Нет ни того, ни
// другого — просьба умерла бы в его логе молча, и Enter окажется нажатым
// впустую.
test('ни окна, ни каталога — открываем локально, как до этой ветки', () => {
  assert.equal(
    chooseEnterAction(WINDOWLESS, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction({ ...WINDOWLESS, window: null }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
});

// Ради этого случая ветка менеджера и заведена: терминал закрыт, сессию трекер
// не помнит, и открыть её с нужным профилем Windows Terminal умеет только
// менеджер — по каталогу проекта (`claudeWt.projects` → `profileForCwd`).
// Собранная в пикере команда `wt.exe` профиль теряет.
test('окна нет, но каталог проекта известен — просим менеджер', () => {
  assert.equal(
    chooseEnterAction(WINDOWLESS_WITH_CWD, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'manager',
  );
});

test('пустой или пробельный каталог — то же, что его нет вовсе', () => {
  assert.equal(
    chooseEnterAction({ ...WINDOWLESS, cwd: '' }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction({ ...WINDOWLESS, cwd: '   ' }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction({ ...WINDOWLESS, cwd: 42 }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
});

test('каталог не отменяет ни чужого хоста, ни отсутствия брокера', () => {
  // Обе проверки стоят раньше и остаются на месте: на маке менеджера не
  // существует, а без брокера просьбе некуда уйти.
  assert.equal(
    chooseEnterAction(WINDOWLESS_WITH_CWD, 'resume', OTHER_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction(WINDOWLESS_WITH_CWD, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, false),
    'local',
  );
});

test('каталог не открывает ветку менеджера строке не-сессии', () => {
  // У строки проекта в `id` лежит путь каталога, а `cwd` есть и у неё —
  // позитивный список видов строк должен стоять раньше каталога.
  for (const kind of NON_SESSION_ROW_KINDS) {
    assert.equal(
      chooseEnterAction({ ...WINDOWLESS_WITH_CWD, kind }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
      'local',
      kind,
    );
  }
});

test('rowProjectDir отдаёт каталог строки и пустоту вместо мусора', () => {
  // То же поле, что уезжает в теле просьбы (openViaManager в sessions.html):
  // разойдись оно с проверкой — Enter уходил бы менеджеру без каталога.
  assert.equal(rowProjectDir(WINDOWLESS_WITH_CWD), '/p/site');
  assert.equal(rowProjectDir({ cwd: ' /p/home ' }), '/p/home');
  assert.equal(rowProjectDir({}), '');
  assert.equal(rowProjectDir(null), '');
  assert.equal(rowProjectDir({ cwd: null }), '');
});

test('трекер знает сессию, но поднять окно пикер не может — просим менеджер', () => {
  // Стратегия не 'focus' (например, у ответа агрегатора нет windowPid, и
  // право на передний план выдать некому) — поднимать окно самим нечем, а
  // менеджер умеет и открыть терминал с профилем проекта.
  assert.equal(
    chooseEnterAction(WINDOWED, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'manager',
  );
});

test('свой хост, но брокера нет — локально: просьбе некуда уйти', () => {
  assert.equal(
    chooseEnterAction(WINDOWED, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, false),
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
      chooseEnterAction({ ...WINDOWED, kind }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
      'local',
      kind,
    );
  }
});

test('незнакомый вид строки (или вовсе без kind) — локально', () => {
  assert.equal(
    chooseEnterAction({ ...WINDOWED, kind: 'something-new' }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
  assert.equal(
    chooseEnterAction({ id: 's1', window: {} }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'local',
  );
});

test('сессия из снимка с открытым окном — тот же вид строки, что и обычная', () => {
  assert.equal(
    chooseEnterAction({ ...WINDOWED, kind: 'snapshot-session' }, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true),
    'manager',
  );
});

test('строки нет вовсе — локально', () => {
  assert.equal(chooseEnterAction(null, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true), 'local');
  // 'focus' до строки не добирается: стратегию посчитали по ней же, и без
  // строки её не бывает.
  assert.equal(chooseEnterAction(undefined, 'resume', THIS_HOST_MANAGER, CONFIG_HOST, true), 'local');
});

test('трекера нет вовсе — локально', () => {
  assert.equal(chooseEnterAction(WINDOWED, 'resume', null, CONFIG_HOST, true), 'local');
});

test('строка проекта на машине трекера уходит к менеджеру', () => {
  // Профиль Windows Terminal по каталогу знает только менеджер, и ради него
  // просьба и уезжает: собранная в пикере команда wt.exe профиль теряет.
  const row = { kind: 'project', id: '/p/site', cwd: '/p/site' };
  assert.equal(chooseProjectOpenAction(row, { host: 'PC-WIN' }, 'pc-win', true), 'manager');
});

test('вид строки на выбор не влияет — важен только каталог', () => {
  // «New session» предлагается и рядом с живой сессией, и на сессии снимка.
  // Просьба у всех одна и та же — про каталог, — и id в ней нет вовсе,
  // поэтому позитивный список SESSION_ID_ROW_KINDS здесь не нужен.
  const manager = { host: 'PC-WIN' };
  for (const kind of ['project', 'interactive', 'snapshot-session', 'что-то новое']) {
    assert.equal(chooseProjectOpenAction({ kind, cwd: '/p/site' }, manager, 'pc-win', true), 'manager');
  }
});

test('чужая машина и ненастроенный брокер — открываем сами', () => {
  const row = { kind: 'project', cwd: '/p/site' };
  assert.equal(chooseProjectOpenAction(row, { host: 'PC-WIN' }, 'macbook', true), 'local');
  assert.equal(chooseProjectOpenAction(row, { host: 'PC-WIN' }, 'pc-win', false), 'local');
});

test('каталога нет — просить не о чем', () => {
  // Без каталога просьба умерла бы в журнале менеджера молча: ответа у
  // публикации нет. Прежняя местная дорога хотя бы скажет человеку об отказе.
  const manager = { host: 'PC-WIN' };
  assert.equal(chooseProjectOpenAction({ kind: 'project', cwd: '  ' }, manager, 'pc-win', true), 'local');
  assert.equal(chooseProjectOpenAction({ kind: 'project' }, manager, 'pc-win', true), 'local');
  assert.equal(chooseProjectOpenAction(null, manager, 'pc-win', true), 'local');
});

test('строка зелийной сессии не уезжает к менеджеру со своим id', () => {
  // `zellij:home` — не id сессии, и менеджер ответил бы `unknown session` в
  // свой лог, а пикер бы этого не увидел: у публикации нет ответа. Держится
  // это на позитивном списке SESSION_ID_ROW_KINDS: «починить» его на
  // негативный значило бы отправлять туда каждый новый вид строки.
  const row = { id: 'zellij:home', kind: 'zellij', zellij: 'home' };
  const manager = { host: 'pc-win' };
  assert.equal(chooseEnterAction(row, 'attach', manager, 'pc-win', true), 'local');
  assert.equal(canOpenRemote(row, manager, 'другой-хост', true), false);
});

// Задача 10: транспорт спрашивает про менеджера (openManager), а не про
// верхнее поле ответа — разбор списка трекеров остался в session-windows.js.

test('менеджер на нашей машине — просьба уходит ему', () => {
  assert.equal(
    OpenTransport.chooseOpenTransport({ host: 'windows-box' }, 'windows-box', true),
    'manager',
  );
});

test('менеджера нет вовсе — открываем сами', () => {
  // На маке менеджера не существует, и просьба уехала бы открывать окно на
  // чужой машине.
  assert.equal(OpenTransport.chooseOpenTransport(null, 'mac-host', true), 'local');
});

test('менеджер на соседней машине — открываем сами', () => {
  assert.equal(
    OpenTransport.chooseOpenTransport({ host: 'windows-box' }, 'mac-host', true),
    'local',
  );
});

test('без брокера остаётся местная дорога', () => {
  // Иначе Enter вёл бы в ошибку там, где раньше открывал терминал, — на
  // машине, которой MQTT никогда не был нужен.
  assert.equal(
    OpenTransport.chooseOpenTransport({ host: 'windows-box' }, 'windows-box', false),
    'local',
  );
});

test('пункт «Open on <host>» предлагается только при чужом менеджере', () => {
  const row = { kind: 'interactive', id: 'abc' };
  assert.equal(OpenTransport.canOpenRemote(row, { host: 'windows-box' }, 'mac-host', true), true);
  assert.equal(OpenTransport.canOpenRemote(row, { host: 'windows-box' }, 'windows-box', true), false);
  assert.equal(OpenTransport.canOpenRemote(row, null, 'mac-host', true), false);
  assert.equal(OpenTransport.canOpenRemote(row, { host: 'windows-box' }, 'mac-host', false), false);
});

// Точку курсора Rust прикладывает только к просьбе, адресованной своей же
// машине, а решает это признак `sameMachine` в теле вызова. Забудь его страница
// — и галка «Open sessions on active display» перестала бы работать молча:
// отсутствующий ключ Rust читает как «не своя машина», просьба уходит, окно
// открывается, просто не там. Поймать это поведением нечем — ответа у
// публикации нет, — отсюда сторож по тексту страницы.
test('страница называет своей машину, у которой спрашивает курсор', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const call = page.slice(page.indexOf("invoke('open_session_mqtt'"));
  const body = call.slice(0, call.indexOf('});'));
  assert.match(body, /sameMachine:/);
  // Тем же правилом, а не своим: второе разошлось бы с первым, и пункт «Open
  // on <host>» уехал бы к соседу с координатами нашего стола.
  assert.match(body, /chooseOpenTransport\(/);
});
