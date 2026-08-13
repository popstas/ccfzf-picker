const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeSort, cycleSort, compareSessions, groupSessions, labelSessions, SORT_MODES,
  DEFAULT_SORT, buildSessionsPayload,
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
  // Группа «Not running» при этом не остаётся пустой — её просто нет.
  assert.deepStrictEqual(payload.groups.map(g => g.label), ['Active sessions - 2']);
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
