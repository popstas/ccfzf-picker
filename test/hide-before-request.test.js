// Порядок «погасить пикер → попросить окно» у всех веток, кончающихся окном.
//
// Windows отдаёт передний план владельцу либо тому, кто получил последнее
// событие ввода. Пикер владеет им в момент нажатия и раздаёт право дальше
// (`allow_any_foreground` в main.rs), но гашение — это тоже ход за передний
// план: погасив себя после просьбы, пикер отбирает фокус у окна, которое его
// только что получило. На ветке подъёма окна это уже было оплачено багом, на
// проектных ветках — вторым, свернувшимся терминалом из списка `^A`.
//
// Проверяется настоящий код страницы, а не его копия: функции вычитываются из
// sessions.html и исполняются в vm — тем же приёмом, что и renderProjects в
// row-contract.test.js. Копия разъехалась бы молча, а сторож остался бы
// зелёным.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}async function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

const ROW = {
  kind: 'project', id: 'ffff-1111', cwd: '/home/user/projects/x',
  path: '/home/user/projects/x',
};

/** Прогнать функцию страницы с подставным `invoke` и вернуть порядок вызовов. */
function callsOf(name, extra = {}) {
  const calls = [];
  const ctx = {
    invoke: (cmd) => { calls.push(cmd); return Promise.resolve(); },
    // Ровно то, чем эти четыре функции пользуются снаружи себя.
    CONFIG: { windowHost: 'pc-win', mqtt: { configured: true } },
    lastState: { windowHost: 'pc-win', windowPid: 4242, sessions: [] },
    window: {
      OpenTransport: {
        rowProjectDir: (row) => row.cwd,
        chooseProjectOpenAction: () => 'manager',
        // openViaManager спрашивает её про «свою машину» — признак едет в теле
        // просьбы (`sameMachine`). Без заглушки функция падала бы в свой же
        // catch, и сторож ловил бы не порядок вызовов, а отсутствие мока.
        chooseOpenTransport: () => 'manager',
      },
      OpenStrategy: { newSessionName: () => 'x-2' },
      SessionWindows: { placeIds: () => ['ffff-1111'] },
    },
    // Отсев тусклых строк из раскладки — не предмет этого сторожа: он про
    // порядок вызовов. Настройка нужна placeWindows снаружи себя, как и
    // `focusBase` рядом.
    staleSettings: () => ({ enabled: false }),
    rows: [ROW],
    issuedNames: new Map(),
    takenSessionNames: () => [],
    newSession: () => { calls.push('newSession'); return Promise.resolve(); },
    markSeen: () => { calls.push('markSeen'); return Promise.resolve(); },
    // Адрес машины — не предмет этого сторожа, он про порядок вызовов; тут
    // достаточно заглушки с тем же именем, что и у настоящих помощников.
    openManagerHere: () => ({ host: 'pc-win', mqttBase: 'windows/pc-win' }),
    focusBase: () => 'windows/pc-win',
    managerBase: () => 'windows/pc-win',
    render: () => {},
    error: '',
    row: ROW,
    ...extra,
  };
  vm.createContext(ctx);
  // Второй аргумент — раскладка: он нужен только placeWindows, а прочие
  // ветки лишний аргумент не замечают.
  vm.runInContext(`${sourceOf(name)}\nresult = ${name}(row, 'tile');`, ctx, { filename: 'sessions.html' });
  return ctx.result.then(() => calls);
}

const BRANCHES = [
  ['focusSession', 'focus_window_mqtt'],
  ['openProjectRow', 'open_project_mqtt'],
  ['newSessionHere', 'new_session_mqtt'],
  ['openViaManager', 'open_session_mqtt'],
  // Пятая ветка: разложенные окна трекер выводит на передний план
  // (macos-windows-manager v0.4.0), то есть кончается она окном — и правило
  // про гашение до просьбы у неё то же.
  ['placeWindows', 'place_windows_mqtt'],
  // Шестая: сессию Claude Desktop открывает само приложение по ссылке
  // `claude://resume`, то есть ветка тоже кончается чужим окном. На маке
  // пикер вдобавок `alwaysOnTop` — погасив себя после, он накрыл бы окно,
  // которое только что попросил поднять.
  ['openInDesktopApp', 'open_desktop_session'],
];

for (const [fn, command] of BRANCHES) {
  test(`${fn} гасит пикер до просьбы, а не после`, async () => {
    const calls = await callsOf(fn);
    assert.ok(calls.includes(command), `${fn} не отправила ${command}: ${calls.join(', ')}`);
    assert.strictEqual(calls.indexOf('hide_picker'), 0,
      `${fn} должна гасить пикер первой, а вызвала: ${calls.join(', ')}`);
    assert.ok(calls.indexOf('hide_picker') < calls.indexOf(command),
      `${fn} гасит пикер после просьбы — окно потеряет фокус: ${calls.join(', ')}`);
  });
}

test('гашение не повторяется: второй hide_picker после просьбы — тот самый баг наоборот', async () => {
  for (const [fn] of BRANCHES) {
    const calls = await callsOf(fn);
    assert.strictEqual(calls.filter(c => c === 'hide_picker').length, 1,
      `${fn}: ${calls.join(', ')}`);
  }
});
