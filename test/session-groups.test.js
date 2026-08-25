const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeSort, cycleSort, compareSessions, groupSessions, labelSessions, SORT_MODES,
  DEFAULT_SORT, buildSessionsPayload, activeFilters,
} = require('../frontend-src/session-groups');

// Сырые сессии — то, что отдаёт `ccfzf --state`, а не строки списка.
const RAW = {
  ok: true,
  seen: {},
  sessions: [
    { id: 'live-1', title: 'Живая', cwd: '/home/user/a', live: true },
    { id: 'dead-1', title: 'Мёртвая', cwd: '/home/user/b', live: false },
    { id: 'live-2', title: 'Тоже живая', cwd: '/home/user/c', live: true },
  ],
};

function idsOf(payload) {
  return payload.groups.flatMap(g => g.sessions).map(s => s.id).sort();
}

test('без onlyLive в списке остаются все сессии', () => {
  assert.deepStrictEqual(idsOf(buildSessionsPayload(RAW, 'name')), ['dead-1', 'live-1', 'live-2']);
});

test('onlyLive оставляет одни работающие', () => {
  const payload = buildSessionsPayload(RAW, 'name', { onlyLive: true });
  assert.deepStrictEqual(idsOf(payload), ['live-1', 'live-2']);
  // Группа «History» при этом не остаётся пустой — её просто нет.
  assert.deepStrictEqual(payload.groups.map(g => g.label), ['Active sessions']);
});

test('onlyLive не отбирает у живой сессии её фонового агента', () => {
  const withChild = {
    ok: true,
    seen: {},
    sessions: [
      { id: 'p', title: 'Родитель', cwd: '/home/user/a', live: true },
      // Форк не живой и под onlyLive из списка уходит — но запись агента, под
      // которой сейчас идёт работа, обязана доехать до родителя.
      { id: 'c', kind: 'background', parent: 'p', live: false,
        agent: { state: 'active', updated: 100, summary: 'форк работает' } },
    ],
  };
  const [row] = buildSessionsPayload(withChild, 'name', { onlyLive: true })
    .groups.flatMap(g => g.sessions);
  assert.strictEqual(row.id, 'p');
  assert.strictEqual(row.agentBackground, true);
  assert.strictEqual(row.agentDescription, 'форк работает');
});

// Имена полей — те же, что кладёт buildSessionList (см. test/row-contract.test.js).
function row(extra) {
  return Object.assign({
    id: 'a', title: 'T', label: 'T', cwd: '/home/user/x', live: false,
    agentCostUsd: 0, lastActivity: 0, agentSeen: false,
  }, extra || {});
}

/** Порядок id после сортировки режимом `mode`. */
function order(rows, mode) {
  return [...rows].sort((a, b) => compareSessions(a, b, mode)).map(s => s.id);
}

test('незнакомый режим сортировки сводится к предусмотренному', () => {
  assert.strictEqual(normalizeSort('чепуха'), DEFAULT_SORT);
  assert.strictEqual(normalizeSort('newest'), 'newest');
});

test('умолчание сортировки — recent', () => {
  // Список открывают, чтобы вернуться к тому, чем занимались только что;
  // стоимость для этого не отвечает ни на один вопрос.
  assert.strictEqual(DEFAULT_SORT, 'recent');
});

test('перебор режимов зациклен', () => {
  // Раньше здесь `first` не участвовал в проверке, а утверждение сравнивало
  // значение само с собой — тест не мог упасть ни при каком поведении
  // cycleSort, включая функцию, которая просто возвращает свой аргумент.
  // Проверяем настоящее свойство цикла: ровно SORT_MODES.length шагов
  // возвращают в стартовую точку, и ни один из промежуточных шагов не стоит
  // на месте.
  const first = normalizeSort();
  let mode = first;
  const seen = [mode];
  for (let i = 0; i < SORT_MODES.length; i++) {
    mode = cycleSort(mode);
    seen.push(mode);
  }
  assert.strictEqual(mode, first, 'после SORT_MODES.length шагов должны вернуться в исходный режим');
  // Ни один шаг цикла не должен стоять на месте — иначе цикл не проходит все
  // режимы за отведённое число шагов.
  for (let i = 0; i < seen.length - 1; i++) {
    assert.notStrictEqual(seen[i], seen[i + 1], `шаг ${i} не должен повторять предыдущий режим`);
  }
});

test('живые сессии идут отдельной группой впереди', () => {
  const groups = groupSessions([
    row({ id: 'dead', live: false, lastActivity: 200 }),
    row({ id: 'alive', live: true, lastActivity: 100 }),
  ], 'newest');
  assert.strictEqual(groups[0].sessions[0].id, 'alive');
});

test('пустой список даёт пустой результат', () => {
  assert.deepStrictEqual(groupSessions([], 'cost'), []);
});

test('cost: дороже — выше', () => {
  const rows = [
    row({ id: 'mid', label: 'mid', agentCostUsd: 5 }),
    row({ id: 'rich', label: 'rich', agentCostUsd: 50 }),
    row({ id: 'cheap', label: 'cheap', agentCostUsd: 1 }),
  ];
  assert.deepStrictEqual(order(rows, 'cost'), ['rich', 'mid', 'cheap']);
});

test('recent: свежее — выше', () => {
  const rows = [
    row({ id: 'old', label: 'old', lastActivity: 100 }),
    row({ id: 'fresh', label: 'fresh', lastActivity: 900 }),
    row({ id: 'mid', label: 'mid', lastActivity: 500 }),
  ];
  assert.deepStrictEqual(order(rows, 'recent'), ['fresh', 'mid', 'old']);
});

test('recent: секунды внутри одной минуты порядок не двигают', () => {
  // Ровно та гонка, из-за которой ключ и округляется: у двух работающих сессий
  // lastActivity дёргается на каждый вызов инструмента, подача тикает раз в
  // секунду, и на секундном ключе строки менялись местами непрерывно.
  const at = (t) => [
    row({ id: 'aaa', label: 'aaa', lastActivity: t.aaa }),
    row({ id: 'bbb', label: 'bbb', lastActivity: t.bbb }),
  ];
  // 10:00:05 против 10:00:55 — минута одна, порядок по имени.
  assert.deepStrictEqual(order(at({ aaa: 600, bbb: 655 }), 'recent'), ['aaa', 'bbb']);
  // Через секунду вперёд ушла другая — порядок обязан остаться прежним.
  assert.deepStrictEqual(order(at({ aaa: 656, bbb: 655 }), 'recent'), ['aaa', 'bbb']);
  assert.deepStrictEqual(order(at({ aaa: 600, bbb: 659 }), 'recent'), ['aaa', 'bbb']);
});

test('recent: через границу минуты порядок всё-таки меняется', () => {
  // Округление не должно превращаться в «порядок не меняется никогда»: минутой
  // позже сессия обязана всплыть.
  const rows = [
    row({ id: 'aaa', label: 'aaa', lastActivity: 659 }),  // 10:00:59
    row({ id: 'bbb', label: 'bbb', lastActivity: 661 }),  // 10:01:01
  ];
  assert.deepStrictEqual(order(rows, 'recent'), ['bbb', 'aaa']);
});

test('recent: сессия без активности остаётся внизу', () => {
  const rows = [
    row({ id: 'never', label: 'never', lastActivity: 0 }),
    row({ id: 'none', label: 'none' }),                    // поля нет вовсе
    row({ id: 'some', label: 'some', lastActivity: 30 }),  // меньше минуты — но было
  ];
  // Ключ 'some' округляется в ноль, но нулём быть не должен: иначе строка с
  // активностью утонула бы к тем, у кого её не было вовсе.
  assert.deepStrictEqual(order(rows, 'recent'), ['some', 'never', 'none']);
});

test('newest и oldest — обратные друг другу порядки по началу сессии', () => {
  const rows = [
    row({ id: 'b', label: 'b', agentStarted: 200 }),
    row({ id: 'a', label: 'a', agentStarted: 100 }),
    row({ id: 'c', label: 'c', agentStarted: 300 }),
  ];
  assert.deepStrictEqual(order(rows, 'oldest'), ['a', 'b', 'c']);
  assert.deepStrictEqual(order(rows, 'newest'), ['c', 'b', 'a']);
});

test('name: по имени, а безымянная сессия зовётся заголовком', () => {
  const rows = [
    row({ id: '3', label: 'zed' }),
    row({ id: '1', label: 'alpha' }),
    // label не проставлен — имя берётся из title (см. nameOf).
    row({ id: '2', label: undefined, title: 'beta' }),
  ];
  assert.deepStrictEqual(order(rows, 'name'), ['1', '2', '3']);
});

test('пустые и нулевые значения тонут в конец при любом направлении', () => {
  // И в убывающем cost, и в возрастающем oldest: строка без данных не должна
  // всплывать наверх только потому, что её ноль меньше всех.
  const cost = [
    row({ id: 'none', label: 'none' }),                       // поля нет вовсе
    row({ id: 'zero', label: 'zero', agentCostUsd: 0 }),
    row({ id: 'some', label: 'some', agentCostUsd: 2 }),
  ];
  assert.deepStrictEqual(order(cost, 'cost'), ['some', 'none', 'zero']);

  const oldest = [
    row({ id: 'none', label: 'none' }),
    row({ id: 'late', label: 'late', agentStarted: 900 }),
    row({ id: 'early', label: 'early', agentStarted: 100 }),
  ];
  assert.deepStrictEqual(order(oldest, 'oldest'), ['early', 'late', 'none']);
});

test('строка без отметки старта оставляет порядок устойчивым, а не случайным', () => {
  // Отметку пишет хук в `<id>.meta.json`, и у сессий, поднятых до его
  // появления, её нет. У таких oldest и newest вырождаются в общий порядок по
  // имени и id, но остаются порядком.
  const rows = [
    row({ id: 'y', label: 'b' }),
    row({ id: 'x', label: 'a' }),
    row({ id: 'z', label: 'a' }),
  ];
  assert.deepStrictEqual(order(rows, 'oldest'), ['x', 'z', 'y']);
  assert.deepStrictEqual(order(rows, 'newest'), ['x', 'z', 'y']);
});

test('равные значения разводятся именем, а одинаковые имена — id', () => {
  const rows = [
    row({ id: 'b2', label: 'same', agentCostUsd: 7 }),
    row({ id: 'a1', label: 'same', agentCostUsd: 7 }),
    row({ id: 'c3', label: 'aaa', agentCostUsd: 7 }),
  ];
  assert.deepStrictEqual(order(rows, 'cost'), ['c3', 'a1', 'b2']);
  // Полностью одинаковые ключи — 0, и порядок остаётся исходным.
  const twins = [row({ id: 'a', label: 'x' }), row({ id: 'a', label: 'x' })];
  assert.strictEqual(compareSessions(twins[0], twins[1], 'cost'), 0);
});

test('незнакомый режим сортирует умолчанием, а не как попало', () => {
  const rows = [
    row({ id: 'old', label: 'old', lastActivity: 100 }),
    row({ id: 'fresh', label: 'fresh', lastActivity: 900 }),
  ];
  assert.deepStrictEqual(order(rows, 'чепуха'), order(rows, DEFAULT_SORT));
  assert.deepStrictEqual(order(rows, undefined), ['fresh', 'old']);
});

test('режим сортировки действует внутри каждой группы', () => {
  const groups = groupSessions([
    row({ id: 'live-cheap', label: 'live-cheap', live: true, agentCostUsd: 1 }),
    row({ id: 'live-rich', label: 'live-rich', live: true, agentCostUsd: 9 }),
    row({ id: 'dead-cheap', label: 'dead-cheap', agentCostUsd: 2 }),
    row({ id: 'dead-rich', label: 'dead-rich', agentCostUsd: 8 }),
  ], 'cost');
  assert.deepStrictEqual(groups[0].sessions.map(s => s.id), ['live-rich', 'live-cheap']);
  assert.deepStrictEqual(groups[1].sessions.map(s => s.id), ['dead-rich', 'dead-cheap']);
});

test('labelSessions даёт имя каждой строке и не трогает остальные поля', () => {
  const [out] = labelSessions([row({ id: 'a', title: 'Тема', label: undefined, agentCostUsd: 3 })]);
  assert.strictEqual(out.label, 'Тема');
  assert.strictEqual(out.agentCostUsd, 3);
  assert.strictEqual(out.id, 'a');
});

test('двойники разводятся именем машины окна', () => {
  // Одинаковые имя и каталог, окна на разных машинах. Своя машина названа
  // пустотой намеренно: имя пикера в каждой строке было бы шумом, а голая
  // строка рядом с «· mac» читается как «здесь».
  const rows = labelSessions([
    { id: 'f381b515', title: 'settings', cwd: '/home/user/p', windowHost: '' },
    { id: 'b4ed3029', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings', 'settings · mac']);
});

test('двойники на одной машине разводятся хвостом id', () => {
  // Пометка, одинаковая у всей пары, не различает ничего — и хвост достаётся
  // именно ей, а не приписывается поверх бесполезного имени машины.
  const rows = labelSessions([
    { id: 'f381b515', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
    { id: 'b4ed3029', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings · f381', 'settings · b4ed']);
});

test('тройке достаётся и машина, и хвост — но только тем, кому нужно', () => {
  const rows = labelSessions([
    { id: 'aaaa1111', title: 'settings', cwd: '/home/user/p', windowHost: '' },
    { id: 'bbbb2222', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
    { id: 'cccc3333', title: 'settings', cwd: '/home/user/p', windowHost: 'mac' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label),
    ['settings', 'settings · mac · bbbb', 'settings · mac · cccc']);
});

test('закрытая тёзка живую не помечает', () => {
  // Поймано на живых данных (2026-08-18, `picker-list-polish`): живая сессия с
  // окном на маке и закрытая тёзка того же каталога. Пикер на маке рисовал
  // обеим хвост id, потому что имя машины у обеих вышло пустым — у живой
  // «своя машина», у закрытой окна нет вовсе. Пометки здесь не нужно ни одной:
  // строки лежат в разных секциях (`live` и `past`), рядом их не видно, а под
  // умолчанием `onlyLive` закрытой в списке нет вообще.
  const rows = labelSessions([
    { id: 'fdd74d58', title: 'picker-list-polish', cwd: '/home/user/p', windowHost: '', live: true },
    { id: '4b93d3bd', title: 'picker-list-polish', cwd: '/home/user/p', windowHost: '', live: false },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['picker-list-polish', 'picker-list-polish']);
});

test('две закрытые тёзки в истории по-прежнему разводятся хвостом id', () => {
  // Сторож на противоположную починку: «неживым пометок не давать вовсе»
  // оставила бы историю с двумя дословно одинаковыми строками, а там они как
  // раз стоят рядом.
  const rows = labelSessions([
    { id: 'aaaa1111', title: 'settings', cwd: '/home/user/p', windowHost: '', live: false },
    { id: 'bbbb2222', title: 'settings', cwd: '/home/user/p', windowHost: '', live: false },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings · aaaa', 'settings · bbbb']);
});

test('одинокая строка и тёзка из другого каталога остаются как есть', () => {
  // Двойник — это совпадение имени И каталога. Одно имя на два проекта
  // различается путём, который и так виден в строке.
  const rows = labelSessions([
    { id: 'aaaa1111', title: 'settings', cwd: '/home/user/a', windowHost: '' },
    { id: 'bbbb2222', title: 'settings', cwd: '/home/user/b', windowHost: 'mac' },
    { id: 'cccc3333', title: 'other', cwd: '/home/user/a', windowHost: '' },
  ]);
  assert.deepStrictEqual(rows.map(r => r.label), ['settings', 'settings', 'other']);
});

// ── карточка на окно: двойник — это тёзка, а не своя же вторая карточка ────
//
// Пометка двойников ловит РАЗНЫЕ сессии с одинаковым именем и каталогом.
// Сессия с двумя окнами (buildSessionList) даёт две карточки с общим id, и
// они совпадают по twinKey (имя, каталог, живость) точно так же, как настоящие
// тёзки, — а различаются как раз windowHost, то есть первым же проходом
// withTwinMarks помечались бы друг против друга. Пойман живьём (ревью
// соседней работы): удалённая карточка получала паразитный хвост «· mac-host»,
// хотя машина и так названа соседней колонкой, а разные подписи у одной и той
// же сессии читаются как две разные сессии.
test('карточки одной сессии на разных машинах не считаются двойниками друг другу', () => {
  const res = {
    ok: true,
    seen: {},
    sessions: [{
      id: 'twin-session', title: 'myproject', cwd: '/home/user/p', live: true,
      windows: [
        { host: 'windows-box', pid: 7, focusedAt: 5 },
        { host: 'mac-host', pid: 3, focusedAt: 3 },
      ],
    }],
  };
  const payload = buildSessionsPayload(res, 'recent', { configHost: 'windows-box' });
  const labels = payload.groups.flatMap(g => g.sessions).map(s => s.label);
  assert.deepStrictEqual(labels, ['myproject', 'myproject']);
});

/**
 * Проверка на пару «многооконная сессия + настоящая тёзка» — общая для обоих
 * порядков карточек ниже. Пометка обязана считаться по СВОЕЙ машине каждой
 * карточки, а не по машине представителя (тем, кто первым встретился в
 * списке): представитель решает только, надо ли вообще что-то различать, а
 * какую метку носит карточка — решает её собственный windowHost.
 */
function assertTwinCardsDistinguished(rows) {
  const local = rows.filter(r => r.id === 'twin-session' && r.windowHost === '')[0];
  const foreign = rows.filter(r => r.id === 'twin-session' && r.windowHost === 'mac-host')[0];
  const lookalike = rows.find(r => r.id === 'lookalike');
  assert.ok(local && foreign && lookalike, 'тест сторожит не то');
  // Критично (Critical из ревью): местная карточка не смеет носить имя чужой
  // машины — оно принадлежит второй карточке той же сессии, не этой.
  assert.ok(!local.label.includes('mac-host'),
    `местная карточка помечена чужой машиной: ${local.label}`);
  // Чужая карточка обязана нести своё имя машины — эту часть представитель не
  // портил никогда, но регрессия здесь дешева, а сторож дёшев тоже.
  assert.ok(foreign.label.includes('mac-host'),
    `чужая карточка своей машины не назвала: ${foreign.label}`);
  // Настоящая тёзка обязана остаться отличимой от местной карточки той же
  // сессии — иначе различить их снова нечем, ровно то, что нашло ревью.
  assert.notStrictEqual(lookalike.label, local.label,
    `тёзка и местная карточка неотличимы: обе «${local.label}»`);
}

test('настоящий двойник рядом с многооконной сессией по-прежнему помечается (своя карточка первой)', () => {
  // «Удачный» порядок из первой редакции починки — при нём Critical-баг не
  // проявлялся, и тест его не ловил. Оставлен как есть (сторож на регрессию в
  // эту сторону), рядом — тот же случай в обратном порядке.
  const rows = labelSessions([
    { id: 'twin-session', title: 'myproject', cwd: '/home/user/p', windowHost: '' },
    { id: 'twin-session', title: 'myproject', cwd: '/home/user/p', windowHost: 'mac-host' },
    { id: 'lookalike', title: 'myproject', cwd: '/home/user/p', windowHost: '' },
  ]);
  assertTwinCardsDistinguished(rows);
});

// Тот самый порядок из ревью: чужое окно смотрели позже своего — оно едет
// первой карточкой сессии («свежайший взгляд первым», session-list.js), и
// представитель (первая встреченная карточка) оказывается чужим. Прогонка
// через настоящий buildSessionsPayload — снимает вопрос «а не подмешал ли
// тест своё group-разбиение» и ловит баг end-to-end, как его нашло ревью.
test('настоящий двойник рядом с многооконной сессией по-прежнему помечается (чужую карточку смотрели позже — порядок из ревью)', () => {
  const res = {
    ok: true,
    seen: {},
    sessions: [
      {
        id: 'twin-session', title: 'myproject', cwd: '/home/user/p', live: true,
        windows: [
          { host: 'mac-host', pid: 3, focusedAt: 50 },
          { host: 'windows-box', pid: 7, focusedAt: 10 },
        ],
      },
      { id: 'lookalike', title: 'myproject', cwd: '/home/user/p', live: true },
    ],
  };
  const payload = buildSessionsPayload(res, 'recent', { configHost: 'windows-box' });
  const rows = payload.groups.flatMap(g => g.sessions);
  assertTwinCardsDistinguished(rows);
});

// Фильтр `only windowed` живёт на одном лишь наличии поля `window` и о машинах
// не знает ничего: `rows.filter(r => r.window)` в buildSessionsPayload. Сторож
// на то, что окно с чужой машины он считает окном — этим и чинится «чекбокс
// only windowed на macOS»: не правкой фильтра, а появлением источника.
test('onlyWindow считает окном и окно на соседней машине', () => {
  const raw = {
    ok: true,
    seen: {},
    sessions: [
      { id: 'mac-1', title: 'На маке', cwd: '/home/user/a', live: true,
        window: { title: 'На маке', host: 'macbook', pid: 7, canFocus: false, lastSeen: 1 } },
      { id: 'win-1', title: 'На Windows', cwd: '/home/user/b', live: true,
        window: { title: 'На Windows', host: 'desktop-box', pid: 42, canFocus: true, lastSeen: 1 } },
      { id: 'none-1', title: 'Без окна', cwd: '/home/user/c', live: true },
    ],
  };
  assert.deepStrictEqual(
    idsOf(buildSessionsPayload(raw, 'name', { onlyWindow: true })),
    ['mac-1', 'win-1'],
  );
});

test('onlyWindow считает окном и само приложение Claude Desktop', () => {
  // Иначе фильтр спорил бы с тем, что нарисовано: в колонке окна у такой
  // строки стоит `c`, а «покажи то, что сейчас на экране» её выбрасывало —
  // пометка окна есть, а строки нет.
  const raw = {
    ok: true,
    seen: {},
    sessions: [
      { id: 'app-1', title: 'В приложении', cwd: '/home/user/a', live: true,
        entrypoint: 'claude-desktop' },
      { id: 'cli-1', title: 'В терминале', cwd: '/home/user/b', live: true,
        entrypoint: 'cli' },
    ],
  };
  assert.deepStrictEqual(
    idsOf(buildSessionsPayload(raw, 'name', { onlyWindow: true })),
    ['app-1'],
  );
});

test('hideDesktop убирает сессии приложения Claude Desktop, и только их', () => {
  // Отсев про entrypoint, а не про живость: приложение отвечает на вопрос «в
  // чём открыта сессия», и закрытая в нём — такая же его сессия, как живая.
  const raw = {
    ok: true,
    seen: {},
    sessions: [
      { id: 'app-live', title: 'В приложении', cwd: '/home/user/a', live: true,
        entrypoint: 'claude-desktop' },
      { id: 'app-past', title: 'Было в приложении', cwd: '/home/user/b', live: false,
        entrypoint: 'claude-desktop' },
      { id: 'cli-live', title: 'В терминале', cwd: '/home/user/c', live: true,
        entrypoint: 'cli' },
      { id: 'cli-past', title: 'Было в терминале', cwd: '/home/user/d', live: false },
    ],
  };
  assert.deepStrictEqual(
    idsOf(buildSessionsPayload(raw, 'name', { hideDesktop: true })),
    ['cli-live', 'cli-past'],
  );
  // Выключенный отсев — нынешнее поведение: не убирает никого.
  assert.deepStrictEqual(
    idsOf(buildSessionsPayload(raw, 'name', { hideDesktop: false })).sort(),
    ['app-live', 'app-past', 'cli-live', 'cli-past'],
  );
});

test('hideDesktop и onlyWindow спорят в пользу отсева приложения', () => {
  // `onlyWindow` считает приложение окном (сторож выше), и без явного порядка
  // строка приложения пережила бы отсев, которым её и просили убрать.
  const raw = {
    ok: true,
    seen: {},
    sessions: [
      { id: 'app-1', title: 'В приложении', cwd: '/home/user/a', live: true,
        entrypoint: 'claude-desktop' },
      { id: 'win-1', title: 'С окном', cwd: '/home/user/b', live: true,
        window: { title: 'С окном', host: 'desktop-box', pid: 42, canFocus: true, lastSeen: 1 } },
    ],
  };
  assert.deepStrictEqual(
    idsOf(buildSessionsPayload(raw, 'name', { onlyWindow: true, hideDesktop: true })),
    ['win-1'],
  );
});

test('отсев hideDesktop зелийных строк не касается', () => {
  // Та же причина, что у onlyLive и onlyWindow: зелийная строка — не сессия
  // агента, и entrypoint у неё не бывает вовсе.
  const res = {
    ok: true,
    sessions: [{ id: 'app-1', title: 'В приложении', live: true, entrypoint: 'claude-desktop' }],
    zellij: [{ name: 'home', created: 50 }],
  };
  const out = buildSessionsPayload(res, 'recent', { hideDesktop: true });
  assert.ok(out.groups.some(g => g.label === 'Zellij'));
});

test('onlyWindow историю не трогает: окна у неё не бывает по определению', () => {
  // Отсев спрашивает «покажи то, что сейчас на экране», и живой сессии без
  // окна отвечает честно. История же вычищалась им целиком — не потому, что
  // человек её не просил, а потому, что окна у закрытой сессии нет и быть не
  // может. Выглядело это пропажей: с `show all` галка «only windowed»
  // опустошала историю до заголовка, и причину было не прочитать нигде.
  const res = {
    ok: true,
    sessions: [
      { id: 'live-win', title: 'С окном', live: true,
        window: { title: 'С окном', host: 'desktop-box', pid: 42, canFocus: true, lastSeen: 1 } },
      { id: 'live-bare', title: 'Без окна', live: true },
      { id: 'past-1', title: 'Закрытая', live: false },
    ],
  };
  const out = buildSessionsPayload(res, 'name', { onlyWindow: true });
  assert.deepStrictEqual(idsOf(out), ['live-win', 'past-1']);
});

test('зелийные сессии идут своей группой, и она последняя', () => {
  const res = {
    ok: true,
    sessions: [
      { id: 'a', title: 'жив', live: true, agent: { state: 'active', updated: 100 } },
      { id: 'b', title: 'мёртв', live: false },
    ],
    zellij: [{ name: 'home', created: 50, agents: 0 }],
  };
  const out = buildSessionsPayload(res, 'recent');
  const labels = out.groups.map(g => g.label);
  assert.strictEqual(labels[labels.length - 1], 'Zellij');
  const last = out.groups[out.groups.length - 1].sessions;
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].kind, 'zellij');
  // Живая группа не должна их всосать: у строки live: true, и без явной
  // ветки она встала бы среди работающих агентов.
  assert.ok(!out.groups[0].sessions.some(s => s.kind === 'zellij'));
});

test('без зелийных сессий группы не появляется вовсе', () => {
  const res = { ok: true, sessions: [{ id: 'a', title: 'жив', live: true }], zellij: [] };
  const out = buildSessionsPayload(res, 'recent');
  assert.ok(!out.groups.some(g => g.label.startsWith('Zellij')));
});

test('отсев onlyLive и onlyWindow зелийных строк не касается', () => {
  // Оба отсева про сессии агента: у зелийной строки окна нет никогда, и
  // onlyWindow вычистил бы весь режим.
  const res = {
    ok: true,
    sessions: [{ id: 'a', title: 'жив', live: true }],
    zellij: [{ name: 'home', created: 50 }],
  };
  const out = buildSessionsPayload(res, 'recent', { onlyWindow: true });
  assert.ok(out.groups.some(g => g.label === 'Zellij'));
});

// ── живые сессии делятся по машине окна ─────────────────────────────────────
//
// «Своё/чужое» у строки одно — машина её окна (поле windowHost, ставит
// buildSessionList). Оно же решает, поднимет ли Enter окно или откроет
// терминал, так что деление списка отвечает на тот же вопрос, что и Enter.
const TWO_HOSTS = {
  ok: true,
  seen: {},
  windowHost: 'win-host',
  windowPid: 7,
  sessions: [
    { id: 'here', title: 'Тут', cwd: '/home/user/a', live: true,
      window: { host: 'win-host', pid: 7 } },
    { id: 'there', title: 'Там', cwd: '/home/user/b', live: true,
      window: { host: 'mac-host', pid: 9 } },
    { id: 'nowhere', title: 'Без окна', cwd: '/home/user/c', live: true },
  ],
};

test('живые сессии делятся на свои и чужие по машине окна', () => {
  const payload = buildSessionsPayload(TWO_HOSTS, 'name', { configHost: 'win-host' });
  assert.deepStrictEqual(payload.groups.map(g => g.label),
    ['Active local sessions', 'Active on mac-host']);
  // Сессия без окна — своя: чужой её делает только названная чужая машина.
  const local = payload.groups[0].sessions.map(s => s.id).sort();
  assert.deepStrictEqual(local, ['here', 'nowhere']);
  assert.deepStrictEqual(payload.groups[1].sessions.map(s => s.id), ['there']);
});

test('без единого чужого окна группа остаётся одна и называется как раньше', () => {
  // На машине с одним трекером делить нечего, и «Active local sessions» без
  // пары читалось бы вопросом «а где тогда остальные».
  const payload = buildSessionsPayload(RAW, 'name', { onlyLive: true, configHost: 'win-host' });
  assert.deepStrictEqual(payload.groups.map(g => g.label), ['Active sessions']);
});

test('когда своих живых нет, пустая группа не заводится', () => {
  const onlyThere = {
    ...TWO_HOSTS,
    sessions: TWO_HOSTS.sessions.filter(s => s.id === 'there'),
  };
  const payload = buildSessionsPayload(onlyThere, 'name', { configHost: 'win-host' });
  assert.deepStrictEqual(payload.groups.map(g => g.label), ['Active on mac-host']);
});

// Трекеров несколько, и «чужое» перестало быть одним местом: сессия на соседнем
// маке и сессия на сервере — это два разных «дотуда», и общая группа отвечала
// бы на вопрос «где она» словом «не здесь».
const MANY_HOSTS = {
  ok: true,
  seen: {},
  windowHost: 'win-host',
  windowPid: 7,
  sessions: [
    { id: 'here', title: 'Тут', cwd: '/home/user/a', live: true,
      window: { host: 'win-host', pid: 7 } },
    // Порядок в ответе агрегатора — не алфавитный намеренно: сортировку групп
    // проверяет как раз он.
    { id: 'z1', title: 'Зета', cwd: '/home/user/b', live: true,
      window: { host: 'zeta-host', pid: 9 } },
    { id: 'a1', title: 'Альфа', cwd: '/home/user/c', live: true,
      window: { host: 'alpha-host', pid: 10 } },
    { id: 'z2', title: 'Зета вторая', cwd: '/home/user/d', live: true,
      window: { host: 'zeta-host', pid: 11 } },
  ],
};

test('чужие живые сессии делятся по машинам, своя группа впереди', () => {
  const payload = buildSessionsPayload(MANY_HOSTS, 'name', { configHost: 'win-host' });
  assert.deepStrictEqual(payload.groups.map(g => g.label),
    ['Active local sessions', 'Active on alpha-host', 'Active on zeta-host']);
  assert.deepStrictEqual(payload.groups[2].sessions.map(s => s.id), ['z1', 'z2']);
});

test('чужая группа помечена полем, а не заголовком', () => {
  // По этой пометке список склеивает чужие группы обратно в один блок.
  // Разбирай он заголовок, имя машины в нём стало бы форматом, который нельзя
  // менять, — а это данные, приехавшие с чужой машины.
  const payload = buildSessionsPayload(MANY_HOSTS, 'name', { configHost: 'win-host' });
  assert.deepStrictEqual(payload.groups.map(g => g.remote === true),
    [false, true, true]);
  assert.deepStrictEqual(payload.groups.map(g => g.host || ''),
    ['', 'alpha-host', 'zeta-host']);
});

test('единственная группа живых чужой не считается', () => {
  // Пометка идёт от деления: делить нечего — и склеивать нечего, блок
  // остаётся тем же, что и группа.
  const payload = buildSessionsPayload(RAW, 'name', { onlyLive: true, configHost: 'win-host' });
  assert.strictEqual(payload.groups[0].remote, false);
});

test('мёртвые сессии делению не подлежат', () => {
  // Они группируются по рабочим столам, и это деление другого рода: там вопрос
  // «где она стояла», а не «дотянусь ли я до неё сейчас».
  const dead = {
    ...TWO_HOSTS,
    sessions: [{ id: 'gone', title: 'Ушла', cwd: '/home/user/a', live: false,
      window: { host: 'mac-host', pid: 9 } }],
  };
  const payload = buildSessionsPayload(dead, 'name', { configHost: 'win-host' });
  assert.ok(!payload.groups.some(g => /Active/.test(g.label)), payload.groups.map(g => g.label));
});

test('ключ группы стабилен, а счёт из заголовка убран', () => {
  // Ключ — то, по чему помнится свёрнутость секции. Считайся он от заголовка
  // со счётом, уснувшая сессия меняла бы ключ и сбрасывала бы состояние.
  const live = (id) => ({ id, label: id, cwd: `/w/${id}`, live: true });
  const one = groupSessions([live('a')]);
  const two = groupSessions([live('a'), live('b')]);
  assert.strictEqual(one[0].key, 'live');
  assert.strictEqual(two[0].key, 'live');
  assert.strictEqual(one[0].label, 'Active sessions');
  assert.strictEqual(two[0].label, 'Active sessions');
});

test('ключи чужих групп, истории и зелия', () => {
  const row = (id, extra) => ({ id, label: id, cwd: `/w/${id}`, live: true, ...extra });
  const groups = groupSessions([
    row('a'),
    row('x', { windowHost: 'alpha-host' }),
    row('old', { live: false }),
    row('z', { kind: 'zellij' }),
  ]);
  const byKey = Object.fromEntries(groups.map(g => [g.key, g.label]));
  assert.strictEqual(byKey['live'], 'Active local sessions');
  assert.strictEqual(byKey['remote:alpha-host'], 'Active on alpha-host');
  assert.strictEqual(byKey['past'], 'History');
  assert.strictEqual(byKey['zellij'], 'Zellij');
});

test('чужие машины идут по свежести, свежая первой', () => {
  // Машина, на которой только что говорили, должна стоять сверху. Раньше
  // порядок был алфавитным, и `zeta-host` с полуминутной сессией уходил вниз
  // под `alpha-host`, где последний раз говорили час назад.
  const now = Math.floor(Date.now() / 1000);
  const row = (id, host, ago) => ({
    id, label: id, cwd: `/w/${id}`, live: true,
    windowHost: host, lastActivity: now - ago,
  });
  const groups = groupSessions([
    row('a', 'alpha-host', 3600),
    row('z', 'zeta-host', 30),
  ]);
  assert.deepStrictEqual(
    groups.filter(g => g.remote).map(g => g.key),
    ['remote:zeta-host', 'remote:alpha-host'],
  );
});

test('на равной свежести машины разводятся по имени', () => {
  // Иначе две одинаково свежие менялись бы местами от опроса к опросу — тот же
  // класс дрожания, из-за которого свежесть меряется минутами, а не секундами.
  const now = Math.floor(Date.now() / 1000);
  const row = (id, host) => ({
    id, label: id, cwd: `/w/${id}`, live: true,
    windowHost: host, lastActivity: now,
  });
  const groups = groupSessions([row('z', 'zeta-host'), row('a', 'alpha-host')]);
  assert.deepStrictEqual(
    groups.filter(g => g.remote).map(g => g.key),
    ['remote:alpha-host', 'remote:zeta-host'],
  );
});

// ── карточка на окно: id больше не уникален ─────────────────────────────────
//
// Сессию с двумя окнами buildSessionList превращает в две карточки с общим
// id — одна карточка со своим окном, вторая с чужим. tieBreak и группировка
// обязаны различать их без дрожи.

test('тай-брейк разводит карточки одной сессии по машине окна', () => {
  // Имя и id у карточек одной сессии совпадают всегда — их развела бы только
  // машина окна. Без неё compareSessions вернул бы 0, и пара менялась бы
  // местами от тика к тику вместе с порядком, в котором агрегатор шлёт окна.
  const own = { id: 'twin', label: 'x', windowHost: '' };
  const foreign = { id: 'twin', label: 'x', windowHost: 'mac-host' };
  assert.notStrictEqual(compareSessions(own, foreign, 'name'), 0);
  // Порядок стабилен независимо от того, кто передан первым.
  assert.strictEqual(
    compareSessions(own, foreign, 'name'),
    -compareSessions(foreign, own, 'name'),
  );
});

test('карточки сессии с окнами на своей и на чужой машине попадают в разные группы', () => {
  // Ревью нашло: строка с местным и чужим окном уезжала в блок чужой машины
  // целиком. После карточки-на-окно это чинится само — у каждой карточки
  // своё windowHost, — и тест это подтверждает, а не полагается на слово.
  const res = {
    ok: true,
    seen: {},
    sessions: [{
      id: 'twin', title: 'На двух машинах', cwd: '/home/user/a', live: true,
      windows: [
        { host: 'win-host', pid: 7, focusedAt: 5 },
        { host: 'mac-host', pid: 9, focusedAt: 3 },
      ],
    }],
  };
  const payload = buildSessionsPayload(res, 'name', { configHost: 'win-host' });
  assert.deepStrictEqual(payload.groups.map(g => g.label),
    ['Active local sessions', 'Active on mac-host']);
  assert.strictEqual(payload.groups[0].sessions.length, 1);
  assert.strictEqual(payload.groups[0].sessions[0].windowHost, '');
  assert.strictEqual(payload.groups[1].sessions.length, 1);
  assert.strictEqual(payload.groups[1].sessions[0].windowHost, 'mac-host');
  // Обе карточки несут один и тот же id сессии.
  assert.strictEqual(payload.groups[0].sessions[0].id, 'twin');
  assert.strictEqual(payload.groups[1].sessions[0].id, 'twin');
});

// ── activeFilters: спрошенное перебивает отобранное ────────────────────────

test('без запроса и без префикса отсевы остаются как есть', () => {
  assert.deepStrictEqual(
    activeFilters({ mode: 'sessions', query: '', onlyLive: true, onlyWindow: true, hideDesktop: true }),
    { onlyLive: true, onlyWindow: true, hideDesktop: true },
  );
  assert.deepStrictEqual(
    activeFilters({ mode: 'sessions', query: '', onlyLive: false, onlyWindow: false, hideDesktop: false }),
    { onlyLive: false, onlyWindow: false, hideDesktop: false },
  );
});

test('непустой запрос снимает все отсевы', () => {
  // Искали сессию, а не отбор. Отсев при поиске молчит: найденного просто нет
  // в списке, и почему — не сказано ни словом.
  assert.deepStrictEqual(
    activeFilters({ mode: 'sessions', query: 'ccfzf', onlyLive: true, onlyWindow: true, hideDesktop: true }),
    { onlyLive: false, onlyWindow: false, hideDesktop: false },
  );
});

test('пробелы запросом не считаются', () => {
  // Иначе случайно нажатый пробел молча снимал бы отсевы, и человек видел бы
  // другой список, ничего не набрав.
  assert.deepStrictEqual(
    activeFilters({ mode: 'sessions', query: '   ', onlyLive: true, onlyWindow: true, hideDesktop: true }),
    { onlyLive: true, onlyWindow: true, hideDesktop: true },
  );
});

test('любой префикс режима снимает отсевы и на пустом запросе', () => {
  // Оговорок по режимам нет намеренно: `/p` и `/s` сессий не касаются вовсе, а
  // `/l` и `/r` живые по построению — таблица «какой режим что отменяет» была
  // бы вторым списком рядом с PREFIXES и разошлась бы с ним на первой правке.
  for (const mode of ['local', 'remote', 'history', 'projects', 'snapshots']) {
    assert.deepStrictEqual(
      activeFilters({ mode, query: '', onlyLive: true, onlyWindow: true, hideDesktop: true }),
      { onlyLive: false, onlyWindow: false, hideDesktop: false },
      `режим ${mode}`,
    );
  }
});

test('пустой вход не роняет и не выдумывает отсевов', () => {
  // Зовётся она из regroup, а тот бывает позван и до первого ответа.
  assert.deepStrictEqual(activeFilters(), { onlyLive: false, onlyWindow: false, hideDesktop: false });
  assert.deepStrictEqual(activeFilters({}), { onlyLive: false, onlyWindow: false, hideDesktop: false });
});
