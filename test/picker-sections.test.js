const { test } = require('node:test');
const assert = require('node:assert');
const { buildSections, sectionHeaderText, moveInBlocks, moveBetweenBlocks } = require('../frontend-src/picker-sections');

/** Живая сессия в том объёме, в каком её читают секции. */
function session(id, extra) {
  return { id, label: id, cwd: `/home/user/${id}`, live: true, ...extra };
}

// Полдень по местным часам: подпись свёрнутой секции считает дату местной, и
// от полудня она одинакова в любом часовом поясе, где гоняются тесты.
const AUG_12 = Math.floor(new Date(2026, 7, 12, 12, 0).getTime() / 1000);

const GROUPS = [
  { key: 'live', label: 'Active local sessions', sessions: [session('a'), session('b')], remote: false },
  { key: 'past', label: 'Not running', past: true, sessions: [session('old', { live: false, lastActivity: AUG_12 })] },
];

// Список с двумя чужими машинами: в узком списке это две секции, в широком —
// одна. Пометка `remote` приезжает из groupSessions.
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
    mode: 'sessions', query: '', trackerHere: true, collapsed: {},
    layout: 'wide', ...extra,
  };
}

test('каждая группа сессий становится секцией, проекты и снимки — своими', () => {
  const blocks = buildSections(base());
  // Порядок — порядок чтения: колонка за колонкой, сверху вниз внутри колонки.
  assert.deepStrictEqual(blocks.map(b => b.label), [
    'Active local sessions', 'Projects', 'Not running', 'Snapshots',
  ]);
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'projects', 'sessions', 'snapshots']);
});

test('раскладка по колонкам: свои живые слева, рядом чужие и проекты, справа история и снимки', () => {
  // Раскладку задал человек, и держится она на смысле строк: слева то, с чем
  // работают сейчас, посередине то, что рядом, справа то, к чему возвращаются.
  const blocks = buildSections(base({ groups: REMOTE_GROUPS }));
  assert.deepStrictEqual(blocks.map(b => [b.label, b.column]), [
    ['Active local sessions', 1],
    ['Active remote sessions', 2],
    ['Projects', 2],
    ['Not running', 3],
    ['Snapshots', 3],
  ]);
});

test('чужие машины склеиваются в одну секцию', () => {
  // Секция занимает колонку, и пять машин дали бы пять узких колонок. Деление
  // по машинам живёт в узком списке, где строки идут сверху вниз и лишний
  // заголовок ничего не стоит.
  const blocks = buildSections(base({ groups: REMOTE_GROUPS }));
  assert.deepStrictEqual(blocks.map(b => b.label), [
    'Active local sessions', 'Active remote sessions',
    'Projects', 'Not running', 'Snapshots',
  ]);
  // Строки — все чужие подряд, в порядке групп: сортировка внутри группы уже
  // сделана, а порядок машин задан groupSessions.
  assert.deepStrictEqual(
    blocks[1].rows.filter(r => r.kind !== 'block-subhead').map(r => r.id), ['x', 'y', 'z']);
});

test('внутри склеенной секции машины названы подзаголовками', () => {
  // Склейка убрала заголовки групп, а вопрос «на какой машине» остался — ради
  // него деление и заводили. Подзаголовок отвечает на него внутри колонки.
  const blocks = buildSections(base({ groups: REMOTE_GROUPS }));
  assert.deepStrictEqual(blocks[1].rows.map(r => r.kind === 'block-subhead' ? r.label : r.id), [
    'alpha-host - 1', 'x', 'zeta-host - 2', 'y', 'z',
  ]);
});

test('склейка идёт по пометке группы, а не по её заголовку', () => {
  // Заголовок чужой группы носит имя машины — данные с той стороны. Разбирай
  // склейка текст, имя машины стало бы форматом, который нельзя менять; тут
  // заголовок такой же, а пометки нет — и секция остаётся своей.
  const groups = [
    { key: 'live', label: 'Active on ghost-host', sessions: [session('g')] },
    { key: 'remote:alpha-host', label: 'Active on alpha-host', sessions: [session('x')], remote: true, host: 'alpha-host' },
  ];
  const blocks = buildSections(base({ groups, projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.label),
    ['Active on ghost-host', 'Active remote sessions']);
});

test('единственная чужая машина тоже становится общей секцией', () => {
  // Колонка одна на все машины, и её заголовок не может называть одну из них:
  // с приездом второй он молча стал бы враньём.
  const groups = REMOTE_GROUPS.filter(g => g.host !== 'zeta-host');
  const blocks = buildSections(base({ groups, projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.label),
    ['Active local sessions', 'Active remote sessions', 'Not running']);
});

test('колонку истории выбирает пометка группы, а не её заголовок', () => {
  // Заголовок — видимая человеку строка, и опознавай мы историю по нему,
  // правка формулировки молча увела бы её из своей колонки и заодно выключила
  // бы сворачивание. Пометку `past` ставит groupSessions.
  const renamed = [
    { key: 'live', label: 'Active local sessions', sessions: [session('a')], remote: false },
    { key: 'past', label: 'Что угодно', past: true, sessions: [session('old', { live: false })] },
  ];
  const blocks = buildSections(base({ groups: renamed, projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => [b.label, b.column]), [
    ['Active local sessions', 1],
    ['Что угодно', 3],
  ]);
});

test('ключ склеенной секции не зависит от набора машин', () => {
  // По ключу секции помнится её отрисовка (renderedBlocks) и её свёрнутость.
  // Считайся ключ от заголовка со счётом или от имён машин — уснувшая на
  // соседней машине сессия пересобирала бы колонку целиком.
  const one = buildSections(base({ groups: REMOTE_GROUPS }))[1];
  const few = buildSections(base({ groups: REMOTE_GROUPS.filter(g => g.host !== 'zeta-host') }))[1];
  assert.strictEqual(one.key, few.key);
});

test('пустая секция не заводится', () => {
  // Правило то же, по которому не заводится пустая половина живых сессий:
  // секция без строк — это заголовок, обещающий содержимое, которого нет.
  const blocks = buildSections(base({ projects: [], snapshots: [] }));
  assert.deepStrictEqual(blocks.map(b => b.kind), ['sessions', 'sessions']);
});

test('снимков нет там, где восстанавливать их нечем', () => {
  // То же условие, что у ^S: секция, чей Enter молчит, хуже отсутствующей.
  const blocks = buildSections(base({ trackerHere: false }));
  assert.ok(!blocks.some(b => b.kind === 'snapshots'));
});

test('префикс оставляет на экране одну секцию', () => {
  assert.deepStrictEqual(buildSections(base({ mode: 'projects' })).map(b => b.kind), ['projects']);
  assert.deepStrictEqual(buildSections(base({ mode: 'snapshots' })).map(b => b.kind), ['snapshots']);
});

test('запрос отбирает строки во всех секциях сразу', () => {
  // Снимки приезжают сюда уже отобранными: buildSnapshotRows берёт запрос
  // сама, и второй отбор здесь порвал бы пару «заголовок раскладки и её
  // сессии». Поэтому на непустом запросе вызывающая сторона передаёт то, что
  // осталось, — здесь ничего.
  const blocks = buildSections(base({ query: 'picker', snapshots: [] }));
  // Сессий с таким именем нет, проект есть — секции сессий исчезают целиком.
  assert.deepStrictEqual(blocks.map(b => b.kind), ['projects']);
});

test('в широкой раскладке история приходит развёрнутой', () => {
  // Сворачивалась она затем, чтобы «что было раньше» не оттесняло вниз «что
  // работает сейчас». Со своей колонкой во всю высоту она никого не оттесняет.
  const blocks = buildSections(base());
  const history = blocks.find(b => b.label === 'Not running');
  assert.strictEqual(history.collapsed, false);
  assert.deepStrictEqual(history.rows.map(r => r.id), ['old']);
});

test('узкая раскладка не склеивает чужие группы и не считает колонок', () => {
  // Склейка — правило раскладки, а не группировки: в широком блок занимает
  // колонку, и пять трекеров дали бы пять узких колонок на то, что человек
  // читает как одно «не здесь». В узком строки идут сверху вниз, и лишний
  // заголовок там ничего не стоит.
  const narrow = buildSections(base({ groups: REMOTE_GROUPS, layout: 'narrow' }));
  assert.deepStrictEqual(narrow.map(s => s.key), [
    'live', 'remote:alpha-host', 'remote:zeta-host', 'past', 'projects', 'snapshots',
  ]);
  assert.ok(narrow.every(s => s.column === undefined));
});

test('широкая раскладка склеивает чужие группы и раскладывает по колонкам', () => {
  const wide = buildSections(base({ groups: REMOTE_GROUPS, layout: 'wide' }));
  assert.deepStrictEqual(wide.map(s => s.key), [
    'live', 'remote', 'projects', 'past', 'snapshots',
  ]);
  assert.deepStrictEqual(wide.map(s => s.column), [1, 2, 2, 3, 3]);
});

test('счёт секции не считает подзаголовки, а заголовок собирается из него', () => {
  const wide = buildSections(base({ groups: REMOTE_GROUPS, layout: 'wide' }));
  const remote = wide.find(s => s.key === 'remote');
  // Три чужие сессии на двух машинах: строк в секции пять (две из них —
  // подзаголовки машин), а счёт — по сессиям.
  assert.strictEqual(remote.count, 3);
  assert.strictEqual(remote.rows.length, 5);
  assert.strictEqual(sectionHeaderText(remote), 'Active remote sessions - 3');
});

test('у свёрнутой истории в заголовке дата последней сессии', () => {
  const past = { key: 'past', label: 'Not running', count: 1, lastAt: AUG_12, collapsed: true };
  assert.strictEqual(sectionHeaderText(past), 'Not running - 1 · last Aug 12');
  // Развёрнутая дату не показывает: строки видны, и подпись повторяла бы их.
  assert.strictEqual(sectionHeaderText({ ...past, collapsed: false }), 'Not running - 1');
});

test('умолчание свёрнутости зависит от раскладки', () => {
  // В узком списке история оттесняет вниз то, что работает сейчас, а проекты и
  // снимки — справочники, за которыми приходят намеренно. В широком у каждой
  // своя колонка, и оттеснять там некого.
  const narrow = buildSections(base({ layout: 'narrow' }));
  assert.deepStrictEqual(
    Object.fromEntries(narrow.map(s => [s.key, s.collapsed])),
    { live: false, past: true, projects: true, snapshots: true },
  );
  const wide = buildSections(base({ layout: 'wide' }));
  assert.ok(wide.every(s => s.collapsed === false));
});

test('карта человека перекрывает умолчание, отсутствие ключа — нет', () => {
  // Отсутствие ключа значит «как по умолчанию», а не «развёрнута»: так
  // умолчание остаётся в коде и его можно менять, не переписывая людям ui.json.
  const sections = buildSections(base({
    layout: 'narrow', collapsed: { past: false, live: true },
  }));
  const byKey = Object.fromEntries(sections.map(s => [s.key, s.collapsed]));
  assert.strictEqual(byKey.past, false);
  assert.strictEqual(byKey.live, true);
  assert.strictEqual(byKey.projects, true);
});

test('префикс оставляет одну секцию и разворачивает её', () => {
  // Иначе `/h` при свёрнутой по умолчанию истории показал бы один заголовок,
  // то есть ровно ничего.
  const history = buildSections(base({
    layout: 'narrow', mode: 'history', collapsed: { past: true },
  }));
  assert.deepStrictEqual(history.map(s => s.key), ['past']);
  assert.strictEqual(history[0].collapsed, false);

  const local = buildSections(base({ groups: REMOTE_GROUPS, layout: 'narrow', mode: 'local' }));
  assert.deepStrictEqual(local.map(s => s.key), ['live']);

  const remote = buildSections(base({ groups: REMOTE_GROUPS, layout: 'narrow', mode: 'remote' }));
  assert.deepStrictEqual(remote.map(s => s.key), ['remote:alpha-host', 'remote:zeta-host']);

  const projects = buildSections(base({ layout: 'narrow', mode: 'projects' }));
  assert.deepStrictEqual(projects.map(s => s.key), ['projects']);
});

test('в режиме remote своя живая группа не показывается, и наоборот', () => {
  const remote = buildSections(base({ groups: GROUPS, layout: 'narrow', mode: 'remote' }));
  // В GROUPS чужих машин нет вовсе — секций не будет ни одной, и страница
  // скажет об этом подписью, а не подменит список.
  assert.deepStrictEqual(remote, []);
});

// Три секции подряд в одном плоском массиве: 0-1 в первой, 2-3-4 во второй,
// 5 в третьей. Ровно так строки и лежат в rows у страницы.
const ROWS = [
  { block: 0 }, { block: 0 },
  { block: 1 }, { block: 1 }, { block: 1 },
  { block: 2 },
];

test('стрелки вверх-вниз ходят внутри секции', () => {
  assert.strictEqual(moveInBlocks(ROWS, 2, 1), 3);
  assert.strictEqual(moveInBlocks(ROWS, 3, -1), 2);
});

test('вниз в конце секции упирается, а не заворачивается', () => {
  // Круг по одной колонке из шести читался бы как «список кончился и начался
  // заново», а конец секции в широком режиме виден глазом.
  assert.strictEqual(moveInBlocks(ROWS, 4, 1), 4);
  assert.strictEqual(moveInBlocks(ROWS, 2, -1), 2);
});

test('вправо переводит в соседнюю секцию на ту же позицию', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 1, 1), 3);
  assert.strictEqual(moveBetweenBlocks(ROWS, 3, -1), 1);
});

test('в коротком соседе выбирается последняя строка', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 4, 1), 5);
});

test('за крайней секцией стоять некуда — выбор не двигается', () => {
  assert.strictEqual(moveBetweenBlocks(ROWS, 5, 1), 5);
  assert.strictEqual(moveBetweenBlocks(ROWS, 0, -1), 0);
});

test('пустой список никуда не ведёт', () => {
  assert.strictEqual(moveInBlocks([], 0, 1), 0);
  assert.strictEqual(moveBetweenBlocks([], 0, 1), 0);
});
