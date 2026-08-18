const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionList } = require('../frontend-src/session-list');

function state(extra) {
  return Object.assign({
    id: 'a', cwd: '/home/user/x', title: 'Тема', gist: '', doing: '',
    mtime: 100, live: false, frozen: false, kind: 'interactive', parent: '',
    pid: 0, tty: '', tmux: null, agent: null,
  }, extra || {});
}

test('строка собирается из сессии и её записи агента', () => {
  const rows = buildSessionList({
    sessions: [state({ agent: {
      state: 'question', event: 'stop', summary: 'Готово', lastSummary: '',
      prompt: 'сделай', branch: 'feat/x', pr_url: 'https://github.com/o/r/pull/3',
      costUsd: 2, contextPct: 10, updated: 500,
    } })],
    seen: {},
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].agentState, 'question');
  assert.strictEqual(rows[0].agentEvent, 'stop');
  assert.strictEqual(rows[0].agentDescription, 'Готово');
  assert.strictEqual(rows[0].agentPrompt, 'сделай');
  assert.strictEqual(rows[0].branch, 'feat/x');
  assert.strictEqual(rows[0].pr_url, 'https://github.com/o/r/pull/3');
  assert.strictEqual(rows[0].agentCostUsd, 2);
  assert.strictEqual(rows[0].agentContextPct, 10);
  assert.strictEqual(rows[0].lastActivity, 500);
});

test('фоновые агенты не занимают своей строки', () => {
  const rows = buildSessionList({
    sessions: [
      state({ id: 'p', agent: { updated: 100, summary: 'ушёл в фон' } }),
      state({ id: 'c', kind: 'background', parent: 'p',
              agent: { updated: 200, summary: 'работаю' } }),
    ],
    seen: {},
  });
  assert.deepStrictEqual(rows.map(r => r.id), ['p']);
  assert.strictEqual(rows[0].agentDescription, 'работаю');
  assert.strictEqual(rows[0].agentBackground, true);
  assert.strictEqual(rows[0].agentSessionId, 'c');
});

// agentSeen — «человек это видел», обратное прежнему unread. Полярность
// проверяется с обеих сторон: отметки нет и отметка старше записи — не видел,
// отметка той же секунды — видел (сравнение нестрогое, см. seenSinceUpdate).
test('agentSeen считается по отметке открытия и означает «видел»', () => {
  const sessions = [state({ id: 'a', agent: { updated: 500, summary: 'ответ' } })];
  assert.strictEqual(buildSessionList({ sessions, seen: {} })[0].agentSeen, false);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 499 } })[0].agentSeen, false);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 500 } })[0].agentSeen, true);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 900 } })[0].agentSeen, true);
});

test('отметка открытия попадает в строку', () => {
  const sessions = [state({ id: 'a', agent: { updated: 500 } })];
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 700 } })[0].focusedAt, 700);
  assert.strictEqual(buildSessionList({ sessions, seen: {} })[0].focusedAt, 0);
});

// Отметок о просмотре две, и обе настоящие: своя ставится открытием сессии из
// списка, чужая приезжает от оконного трекера — он видит, что на окно перевели
// взгляд, а пикер про это не знает никак. Побеждает поздняя: «посмотрел» верно
// с той секунды, когда посмотрели, чем бы это ни было — щелчком в списке или
// переходом к окну руками.
test('отметка трекера и своя складываются по максимуму', () => {
  const win = focusedAt => ({ title: 'wt', desktop: 1, lastSeen: 900, focusedAt });
  const sessions = [state({ id: 'a', agent: { updated: 500 }, window: win(700) })];
  assert.strictEqual(buildSessionList({ sessions, seen: {} })[0].focusedAt, 700);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 400 } })[0].focusedAt, 700);
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 900 } })[0].focusedAt, 900);

  // И то же самое там, где смотрят на кружок.
  const older = [state({ id: 'a', agent: { updated: 500 }, window: win(499) })];
  const newer = [state({ id: 'a', agent: { updated: 500 }, window: win(500) })];
  assert.strictEqual(buildSessionList({ sessions: older, seen: {} })[0].agentSeen, false);
  assert.strictEqual(buildSessionList({ sessions: newer, seen: {} })[0].agentSeen, true);
});

// Трекера может не быть вовсе (на маке его нет), а прежний трекер поля не
// писал. Строка при этом обязана остаться такой же, как до всей этой затеи.
test('без окна и без отметки трекера считается только своя', () => {
  const sessions = [state({ id: 'a', agent: { updated: 500 }, window: null })];
  assert.strictEqual(buildSessionList({ sessions, seen: { a: 700 } })[0].focusedAt, 700);
  const old = [state({ id: 'a', agent: { updated: 500 },
                       window: { title: 'wt', desktop: null, lastSeen: 900 } })];
  assert.strictEqual(buildSessionList({ sessions: old, seen: { a: 700 } })[0].focusedAt, 700);
  assert.strictEqual(buildSessionList({ sessions: old, seen: {} })[0].focusedAt, 0);
});

// Записи агента нет — сессия не считается ни просмотренной, ни зовущей: звать
// нечему, потому что и кружок, и текст статуса завязаны на пустой agentState
// (это проверяет test/row-contract.test.js на настоящих отрисовщиках).
test('сессия без записи агента не бывает ни просмотренной, ни зовущей', () => {
  const rows = buildSessionList({ sessions: [state({ agent: null })], seen: {} });
  assert.strictEqual(rows[0].agentSeen, false);
  assert.strictEqual(rows[0].agentState, '');
  assert.strictEqual(rows[0].agentEvent, '');
  assert.strictEqual(rows[0].agentDescription, '');
});

test('поля процесса переносятся как есть', () => {
  const rows = buildSessionList({
    sessions: [state({ live: true, pid: 42, tty: '/dev/pts/1', tmux: 'work:2.0' })],
    seen: {},
  });
  assert.strictEqual(rows[0].live, true);
  assert.strictEqual(rows[0].pid, 42);
  assert.strictEqual(rows[0].tty, '/dev/pts/1');
  assert.strictEqual(rows[0].tmux, 'work:2.0');
});

test('пустой список сессий даёт пустой список строк', () => {
  assert.deepStrictEqual(buildSessionList({ sessions: [], seen: {} }), []);
  assert.deepStrictEqual(buildSessionList({}), []);
});

// Фоновый агент отвечает за turnAt/message/question/state — это его работа
// показывается в строке. Но started — про саму строку, а не про того, кто в
// ней сейчас работает: старт принадлежит сессии, и увод в форк его не меняет.
test('agentStarted берётся у самой сессии, а не у фонового агента', () => {
  const rows = buildSessionList({
    sessions: [
      state({ id: 'p', agent: { updated: 100, started: 50, turnAt: 40, summary: 'ушёл в фон' } }),
      state({ id: 'c', kind: 'background', parent: 'p',
              agent: { updated: 200, started: 999, turnAt: 150, summary: 'работаю' } }),
    ],
    seen: {},
  });
  assert.strictEqual(rows[0].agentStarted, 50);
  assert.strictEqual(rows[0].agentTurnAt, 150);
});

test('поля хода, старта и уведомления доезжают до строки', () => {
  const rows = buildSessionList({
    sessions: [state({ agent: {
      state: 'active', updated: 500, turnAt: 400, started: 100,
      message: 'Claude needs your permission to use Bash',
    } })],
    seen: {},
  });
  assert.strictEqual(rows[0].agentTurnAt, 400);
  assert.strictEqual(rows[0].agentStarted, 100);
  assert.strictEqual(rows[0].agentMessage, 'Claude needs your permission to use Bash');
});

// Сессия, поднятая до появления этих полей: ноль и пустая строка значат
// «данных нет», и каждый читатель это переживает — колонка возраста
// откатывается на lastActivity, строки карточки просто не печатаются.
test('без новых полей строка отдаёт умолчания, а не undefined', () => {
  const withAgent = buildSessionList({
    sessions: [state({ agent: { state: 'idle', updated: 500 } })], seen: {},
  })[0];
  assert.strictEqual(withAgent.agentTurnAt, 0);
  assert.strictEqual(withAgent.agentStarted, 0);
  assert.strictEqual(withAgent.agentMessage, '');

  const noAgent = buildSessionList({ sessions: [state({ agent: null })], seen: {} })[0];
  assert.strictEqual(noAgent.agentTurnAt, 0);
  assert.strictEqual(noAgent.agentStarted, 0);
  assert.strictEqual(noAgent.agentMessage, '');
});

// ── машина чужого окна ──────────────────────────────────────────────────────
//
// Пометка ▣ одинакова у своего окна и у окна соседней машины, и по строке было
// не понять, где оно стоит и почему Enter ведёт себя иначе.
function withWindow(win, extra) {
  return buildSessionList(Object.assign({
    sessions: [state({ window: win })],
    seen: {},
    configHost: 'win-host',
  }, extra || {}))[0];
}

test('своя машина у окна не называется', () => {
  // Имя своей машины в колонке — шум: у большинства строк окно там же, где
  // пикер, и колонка повторяла бы одно и то же имя.
  assert.strictEqual(withWindow({ host: 'win-host', pid: 7 }).windowHost, '');
});

test('машина сравнивается без учёта регистра и пробелов', () => {
  // Одна сторона — os.hostname() соседней машины, другая — строка, набранная
  // человеком в конфиге.
  assert.strictEqual(withWindow({ host: ' WIN-Host ', pid: 7 }).windowHost, '');
});

test('чужая машина называется как её написал трекер', () => {
  assert.strictEqual(withWindow({ host: 'Mac-Host', pid: 7 }).windowHost, 'Mac-Host');
});

test('без окна машины нет', () => {
  assert.strictEqual(withWindow(null).windowHost, '');
});

test('на старом агрегаторе машина берётся из верхних полей ответа', () => {
  // Там трекер один, и все окна его; поля host у записи окна нет вовсе.
  const row = withWindow({ pid: 7 }, { state: { windowHost: 'mac-host', windowPid: 7 } });
  assert.strictEqual(row.windowHost, 'mac-host');
});

test('без своей машины в конфиге называются все', () => {
  // Пустое поле в конфиге значит «фокуса не бывает»; раз своей машины пикер не
  // знает, чужими становятся все окна разом — и это верно.
  const row = buildSessionList({
    sessions: [state({ window: { host: 'mac-host', pid: 7 } })], seen: {}, configHost: '',
  })[0];
  assert.strictEqual(row.windowHost, 'mac-host');
});

// ── карточка на окно ────────────────────────────────────────────────────────
//
// Сессию открывают на двух машинах сразу: id один, окон два. Владелец решил
// видеть это двумя карточками — одна встаёт в местный блок списка, вторая в
// блок чужой машины, и у каждой своё время (см. «Дополнение от 2026-08-18:
// карточка на окно» в design.md). Сессия без окон по-прежнему даёт одну
// строку.

test('сессия с двумя окнами даёт две карточки — по одной на окно', () => {
  const rows = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [
      { host: 'mac-host', app: 'kitty', focusedAt: 10 },
      { host: 'windows-box', app: 'WindowsTerminal.exe', focusedAt: 900 },
    ] }],
    seen: {}, state: { sessions: [] }, configHost: 'windows-box',
  });
  assert.strictEqual(rows.length, 2);
  // Обе карточки — одна и та же сессия; различать их ключом строки будет
  // следующая работа (страница и группировка сюда не входят).
  assert.deepStrictEqual(rows.map(r => r.id), ['a', 'a']);
  // Порядок — порядок окон в ответе агрегатора («свежайший взгляд первым»),
  // здесь он не пересчитывается.
  assert.deepStrictEqual(rows.map(r => r.windows[0].host), ['mac-host', 'windows-box']);
});

test('сессия без окон по-прежнему даёт одну строку', () => {
  const rows = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [] }],
    seen: {}, state: { sessions: [] }, configHost: 'windows-box',
  });
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].windows, []);
  assert.strictEqual(rows[0].windowHost, '');
});

test('у каждой карточки своя машина: своя пустая, чужая — как написал трекер', () => {
  const rows = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [
      { host: 'mac-host', focusedAt: 0 },
      { host: 'Windows-Box', focusedAt: 0 },
    ] }],
    seen: {}, state: { sessions: [] }, configHost: 'windows-box',
  });
  assert.strictEqual(rows[0].windowHost, 'mac-host');
  // Своя машина по-прежнему названа пустотой: имя пикера в каждой строке шум.
  assert.strictEqual(rows[1].windowHost, '');
});

test('у каждой карточки своё окно, а sessionWindows несёт оба без урезания', () => {
  const rows = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [
      { host: 'mac-host', focusedAt: 10 },
      { host: 'windows-box', focusedAt: 900 },
    ] }],
    seen: {}, state: { sessions: [] }, configHost: 'windows-box',
  });
  assert.deepStrictEqual(rows[0].windows.map(w => w.host), ['mac-host']);
  assert.deepStrictEqual(rows[1].windows.map(w => w.host), ['windows-box']);
  assert.strictEqual(rows[0].window.host, 'mac-host');
  assert.strictEqual(rows[1].window.host, 'windows-box');
  // sessionWindows — полный список у обеих карточек, не только «своё».
  assert.deepStrictEqual(rows[0].sessionWindows.map(w => w.host), ['mac-host', 'windows-box']);
  assert.deepStrictEqual(rows[1].sessionWindows.map(w => w.host), ['mac-host', 'windows-box']);
});

test('у каждой карточки своё время — максимум своей отметки и focusedAt именно этого окна', () => {
  // Раньше отметка складывалась по максимуму всех окон в одной строке; теперь
  // окна разведены по карточкам, и у каждой — максимум своей отметки и
  // focusedAt только её собственного окна.
  const [rowMac, rowWin] = buildSessionList({
    sessions: [{ id: 'a', title: 'x', windows: [
      { host: 'mac-host', focusedAt: 10 },
      { host: 'windows-box', focusedAt: 900 },
    ] }],
    seen: { a: 500 }, state: { sessions: [] }, configHost: 'windows-box',
  });
  assert.strictEqual(rowMac.focusedAt, 500); // max(500, 10)
  assert.strictEqual(rowWin.focusedAt, 900); // max(500, 900)
});

test('карточка несёт заголовок своего окна', () => {
  // Имя окна — то, которым сессию завёл человек; заголовок сессии приезжает из
  // транскрипта и с ним расходится. По имени окна её ищут и опознают, поэтому
  // оно едет в строку отдельным полем, а не достаётся из `window` по месту:
  // читателей у него двое — поиск и разметка имени.
  const rows = buildSessionList({
    sessions: [state({ id: 'a', live: true, title: 'esm-migration', windows: [
      { host: 'mac-host', title: 'tray-build-time', lastSeen: 2, focusedAt: 2 },
      { host: 'windows-box', title: 'tray-build-time', lastSeen: 1, focusedAt: 1 },
    ] })],
    seen: {},
    configHost: 'mac-host',
  });
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.windowTitle), ['tray-build-time', 'tray-build-time']);
});

test('у строки без окна заголовок окна пуст, а не отсутствует', () => {
  // Пустая строка, а не undefined: поле склеивается в стог поиска, и
  // отсутствующее уехало бы туда словом `undefined`.
  const rows = buildSessionList({ sessions: [state({ id: 'a' })], seen: {} });
  assert.strictEqual(rows[0].windowTitle, '');
});

test('окно фонового форка достаётся строке родителя, и та оживает', () => {
  // Фоновое задание уводит работу в форк со своим id, и трекер привязывает
  // окно терминала к нему — id ему называют хуки самого форка. Родитель при
  // этом перестаёт быть живым (процесс ушёл), то есть его строка уезжает в
  // историю, а форка в списке нет вовсе: он спрятан, чтобы не отбирать у
  // родителя его же окно. В итоге живое отслеживаемое окно не показано ничем.
  const parent = state({ id: 'p', title: 'work', live: false, pid: 0, agent: null });
  const fork = state({
    id: 'f', title: 'work', live: true, kind: 'background', parent: 'p',
    windows: [{ host: 'mac-host', title: 'work', lastSeen: 9, focusedAt: 9 }],
    agent: { state: 'idle', event: 'stop', summary: 'Готово', updated: 500 },
  });
  const rows = buildSessionList({ sessions: [parent, fork], seen: {}, configHost: 'mac-host' });
  assert.deepStrictEqual(rows.map(r => r.id), ['p'], 'форк по-прежнему без своей строки');
  assert.strictEqual(rows[0].live, true, 'работает форк — значит работает и сессия');
  assert.strictEqual(rows[0].window && rows[0].window.host, 'mac-host');
  assert.strictEqual(rows[0].windowTitle, 'work');
});

test('своё окно родителя главнее форкового', () => {
  // Обычный `claude agents`: окно остаётся за родителем, форк работает без
  // окна. Складывать оба списка нельзя — одно и то же окно, привязанное
  // разными трекерами к разным id, дало бы на одной машине две карточки.
  const parent = state({
    id: 'p', title: 'work', live: true,
    windows: [{ host: 'mac-host', title: 'parent-window', lastSeen: 9, focusedAt: 9 }],
    agent: { state: 'idle', event: 'stop', summary: '', updated: 10 },
  });
  const fork = state({
    id: 'f', title: 'work', live: true, kind: 'background', parent: 'p',
    windows: [{ host: 'mac-host', title: 'fork-window', lastSeen: 9, focusedAt: 9 }],
    agent: { state: 'idle', event: 'stop', summary: '', updated: 500 },
  });
  const rows = buildSessionList({ sessions: [parent, fork], seen: {}, configHost: 'mac-host' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].windowTitle, 'parent-window');
});

test('живость родителя не отбирается уснувшим форком', () => {
  // Обратный ход: форк кончился, а родитель работает — строка обязана
  // остаться живой. Живость складывается, а не подменяется.
  const parent = state({ id: 'p', live: true, agent: { state: 'idle', updated: 10 } });
  const fork = state({
    id: 'f', live: false, kind: 'background', parent: 'p',
    agent: { state: 'idle', updated: 500 },
  });
  const rows = buildSessionList({ sessions: [parent, fork], seen: {}, configHost: 'mac-host' });
  assert.strictEqual(rows[0].live, true);
});
