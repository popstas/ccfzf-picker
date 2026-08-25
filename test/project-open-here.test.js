// Enter на строке проекта и проектный хоткей делают одно и то же.
//
// Ключа два (`projectOpenAction` у строки, `projectHotkeyAction` у клавиши), и
// читают их разные половины пикера — страница и Rust. А вот исполнение обязано
// быть общим: двумя копиями оно уже разъехалось — хоткей открытое окно каталога
// искал, Enter шёл прямиком в `newSession`, и на машине без менеджера (оба
// мака) выбранный человеком `focus` не делал ровным счётом ничего.
//
// Проверяется настоящий код страницы, а не его копия: функции вычитываются из
// sessions.html и исполняются в vm — тем же приёмом, что и в
// hide-before-request.test.js. Помощники строки настоящие: `projectFocusRow`
// и `projectHotkeyTarget` берутся из frontend-src, иначе сторож проверял бы
// свои же заглушки.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ProjectList = require('../frontend-src/project-list');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}async function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

const CWD = '/home/user/projects/x';
const ROW = { kind: 'project', id: 'p:x', cwd: CWD, path: CWD, source: 'remote-host' };

// Живая сессия того же каталога с окном на этой машине: ровно то, что должен
// найти `focus`.
const OPEN = {
  id: 'aaaa-1111', cwd: CWD, live: true, title: 'x', lastActivity: 1787000000,
  windows: [{ host: 'mac', pid: 4242, canFocus: true, lastSeen: 1787000000 }],
};

/**
 * Прогнать ветку страницы и вернуть, чем она кончилась.
 *
 * Ветка `focus` кончается общей `focusSession`, прочие — `newSession` или
 * `newSessionHere`; сами они здесь заглушки, их порядок гашения сторожит
 * hide-before-request.test.js.
 */
function endOf(script, { sessions = [], projectOpenAction = 'focus' } = {}) {
  const calls = [];
  const ctx = {
    CONFIG: {
      windowHost: 'mac', mqtt: { configured: true }, projectOpenAction,
      sshHost: 'remote-host',
    },
    lastSessions: sessions,
    lastState: { windowHosts: [{ host: 'mac', pid: 4242, canFocus: true, openSession: false }] },
    projectRows: [ROW],
    // Менеджера на этой машине нет — та самая развилка, на которой ветка
    // `focus` и терялась.
    PICKER_OS: 'darwin',
    window: {
      OpenTransport: {
        rowProjectDir: (row) => row.cwd,
        chooseProjectOpenAction: () => 'local',
        isWindowsLocalRow: () => false,
      },
      ProjectList,
    },
    openManagerHere: () => null,
    // Достижимость менеджера — заглушка с тем же именем, что и у настоящего
    // помощника: этот сторож про то, куда ведёт Enter, а не про развилку
    // транспорта, которую здесь уже решает замоканная chooseProjectOpenAction.
    managerReachable: () => true,
    focusSession: (row) => { calls.push(`focusSession:${row.id}`); return Promise.resolve(); },
    newSession: (cwd) => { calls.push(`newSession:${cwd}`); return Promise.resolve(); },
    newSessionHere: () => { calls.push('newSessionHere'); return Promise.resolve(); },
    invoke: (cmd) => { calls.push(cmd); return Promise.resolve(); },
    render: () => {},
    error: '',
    row: ROW,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${sourceOf('openProjectHere')}${sourceOf('openProjectRow')}${sourceOf('openProjectHotkey')}\n${script}`,
    ctx, { filename: 'sessions.html' },
  );
  return ctx.result.then(() => calls);
}

test('Enter на строке проекта поднимает окно и там, где менеджера нет', async () => {
  const calls = await endOf('result = openProjectRow(row);', { sessions: [OPEN] });
  assert.deepStrictEqual(calls, ['focusSession:aaaa-1111'], calls.join(', '));
});

test('окна каталога нет — Enter заводит сессию, как заводил', async () => {
  const calls = await endOf('result = openProjectRow(row);', { sessions: [] });
  assert.deepStrictEqual(calls, [`newSession:${CWD}`], calls.join(', '));
});

test('projectOpenAction: new окна не ищет вовсе', async () => {
  const calls = await endOf('result = openProjectRow(row);',
    { sessions: [OPEN], projectOpenAction: 'new' });
  assert.deepStrictEqual(calls, ['newSessionHere'], calls.join(', '));
});

test('проектный хоткей поднимает то же окно и той же дорогой', async () => {
  const calls = await endOf(
    `result = openProjectHotkey({ cwd: ${JSON.stringify(CWD)}, action: 'focus' });`,
    { sessions: [OPEN] },
  );
  assert.deepStrictEqual(calls, ['focusSession:aaaa-1111'], calls.join(', '));
});

test('хоткей с action: new окна не ищет — ключи у двух входов разные', async () => {
  const calls = await endOf(
    `result = openProjectHotkey({ cwd: ${JSON.stringify(CWD)}, action: 'new' });`,
    { sessions: [OPEN], projectOpenAction: 'focus' },
  );
  assert.deepStrictEqual(calls, [`newSession:${CWD}`], calls.join(', '));
});

// Самое тихое расхождение из возможных: вторая копия развилки живёт и молчит,
// пока кто-нибудь не поправит одну из двух. Поведением такое не поймать — обе
// половинки по отдельности работают верно.
test('решение про окно каталога живёт в одном месте страницы', () => {
  const hits = SESSIONS_HTML.match(/ProjectList\.projectFocusRow\(/g) || [];
  assert.strictEqual(hits.length, 2,
    'projectFocusRow зовётся не из двух мест (openProjectHere и windows-ветка '
    + `openProjectRow), а из ${hits.length} — развилка снова разъезжается`);
});
