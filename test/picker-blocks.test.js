const { test } = require('node:test');
const assert = require('node:assert');
const { buildBlocks, moveInBlocks, moveBetweenBlocks } = require('../frontend-src/picker-blocks');

/** Живая сессия в том объёме, в каком её читают блоки. */
function session(id, extra) {
  return { id, label: id, cwd: `/home/user/${id}`, live: true, ...extra };
}

// Полдень по местным часам: подпись свёрнутого блока считает дату местной, и
// от полудня она одинакова в любом часовом поясе, где гоняются тесты.
const AUG_12 = Math.floor(new Date(2026, 7, 12, 12, 0).getTime() / 1000);

const GROUPS = [
  { label: 'Active local sessions - 2', sessions: [session('a'), session('b')] },
  { label: 'Not running', sessions: [session('old', { live: false, lastActivity: AUG_12 })] },
];
const PROJECTS = [{ id: 'p1', kind: 'project', label: 'picker', cwd: '/home/user/picker' }];
const SNAPSHOTS = [{ key: 'sn:1', kind: 'snapshot', label: 'work', total: 3 }];

function base(extra) {
  return {
    groups: GROUPS, projects: PROJECTS, snapshots: SNAPSHOTS,
    mode: 'sessions', query: '', trackerHere: true, expanded: [], ...extra,
  };
}

test('каждая группа сессий становится блоком, проекты и снимки — своими', () => {
  const blocks = buildBlocks(base());
  assert.deepStrictEqual(blocks.map(b => b.label), [
    'Active local sessions - 2', 'Not running', 'Projects', 'Snapshots',
  ]);
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'sessions', 'projects', 'snapshots']);
});

test('пустой блок не заводится', () => {
  // Правило то же, по которому не заводится пустая половина живых сессий:
  // блок без строк — это заголовок, обещающий содержимое, которого нет.
  const blocks = buildBlocks(base({ projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'sessions']);
});

test('снимков нет там, где восстанавливать их нечем', () => {
  // То же условие, что у ^S: блок, чей Enter молчит, хуже отсутствующего.
  const blocks = buildBlocks(base({ trackerHere: false }));
  assert.ok(!blocks.some(b => b.kind === 'snapshots'));
});

test('префикс оставляет на экране один блок', () => {
  assert.deepStrictEqual(buildBlocks(base({ mode: 'projects' })).map(b => b.kind), ['projects']);
  assert.deepStrictEqual(buildBlocks(base({ mode: 'snapshots' })).map(b => b.kind), ['snapshots']);
});

test('запрос отбирает строки во всех блоках сразу', () => {
  // Снимки приезжают сюда уже отобранными: buildSnapshotRows берёт запрос
  // сама, и второй отбор здесь порвал бы пару «заголовок раскладки и её
  // сессии». Поэтому на непустом запросе вызывающая сторона передаёт то, что
  // осталось, — здесь ничего.
  const blocks = buildBlocks(base({ query: 'picker', snapshots: [] }));
  // Сессий с таким именем нет, проект есть — блоки сессий исчезают целиком.
  assert.deepStrictEqual(blocks.map(b => b.kind), ['projects']);
});

test('свёрнутая история — одна строка со счётом и датой последней активности', () => {
  const blocks = buildBlocks(base());
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, true);
  assert.strictEqual(history.rows.length, 1);
  assert.strictEqual(history.rows[0].kind, 'block-toggle');
  assert.strictEqual(history.rows[0].label, '1 session · last Aug 12');
});

test('развёрнутая история отдаёт свои сессии', () => {
  const blocks = buildBlocks(base({ expanded: ['g:Not running'] }));
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, false);
  assert.deepStrictEqual(history.rows.map(r => r.id), ['old']);
});

test('живые блоки свёрнутыми не приходят', () => {
  // Свёрнута только история: ради неё и заведено сворачивание — «что было
  // раньше» не должно оттеснять вниз «что работает сейчас».
  const blocks = buildBlocks(base());
  assert.strictEqual(blocks[0].collapsed, false);
});

// Три блока подряд в одном плоском массиве: 0-1 в первом, 2-3-4 во втором,
// 5 в третьем. Ровно так строки и лежат в rows у страницы.
const ROWS = [
  { block: 0 }, { block: 0 },
  { block: 1 }, { block: 1 }, { block: 1 },
  { block: 2 },
];

test('стрелки вверх-вниз ходят внутри блока', () => {
  assert.strictEqual(moveInBlocks(ROWS, 2, 1), 3);
  assert.strictEqual(moveInBlocks(ROWS, 3, -1), 2);
});

test('вниз в конце блока упирается, а не заворачивается', () => {
  // Круг по одной колонке из шести читался бы как «список кончился и начался
  // заново», а конец блока в широком режиме виден глазом.
  assert.strictEqual(moveInBlocks(ROWS, 4, 1), 4);
  assert.strictEqual(moveInBlocks(ROWS, 2, -1), 2);
});

test('вправо переводит в соседний блок на ту же позицию', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 1, 1), 3);
  assert.strictEqual(moveBetweenBlocks(ROWS, 3, -1), 1);
});

test('в коротком соседе выбирается последняя строка', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 4, 1), 5);
});

test('за крайним блоком стоять некуда — выбор не двигается', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 5, 1), 5);
  assert.strictEqual(moveBetweenBlocks(ROWS, 0, -1), 0);
});

test('пустой список никуда не ведёт', () => {
  assert.strictEqual(moveInBlocks([], 0, 1), 0);
  assert.strictEqual(moveBetweenBlocks([], 0, 1), 0);
});
