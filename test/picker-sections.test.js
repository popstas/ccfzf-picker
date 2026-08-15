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

test('непустой запрос разворачивает секции, и память о свёрнутости не спорит', () => {
  // Свёрнутая под запросом секция показывает вместо найденного одну строку с
  // его счётом — а искали не счёт. Отсюда правило сильнее памяти: `past`
  // свёрнут и по умолчанию, и рукой человека, а под запросом всё равно раскрыт.
  const found = buildSections(base({
    layout: 'narrow', query: 'old', collapsed: { past: true },
  }));
  const past = found.find(s => s.key === 'past');
  assert.ok(past, found.map(s => s.key));
  assert.strictEqual(past.collapsed, false);
  assert.deepStrictEqual(past.rows.map(r => r.id), ['old']);

  // Пустой запрос — и память снова главная.
  const idle = buildSections(base({ layout: 'narrow', collapsed: { past: true } }));
  assert.strictEqual(idle.find(s => s.key === 'past').collapsed, true);
});

test('сворачивать можно только там, где свёрнутость не назначена сверху', () => {
  // Под запросом и под префиксом она назначена, и Enter на заголовке не дал бы
  // ничего видимого: `collapsed: true` тут же затёрлось бы обратно. Молчащий
  // переключатель хуже отсутствующего, поэтому там заголовок — подпись.
  assert.ok(buildSections(base({ layout: 'narrow' })).every(s => s.foldable === true));
  assert.ok(buildSections(base({ layout: 'wide' })).every(s => s.foldable === true));
  assert.ok(buildSections(base({ layout: 'narrow', query: 'old' }))
    .every(s => s.foldable === false));
  assert.ok(buildSections(base({ layout: 'narrow', mode: 'projects' }))
    .every(s => s.foldable === false));
  // Пробелы запросом не считаются: строка из одних пробелов ничего не отбирает.
  assert.ok(buildSections(base({ layout: 'narrow', query: '   ' }))
    .every(s => s.foldable === true));
});

// Порядок секций, назначенный человеком. Приезжает половинкой `order` из
// ui.json — своей у каждой раскладки, — и накладывается поверх умолчания,
// которое задаёт код: в узком списке это порядок сборки, в широком — колонка
// по смыслу секции.

test('узкий список идёт в назначенном порядке', () => {
  const sections = buildSections(base({
    layout: 'narrow', order: ['snapshots', 'past', 'live'],
  }));
  assert.deepStrictEqual(sections.map(s => s.key),
    ['snapshots', 'past', 'live', 'projects']);
});

test('секция, которой нет в назначенном порядке, встаёт в конец', () => {
  // Правило то же, что у normalizeCollapsed: чего нет — то по умолчанию, а
  // умолчание для порядка — конец списка. Иначе новый вид секции пришлось бы
  // дописывать людям в ui.json.
  const sections = buildSections(base({ layout: 'narrow', order: ['projects'] }));
  assert.deepStrictEqual(sections.map(s => s.key),
    ['projects', 'live', 'past', 'snapshots']);
});

test('незнакомый ключ в порядке ничего не ломает', () => {
  // `remote:<host>` приходят и уходят вместе с машинами: лёг трекер — ключ в
  // файле остался, а секции нет.
  const sections = buildSections(base({
    layout: 'narrow', order: ['remote:ушедшая-машина', 'past', 'live'],
  }));
  assert.deepStrictEqual(sections.map(s => s.key), ['past', 'live', 'projects', 'snapshots']);
});

test('в широком режиме порядок называет и колонку, и место в ней', () => {
  // Колонку задаёт смысл секции — но только пока человек не сказал иначе.
  const sections = buildSections(base({
    layout: 'wide',
    order: [['past'], ['live'], ['snapshots', 'projects']],
  }));
  assert.deepStrictEqual(sections.map(s => s.key),
    ['past', 'live', 'snapshots', 'projects']);
  assert.deepStrictEqual(sections.map(s => s.column), [1, 2, 3, 3]);
});

test('невыбранная секция остаётся в своей колонке по смыслу', () => {
  // Человек перетащил одну — остальные обязаны остаться там, где были, а не
  // съехать в первую колонку.
  const sections = buildSections(base({ layout: 'wide', order: [['snapshots'], [], []] }));
  const byKey = Object.fromEntries(sections.map(s => [s.key, s.column]));
  assert.strictEqual(byKey.snapshots, 1, 'перетащенная — в названной колонке');
  assert.strictEqual(byKey.live, 1, 'живые сессии остались в своей первой');
  assert.strictEqual(byKey.projects, 2, 'проекты остались во второй');
  assert.strictEqual(byKey.past, 3, 'история осталась в третьей');
  // И внутри первой колонки перетащенная стоит выше: её место названо, а
  // место живых сессий — нет, значит они в конец.
  assert.deepStrictEqual(
    sections.filter(s => s.column === 1).map(s => s.key), ['snapshots', 'live']);
});

test('порядок чтения и порядок секций — одно и то же', () => {
  // По этому порядку ходят ←/→ (moveBetweenBlocks). Разъедься он с видимым —
  // стрелка уводила бы не туда, куда смотрит глаз, и поймать это тестом на
  // одну функцию нельзя: врут они согласованно. Поэтому сверяется здесь:
  // список секций обязан идти колонка за колонкой, сверху вниз внутри колонки.
  const sections = buildSections(base({
    layout: 'wide', order: [['past', 'snapshots'], ['live'], ['projects']],
  }));
  const columns = sections.map(s => s.column);
  assert.deepStrictEqual(columns, [...columns].sort((a, b) => a - b),
    'секции идут не колонка за колонкой');
  assert.deepStrictEqual(sections.map(s => s.key),
    ['past', 'snapshots', 'live', 'projects']);
});

test('порядок применяется и под запросом, хотя перетаскивать там нельзя', () => {
  // Перетаскивание живёт только там, где набор секций постоянный (foldable),
  // но применять уже назначенный порядок надо всегда: иначе секции прыгали бы
  // местами на первую же набранную букву.
  const sections = buildSections(base({
    layout: 'narrow', query: 'a', order: ['past', 'live'],
  }));
  const keys = sections.map(s => s.key);
  assert.ok(keys.indexOf('past') < keys.indexOf('live'), keys.join(' '));
  assert.strictEqual(sections.every(s => s.foldable === false), true,
    'под запросом секции не сворачиваются и не перетаскиваются');
});

test('мусор вместо порядка не роняет список', () => {
  for (const order of [null, 'нет', 42, [], [[], [], []]]) {
    const narrow = buildSections(base({ layout: 'narrow', order }));
    assert.ok(narrow.length, JSON.stringify(order));
    const wide = buildSections(base({ layout: 'wide', order }));
    assert.ok(wide.length, JSON.stringify(order));
  }
});

// Свёрнутая секция в широком режиме опускается в низ своей колонки.
//
// Свёрнутая секция — это одна строка заголовка, а доля колонки ей достаётся
// такая же, как развёрнутому соседу: измерено, свёрнутая история занимала 260
// пикселей из 417 при содержимом в 25, и в WebKit то же самое — 347 из 504.
// Полколонки пустоты, а рядом сосед, которому не хватило.
//
// Опускание сделано сортировкой здесь, а не CSS-трюком в раскладке: по этому
// же списку считается `rows` и порядок блоков, по которому ходят `←/→`.
// Подвинь мы блок одним оформлением — стрелка уводила бы не туда, куда
// смотрит глаз, и это ровно та поломка, от которой бережёт правило про
// порядок чтения.

test('свёрнутая секция опускается в низ своей колонки', () => {
  const sections = buildSections(base({ layout: 'wide', collapsed: { past: true } }));
  const third = sections.filter(s => s.column === 3).map(s => s.key);
  // Умолчание колонки — история сверху, снимки под ней. Свёрнутая история
  // уходит вниз, снимкам достаётся вся высота.
  assert.deepStrictEqual(third, ['snapshots', 'past']);
});

test('развёрнутые секции колонки сохраняют свой порядок', () => {
  // Опускание трогает только свёрнутые: остальные стоят там, где стояли.
  const sections = buildSections(base({
    layout: 'wide', groups: REMOTE_GROUPS, collapsed: { projects: true },
  }));
  const second = sections.filter(s => s.column === 2).map(s => s.key);
  assert.deepStrictEqual(second, ['remote', 'projects']);
});

test('две свёрнутые секции ложатся вниз в своём прежнем порядке', () => {
  const sections = buildSections(base({
    layout: 'wide', collapsed: { past: true, snapshots: true },
  }));
  const third = sections.filter(s => s.column === 3).map(s => s.key);
  // Обе свёрнуты — двигать друг относительно друга их незачем.
  assert.deepStrictEqual(third, ['past', 'snapshots']);
});

test('опускание сильнее назначенного порядка, но только внутри колонки', () => {
  // Человек перетащил историю наверх третьей колонки, потом свернул её.
  // Свёрнутая она всё равно уходит вниз: полоска-заголовок наверху колонки
  // отнимала бы высоту у того, ради чего колонку и открыли. Колонку при этом
  // назначенный порядок задаёт по-прежнему.
  const sections = buildSections(base({
    layout: 'wide',
    order: [[], [], ['past', 'snapshots']],
    collapsed: { past: true },
  }));
  const third = sections.filter(s => s.column === 3).map(s => s.key);
  assert.deepStrictEqual(third, ['snapshots', 'past']);
});

test('порядок чтения остаётся порядком чтения и после опускания', () => {
  // По нему ходят ←/→, и разъедься он с видимым — стрелка уводила бы не туда.
  const sections = buildSections(base({
    layout: 'wide', groups: REMOTE_GROUPS, collapsed: { past: true, projects: true },
  }));
  const columns = sections.map(s => s.column);
  assert.deepStrictEqual(columns, [...columns].sort((a, b) => a - b),
    'секции идут не колонка за колонкой');
});

test('в узком списке свёрнутая секция никуда не уезжает', () => {
  // Там секции идут одним потоком, «низа колонки» не существует, а свёрнутая
  // секция и так занимает ровно строку заголовка. Уехавшая вниз история
  // выглядела бы самовольной перестановкой списка.
  const sections = buildSections(base({ layout: 'narrow', collapsed: { past: true } }));
  assert.deepStrictEqual(sections.map(s => s.key), ['live', 'past', 'projects', 'snapshots']);
});

// Спрятанные панели: третья ось поверх колонки и свёрнутости. Ставится только
// из окна настроек — случайной клавишей панель не убрать.

test('спрятанная панель не попадает в список вовсе', () => {
  const sections = buildSections(base({ layout: 'wide', hidden: { past: true } }));
  assert.ok(!sections.some(s => s.key === 'past'), sections.map(s => s.key).join(' '));
  // Остальные на месте: прячется названная, а не всё подряд.
  assert.ok(sections.some(s => s.key === 'live'));
});

test('прятанье переживает непустой запрос', () => {
  // Свернуть значит «покажи одной строкой», спрятать — «убери». Запрос
  // разворачивает свёрнутое, но отменять просьбу убрать ему не за чем.
  const sections = buildSections(base({ layout: 'wide', query: 'a', hidden: { past: true } }));
  assert.ok(!sections.some(s => s.key === 'past'), sections.map(s => s.key).join(' '));
});

test('префикс сильнее прятанья — он спрашивает про панель поимённо', () => {
  // `/h` при спрятанной истории иначе показал бы пустой экран, а это то же
  // самое, что молчащий Enter.
  const sections = buildSections(base({
    layout: 'wide', mode: 'history', hidden: { past: true },
  }));
  assert.deepStrictEqual(sections.map(s => s.key), ['past']);
});

test('прятанье работает и в узком списке', () => {
  const sections = buildSections(base({ layout: 'narrow', hidden: { projects: true } }));
  assert.ok(!sections.some(s => s.key === 'projects'), sections.map(s => s.key).join(' '));
});

// ── своя живая панель показывается всегда ───────────────────────────────────
//
// Это главная панель, и в широкой раскладке ей отдана первая колонка. Пустая
// колонка не рисуется, и на машине без своих живых сессий она исчезала целиком:
// три назначенных колонки давали на экране две, и выглядело это потерянной
// настройкой, а не отсутствием сессий. Поймано на маке.

const NO_GROUPS = { groups: [], projects: [], snapshots: [] };

test('панель своих сессий есть и когда своих сессий нет', () => {
  for (const layout of ['wide', 'narrow']) {
    const sections = buildSections(base({ ...NO_GROUPS, layout }));
    const live = sections.find(s => s.key === 'live');
    assert.ok(live, `${layout}: панели нет — колонка исчезнет`);
    assert.strictEqual(live.count, 0);
  }
});

test('пустая панель стоит в первой колонке и первой в списке', () => {
  // Колонка нужна затем, ради чего всё и делалось: непустая первая колонка и
  // есть то, что рисуется. Место — то же, где панель стоит с сессиями.
  const sections = buildSections(base({ ...NO_GROUPS, layout: 'wide' }));
  assert.strictEqual(sections[0].key, 'live');
  assert.strictEqual(sections[0].column, 1);
});

test('пустая панель называется по тому же правилу, что и полная', () => {
  // Без чужих машин — «Active sessions», с ними — «Active local sessions».
  // Разойдись эти имена, панель называлась бы по-разному в зависимости от
  // того, пуста она или нет.
  const alone = buildSections(base({ ...NO_GROUPS, layout: 'wide' }));
  assert.strictEqual(alone[0].label, 'Active sessions');
  const withRemote = buildSections(base({
    ...NO_GROUPS, layout: 'wide',
    groups: [{ key: 'remote:alpha-host', label: 'Active on alpha-host', remote: true, host: 'alpha-host', sessions: [session('x')] }],
  }));
  assert.strictEqual(withRemote.find(s => s.key === 'live').label, 'Active local sessions');
});

test('пустая панель говорит о пустоте подписью, а не строкой', () => {
  // У `block-subhead` нет ни `data-index`, ни класса `row`: ни стрелки, ни
  // клик её не видят, и Enter на ней невозможен. Иначе выбор вставал бы на
  // строку, которую нечем открыть.
  const live = buildSections(base({ ...NO_GROUPS, layout: 'wide' }))[0];
  assert.deepStrictEqual(live.rows.map(r => r.kind), ['block-subhead']);
  assert.strictEqual(live.rows[0].label, 'No local sessions.');
  // И в счёт она не входит: счёт про сессии, а не про строки разметки.
  assert.strictEqual(live.count, 0);
});

test('своей панели не заводится второй, когда сессии есть', () => {
  const sections = buildSections(base({ layout: 'wide' }));
  assert.strictEqual(sections.filter(s => s.key === 'live').length, 1);
  assert.ok(sections.find(s => s.key === 'live').count > 0);
});

test('под запросом пустая панель исчезает, как и все остальные', () => {
  // Секция без совпадений уходит у всех одинаково, и пустой блок посреди
  // найденного был бы шумом.
  const sections = buildSections(base({ ...NO_GROUPS, layout: 'wide', query: 'ничего-такого' }));
  assert.ok(!sections.some(s => s.key === 'live'), sections.map(s => s.key).join(' '));
});

test('под префиксом `/l` пустая панель не заводится', () => {
  // Про пустоту там прямо говорит подпись «No sessions on this machine.», и
  // заголовок с нулём рядом с ней — второй раз одно и то же.
  const sections = buildSections(base({ ...NO_GROUPS, layout: 'wide', mode: 'local' }));
  assert.deepStrictEqual(sections, []);
});

test('спрятанная панель остаётся спрятанной и пустой', () => {
  // «Убери» сказано намеренно, и всегда-показ это не перебивает.
  const sections = buildSections(base({ ...NO_GROUPS, layout: 'wide', hidden: { live: true } }));
  assert.ok(!sections.some(s => s.key === 'live'), sections.map(s => s.key).join(' '));
});

test('мусор вместо карты спрятанных ничего не прячет', () => {
  for (const hidden of [null, 'нет', 42, { past: 'да' }]) {
    const sections = buildSections(base({ layout: 'wide', hidden }));
    assert.ok(sections.some(s => s.key === 'past'), JSON.stringify(hidden));
  }
});
