const { test } = require('node:test');
const assert = require('node:assert');
const { q, chooseOpenStrategy, buildOpenCommand } = require('../frontend-src/open-strategy');

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
  assert.strictEqual(cmd.argv[cmd.argv.length - 1], 'reptyr -T 42');
});

test('команда resume заходит в каталог сессии', () => {
  const cmd = buildOpenCommand(row(), 'resume', OPTS);
  assert.strictEqual(cmd.destructive, false);
  assert.strictEqual(
    cmd.argv[cmd.argv.length - 1],
    "cd '/home/user/projects/x' && claude --resume 'aaaa-bbbb'",
  );
});

test('перехват помечен необратимым и убивает мягко', () => {
  const cmd = buildOpenCommand(row({ live: true, pid: 42 }), 'takeover', OPTS);
  assert.strictEqual(cmd.destructive, true);
  const remote = cmd.argv[cmd.argv.length - 1];
  assert.ok(remote.startsWith('kill -HUP 42'), remote);
  assert.ok(!remote.includes('-9'), remote);
  assert.ok(remote.includes("claude --resume 'aaaa-bbbb'"), remote);
});

test('кавычки в пути не разрывают команду', () => {
  const cmd = buildOpenCommand(row({ cwd: "/home/user/it's" }), 'resume', OPTS);
  assert.ok(cmd.argv[cmd.argv.length - 1].includes("/home/user/it'\\''s"));
});

test('незнакомая стратегия не даёт команды', () => {
  assert.strictEqual(buildOpenCommand(row(), 'нет такой', OPTS), null);
});
