// Ctrl на строке списка: «открой окно там, куда я смотрю, и не двигай дальше».
//
// Просьба уходит ключом `noAutoplace` в теле `claude-session-open`, а пометку
// ставит менеджер на той стороне (`placeByCursor` в windows11-manager).
// Ответа у публикации нет, поэтому ошибка здесь не краснеет нигде: тело
// уедет верной формы, брокер подтвердит, окно откроется — и через секунду
// уползёт в слот, где эта сессия жила вчера. Ровно тот симптом, ради которого
// модификатор и заведён.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { noAutoplaceWanted } = require('../frontend-src/open-transport');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

const ROW = {
  kind: 'project', id: 'ffff-1111', cwd: '/home/user/projects/x',
  path: '/home/user/projects/x',
};

/** Тело просьбы, ушедшей из функции страницы, — по имени команды. */
function bodyOf(name, opts) {
  const re = new RegExp(`\\n {2}async function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const source = SESSIONS_HTML.match(re);
  assert.ok(source, `${name} не найдена в sessions.html — тест сторожит не то`);
  const sent = {};
  const ctx = {
    invoke: (cmd, args) => { sent[cmd] = args || {}; return Promise.resolve(); },
    CONFIG: { windowHost: 'pc-win', mqtt: { configured: true } },
    lastState: { windowHost: 'pc-win', windowPid: 4242, sessions: [] },
    // Модификатор — про просьбу к менеджеру, а под Windows у своей строки
    // просьбы нет вовсе: там открывается папка. Сторож про первую дорогу.
    PICKER_OS: 'linux',
    window: {
      OpenTransport: {
        rowProjectDir: (row) => row.cwd,
        chooseProjectOpenAction: () => 'manager',
        chooseOpenTransport: () => 'manager',
        isWindowsLocalRow: () => false,
      },
      OpenStrategy: { newSessionName: () => 'x-2' },
    },
    rows: [ROW],
    issuedNames: new Map(),
    takenSessionNames: () => [],
    newSession: () => Promise.resolve(),
    markSeen: () => Promise.resolve(),
    openManagerHere: () => ({ host: 'pc-win', mqttBase: 'windows/pc-win' }),
    managerBase: () => 'windows/pc-win',
    render: () => {},
    error: '',
    row: ROW,
    opts,
  };
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nresult = ${name}(row, opts);`, ctx, { filename: 'sessions.html' });
  return ctx.result.then(() => sent);
}

// Три просьбы, кончающиеся новым окном терминала. Забудь любую — и модификатор
// работал бы через раз: строка сессии слушалась бы, а строка проекта молчала.
const BRANCHES = [
  ['openViaManager', 'open_session_mqtt'],
  ['openProjectRow', 'open_project_mqtt'],
  ['newSessionHere', 'new_session_mqtt'],
];

for (const [fn, command] of BRANCHES) {
  test(`${fn} доносит просьбу «не расставляй» до тела`, async () => {
    const sent = await bodyOf(fn, { noAutoplace: true });
    assert.ok(sent[command], `${fn} не отправила ${command}`);
    assert.strictEqual(sent[command].noAutoplace, true);
  });

  test(`${fn} без модификатора просит как раньше`, async () => {
    const plain = await bodyOf(fn, {});
    assert.strictEqual(plain[command].noAutoplace, false);
    // Забытый аргумент обязан выключать оговорку, а не включать её: то же
    // правило, что у `sameMachine` рядом.
    const bare = await bodyOf(fn, undefined);
    assert.strictEqual(bare[command].noAutoplace, false);
  });
}

// Правило одно на клавишу и на мышь: второе разошлось бы с первым молча, и
// Ctrl+Enter делал бы не то же, что Ctrl+клик.
test('модификатор — Ctrl или Cmd без Shift и Alt', () => {
  assert.strictEqual(noAutoplaceWanted({ ctrlKey: true }), true);
  assert.strictEqual(noAutoplaceWanted({ metaKey: true }), true);
  assert.strictEqual(noAutoplaceWanted({}), false);
  // Shift занят переключением отметки «просмотрено»: промах по нему не должен
  // молча становиться просьбой о другом открытии.
  assert.strictEqual(noAutoplaceWanted({ ctrlKey: true, shiftKey: true }), false);
  assert.strictEqual(noAutoplaceWanted({ ctrlKey: true, altKey: true }), false);
});

// «Не знаю» обязано читаться как обычное открытие — то же правило, что у
// отсутствующего ключа `cursor` в теле.
test('не событие — не просьба', () => {
  assert.strictEqual(noAutoplaceWanted(null), false);
  assert.strictEqual(noAutoplaceWanted(undefined), false);
  assert.strictEqual(noAutoplaceWanted('ctrl'), false);
});

// Сторож текстовый, и иначе нельзя: оба входа висят на `document`, а прочитать
// модификатор им неоткуда, кроме события. Забудь передать его — и открытие
// пройдёт обычным, без единого следа: ни ошибки, ни отказа.
test('оба входа спрашивают модификатор у OpenTransport, а не по месту', () => {
  // Веток по `Enter` в файле несколько — у комментария и у меню свои; нужна
  // та единственная, что открывает выбранную строку.
  const enter = SESSIONS_HTML.match(/else if \(e\.key === 'Enter'\) \{[\s\S]{0,240}?choose\([\s\S]{0,80}?\}\)/);
  assert.ok(enter, 'ветка Enter, зовущая choose, не найдена — тест сторожит не то');
  assert.match(enter[0], /choose\(\{ noAutoplace: window\.OpenTransport\.noAutoplaceWanted\(e\) \}\)/);

  const click = SESSIONS_HTML.match(/list\.addEventListener\('click',[\s\S]*?\n {2}\}\);/);
  assert.ok(click, 'обработчик клика не найден — тест сторожит не то');
  assert.match(click[0], /choose\(\{ noAutoplace: window\.OpenTransport\.noAutoplaceWanted\(e\) \}\)/);
});
