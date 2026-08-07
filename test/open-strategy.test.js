const { test } = require('node:test');
const assert = require('node:assert');
const {
  q, chooseOpenStrategy, buildOpenCommand, buildAttachCommand, resumeCommand, newSessionCommand,
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
  assert.ok(!cmd.includes(";"), 'точка с запятой ломает Windows Terminal');
  assert.match(cmd, /claude -n /);
});
