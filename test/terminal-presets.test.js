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
  assert.deepStrictEqual(kitty.args, ['--single-instance']);
  assert.strictEqual(presetById('нет такого'), null);
});

test('выбранный пресет считается по полям, а не хранится отдельно', () => {
  // Второй источник правды разошёлся бы с полями, которые правят руками, и
  // выпадашка обещала бы iTerm2 там, где в поле стоит kitty.
  assert.strictEqual(
    matchPreset({ file: '/opt/homebrew/bin/kitty', args: ['--single-instance'] }, 'MacIntel'),
    'kitty');
  // Тот же путь без флага — уже не пресет: флаг и есть половина пресета.
  assert.strictEqual(
    matchPreset({ file: '/opt/homebrew/bin/kitty', args: [] }, 'MacIntel'), CUSTOM);
  assert.strictEqual(matchPreset({ file: '/usr/local/bin/kitty', args: ['--single-instance'] },
    'MacIntel'), CUSTOM);
  assert.strictEqual(matchPreset(null, 'MacIntel'), CUSTOM);
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

function argvFor(id) {
  const cmd = buildOpenCommand(ROW, 'resume', { sshHost: 'host-a', terminal: presetById(id) });
  assert.ok(cmd, `команда для ${id} не собралась`);
  return cmd.argv;
}

test('kitty исполняет хвост argv как есть', () => {
  const argv = argvFor('kitty');
  assert.strictEqual(argv[0], '/opt/homebrew/bin/kitty');
  assert.strictEqual(argv[1], '--single-instance');
  // Команда идёт отдельными элементами: кавычить и экранировать нечего.
  assert.deepStrictEqual(argv.slice(2, 5), ['ssh', '-t', 'host-a']);
  assert.ok(argv[5].includes('claude'), argv[5]);
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
  assert.ok(!script.includes('{command}'), 'подстановка не сработала');
  assert.ok(script.includes('ssh'), 'команды нет в скрипте');
});

test('кавычки команды экранируются для двойных кавычек AppleScript', () => {
  const script = argvFor('iterm2')[2];
  // Внутри двойных кавычек AppleScript живые `"` порвали бы строку, и
  // osascript отказал бы на разборе — молча для пикера.
  const body = script.slice(script.indexOf('command "') + 'command "'.length, -1);
  assert.ok(!/(^|[^\\])"/.test(body), `неэкранированная кавычка: ${body}`);
});

test('подстановка не съедает `$` из команды', () => {
  // В команде стоит `exec $SHELL -ic ...`. У replace со строкой замены свои
  // значения у `$&` и `$'`, и подстановка молча съела бы кусок команды.
  const script = argvFor('iterm2')[2];
  assert.ok(script.includes('$SHELL'), script);
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
