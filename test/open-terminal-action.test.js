// Пункт «Open terminal» — шелл в каталоге строки, без агента.
//
// Проверяется настоящий код страницы, а не его копия: функция вычитывается из
// sessions.html и исполняется в vm — тем же приёмом, что и в
// `test/hide-before-request.test.js`. Копия разъехалась бы молча, а сторож
// остался бы зелёным.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const strategy = require('../frontend-src/open-strategy');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}async function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

const TERMINAL = { file: '/usr/bin/kitty', args: ['--single-instance', '--hold'] };

/** Прогнать `openTerminalHere` с настоящей OpenStrategy и подставным invoke. */
function run(row, extra = {}) {
  const calls = [];
  const ctx = {
    invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(); },
    CONFIG: { terminal: TERMINAL, sshHost: 'work-host' },
    // Настоящая сборка команды и argv: подстановки терминала — ровно то, ради
    // чего страница обязана ходить через terminalArgv, и подменять их здесь
    // значило бы сторожить заглушку.
    window: { OpenStrategy: strategy },
    noSources: () => false,
    helperPath: () => Promise.resolve('/home/user/.config/ccfzf-picker/open-terminal.sh'),
    helperError: '',
    render: () => {},
    error: '',
    row,
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(`${sourceOf('openTerminalHere')}\nresult = openTerminalHere(row);`,
    ctx, { filename: 'sessions.html' });
  return ctx.result.then(() => ({ calls, ctx }));
}

test('терминал открывается выбранным пресетом, а команда едет через ssh к источнику строки', async () => {
  const { calls } = await run({ cwd: '/home/user/projects/x', source: 'work-host' });
  const spawn = calls.find(c => c.cmd === 'spawn_detached');
  assert.ok(spawn, `spawn_detached не вызван: ${calls.map(c => c.cmd).join(', ')}`);
  const argv = spawn.args.argv;
  assert.strictEqual(argv[0], TERMINAL.file, argv.join(' '));
  assert.deepStrictEqual(argv.slice(1, 3), TERMINAL.args);
  assert.deepStrictEqual(argv.slice(3, 6), ['ssh', '-t', 'work-host'], argv.join(' '));
  // Каталог и интерактивный шелл — в самой команде, а не в аргументах
  // терминала: у каждого терминала они свои, а команда одна на всех.
  assert.match(argv[6], /cd -- .*projects\/x.* && exec \$SHELL -i/);
});

test('местная строка идёт без ssh, а не с пустым хостом', async () => {
  // `ssh -t ''` не работает никогда: у местного источника второго адресата
  // взяться неоткуда, и команду исполняет `sh -c` здесь же.
  const { calls } = await run({ cwd: '/home/user/projects/x', source: 'local' });
  const argv = calls.find(c => c.cmd === 'spawn_detached').args.argv;
  assert.deepStrictEqual(argv.slice(3, 5), ['/bin/sh', '-c'], argv.join(' '));
});

test('пикер гасится после запуска, а не до', async () => {
  // Окно поднимает сам пикер, права на передний план у него никто не
  // отбирает — то же, что у местной `newSession`. Гашение до запуска здесь
  // было бы обещанием окна, которого может и не случиться.
  const { calls } = await run({ cwd: '/home/user/projects/x', source: 'work-host' });
  const order = calls.map(c => c.cmd);
  assert.deepStrictEqual(order, ['spawn_detached', 'hide_picker'], order.join(', '));
});

test('менеджера этот пункт не просит вовсе', async () => {
  // Все его просьбы (`terminal`, `terminal-new`) кончаются агентом, а голого
  // шелла он открывать не умеет. Цена — потерянный профиль Windows Terminal по
  // каталогу, и она уплачена сознательно.
  const { calls } = await run({ cwd: '/home/user/projects/x', source: 'work-host' });
  assert.ok(!calls.some(c => /mqtt/.test(c.cmd)), calls.map(c => c.cmd).join(', '));
});

test('путь с `;` — сообщение человеку, а не молчание', async () => {
  // Windows Terminal режет свою командную строку по `;` до всякого шелла.
  // Пункт, который молча ничего не делает, читается как поломка пикера.
  const { calls, ctx } = await run({ cwd: '/home/user/pro;ject', source: 'work-host' });
  assert.deepStrictEqual(calls, []);
  assert.match(ctx.error, /";"/);
});

test('строка без каталога не запускает ничего', async () => {
  // Пункта у неё и не бывает (`availableActions`), но проверка стоит и здесь:
  // прямая клавиша `^T` приходит мимо меню.
  const { calls } = await run({ cwd: '', source: 'work-host' });
  assert.deepStrictEqual(calls, []);
});
