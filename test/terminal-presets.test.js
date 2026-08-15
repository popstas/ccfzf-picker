const { test } = require('node:test');
const assert = require('node:assert');
const {
  PRESETS, CUSTOM, osOf, presetsFor, presetById, matchPreset,
} = require('../frontend-src/terminal-presets');
const { buildOpenCommand } = require('../frontend-src/open-strategy');

test('система узнаётся по тому, что видно странице', () => {
  assert.strictEqual(osOf('MacIntel'), 'macos');
  assert.strictEqual(osOf('darwin'), 'macos');
  assert.strictEqual(osOf('Win32'), 'windows');
  assert.strictEqual(osOf('Linux x86_64'), 'linux');
  // Незнакомое — Linux: там путь к терминалу набирают руками чаще всего, и
  // ошибка здесь стоит неверного списка, а не поломки.
  assert.strictEqual(osOf(''), 'linux');
  assert.strictEqual(osOf(null), 'linux');
});

test('в списке — терминалы своей системы и «Custom» последним', () => {
  const mac = presetsFor('MacIntel').map(p => p.id);
  assert.deepStrictEqual(mac, ['kitty', 'ghostty', 'iterm2', CUSTOM]);
  const win = presetsFor('Win32').map(p => p.id);
  assert.deepStrictEqual(win, ['wt', CUSTOM]);
  // Чужие по системе не предлагаются: путь с другой системы здесь всё равно
  // не работает.
  assert.ok(!win.includes('iterm2'));
});

test('пресет заполняет оба поля, а не одно', () => {
  // Человеку, у которого стоит iTerm2, иначе пришлось бы знать и путь, и флаг.
  const kitty = presetById('kitty');
  assert.strictEqual(kitty.file, '/opt/homebrew/bin/kitty');
  assert.deepStrictEqual(kitty.args, ['--single-instance', '--hold']);
  assert.strictEqual(presetById('нет такого'), null);
});

test('оба kitty держат окно открытым после команды', () => {
  // Без `--hold` окно закрывается вместе с сессией агента, и чем та кончилась
  // — не прочитать. Флаг один и тот же на обеих системах: спутать его с
  // `--hide` (которого у kitty нет) или с `--start-as=hidden` (тот прячет
  // окно, то есть делает обратное) уже случалось.
  for (const id of ['kitty', 'kitty-linux']) {
    assert.ok(presetById(id).args.includes('--hold'), id);
  }
});

test('выбранный пресет считается по полям, а не хранится отдельно', () => {
  // Второй источник правды разошёлся бы с полями, которые правят руками, и
  // выпадашка обещала бы iTerm2 там, где в поле стоит kitty.
  assert.strictEqual(
    matchPreset({ file: '/opt/homebrew/bin/kitty', args: ['--single-instance', '--hold'] },
      'MacIntel'),
    'kitty');
  // Тот же путь без флага — уже не пресет: флаг и есть половина пресета.
  assert.strictEqual(
    matchPreset({ file: '/opt/homebrew/bin/kitty', args: [] }, 'MacIntel'), CUSTOM);
  assert.strictEqual(matchPreset({ file: '/usr/local/bin/kitty', args: ['--single-instance'] },
    'MacIntel'), CUSTOM);
  assert.strictEqual(matchPreset(null, 'MacIntel'), CUSTOM);
});

test('прежний kitty из config.yaml показывается как Custom, а не как kitty', () => {
  // Цена добавления `--hold`, и она видна человеку: у того, кто сохранил kitty
  // до этой правки, в файле лежит один `--single-instance`, и выпадашка обязана
  // сказать «Custom» — иначе она обещала бы пресет, которого в полях нет.
  // Лечится выбором пресета заново.
  assert.strictEqual(
    matchPreset({ file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] }, 'MacIntel'),
    CUSTOM);
});

test('прежний iTerm2 из config.yaml показывается как Custom', () => {
  // Та же цена, что у kitty с `--hold`, и платится она по той же причине:
  // в файле у того, кто выбрал iTerm2 до этой правки, лежит форма с
  // `command`, а она не работает вовсе — команду разбирает токенизатор
  // iTerm2. Выпадашка обязана сказать «Custom»: пообещай она iTerm2,
  // человек решил бы, что пресет у него уже верный, и не выбрал бы заново —
  // то есть остался бы с окном, закрывающимся сразу после открытия.
  // Форм, побывавших в конфигах, две: первая отдавала команду параметру
  // `command` (её ломал токенизатор), вторая печатала её в сессию через
  // `write text` (работала, но простыню экранирования было видно). Обе обязаны
  // читаться как Custom.
  for (const args of [
    ['-e', 'tell application "iTerm" to create window with default profile command "{command}"'],
    ['-e', 'tell application "iTerm" to tell (create window with default profile) to tell current session to write text "{command}"'],
  ]) {
    assert.strictEqual(matchPreset({ file: '/usr/bin/osascript', args }, 'MacIntel'), CUSTOM,
      args[1]);
  }
});

test('пресет чужой системы своим не считается', () => {
  // Иначе на Windows выпадашка показывала бы «kitty», хотя такого пути там нет.
  assert.strictEqual(
    matchPreset({ file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] }, 'Win32'),
    CUSTOM);
});

// ── argv, который получится у каждого терминала ─────────────────────────────
//
// Проверяется форма команды, а не то, что терминал её примет: живая проверка
// возможна только на машине, где эти терминалы стоят. Форма — это ровно то,
// что здесь можно удержать от расхождения.

const ROW = { id: 'sess-1', cwd: '/home/user/projects/x', live: false };

const HELPER = '/home/user/.config/ccfzf-picker/open-terminal.sh';

function argvFor(id) {
  const cmd = buildOpenCommand(ROW, 'resume',
    { sshHost: 'host-a', terminal: presetById(id), helperPath: HELPER });
  assert.ok(cmd, `команда для ${id} не собралась`);
  return cmd.argv;
}

test('kitty исполняет хвост argv как есть', () => {
  const argv = argvFor('kitty');
  assert.strictEqual(argv[0], '/opt/homebrew/bin/kitty');
  assert.deepStrictEqual(argv.slice(1, 3), ['--single-instance', '--hold']);
  // Команда идёт отдельными элементами: кавычить и экранировать нечего.
  assert.deepStrictEqual(argv.slice(3, 6), ['ssh', '-t', 'host-a']);
  assert.ok(argv[6].includes('claude'), argv[6]);
});

test('Ghostty получает команду после -e', () => {
  const argv = argvFor('ghostty');
  assert.strictEqual(argv[1], '-e');
  assert.deepStrictEqual(argv.slice(2, 5), ['ssh', '-t', 'host-a']);
});

test('Windows Terminal берёт хвост argv без флагов', () => {
  const argv = argvFor('wt');
  assert.strictEqual(argv[0], 'wt.exe');
  assert.deepStrictEqual(argv.slice(1, 4), ['ssh', '-t', 'host-a']);
});

test('iTerm2 получает команду одной строкой внутри AppleScript', () => {
  // В argv iTerm2 команду не принимает вовсе: `open -a iTerm` аргументы до
  // программы не доносит. Единственная дорога — AppleScript, где команда
  // обязана быть одной строкой.
  const argv = argvFor('iterm2');
  assert.strictEqual(argv[0], '/usr/bin/osascript');
  assert.strictEqual(argv[1], '-e');
  assert.strictEqual(argv.length, 3, 'команда не должна доезжать отдельными элементами');
  const script = argv[2];
  assert.ok(script.startsWith('tell application "iTerm"'), script.slice(0, 40));
  assert.ok(!script.includes('{helper}') && !script.includes('{commandBase64}'),
    'подстановка не сработала');
  assert.ok(script.includes(HELPER), 'помощника нет в скрипте');
});

test('iTerm2 не получает ни одной кавычки команды', () => {
  // Токенизатор iTerm2 обрабатывает `\` и внутри одинарных кавычек, поэтому
  // отдавать ему команду нельзя ни в каком виде — ни параметром `command`, ни
  // печатью в сессию. Отдаются два токена: путь помощника и base64. Кавычки в
  // скрипте остаются только свои, AppleScript'овые, вокруг пары токенов.
  const argv = argvFor('iterm2');
  const script = argv[2];
  const inside = script.slice(script.indexOf('command "') + 'command "'.length, -1);
  assert.match(inside, /^\S+ [A-Za-z0-9+/]+={0,2}$/, inside);
  assert.ok(!inside.includes("'"), `одинарная кавычка доехала до iTerm2: ${inside}`);
  assert.ok(!inside.includes('\\'), `обратный слэш доехал до iTerm2: ${inside}`);
});

test('команду разбирает шелл, а не токенизатор iTerm2', () => {
  // Параметр `command` у `create window` разбирает сам iTerm2, своим
  // токенизатором, — и тот, в отличие от POSIX-шелла, обрабатывает `\` и
  // внутри одинарных кавычек. Идиома `'\''`, которой `q` закрывает кавычку,
  // от этого рассыпается. Замер на живом маке (2026-08-15) — одна и та же
  // строка, два разбора:
  //
  //   sh:     exec $SHELL -ic 'cd -- '\''/home/user/x'\'' && claude --resume …
  //   iTerm2: exec $SHELL -ic 'cd -- '\\\/home/user/x\''' && claude --resume …
  //
  // До ssh доезжала вторая, падала мгновенно, и окно закрывалось — ровно тот
  // симптом, с которого началась задача. Лечится это не подбором
  // экранирования, а тем, что кавычек в строке не остаётся вовсе: команда
  // едет в base64 и разворачивается помощником, уже в шелле.
  const script = argvFor('iterm2')[2];
  const b64 = script.slice(script.lastIndexOf(' ') + 1, script.lastIndexOf('"'));
  const restored = Buffer.from(b64, 'base64').toString('utf8');
  // Развёрнутое — та же командная строка, что уехала бы хвостом argv у kitty.
  assert.ok(restored.includes("'ssh' '-t' 'host-a'"), restored);
  assert.ok(restored.includes('exec $SHELL -ic'), restored);
  assert.ok(restored.includes('claude --resume'), restored);
});

// Пресетами `{command}` больше не пользуется никто — iTerm2 ушёл на помощника,
// — но механизм жив: на нём держатся терминалы, настроенные человеком руками.
// Поэтому проверяется он теперь напрямую, а не через пресет.

const ONE_STRING = { file: 'osascript', args: ['-e', 'run "{command}"'] };

function oneStringScript() {
  return buildOpenCommand(ROW, 'resume',
    { sshHost: 'host-a', terminal: ONE_STRING }).argv[2];
}

test('кавычки команды экранируются для двойных кавычек', () => {
  // Внутри двойных кавычек AppleScript живые `"` порвали бы строку, и
  // osascript отказал бы на разборе — молча для пикера.
  const script = oneStringScript();
  const body = script.slice(script.indexOf('"') + 1, script.lastIndexOf('"'));
  assert.ok(!/(^|[^\\])"/.test(body), `неэкранированная кавычка: ${body}`);
});

test('подстановка не съедает `$` из команды', () => {
  // В команде стоит `exec $SHELL -ic ...`. У replace со строкой замены свои
  // значения у `$&` и `$'`, и подстановка молча съела бы кусок команды.
  assert.ok(oneStringScript().includes('$SHELL'), oneStringScript());
});

test('терминал без подстановки ведёт себя как раньше', () => {
  // Умолчание и все пресеты, кроме iTerm2, идут прежней дорогой — команда
  // хвостом argv. Эту форму ломать нельзя: на ней работает всё, что работало.
  const cmd = buildOpenCommand(ROW, 'resume',
    { sshHost: 'host-a', terminal: { file: 'kitty', args: [] } });
  assert.deepStrictEqual(cmd.argv.slice(0, 4), ['kitty', 'ssh', '-t', 'host-a']);
});

test('у каждого пресета есть и путь, и подпись', () => {
  for (const p of PRESETS) {
    assert.ok(p.id && p.label, JSON.stringify(p));
    assert.ok(p.file, `у ${p.id} нет пути`);
    assert.ok(Array.isArray(p.args), `у ${p.id} нет аргументов`);
    assert.ok(['macos', 'windows', 'linux'].includes(p.os), `у ${p.id} чужая система`);
  }
});
