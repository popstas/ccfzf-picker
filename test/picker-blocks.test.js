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
  { key: 'live', label: 'Active local sessions', sessions: [session('a'), session('b')], remote: false },
  { key: 'past', label: 'Not running', past: true, sessions: [session('old', { live: false, lastActivity: AUG_12 })] },
];

// Список с двумя чужими машинами: в узком списке это две группы, в широком —
// один блок. Пометка `remote` приезжает из groupSessions.
const REMOTE_GROUPS = [
  { key: 'live', label: 'Active local sessions', sessions: [session('a')], remote: false },
  { key: 'remote:alpha-host', label: 'Active on alpha-host', sessions: [session('x')], remote: true, host: 'alpha-host' },
  { key: 'remote:zeta-host', label: 'Active on zeta-host', sessions: [session('y'), session('z')], remote: true, host: 'zeta-host' },
  { key: 'past', label: 'Not running', past: true, sessions: [session('old', { live: false, lastActivity: AUG_12 })] },
];
const PROJECTS = [{ id: 'p1', kind: 'project', label: 'picker', cwd: '/home/user/picker' }];
const SNAPSHOTS = [{ key: 'sn:1', kind: 'snapshot', label: 'work', total: 3 }];

function base(extra) {
  return {
    groups: GROUPS, projects: PROJECTS, snapshots: SNAPSHOTS,
    mode: 'sessions', query: '', trackerHere: true, collapsed: [], ...extra,
  };
}

test('каждая группа сессий становится блоком, проекты и снимки — своими', () => {
  const blocks = buildBlocks(base());
  // Порядок — порядок чтения: колонка за колонкой, сверху вниз внутри колонки.
  assert.deepStrictEqual(blocks.map(b => b.label), [
    'Active local sessions', 'Projects', 'Not running', 'Snapshots',
  ]);
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'projects', 'sessions', 'snapshots']);
});

test('раскладка по колонкам: свои живые слева, рядом чужие и проекты, справа история и снимки', () => {
  // Раскладку задал человек, и держится она на смысле строк: слева то, с чем
  // работают сейчас, посередине то, что рядом, справа то, к чему возвращаются.
  const blocks = buildBlocks(base({ groups: REMOTE_GROUPS }));
  assert.deepStrictEqual(blocks.map(b => [b.label, b.column]), [
    ['Active local sessions', 1],
    ['Active remote sessions - 3', 2],
    ['Projects', 2],
    ['Not running', 3],
    ['Snapshots', 3],
  ]);
});

test('чужие машины склеиваются в один блок', () => {
  // Блок занимает колонку, и пять машин дали бы пять узких колонок. Деление по
  // машинам живёт в узком списке, где строки идут сверху вниз и лишний
  // заголовок ничего не стоит.
  const blocks = buildBlocks(base({ groups: REMOTE_GROUPS }));
  assert.deepStrictEqual(blocks.map(b => b.label), [
    'Active local sessions', 'Active remote sessions - 3',
    'Projects', 'Not running', 'Snapshots',
  ]);
  // Строки — все чужие подряд, в порядке групп: сортировка внутри группы уже
  // сделана, а порядок машин задан алфавитом их имён.
  assert.deepStrictEqual(
    blocks[1].rows.filter(r => r.kind !== 'block-subhead').map(r => r.id), ['x', 'y', 'z']);
});

test('внутри склеенного блока машины названы подзаголовками', () => {
  // Склейка убрала заголовки групп, а вопрос «на какой машине» остался — ради
  // него деление и заводили. Подзаголовок отвечает на него внутри колонки.
  const blocks = buildBlocks(base({ groups: REMOTE_GROUPS }));
  assert.deepStrictEqual(blocks[1].rows.map(r => r.kind === 'block-subhead' ? r.label : r.id), [
    'alpha-host - 1', 'x', 'zeta-host - 2', 'y', 'z',
  ]);
});

test('счёт в заголовке чужого блока считает сессии, а не подзаголовки', () => {
  const blocks = buildBlocks(base({ groups: REMOTE_GROUPS }));
  assert.strictEqual(blocks[1].label, 'Active remote sessions - 3');
});

test('склейка идёт по пометке группы, а не по её заголовку', () => {
  // Заголовок чужой группы носит имя машины — данные с той стороны. Разбирай
  // склейка текст, имя машины стало бы форматом, который нельзя менять; тут
  // заголовок такой же, а пометки нет — и блок остаётся своим.
  const groups = [
    { label: 'Active on ghost-host', sessions: [session('g')] },
    { label: 'Active on alpha-host', sessions: [session('x')], remote: true, host: 'alpha-host' },
  ];
  const blocks = buildBlocks(base({ groups, projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.label),
    ['Active on ghost-host', 'Active remote sessions - 1']);
});

test('единственная чужая машина тоже становится общим блоком', () => {
  // Колонка одна на все машины, и её заголовок не может называть одну из них:
  // с приездом второй он молча стал бы враньём.
  const groups = REMOTE_GROUPS.filter(g => g.host !== 'zeta-host');
  const blocks = buildBlocks(base({ groups, projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.label),
    ['Active local sessions', 'Active remote sessions - 1', 'Not running']);
});

test('колонку истории выбирает пометка группы, а не её заголовок', () => {
  // Заголовок — видимая человеку строка, и опознавай мы историю по нему,
  // правка формулировки молча увела бы её из своей колонки и заодно выключила
  // бы сворачивание. Пометку `past` ставит groupSessions.
  const renamed = [
    { label: 'Active local sessions', sessions: [session('a')], remote: false },
    { label: 'Что угодно', past: true, sessions: [session('old', { live: false })] },
  ];
  const blocks = buildBlocks(base({ groups: renamed, projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => [b.label, b.column]), [
    ['Active local sessions', 1],
    ['Что угодно', 3],
  ]);
});

test('ключ склеенного блока не зависит от набора машин', () => {
  // По ключу блока помнится его отрисовка (renderedBlocks) и его развёрнутость.
  // Считайся ключ от заголовка со счётом или от имён машин — уснувшая на
  // соседней машине сессия пересобирала бы блок целиком.
  const one = buildBlocks(base({ groups: REMOTE_GROUPS }))[1];
  const few = buildBlocks(base({ groups: REMOTE_GROUPS.filter(g => g.host !== 'zeta-host') }))[1];
  assert.strictEqual(one.key, few.key);
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

test('история приходит развёрнутой', () => {
  // Сворачивалась она затем, чтобы «что было раньше» не оттесняло вниз «что
  // работает сейчас». Со своей колонкой во всю высоту она никого не оттесняет,
  // и умолчание перевернулось; сам механизм остался.
  const blocks = buildBlocks(base());
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, false);
  assert.deepStrictEqual(history.rows.map(r => r.id), ['old']);
});

test('свёрнутая история — одна строка со счётом и датой последней активности', () => {
  const blocks = buildBlocks(base({ collapsed: ['g:Not running'] }));
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, true);
  assert.strictEqual(history.rows.length, 1);
  assert.strictEqual(history.rows[0].kind, 'block-toggle');
  assert.strictEqual(history.rows[0].label, '1 session · last Aug 12');
});

test('свернуть можно только историю', () => {
  // Список свёртываемых заголовков — один, и просьба про чужой блок ничего не
  // меняет: колонка живых сессий, свёрнутая в строку, не сообщала бы главного.
  const blocks = buildBlocks(base({ collapsed: ['g:Active local sessions - 2', 'projects'] }));
  assert.deepStrictEqual(blocks.map(b => b.collapsed), [false, false, false, false]);
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
