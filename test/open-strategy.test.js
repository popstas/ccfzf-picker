const { test } = require('node:test');
const assert = require('node:assert');
const {
  q, chooseOpenStrategy, buildOpenCommand, buildAttachCommand, resumeCommand, newSessionCommand,
  newSessionName, commandParts, LOCAL_SOURCE,
} = require('../frontend-src/open-strategy');

const ATTACH_42 = `reptyr -T 42 || reptyr "$(pgrep -x -f 'reptyr -T 42' | head -1)"`;

test('команда переклейки собирается только при настоящем pid', () => {
  assert.strictEqual(buildAttachCommand({ pid: 42 }), ATTACH_42);
  assert.strictEqual(buildAttachCommand({ pid: '42' }), ATTACH_42);
  // Без sudo намеренно: он заводит собственный pty, и сессия уехала бы в него.
  assert.ok(!buildAttachCommand({ pid: 42 }).includes('sudo'));
  // Нечисловой pid дал бы `reptyr -T NaN` — команду, которая выглядит
  // рабочей и не работает. Пустая строка честнее: пункт меню просто не
  // появится.
  assert.strictEqual(buildAttachCommand({ pid: 'ой' }), '');
  assert.strictEqual(buildAttachCommand({ pid: 0 }), '');
  assert.strictEqual(buildAttachCommand({ pid: -1 }), '');
  assert.strictEqual(buildAttachCommand({}), '');
  assert.strictEqual(buildAttachCommand(null), '');
});

test('второй перенос целится в первый reptyr, а не в сессию', () => {
  // Проверено на живом хосте 2026-08-05: повторный `-T` по сессии падает с
  // «Unable to find the fd for the pty!», потому что мастер pty уже унесён из
  // sshd первым reptyr. Запасная половина команды тянет самого reptyr.
  const cmd = buildAttachCommand({ pid: 42 });
  const [first, second] = cmd.split(' || ');
  assert.strictEqual(first, 'reptyr -T 42');
  assert.ok(second.startsWith('reptyr "$('), second);
  // Запасная половина не должна быть повторением первой: `-T` там встречается
  // ровно один раз и только внутри шаблона поиска, а сам вызов идёт по pid.
  assert.ok(!/^reptyr\s+-T/.test(second), second);
  assert.strictEqual(second.match(/-T/g).length, 1, second);
  // Шаблон поиска — вся командная строка целиком (-x -f). Без -x подстрока
  // «reptyr -T 42» нашлась бы и в самой этой команде, и в чужих обёртках.
  assert.ok(second.includes("pgrep -x -f 'reptyr -T 42'"), second);
  // Несколько совпадений оборвали бы вызов лишними аргументами.
  assert.ok(second.includes('head -1'), second);
});

test('q закрывает кавычку, а не пропускает её дальше', () => {
  assert.strictEqual(q('/home/user/x'), "'/home/user/x'");
  assert.strictEqual(q("/home/user/it's"), "'/home/user/it'\\''s'");
  assert.strictEqual(q(''), "''");
  assert.strictEqual(q(null), "''");
  assert.strictEqual(q(undefined), "''");
  // Точка с запятой и подстановка внутри кавычек — обычные знаки: ровно ради
  // этого q и стоит перед каждым путём, уезжающим в удалённую команду.
  assert.strictEqual(q('a; rm -rf /'), "'a; rm -rf /'");
  assert.strictEqual(q('$(id)'), "'$(id)'");
});

const OPTS = {
  sshHost: 'user@example-host',
  terminal: { file: 'open', args: ['-na', 'kitty', '--args'] },
};

function row(extra) {
  return Object.assign({
    id: 'aaaa-bbbb', cwd: '/home/user/projects/x',
    live: false, pid: 0, tty: '', tmux: null,
  }, extra || {});
}

test('сессия в tmux открывается присоединением', () => {
  assert.strictEqual(chooseOpenStrategy(row({ live: true, tmux: 'work:2.0' }), { reptyr: true }), 'attach');
});

test('tmux выигрывает у reptyr даже у мёртвой сессии', () => {
  assert.strictEqual(chooseOpenStrategy(row({ live: false, tmux: 'work:2.0' }), { reptyr: true }), 'attach');
});

test('живая сессия вне tmux переносится через reptyr, когда он есть', () => {
  assert.strictEqual(chooseOpenStrategy(row({ live: true, pid: 42 }), { reptyr: true }), 'reptyr');
});

test('без reptyr живая сессия открывается рядом, а не убивается', () => {
  assert.strictEqual(chooseOpenStrategy(row({ live: true, pid: 42 }), { reptyr: false }), 'resume');
  assert.strictEqual(chooseOpenStrategy(row({ live: true, pid: 42 }), {}), 'resume');
});

test('перехват выбирается, только когда его просят явно', () => {
  assert.strictEqual(
    chooseOpenStrategy(row({ live: true, pid: 42 }), { reptyr: false, takeover: true }), 'takeover');
  // reptyr сохраннее перехвата, поэтому выигрывает, когда доступны оба.
  assert.strictEqual(
    chooseOpenStrategy(row({ live: true, pid: 42 }), { reptyr: true, takeover: true }), 'reptyr');
  // Просить перехват у мёртвой сессии бессмысленно: убивать в ней нечего.
  assert.strictEqual(chooseOpenStrategy(row({ live: false }), { takeover: true }), 'resume');
});

test('живая сессия без pid перехватить нечего — идёт resume', () => {
  assert.strictEqual(chooseOpenStrategy(row({ live: true, pid: 0 }), { reptyr: true }), 'resume');
});

test('мёртвая сессия просто возобновляется', () => {
  assert.strictEqual(chooseOpenStrategy(row(), { reptyr: true }), 'resume');
  assert.strictEqual(chooseOpenStrategy(row(), {}), 'resume');
});

const WINDOW = { title: 'ccfzf-picker', desktop: 2, lastSeen: 1000 };

test('открытое окно выигрывает у всех остальных веток', () => {
  // Иначе у сессии с уже открытым терминалом любая ветка заводит вторую копию
  // рядом с первой — ровно то, ради чего трекер и опрашивается.
  const live = row({ live: true, pid: 42, window: WINDOW });
  assert.strictEqual(chooseOpenStrategy(live, { reptyr: true }, { canFocus: true }), 'focus');
  assert.strictEqual(chooseOpenStrategy(live, { takeover: true }, { canFocus: true }), 'focus');
  assert.strictEqual(
    chooseOpenStrategy(row({ tmux: 'work:2.0', window: WINDOW }), {}, { canFocus: true }), 'focus');
});

test('без разрешения фокусировать окно ничего не меняется', () => {
  // canFocus приходит false на маке: окна там на другой машине, и подъём окна
  // отнял бы у Enter открытие терминала, не дав взамен ничего видимого.
  const live = row({ live: true, pid: 42, window: WINDOW });
  assert.strictEqual(chooseOpenStrategy(live, { reptyr: true }, { canFocus: false }), 'reptyr');
  assert.strictEqual(chooseOpenStrategy(live, { reptyr: true }, {}), 'reptyr');
  assert.strictEqual(chooseOpenStrategy(live, { reptyr: true }), 'reptyr');
});

test('без окна разрешение фокусировать ничего не даёт', () => {
  assert.strictEqual(
    chooseOpenStrategy(row({ live: true, pid: 42, window: null }), {}, { canFocus: true }), 'resume');
});

test('у фокуса нет команды терминала', () => {
  // Окно уже открыто, поднимает его трекер по http. Вызывающий обязан развести
  // фокус и остальные ветки до сборки команды — здесь ему возвращается null,
  // и запуск терминала с пустым argv так не случится.
  assert.strictEqual(buildOpenCommand(row({ window: WINDOW }), 'focus', OPTS), null);
});

test('команда attach ведёт в панель tmux', () => {
  const cmd = buildOpenCommand(row({ tmux: 'work:2.0' }), 'attach', OPTS);
  assert.strictEqual(cmd.destructive, false);
  assert.deepStrictEqual(cmd.argv, [
    'open', '-na', 'kitty', '--args',
    'ssh', '-t', 'user@example-host',
    "tmux attach -t 'work:2.0'",
  ]);
});

test('команда reptyr забирает процесс по pid', () => {
  const cmd = buildOpenCommand(row({ live: true, pid: 42 }), 'reptyr', OPTS);
  assert.strictEqual(cmd.destructive, false);
  // exec обязателен: иначе рядом остаётся шелл ssh в той же группе процессов,
  // и следующий перенос этой сессии упрётся в «shares process group».
  assert.strictEqual(cmd.argv[cmd.argv.length - 1], 'exec reptyr -T 42');
});

test('команда resume заходит в каталог сессии через интерактивный шелл', () => {
  const cmd = buildOpenCommand(row(), 'resume', OPTS);
  assert.strictEqual(cmd.destructive, false);
  const remote = cmd.argv[cmd.argv.length - 1];
  // `ssh host cmd` — неинтерактивный шелл, а zsh читает тогда только .zshenv:
  // без -i не отработает ни хук chpwd, ни экспорты из .zshrc, и агент пишет
  // телеметрию без project=. Проверено на живом хосте 2026-08-05.
  assert.ok(remote.startsWith('exec $SHELL -ic '), remote);
  // cd — внутри интерактивного шелла, после чтения rc: иначе rc, который сам
  // куда-то переходит, уводит каталог обратно.
  assert.ok(remote.includes("cd -- '\\''/home/user/projects/x'\\''"), remote);
  assert.ok(remote.includes("claude --resume '\\''aaaa-bbbb'\\''"), remote);
});

test('двойные кавычки в команде запуска не появляются', () => {
  // Внутри двойных кавычек $(…) из чужого пути выполнилось бы шеллом на той
  // стороне. Единственная защита — одинарные, навешенные дважды.
  const cmd = buildOpenCommand(row({ cwd: '/home/user/$(id)' }), 'resume', OPTS);
  const remote = cmd.argv[cmd.argv.length - 1];
  assert.ok(!remote.includes('"'), remote);
  assert.ok(remote.includes('$(id)'), remote);
});

test('перехват помечен необратимым и убивает мягко', () => {
  const cmd = buildOpenCommand(row({ live: true, pid: 42 }), 'takeover', OPTS);
  assert.strictEqual(cmd.destructive, true);
  const remote = cmd.argv[cmd.argv.length - 1];
  assert.ok(remote.startsWith('kill -HUP 42'), remote);
  assert.ok(!remote.includes('-9'), remote);
  // Хвост перехвата — та же команда запуска, что и у resume, а не своя копия.
  assert.ok(remote.endsWith(resumeCommand('/home/user/projects/x', 'aaaa-bbbb')), remote);
});

test('кавычки в пути не разрывают команду', () => {
  const cmd = buildOpenCommand(row({ cwd: "/home/user/it's" }), 'resume', OPTS);
  // Путь проходит через q дважды, поэтому и лесенка кавычек двойная: первый q
  // даёт it'\''s, второй экранирует в нём и кавычки, и ничего не делает с
  // бэкслешем — отсюда \'\'' в середине. String.raw, чтобы написанное здесь
  // совпадало с тем, что уедет в ssh, знак в знак.
  assert.ok(cmd.argv[cmd.argv.length - 1].includes(String.raw`it'\''\'\'''\''s`),
    cmd.argv[cmd.argv.length - 1]);
});

test('незнакомая стратегия не даёт команды', () => {
  assert.strictEqual(buildOpenCommand(row(), 'нет такой', OPTS), null);
});

// ── commandParts: одно место, где команда встречается с транспортом ─────────

test('местная команда идёт без ssh, но через интерактивный шелл', () => {
  // Строка команды та же: `exec $SHELL -ic` нужна ровно затем же, зачем и на
  // удалённой машине — поднять интерактивный шелл, чтобы отработал хук chpwd и
  // телеметрия получила имя проекта. Меняется только транспорт.
  const parts = commandParts("exec $SHELL -ic 'cd -- /a && claude'", LOCAL_SOURCE);
  assert.deepStrictEqual(parts, ['/bin/sh', '-c', "exec $SHELL -ic 'cd -- /a && claude'"]);
});

test('удалённая команда по-прежнему уезжает одной строкой в ssh', () => {
  const parts = commandParts('claude --resume x', 'remote-host');
  assert.deepStrictEqual(parts, ['ssh', '-t', 'remote-host', 'claude --resume x']);
});

test('buildOpenCommand берёт источник у строки, а не у конфига', () => {
  // CONFIG.sshHost перестал быть адресом чего бы то ни было: местная сессия
  // открылась бы на удалённой машине, где её нет вовсе.
  const row = { id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76', cwd: '/a', source: LOCAL_SOURCE };
  const out = buildOpenCommand(row, 'resume', {
    sshHost: 'remote-host', terminal: { file: 'kitty', args: ['--hold'] },
  });
  assert.ok(!out.argv.includes('ssh'), `ssh в местной команде: ${JSON.stringify(out.argv)}`);
  assert.deepStrictEqual(out.argv.slice(0, 3), ['kitty', '--hold', '/bin/sh']);
});

test('строка без источника открывается по sshHost — как до этой правки', () => {
  const row = { id: 'b5a54ce3-a022-4c9a-aa91-e306d75bdc76', cwd: '/a' };
  const out = buildOpenCommand(row, 'resume', {
    sshHost: 'remote-host', terminal: { file: 'kitty', args: [] },
  });
  assert.deepStrictEqual(out.argv.slice(0, 4), ['kitty', 'ssh', '-t', 'remote-host']);
});

// ── terminalArgv: одно место, где команда встречается с терминалом ──────────
//
// Мина, ради которой это заведено, уже сработала: `newSession` в
// `sessions.html` собирал argv руками — `[file, ...args, 'ssh', …]`, — то есть
// про подстановку не знал вовсе. У iTerm2 это значило окно, в которое
// печатается литеральный `{command}`, а `ssh` с аргументами уезжает osascript
// в никуда. Живьём поймано 2026-08-15. Второй сборки argv быть не должно.

const { terminalArgv, toBase64 } = require('../frontend-src/open-strategy');
const PARTS = ['ssh', '-t', 'host-a', "exec $SHELL -ic 'cd -- x'"];

test('терминал без подстановки получает команду хвостом argv', () => {
  assert.deepStrictEqual(terminalArgv({ file: 'kitty', args: ['--hold'] }, PARTS, {}),
    ['kitty', '--hold', ...PARTS]);
});

test('терминалу с {command} команда приезжает одной строкой', () => {
  const argv = terminalArgv({ file: 'x', args: ['-e', 'run "{command}"'] }, PARTS, {});
  assert.strictEqual(argv.length, 3);
  assert.ok(!argv[2].includes('{command}'), argv[2]);
  assert.ok(argv[2].includes('ssh'), argv[2]);
});

test('терминалу с помощником не достаётся ни одной кавычки', () => {
  // Ради этого помощник и заведён: токенизатор iTerm2 обрабатывает `\` внутри
  // одинарных кавычек, поэтому команду ему отдавать нельзя вовсе. Отдаётся
  // путь помощника и base64 — а в алфавите base64 нет ни кавычки, ни слэша
  // наружу, ни пробела, так что делить тут нечего и портить нечего.
  const term = { file: 'osascript', args: ['-e', 'run command "{helper} {commandBase64}"'] };
  const argv = terminalArgv(term, PARTS, { helperPath: '/home/user/.config/x/open.sh' });
  const script = argv[2];
  assert.ok(!script.includes('{helper}') && !script.includes('{commandBase64}'), script);
  // Внутри кавычек AppleScript — ровно два токена, и оба безопасны.
  const inside = script.slice(script.indexOf('"') + 1, script.lastIndexOf('"'));
  assert.deepStrictEqual(inside.split(' ').length, 2, inside);
  const [path, blob] = inside.split(' ');
  assert.strictEqual(path, '/home/user/.config/x/open.sh');
  assert.match(blob, /^[A-Za-z0-9+/]+={0,2}$/, blob);
});

test('base64 разворачивается обратно в ту же команду', () => {
  // Круг замыкается на той стороне: помощник декодирует и отдаёт шеллу.
  const term = { file: 'osascript', args: ['{helper} {commandBase64}'] };
  const blob = terminalArgv(term, PARTS, { helperPath: '/h' })[1].split(' ')[1];
  assert.strictEqual(Buffer.from(blob, 'base64').toString('utf8'),
    PARTS.map(p => `'${p.replace(/'/g, "'\\''")}'`).join(' '));
});

test('не-ASCII в пути переживает base64', () => {
  // Каталог с кириллицей — обычное дело, а btoa на таком падает: кодировать
  // надо байты UTF-8, а не символы.
  const term = { file: 'x', args: ['{helper} {commandBase64}'] };
  const parts = ['ssh', '-t', 'h', 'cd -- /home/user/проекты/тест'];
  const blob = terminalArgv(term, parts, { helperPath: '/h' })[1].split(' ')[1];
  assert.ok(Buffer.from(blob, 'base64').toString('utf8').includes('проекты/тест'));
});

test('без пути помощника команда не собирается', () => {
  // Молча уехать нельзя: пустой путь дал бы токен-пустышку, iTerm2 запустил бы
  // base64 как программу, и окно закрылось бы — тот самый симптом, с которого
  // всё началось.
  const term = { file: 'x', args: ['{helper} {commandBase64}'] };
  assert.strictEqual(terminalArgv(term, PARTS, {}), null);
  assert.strictEqual(terminalArgv(term, PARTS, { helperPath: '' }), null);
});

test('toBase64 не тащит переносов строк', () => {
  // Перенос внутри токена разорвал бы его на два, и второй уехал бы отдельным
  // аргументом. У длинной команды это не гипотеза: base64 в утилитах переносит
  // по 76 знаков.
  const blob = toBase64('x'.repeat(400));
  assert.ok(!blob.includes('\n'), blob);
});

test('новая сессия называется по каталогу проекта', () => {
  // Имя не для красоты: по нему оконный трекер находит сессию в заголовке
  // окна, не дожидаясь /rename. Форма взята у ccfzf.
  assert.strictEqual(
    newSessionCommand('/home/user/projects/ccfzf'),
    `exec $SHELL -ic 'cd -- '\\''/home/user/projects/ccfzf'\\'' && claude -n '\\''ccfzf'\\'''`,
  );
});

test('имя новой сессии берётся у последнего сегмента пути', () => {
  const withSlash = newSessionCommand('/home/user/projects/ccfzf/');
  assert.match(withSlash, /claude -n '\\''ccfzf'\\''/);
});

test('кавычка в имени каталога не разваливает команду', () => {
  // Единственный барьер между придуманным человеком путём и чужим шеллом — q.
  const cmd = newSessionCommand("/home/user/pro'ject");
  assert.match(cmd, /claude -n /);
});

test('точка с запятой в пути — отказ, а не команда', () => {
  // Проверка гоняется на пути, в котором `;` действительно есть: для шелла он
  // безопасен (q отработала), но Windows Terminal режет по нему свою
  // командную строку на панели ещё до всякого шелла. Вызывающий на пустую
  // строку показывает отказ — молча открыть сессию в чужом каталоге хуже.
  assert.strictEqual(newSessionCommand('/home/user/a;b'), '');
  assert.strictEqual(newSessionCommand('/home/user/a;b/'), '');
  assert.strictEqual(newSessionCommand(';'), '');
  // Соседний путь по-прежнему собирается, и `;` в готовой команде не заводится.
  const ok = newSessionCommand('/home/user/projects/ccfzf');
  assert.ok(ok && !ok.includes(';'), ok);
});

test('новая сессия в занятом имени получает суффикс', () => {
  // Кавычки навешиваются дважды (см. inDir), поэтому и в готовой команде имя
  // ищем в экранированном виде — как в соседних тестах этого файла.
  const cmd = newSessionCommand('/home/user/projects/api', ['api']);
  assert.match(cmd, /claude -n '\\''api-2'\\''/);
});

test('свободное имя остаётся без суффикса', () => {
  const cmd = newSessionCommand('/home/user/projects/api', ['другая']);
  assert.match(cmd, /claude -n '\\''api'\\''/);
});

test('без списка занятых поведение прежнее', () => {
  // Аргумент необязателен: вызов без него не должен ломаться — так зовут из
  // тестов соседних функций и из старого кода.
  assert.match(newSessionCommand('/home/user/projects/api'), /claude -n '\\''api'\\''/);
});

test('newSessionName отдаёт то же имя, что попадает в команду', () => {
  // Имя нужно вызывающему отдельно: он помнит выданные имена, чтобы два ^N
  // подряд не дали тёзок. Разойтись этим двум нельзя.
  const taken = ['api'];
  const name = newSessionName('/home/user/projects/api', taken);
  assert.strictEqual(name, 'api-2');
  assert.ok(newSessionCommand('/home/user/projects/api', taken).includes(`-n '\\''${name}'\\'''`));
});

test('путь с точкой с запятой отказывает и по имени тоже', () => {
  // Отказ остаётся первым: Windows Terminal порежет такую команду на панели
  // ещё до шелла, и никакое имя этого не спасает.
  assert.strictEqual(newSessionCommand('/home/user/a;b', ['a;b']), '');
  assert.strictEqual(newSessionName('/home/user/a;b', []), '');
});

test('строка внутри zellij открывается присоединением, а не вторым процессом', () => {
  const row = { id: 'a', live: true, pid: 42, zellij: 'obsidian-agent-base' };
  assert.strictEqual(chooseOpenStrategy(row, { reptyr: true }, {}), 'attach');
  const cmd = buildOpenCommand(row, 'attach', { sshHost: 'user@example-host', terminal: { file: 'wt', args: [] } });
  assert.ok(cmd.argv.includes("zellij attach 'obsidian-agent-base'"), cmd.argv);
  assert.strictEqual(cmd.destructive, false);
});

test('при обоих мультиплексорах выигрывает tmux', () => {
  // Порядок веток — по убыванию сохранности, и между двумя одинаково
  // сохранными решает то, что было раньше: менять привычное поведение
  // tmux-строк эта правка не должна.
  const row = { id: 'a', live: true, tmux: 'main:0.1', zellij: 'home' };
  const cmd = buildOpenCommand(row, 'attach', { sshHost: 'user@example-host', terminal: { file: 'wt', args: [] } });
  assert.ok(cmd.argv.includes("tmux attach -t 'main:0.1'"), cmd.argv);
});

test('строка зелийной сессии присоединяется своим же именем', () => {
  // У строки kind: 'zellij' нет ни pid, ни живой сессии — только имя, и его
  // хватает: поле одно и то же, ветка одна и та же.
  const row = { id: 'zellij:home', kind: 'zellij', zellij: 'home' };
  assert.strictEqual(chooseOpenStrategy(row, {}, {}), 'attach');
  const cmd = buildOpenCommand(row, 'attach', { sshHost: 'user@example-host', terminal: { file: 'wt', args: [] } });
  assert.ok(cmd.argv.includes("zellij attach 'home'"), cmd.argv);
});

test('страница не собирает argv терминала мимо terminalArgv', () => {
  // Мина сработавшая: `newSession` складывал argv у себя,
  // `[CONFIG.terminal.file, ...CONFIG.terminal.args, 'ssh', …]`, и про
  // подстановку не знал вовсе — у iTerm2 это давало окно с литеральным
  // `{command}`, а ssh уезжал osascript в никуда. Ловится текстом страницы:
  // поведением это не поймать, argv тут собирается верным для kitty и молча
  // неверным для того единственного терминала, который подстановкой живёт.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const byHand = page.match(/terminal\.file,\s*\.\.\.[A-Za-z_$][\w$]*\.terminal\.args/g) || [];
  assert.deepStrictEqual(byHand, [], 'argv терминала снова собирается на месте');
  // И обратное: обе дороги открытия обязаны звать общую сборку.
  const calls = page.match(/OpenStrategy\.terminalArgv\(/g) || [];
  assert.ok(calls.length >= 1, 'terminalArgv со страницы не зовётся вовсе');
});

test('страница не собирает ssh-хвост мимо commandParts', () => {
  // Поведением такое не поймать: argv тут собирается верным для удалённых
  // строк и молча неверным для местных — то есть ровно та же мина, что
  // взорвалась на `newSession` и iTerm2.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
  const hits = page.match(/'ssh',\s*'-t'/g) || [];
  assert.deepStrictEqual(hits, [], 'ssh-хвост собран на странице, а не в commandParts');
});
