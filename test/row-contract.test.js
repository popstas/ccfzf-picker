// Шов между сборкой строки и её отрисовкой.
//
// Все остальные тесты проверяют одну сторону шва: session-list.test.js — что
// строка собралась, session-glyph.test.js — что отрисовщик рисует то, что ему
// дали. Обе стороны могут быть зелёными, пока строка приезжает под одними
// именами, а рисуется по другим: колонки просто молча пустеют. Здесь строка
// проходит настоящий путь (buildSessionsPayload → labelSessions →
// groupSessions) и уходит в настоящие отрисовщики, а проверяется то, что они
// нарисовали.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSessionsPayload } = require('../frontend-src/session-groups');
const Groups = require('../frontend-src/session-groups');
const Glyph = require('../frontend-src/session-glyph');
const { buildSessionInfoRows } = require('../frontend-src/session-info');
const { filterSessions, filterProjects } = require('../frontend-src/picker-filter');
const { buildProjectList, markHotkeysTaken } = require('../frontend-src/project-list');
const { availableActions } = require('../frontend-src/session-actions');

// Форма — с живого ответа `ccfzf --state` (см. scripts/check-state.js), поля
// в том же порядке и с теми же именами.
function aggregatorSession(extra) {
  return Object.assign({
    id: 'f8ef5e26-24b7-47f7-822c-812a5c25002a',
    cwd: '/home/user/projects/expertizeme/cup-dashboard',
    file: '/home/user/.claude/projects/-home-.../f8ef5e26.jsonl',
    projects: ['/home/user/projects/expertizeme/cup-dashboard'],
    title: 'cup-dashboard',
    gist: 'давай A, разворачивай дизайн',
    doing: 'ок',
    mtime: 1785870223.67,
    age: '0m',
    live: true,
    frozen: false,
    kind: 'interactive',
    parent: '',
    pid: 4242,
    tty: '/dev/pts/3',
    tmux: null,
    agent: {
      state: 'review',
      event: 'stop',
      // Пусто у не-attention: базовая фикстура — сессия, закончившая ход.
      message: '',
      summary: 'Готово — сборка зелёная',
      lastSummary: 'Чинил сборку',
      prompt: 'почини сборку',
      // Пусто: вопрос живёт только пока вызов AskUserQuestion не закрыт.
      question: '',
      branch: 'feat/x',
      pr_url: 'https://github.com/popstas/ccfzf/pull/3',
      costUsd: 3,
      contextPct: 41,
      updated: 1785870255,
      turnAt: 1785870015,   // пять минут до NOW
      started: 1785869115,  // двадцать минут до NOW
    },
  }, extra || {});
}

const NOW = 1785870315; // минута после updated

function firstRow(state, seen) {
  const payload = buildSessionsPayload(
    { ok: true, sessions: state, seen: seen || {} },
    'cost',
  );
  assert.strictEqual(payload.ok, true);
  return payload.groups[0].sessions[0];
}

test('строка с настоящего пути доезжает до имени в списке и до поиска', () => {
  const row = firstRow([aggregatorSession()]);
  // label назначает labelSessions внутри buildSessionsPayload: имя рисуется
  // прямо из него (sessions.html), и по нему же ищут.
  assert.strictEqual(row.label, 'cup-dashboard');
  assert.notStrictEqual(row.label, undefined);
  assert.strictEqual(Glyph.escapeHtml(row.label), 'cup-dashboard');

  const groups = buildSessionsPayload({ ok: true, sessions: [aggregatorSession()] }, 'cost').groups;
  assert.strictEqual(filterSessions(groups, 'cup-dash')[0].sessions.length, 1);
  assert.strictEqual(filterSessions(groups, 'expertizeme')[0].sessions.length, 1);
  assert.strictEqual(filterSessions(groups, 'нет такой сессии').length, 0);
});

test('строка доезжает до правых колонок глифа', () => {
  const row = firstRow([aggregatorSession()]);
  assert.strictEqual(Glyph.statusDotHtml(row), '<div class="dot review"></div>');
  assert.strictEqual(Glyph.stateText(row), 'review · stop');
  assert.strictEqual(
    Glyph.usageHtml(row, { showCost: true, showContext: true }),
    '<div class="usage"><span class="cost">$3</span> · <span class="ctx hot">41%</span></div>',
  );
  assert.strictEqual(Glyph.ageHtml(row, NOW), '<div class="age">1m</div>');
  assert.strictEqual(Glyph.prBadgeHtml(row), '<span class="pr">↗ #3</span>');
  assert.strictEqual(Glyph.shortSessionId(row), 'f8ef');
  assert.strictEqual(Glyph.sessionName(row), 'cup-dashboard');
});

test('строка доезжает до подсказки и до карточки', () => {
  const row = firstRow([aggregatorSession()], { 'f8ef5e26-24b7-47f7-822c-812a5c25002a': 1785870300 });
  const title = Glyph.rowTitle(row);
  assert.ok(title.includes('~/projects/expertizeme/cup-dashboard'), title);
  assert.ok(title.includes('почини сборку'), title);
  assert.ok(title.includes('Готово — сборка зелёная'), title);
  assert.ok(!title.includes('undefined'), title);

  const rows = buildSessionInfoRows(row, NOW);
  const value = label => rows.find(r => r.label === label)?.value;
  assert.strictEqual(value('id'), 'f8ef5e26-24b7-47f7-822c-812a5c25002a');
  assert.strictEqual(value('name'), 'cup-dashboard');
  assert.strictEqual(value('cwd'), '/home/user/projects/expertizeme/cup-dashboard');
  assert.strictEqual(value('process'), 'live');
  assert.strictEqual(value('state'), 'review');
  assert.strictEqual(value('event'), 'stop');
  assert.strictEqual(value('seen'), 'yes');
  assert.strictEqual(value('prompt'), 'почини сборку');
  assert.strictEqual(value('summary'), 'Готово — сборка зелёная');
  assert.strictEqual(value('cost'), '$3');
  assert.strictEqual(value('context'), '41%');
  assert.strictEqual(value('branch'), 'feat/x');
  assert.strictEqual(value('pr_url'), 'https://github.com/popstas/ccfzf/pull/3');
  assert.match(value('last activity'), /^\d{2}:\d{2} · 1m$/);
  assert.match(value('focused'), /^\d{2}:\d{2} · /);
  // Карточка — про то, чего не видно в строке; из 19 её строк здесь ждём 17
  // (message пуст у сессии, закончившей ход, agent — не фоновая).
  assert.strictEqual(rows.length, 17);
  for (const r of rows) assert.ok(!r.value.includes('undefined'), `${r.label}: ${r.value}`);
});

test('agentSeen гасит кружок ровно с той стороны, с которой должен', () => {
  const id = 'f8ef5e26-24b7-47f7-822c-812a5c25002a';
  // Не смотрели — сессия зовёт.
  assert.strictEqual(Glyph.statusDotHtml(firstRow([aggregatorSession()], {})),
    '<div class="dot review"></div>');
  // Открыли после записи — гаснет. Перепутанная полярность даёт ровно обратную
  // пару, и этот тест на ней падает.
  assert.strictEqual(Glyph.statusDotHtml(firstRow([aggregatorSession()], { [id]: 1785870300 })),
    '<div class="dot idle"></div>');
});

test('сессия без записи агента рисуется пусто, а не «undefined»', () => {
  const row = firstRow([aggregatorSession({ agent: null, live: false })]);
  assert.strictEqual(Glyph.statusDotHtml(row), '<div class="dot closed"></div>');
  assert.strictEqual(Glyph.stateText(row), '');
  assert.strictEqual(Glyph.stateHtml(row, true), '<div class="state"></div>');
  assert.strictEqual(Glyph.usageHtml(row, { showCost: true, showContext: true }),
    '<div class="usage"><span class="cost">$0</span> · <span class="ctx">0%</span></div>');
  assert.strictEqual(Glyph.ageHtml(row, NOW), '<div class="age"></div>');
  assert.strictEqual(Glyph.prBadgeHtml(row), '');
  assert.strictEqual(Glyph.rowTitle(row), '~/projects/expertizeme/cup-dashboard');
  for (const r of buildSessionInfoRows(row, NOW)) {
    assert.ok(!r.value.includes('undefined'), `${r.label}: ${r.value}`);
  }
});

test('поля без источника не роняют отрисовку', () => {
  const row = firstRow([aggregatorSession()]);
  // hotkey — понятие windows11-manager (claudeWt.projects), desktop — номер
  // рабочего стола Windows. Источника у них здесь нет и не будет, поэтому
  // проверяется не отсутствие ради отсутствия, а то, что отрисовка от него не
  // портится. Остальные три имени этот тест сторожил до того, как строка
  // начала их отдавать, — см. тест ниже.
  for (const key of ['hotkey', 'desktop']) {
    assert.ok(!(key in row), `${key} не должен появляться из ниоткуда`);
  }
  assert.strictEqual(Glyph.hotkeyHtml(row, true), '<div class="hk"></div>');
  assert.ok(!Glyph.rowTitle(row).includes('undefined'));
});

test('ход, старт и уведомление доезжают с настоящего пути до отрисовщиков', () => {
  // Колонка возраста у работающей сессии — про текущий ход, а не про секунды
  // с последнего вызова инструмента: их десятки в минуту.
  const working = aggregatorSession({
    agent: { ...aggregatorSession().agent, state: 'active' },
  });
  assert.strictEqual(Glyph.ageHtml(firstRow([working]), NOW), '<div class="age">5m</div>');
  // Ход кончился — колонка снова про активность.
  assert.strictEqual(Glyph.ageHtml(firstRow([aggregatorSession()]), NOW),
    '<div class="age">1m</div>');

  const rows = buildSessionInfoRows(firstRow([aggregatorSession()]), NOW);
  const value = label => rows.find(r => r.label === label)?.value;
  assert.match(value('started'), /^\d{2}:\d{2} · 20m$/);
  assert.match(value('turn'), /^\d{2}:\d{2} · 5m$/);

  // Уведомление доезжает до подсказки, а фраза про простое — гасится: она
  // висела бы на каждой отдохнувшей сессии и вытесняла то, ради чего в
  // подсказку и смотрят.
  const asking = aggregatorSession({
    agent: { ...aggregatorSession().agent, state: 'question',
             message: 'Claude needs your permission to use Bash' },
  });
  assert.ok(Glyph.rowTitle(firstRow([asking])).includes('permission to use Bash'));
  const resting = aggregatorSession({
    agent: { ...aggregatorSession().agent, state: 'idle',
             message: 'Claude is waiting for your input' },
  });
  assert.ok(!Glyph.rowTitle(firstRow([resting])).includes('waiting for your input'));
});

test('вопрос доезжает с настоящего пути и перебивает сводку', () => {
  const waiting = aggregatorSession({
    agent: { ...aggregatorSession().agent, state: 'question',
             question: 'Какой вариант — A или B?' },
  });
  const row = firstRow([waiting]);
  assert.strictEqual(row.agentDescription, 'Какой вариант — A или B?');
  assert.ok(Glyph.rowTitle(row).includes('Какой вариант — A или B?'));
  assert.ok(!Glyph.rowTitle(row).includes('Готово — сборка зелёная'));
});

test('сортировка по деньгам читает то же поле, что строка кладёт', () => {
  const payload = buildSessionsPayload({
    ok: true,
    sessions: [
      aggregatorSession({ id: 'cheap', title: 'cheap', live: false,
        agent: { updated: 10, costUsd: 1 } }),
      aggregatorSession({ id: 'rich', title: 'rich', live: false,
        agent: { updated: 10, costUsd: 99 } }),
    ],
  }, 'cost');
  assert.deepStrictEqual(payload.groups[0].sessions.map(s => s.id), ['rich', 'cheap']);
});

// Структурная проверка: что отрисовщики читают с сессии — и что строка отдаёт.
// Список имён не переписывается руками: он вычитывается из исходников
// потребителей, поэтому переименование ключа в session-list.js роняет этот
// тест, даже если ни один из тестов выше про это имя не знает.
const CONSUMERS = [
  'session-glyph.js', 'session-info.js', 'session-groups.js', 'picker-filter.js',
];

// Читаются с сессии, но источника не имеют. desktop — понятие Windows,
// которого на этом проекте нет вовсе (см. groupSessions); hotkey — понятие
// windows11-manager, список claudeWt.projects живёт только в его конфиге.
// hotkeyTaken — той же природы, что и hotkey: его проставляет не сборка
// строки, а markHotkeysTaken (project-list.js) поверх уже готовых строк
// проектов, по ответу Rust о занятых клавишах.
const NO_SOURCE = new Set(['hotkey', 'desktop', 'hotkeyTaken']);

function readsOfConsumers() {
  const names = new Set();
  for (const file of CONSUMERS) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'frontend-src', file), 'utf8');
    // Переменные, в которых у потребителей лежит сессия: `session`, `s`, а в
    // компараторе — `a` и `b`.
    for (const m of src.matchAll(/(?<![\w$.])(?:session|s|a|b)\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      names.add(m[1]);
    }
  }
  // Методы строк и массивов, а не поля сессии.
  for (const junk of ['map', 'filter', 'sessions', 'push', 'localeCompare', 'length', 'sort']) {
    names.delete(junk);
  }
  return names;
}

test('каждое поле, которое читают отрисовщики, строка действительно отдаёт', () => {
  const row = firstRow([aggregatorSession()]);
  const reads = readsOfConsumers();
  // Сама выборка должна быть непустой и содержать заведомо читаемые имена —
  // иначе тест зелен от того, что регулярка ничего не нашла.
  assert.ok(reads.size >= 15, `слишком мало прочитанных имён: ${reads.size}`);
  for (const anchor of ['agentState', 'label', 'pr_url', 'lastActivity', 'agentCostUsd']) {
    assert.ok(reads.has(anchor), `выборка не нашла ${anchor} — сломалась сама проверка`);
  }
  const missing = [...reads].filter(n => !NO_SOURCE.has(n) && !(n in row));
  assert.deepStrictEqual(missing, [], `отрисовщики читают поля, которых нет в строке: ${missing}`);
  // И наоборот: имена из NO_SOURCE должны и правда кем-то читаться, иначе
  // список исключений незаметно протухнет.
  for (const n of NO_SOURCE) {
    assert.ok(reads.has(n), `${n} больше никто не читает — убрать из NO_SOURCE`);
  }
});

test('labelSessions вызывается на настоящем пути, а не только в тестах', () => {
  // Прямая проверка того, что сломалось: groupSessions получает строки уже с
  // label. Если сборку списка снова обнесут мимо labelSessions, здесь будет
  // undefined.
  const row = firstRow([aggregatorSession({ title: 'без имени не искать' })]);
  assert.strictEqual(row.label, 'без имени не искать');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'label'));
  // И групповой заголовок — тоже label, но группы, а не сессии.
  const payload = buildSessionsPayload({ ok: true, sessions: [aggregatorSession()] }, 'cost');
  assert.strictEqual(payload.groups[0].label, 'Active sessions');
});

test('ошибочный ответ агрегатора не доходит до сборки строк', () => {
  assert.deepStrictEqual(
    Groups.buildSessionsPayload({ ok: false, reason: 'ccfzf: not found' }, 'cost'),
    { ok: false, reason: 'ccfzf: not found' },
  );
});

// ── Тот же шов у строк проектов ──────────────────────────────────────────────
//
// Разница одна: у сессии колонки рисуют отрисовщики из session-glyph.js, а всю
// строку целиком складывают projectItem, snapshotItem и sessionItem — они живут
// прямо в sessions.html, и требовать их через require неоткуда. Поэтому функции
// вычитываются из страницы и выполняются в vm (как именно — см. pageFunctions
// ниже) — тем же приёмом, каким frontend-load.test.js грузит модули тегами.
// Проверяется настоящий писатель в DOM, а не его копия в тесте: копия
// разъехалась бы молча.
const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

/**
 * Вычитать со страницы функции по их точным сигнатурам и склеить в один кусок
 * для vm.
 *
 * Рисовальщик теперь только обходит список, а разметку одной строки собирает
 * вынесенная из него функция: узкий и широкий режимы обходят список
 * по-разному, а разметка у них одна. Вынесенная функция осталась снаружи
 * куска, вычитанного по сигнатуре рисовальщика, и в vm вызов упал бы на
 * «projectItem is not defined». Поэтому достаются обе — и сторож от этого
 * только крепче: настоящий сборщик разметки теперь как раз строчная функция, и
 * шов, ради которого заведён этот файл, проходит через неё.
 *
 * Сигнатура сверяется целиком, как и раньше: переименованный параметр или
 * лишний аргумент обязаны уронить тест, а не молча вычитать соседнюю функцию.
 */
const PickerSections = require('../frontend-src/picker-sections');

/**
 * Строки секции без её заголовка.
 *
 * Заголовок — такая же строка списка, как и остальные, и в `rows` он стоит
 * первым; тесты ниже про содержимое секции, а не про её подпись, и сверяют
 * строки от первой настоящей. Смещение на единицу поэтому написано прямо в
 * ожиданиях `data-index` — их и правда сдвинул заголовок.
 */
function withoutHeader(items, rows) {
  // Array.from — не украшение: массив приезжает из vm, у него другой Object, и
  // deepStrictEqual сравнивает ещё и прототип.
  //
  // Отбор по виду, а не по месту: под пустым запросом заголовок секции —
  // строка списка и занимает место в `rows`, под непустым — подпись, и в
  // `rows` его нет вовсе. Срез по единице врал бы в одном из двух случаев.
  return {
    items: Array.from(items).filter(i => !String(i.key).startsWith('sec:')),
    rows: rows.filter(r => r.kind !== 'section'),
  };
}

function pageFunctions(...signatures) {
  return signatures.map((signature) => {
    // Экранируются только скобки: в сигнатурах других знаков регулярного
    // выражения не бывает.
    const head = signature.replace(/[()]/g, '\\$&');
    const source = SESSIONS_HTML.match(new RegExp(`\\n {2}function ${head} \\{[\\s\\S]*?\\n {2}\\}\\n`));
    assert.ok(source, `${signature} не найден в sessions.html — тест сторожит не то`);
    return source[0];
  }).join('\n');
}

// Форма — с живого ответа `ccfzf --state`, поля те же, что у project_rows.
const AGGREGATOR_PROJECTS = [
  { path: '/home/user/projects/ccfzf', name: 'ccfzf', mark: true,
    sessions: 12, live: 2, mtime: 1786045860 },
  // Проект без единой сессии — ровно то, ради чего режим и заведён. mtime 0
  // значит «активности не было», а не «1970 год».
  { path: '/home/user/projects/empty', name: 'empty', mark: false,
    sessions: 0, live: 0, mtime: 0 },
];

const PROJECTS_NOW = 1786045920; // минута после mtime первого

/**
 * Пропустить проекты настоящим путём: buildProjectList → markHotkeysTaken →
 * filterProjects → renderProjects.
 *
 * `taken` прогоняется через markHotkeysTaken тем же порядком, что и в
 * render() (sessions.html): признак ставится до фильтрации и отрисовки, а не
 * внутри buildProjectList — она про ответ агрегатора, а занятость клавиши
 * знает только эта машина.
 */
function renderProjectRows(projects, query, toggles, taken) {
  const source = pageFunctions(
    'projectItem(project, nowSec)', 'sectionItem(section)', 'itemsOfSection(section, nowSec)');
  const projectRows = buildProjectList({ projects });
  markHotkeysTaken(projectRows, taken || []);
  const ctx = {
    // Ровно то, чем itemsOfSection пользуется снаружи себя. Секция собирается
    // настоящей buildSections — отбор и порядок строк идут той же дорогой, что
    // и на экране, а не переписанной в тесте.
    window: { PickerSections },
    projectRows,
    rows: [],
    toggles: toggles || { showPaths: true },
    escapeHtml: Glyph.escapeHtml,
    shortPath: Glyph.shortPath,
    ageHtml: Glyph.ageHtml,
    hotkeyHtml: Glyph.hotkeyHtml,
    titleAttr: Glyph.titleAttr,
    query: query || '',
    nowSec: PROJECTS_NOW,
  };
  vm.createContext(ctx);
  const items = vm.runInContext(`${source}
    var section = window.PickerSections.buildSections({
      projects: projectRows, mode: 'projects', query, layout: 'narrow' })[0];
    section ? itemsOfSection(section, nowSec) : [];`, ctx, { filename: 'sessions.html' });
  return withoutHeader(items, ctx.rows);
}

test('строка проекта доезжает с настоящего пути до разметки списка', () => {
  const { items, rows } = renderProjectRows(AGGREGATOR_PROJECTS);
  assert.strictEqual(items.length, 2);
  // Ключ строки — проектный префикс плюс путь: по нему picker-list-sync
  // находит, что в DOM менять, и разъехавшийся ключ перерисовывал бы список
  // целиком, роняя скролл и hover.
  assert.deepStrictEqual(items.map(i => i.key),
    AGGREGATOR_PROJECTS.map(p => `p:${p.path}`));

  // Счётчики. Имена sessionCount и liveCount — тот самый промах, который этот
  // тест обязан ловить: переименуй их в project-list.js, и здесь появится
  // «undefined», а в окне — пустая колонка.
  assert.ok(items[0].html.includes('<div class="count">12 · 2●</div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="count">0</div>'), items[1].html);

  // Точка: зелёная там, где кто-то работает, обычная серая — где никого.
  // `closed` (прозрачная) у проекта не появляется: она про закрытую сессию.
  assert.ok(items[0].html.includes('<div class="dot active"></div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="dot"></div>'), items[1].html);
  assert.ok(!items[1].html.includes('closed'), items[1].html);

  // Путь в подсказке и в теле строки — одного вида, через shortPath.
  assert.ok(items[0].html.includes('title="~/projects/ccfzf"'), items[0].html);
  assert.ok(items[0].html.includes('<div class="cwd">~/projects/ccfzf</div>'), items[0].html);

  // Возраст: минута у свежего, пусто у проекта с mtime 0. «1970» здесь взяться
  // неоткуда — но взялось бы, если возраст начнут считать без проверки нуля.
  assert.ok(items[0].html.includes('<div class="age">1m</div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="age"></div>'), items[1].html);
  assert.ok(!items[1].html.includes('d</div>'), items[1].html);

  // Отметка ccfzf — только у отмеченного проекта.
  assert.ok(items[0].html.includes('<span class="mark">★</span>'), items[0].html);
  assert.ok(!items[1].html.includes('mark'), items[1].html);

  // data-index — это индекс в rows, по нему меню и клик находят строку.
  // Нумерация с нуля: под префиксом (а этот режим и есть префикс `/p`)
  // заголовок секции — подпись, а не строка, и места в `rows` не занимает.
  for (let i = 0; i < items.length; i += 1) {
    assert.ok(items[i].html.includes(`data-index="${i}"`), items[i].html);
    assert.strictEqual(rows[i].id, AGGREGATOR_PROJECTS[i].path);
    assert.strictEqual(rows[i].kind, 'project');
  }
  assert.strictEqual(rows.length, items.length);
});

test('имя проекта в разметку экранируется', () => {
  const { items } = renderProjectRows([{
    path: '/home/user/projects/<b>"x"', name: '<b>"amp & co"</b>',
    mark: false, sessions: 1, live: 0, mtime: 1786045860,
  }]);
  assert.ok(items[0].html.includes('&lt;b&gt;&quot;amp &amp; co&quot;&lt;/b&gt;'), items[0].html);
  assert.ok(!items[0].html.includes('<b>'), items[0].html);
  // И путь — в подсказке и в теле строки.
  assert.ok(!items[0].html.includes('"x"'), items[0].html);
});

test('отбор проектов и порядок строк — тот же, что видит человек', () => {
  // Поиск идёт по имени и по пути, а data-index пересчитывается от нуля: иначе
  // после набора в строке поиска клик открывал бы соседний проект.
  const { items, rows } = renderProjectRows(AGGREGATOR_PROJECTS, 'empty');
  assert.strictEqual(items.length, 1);
  // Под непустым запросом заголовок секции — подпись, а не строка, поэтому
  // нумерация снова начинается с нуля.
  assert.ok(items[0].html.includes('data-index="0"'), items[0].html);
  assert.strictEqual(rows[0].id, '/home/user/projects/empty');

  const byPath = renderProjectRows(AGGREGATOR_PROJECTS, 'projects/ccfzf');
  assert.deepStrictEqual(byPath.rows.map(r => r.id), ['/home/user/projects/ccfzf']);
  assert.deepStrictEqual(renderProjectRows(AGGREGATOR_PROJECTS, 'нет такого').items, []);
});

test('выключенный чекбокс путей убирает путь только из тела строки', () => {
  const { items } = renderProjectRows(AGGREGATOR_PROJECTS, '', { showPaths: false });
  assert.ok(!items[0].html.includes('class="cwd"'), items[0].html);
  // Подсказка остаётся: она и заведена для того, чего в строке не видно.
  assert.ok(items[0].html.includes('title="~/projects/ccfzf"'), items[0].html);
});

// Задачи 4 и 7 довели row.hotkey и row.hotkeyTaken до строки проекта, но
// renderProjects hotkeyHtml не звала вовсе — колонка hk у проектов не
// рисовалась, и обе задачи не давали ничего видимого. Сторожим то, что
// столкнуло эту дыру: настоящий вызов renderProjects с настоящей hotkeyHtml.
test('строка проекта несёт колонку hk, и занятая клавиша в ней погашена', () => {
  const withHotkeys = [
    { path: '/p/one', name: 'one', sessions: 1, live: 0, mtime: 0, hotkey: 'Ctrl+F11' },
    { path: '/p/two', name: 'two', sessions: 1, live: 0, mtime: 0, hotkey: 'Ctrl+F12' },
  ];
  const taken = [{ cwd: '/p/one', hotkey: 'Ctrl+F11', reason: 'system' }];
  const { items } = renderProjectRows(withHotkeys, '', undefined, taken);
  assert.ok(items[0].html.includes('<div class="hk taken">Ctrl+F11</div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="hk">Ctrl+F12</div>'), items[1].html);
});

// Пометка идёт по каталогу, а не по комбинации: у дважды названной клавиши
// она общая, а работает клавиша у одного — у первого по каталогу. Пометив по
// комбинации, список перечеркнул бы обоих, и человек искал бы поломку там,
// где её нет.
test('дважды названная клавиша гасит проигравшего, но не победителя', () => {
  const twins = [
    { path: '/p/one', name: 'one', sessions: 1, live: 0, mtime: 0, hotkey: 'Ctrl+F11' },
    { path: '/p/two', name: 'two', sessions: 1, live: 0, mtime: 0, hotkey: 'Ctrl+F11' },
  ];
  const taken = [{ cwd: '/p/two', hotkey: 'Ctrl+F11', reason: 'duplicate' }];
  const { items } = renderProjectRows(twins, '', undefined, taken);
  assert.ok(items[0].html.includes('<div class="hk">Ctrl+F11</div>'), items[0].html);
  assert.ok(items[1].html.includes('<div class="hk taken">Ctrl+F11</div>'), items[1].html);
});

// Строку статуслайна складывает тот же помощник, что и помечает строки: две
// копии разошлись бы на первой же правке формулировок, а поймать это было бы
// нечем — статуслайн ни один тест не читает.
test('статуслайн складывает жалобу помощником, а не своими руками', () => {
  assert.ok(
    SESSIONS_HTML.includes('ProjectList.hotkeysTakenMessage('),
    'sessions.html обязан звать hotkeysTakenMessage — иначе причина отказа снова врёт',
  );
});

test('выключенный чекбокс hotkeys убирает колонку hk у строки проекта', () => {
  const { items } = renderProjectRows(
    [{ path: '/p/one', name: 'one', sessions: 0, live: 0, mtime: 0, hotkey: 'Ctrl+F11' }],
    '', { showPaths: true, showHotkey: false },
  );
  assert.ok(!items[0].html.includes('class="hk'), items[0].html);
});

// ── Тот же шов у строк снимков ───────────────────────────────────────────────
//
// Здесь швов два: buildSnapshotRows называет поля строки, а renderSnapshots в
// sessions.html их читает — разъехавшись, они дадут «undefined» в разметке при
// зелёном picker-snapshots.test.js. Функция так же вычитывается из страницы и
// выполняется в vm: копия отрисовщика в тесте разошлась бы с настоящим молча.
const { buildSnapshotRows, openIdsFromState } = require('../frontend-src/picker-snapshots');

// Форма — с живого ответа `ccfzf --state`, поле `snapshots`.
const AGGREGATOR_SNAPSHOTS = [{
  id: 'snap-1',
  created: 1786045860,
  sessions: [
    { id: 'aaa', cwd: '/home/user/projects/ccfzf', title: 'ccfzf' },
    { id: 'bbb', cwd: '/home/user/projects/empty', title: 'empty' },
  ],
}];

/** Пропустить снимки настоящим путём: buildSnapshotRows → renderSnapshots. */
function renderSnapshotRows(snapshots, query, options) {
  // Строки снимков считает snapshotItemsFor — она вычитывается вместе с
  // рисовальщиком по той же причине, что и snapshotItem: живёт снаружи его тела.
  const source = pageFunctions(
    'snapshotItem(row, nowSec)', 'snapshotItemsFor(query)',
    'sectionItem(section)', 'itemsOfSection(section, nowSec)');
  const opts = options || {};
  const ctx = {
    // Ровно то, чем itemsOfSection пользуется снаружи себя.
    window: { PickerSnapshots: { buildSnapshotRows, openIdsFromState }, PickerSections },
    snapshotRows: snapshots,
    // Открытые окна приезжают тем же ответом, что и весь список.
    lastState: { sessions: (opts.open || []).map(id => ({ id, window: { hwnd: 1 } })) },
    rows: [],
    toggles: opts.toggles || { showPaths: true },
    escapeHtml: Glyph.escapeHtml,
    shortPath: Glyph.shortPath,
    query: query || '',
    nowSec: PROJECTS_NOW,
  };
  vm.createContext(ctx);
  const items = vm.runInContext(`${source}
    var section = window.PickerSections.buildSections({
      snapshots: snapshotItemsFor(query), mode: 'snapshots',
      query, trackerHere: true, layout: 'narrow' })[0];
    section ? itemsOfSection(section, nowSec) : [];`, ctx, { filename: 'sessions.html' });
  return withoutHeader(items, ctx.rows);
}

test('строка снимка доезжает с настоящего пути до разметки списка', () => {
  const { items, rows } = renderSnapshotRows(AGGREGATOR_SNAPSHOTS, '', { open: ['aaa'] });
  // Заголовок и две сессии одним потоком, все три — строки rows: у заголовка
  // своё действие, и Enter на нём поднимает раскладку целиком.
  assert.deepStrictEqual(rows.map(r => r.kind),
    ['snapshot', 'snapshot-session', 'snapshot-session']);
  assert.deepStrictEqual(items.map(i => i.key),
    ['g:snap:snap-1', 'snap:snap-1:aaa', 'snap:snap-1:bbb']);
  for (let i = 0; i < items.length; i += 1) {
    // С нуля по той же причине, что и у проектов: режим снимков — префикс.
    assert.ok(items[i].html.includes(`data-index="${i}"`), items[i].html);
    assert.ok(!items[i].html.includes('undefined'), items[i].html);
  }

  // Счёт в заголовке: сколько сессий всего и сколько из них ещё не на экране.
  // Имена total и missing — тот самый промах, который тест обязан ловить.
  assert.ok(items[0].html.includes('<div class="count">2 · 1 not open</div>'), items[0].html);
  assert.match(items[0].html, /<div class="name">\d{2}:\d{2} · \d{4}-\d{2}-\d{2}<\/div>/);

  // Открытая сессия — тусклая и с пометкой; восстановление её пропустит.
  // Класс именно `on-screen`: `closed` в этом файле значит обратное — «сессии
  // нет», — и строка снимка носила бы его ровно в тех случаях, когда окно есть.
  assert.ok(items[1].html.includes('class="row snapshot-session on-screen"'), items[1].html);
  assert.ok(!items[1].html.includes('closed'), items[1].html);
  assert.ok(items[1].html.includes('<div class="dot active"></div>'), items[1].html);
  assert.ok(items[1].html.includes('▣ open'), items[1].html);
  // Закрытая — обычная, и колонка пуста, а не «undefined».
  assert.ok(items[2].html.includes('class="row snapshot-session"'), items[2].html);
  assert.ok(items[2].html.includes('<div class="dot"></div>'), items[2].html);
  assert.ok(items[2].html.includes('<div class="count"></div>'), items[2].html);

  // Имя строки — каталог проекта, путь — тот же shortPath, что у сессий.
  assert.ok(items[2].html.includes('<div class="name">empty</div>'), items[2].html);
  assert.ok(items[2].html.includes('<div class="cwd">~/projects/empty</div>'), items[2].html);
  assert.ok(items[2].html.includes('title="/home/user/projects/empty"'), items[2].html);
});

test('все окна на экране — заголовок говорит об этом, а не молчит', () => {
  const { items } = renderSnapshotRows(AGGREGATOR_SNAPSHOTS, '', { open: ['aaa', 'bbb'] });
  assert.ok(items[0].html.includes('<div class="count">2 · all on screen</div>'), items[0].html);
});

test('отбор снимков и порядок строк — тот же, что видит человек', () => {
  // Снимок без подошедших сессий уходит с заголовком, а data-index
  // пересчитывается от нуля: иначе после набора Enter поднимал бы не ту строку.
  const { items, rows } = renderSnapshotRows(AGGREGATOR_SNAPSHOTS, 'empty');
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(rows.map(r => r.id), ['snap-1', 'bbb']);
  assert.ok(items[1].html.includes('data-index="1"'), items[1].html);
  assert.deepStrictEqual(renderSnapshotRows(AGGREGATOR_SNAPSHOTS, 'нет такого').items, []);
});

test('имя и путь снимка в разметку экранируются', () => {
  const { items } = renderSnapshotRows([{
    id: 'snap-2', created: 1786045860,
    sessions: [{ id: 'ccc', cwd: '/home/user/projects/<b>"x"', title: 'x' }],
  }]);
  // Путь идёт и в подсказку, и в тело строки — обе через escapeHtml.
  assert.ok(!items[1].html.includes('<b>'), items[1].html);
  assert.ok(!items[1].html.includes('"x"'), items[1].html);
  assert.ok(items[1].html.includes('&lt;b&gt;&quot;x&quot;'), items[1].html);
});

test('выключенный чекбокс путей убирает путь из строки снимка', () => {
  const { items } = renderSnapshotRows(AGGREGATOR_SNAPSHOTS, '', { toggles: { showPaths: false } });
  assert.ok(!items[1].html.includes('class="cwd"'), items[1].html);
  // Подсказка остаётся: она и заведена для того, чего в строке не видно.
  assert.ok(items[1].html.includes('title="/home/user/projects/ccfzf"'), items[1].html);
});

// ── Какой режим показан на самом деле ────────────────────────────────────────
//
// Развилка одна, а раскладок две: узкий список и блоки широкого режима. Пока
// она стояла по месту, широкая ветка брала `mode` как есть — и `/s` на машине
// без трекера давал там пустой экран, потому что buildBlocks на `snapshots`
// без трекера не отдаёт ни одного блока, а узкий список в том же случае честно
// искал по сессиям. Вычитывается со страницы тем же приёмом, что и
// рисовальщики выше.
const { parseQuery } = require('../frontend-src/picker-mode');

function shownFor(value, trackerHere) {
  const ctx = {
    // Ровно то, чем shownModeAndQuery пользуется снаружи себя.
    window: { PickerMode: { parseQuery } },
    search: { value },
    trackerIsHere: () => trackerHere,
  };
  vm.createContext(ctx);
  vm.runInContext(`${pageFunctions('shownModeAndQuery()')}\nvar shown = shownModeAndQuery();`,
    ctx, { filename: 'sessions.html' });
  // Поля переписываются в свой объект: у сделанного внутри vm другой Object, и
  // deepStrictEqual сравнивает ещё и прототип.
  return { mode: ctx.shown.mode, query: ctx.shown.query };
}

test('без трекера `/s` откатывается в поиск по сессиям, а не показывает пустоту', () => {
  // Ищется вся строка целиком, вместе с префиксом: в поиске по сессиям `/s` —
  // то, что человек набрал, а не команда.
  assert.deepStrictEqual(shownFor('/s foo', false), { mode: 'sessions', query: '/s foo' });
  assert.deepStrictEqual(shownFor('/s', false), { mode: 'sessions', query: '/s' });
});

test('с трекером `/s` остаётся режимом снимков, и префикс из отбора уходит', () => {
  assert.deepStrictEqual(shownFor('/s foo', true), { mode: 'snapshots', query: 'foo' });
});

test('режим проектов и обычный поиск от трекера не зависят', () => {
  for (const here of [true, false]) {
    assert.deepStrictEqual(shownFor('/p foo', here), { mode: 'projects', query: 'foo' });
    assert.deepStrictEqual(shownFor('foo', here), { mode: 'sessions', query: 'foo' });
  }
});

// Сторож на само устройство: обе раскладки обязаны брать режим у одной
// функции. Посчитай его render() у себя — и широкая ветка снова разойдётся с
// узкой, а поймать это будет нечем: пустой экран от зелёных тестов не отличим.
test('обе раскладки берут режим из одного места, а не считают его порознь', () => {
  const source = pageFunctions('render()');
  assert.ok(source.includes('shownModeAndQuery()'),
    'render() обязан спрашивать режим у shownModeAndQuery');
  assert.ok(!source.includes('parseQuery'),
    'render() снова разбирает строку поиска сам — раскладки разойдутся');
  // Секции обе раскладки берут у одной sectionsFor: ни своего разбора строки,
  // ни своей развилки по трекеру, ни второй сборки.
  assert.ok(source.includes('sectionsFor(mode, query)'), source);
});

// ── Куда Enter уводит строку снимка ──────────────────────────────────────────
//
// Единственное место, которое различает три исхода — поднять всю раскладку,
// поднять из неё одну сессию, показать уже открытое окно, — и единственное,
// которое обязано взять с сессионной строки `snapshotId`, а не `id`: у неё
// есть оба. Ошибка здесь не краснеет нигде: пикер опубликует тело правильной
// формы с несуществующим id, приёмник запишет «нет такого снимка» себе в лог и
// вернёт пустой ответ, а пикер к тому времени погашен и ответа не ждёт.
// Поэтому строки берутся настоящие — из renderSnapshots выше, — а сам choose
// вычитывается из страницы и выполняется в vm.
function chooseWith(rows, active) {
  const source = SESSIONS_HTML.match(/\n {2}function choose\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(source, 'choose не найден в sessions.html — тест сторожит не то');
  const calls = [];
  const ctx = {
    rows,
    active,
    // Заголовок секции не открывает ничего, а переключает свёрнутость: ключ
    // секции меняется в своей половинке `collapsed`, состояние уходит в файл,
    // а список рисуется заново.
    fullscreen: false,
    collapsed: { narrow: { past: true }, wide: {} },
    layoutName: () => 'narrow',
    saveUi: () => calls.push(['saveUi']),
    render: () => calls.push(['render']),
    // Array.from — не украшение: массив, собранный внутри vm, приходит с
    // прототипом другого realm, и deepStrictEqual сравнивает в том числе его.
    restoreSnapshot: (id, sessionIds) => calls.push(['restoreSnapshot', id, Array.from(sessionIds)]),
    focusSession: row => calls.push(['focusSession', row.id]),
    newSession: cwd => calls.push(['newSession', cwd]),
    openSession: row => calls.push(['openSession', row.id]),
  };
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nchoose();`, ctx, { filename: 'sessions.html' });
  // JSON-круг — не украшение: объект пересобран внутри vm, у него другой
  // Object, и deepStrictEqual сравнивает ещё и прототип.
  return { calls, collapsed: JSON.parse(JSON.stringify(ctx.collapsed)) };
}

test('Enter на строке снимка уходит по трём разным веткам', () => {
  // Настоящие строки: заголовок, открытая сессия (aaa), закрытая (bbb).
  const { rows } = renderSnapshotRows(AGGREGATOR_SNAPSHOTS, '', { open: ['aaa'] });
  assert.deepStrictEqual(rows.map(r => r.kind),
    ['snapshot', 'snapshot-session', 'snapshot-session']);

  // Заголовок — вся раскладка. Пустой список сессий здесь значит «все», и
  // непустой на его месте поднял бы часть вместо целого.
  assert.deepStrictEqual(chooseWith(rows, 0).calls, [['restoreSnapshot', 'snap-1', []]]);

  // Открытая сессия — окно уже есть, Enter показывает его, а не заводит второе.
  assert.deepStrictEqual(chooseWith(rows, 1).calls, [['focusSession', 'aaa']]);

  // Закрытая — просьба на один id, и адресована она снимку. `snapshotId` и
  // `id` здесь заведомо разные: подстановка одного вместо другого роняет
  // именно это сравнение.
  assert.strictEqual(rows[2].id, 'bbb');
  assert.strictEqual(rows[2].snapshotId, 'snap-1');
  assert.deepStrictEqual(chooseWith(rows, 2).calls, [['restoreSnapshot', 'snap-1', ['bbb']]]);
});

// Заголовок секции приходит из buildSections и сессией не является вовсе: у
// него нет ни id, ни cwd. Не разбери его choose первым, он ушёл бы в
// openSession — в просьбу открыть сессию с `id: undefined`, а это молчаливый
// отказ на той стороне: ответа у публикации нет.
test('Enter на заголовке секции переключает её, а не открывает сессию', () => {
  const { calls, collapsed } = chooseWith(
    [{ kind: 'section', sectionKey: 'past', collapsed: true }], 0);
  assert.deepStrictEqual(calls, [['saveUi'], ['render']]);
  // Свёрнутая развернулась, и это запомнилось в своей половинке.
  assert.deepStrictEqual(collapsed, { narrow: { past: false }, wide: {} });

  // И обратно: одна и та же строка сворачивает и разворачивает — прежняя
  // строка-переключатель умела только разворачивать.
  const back = chooseWith([{ kind: 'section', sectionKey: 'past', collapsed: false }], 0);
  assert.deepStrictEqual(back.collapsed, { narrow: { past: true }, wide: {} });

  // Чужая половинка не трогается: умолчания у раскладок разные, и свёрнутая в
  // узком списке история не должна опустошать колонку в широком.
  const other = chooseWith([{ kind: 'section', sectionKey: 'projects', collapsed: true }], 0);
  assert.deepStrictEqual(other.collapsed.wide, {});
});

// ── saveUi сохраняет достоверный uiToggles, а не плоскую toggles (C1, round 1 fix) ──
//
// Ревью нашло: если saveUi() отправляет в save_ui плоскую карту вместо
// двухосного uiToggles, ось statusline у любого ключа схлопывается в
// умолчание при первом же сохранении — не только по клику своего чекбокса,
// но и по смене сортировки. Тест вычитывает настоящий saveUi из страницы (тем
// же приёмом, что renderProjects и choose выше) и проверяет, что сохранённый
// объект правда двухосный и ось statusline из uiToggles никуда не делась.
function saveUiWith(uiToggles, fullscreen) {
  const source = SESSIONS_HTML.match(/\n {2}function saveUi\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(source, 'saveUi не найден в sessions.html — тест сторожит не то');
  const calls = [];
  const ctx = {
    window: { UiState: require('../frontend-src/ui-state') },
    invoke: (cmd, args) => { calls.push(args); return Promise.resolve(); },
    error: null,
    render: () => {},
    sortMode: 'name',
    uiToggles,
    // Режим окна — третий аргумент uiStateToSave: не передай его saveUi, и
    // широкий режим забывался бы при первом же сохранении вида списка.
    fullscreen: Boolean(fullscreen),
    // Четвёртый — свёрнутые секции, по половинке на раскладку.
    collapsed: { narrow: {}, wide: {} },
    // Пятый — порядок секций, тоже по половинке на раскладку. Не передай его
    // saveUi, и назначенный перетаскиванием порядок стирался бы при первой же
    // смене сортировки — та же мина, что уже сработала на fullscreen и на
    // collapsed.
    order: { narrow: [], wide: [[], [], []] },
  };
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nsaveUi();`, ctx, { filename: 'sessions.html' });
  return calls;
}

test('saveUi пишет двухосный uiToggles, ось statusline не теряется', () => {
  const calls = saveUiWith({
    showPrompt: { list: true, statusline: true },
    showId: { list: false, statusline: false },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].ui, {
    sort: 'name',
    toggles: {
      showPrompt: { list: true, statusline: true },
      showId: { list: false, statusline: false },
    },
    // Узкое окно — это и есть умолчание режима.
    fullscreen: false,
    // Свёрнутых секций человек не трогал — обе половинки пусты.
    collapsed: { narrow: {}, wide: {} },
    // Порядка не назначал — тоже пусто, то есть «как по умолчанию».
    order: { narrow: [], wide: [[], [], []] },
  });
});

test('saveUi запоминает и режим окна, а не только вид списка', () => {
  // Третий аргумент uiStateToSave. Забудь его saveUi — и ^F помнился бы ровно
  // до первого сохранения вида списка (смена сортировки, любая галка), после
  // чего перезапуск открывал бы узкое окно, хотя человек его не просил.
  const calls = saveUiWith({ showPrompt: { list: true, statusline: true } }, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].ui.fullscreen, true);
});

// ── renderChecks рисует только галки с осью statusline (C2) ─────────────────
//
// До C2 статуслайн строился один раз при загрузке из TOGGLE_CHECKS целиком —
// ось statusline на разметку никак не влияла. Тест вычитывает настоящие
// TOGGLE_CHECKS и renderChecks из страницы (тем же приёмом, что saveUi выше) и
// проверяет, что в DOM попадают только вынесенные галки, а клик по
// нарисованному чекбоксу по-прежнему правит ось list в uiToggles.
//
// statusChecks — не настоящий DOM, а его минимальная имитация: innerHTML
// парсится регуляркой на data-toggle, querySelectorAll отдаёт получившиеся
// фейковые input'ы. Полноценный jsdom здесь избыточен — renderChecks
// пользуется только этими двумя методами элемента.
function fakeStatusChecks() {
  let html = '';
  let inputs = [];
  return {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      inputs = [...value.matchAll(/data-toggle="([^"]+)"/g)].map(([, key]) => ({
        dataset: { toggle: key },
        checked: false,
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
      }));
    },
    querySelectorAll() { return inputs; },
  };
}

function renderChecksWith(uiToggles) {
  const checksSource = SESSIONS_HTML.match(/\n {2}const TOGGLE_CHECKS = \[[\s\S]*?\n {2}\];\n/);
  assert.ok(checksSource, 'TOGGLE_CHECKS не найден в sessions.html — тест сторожит не то');
  // FILTER_KEYS считается из TOGGLE_CHECKS и стоит следом за ним; без него
  // обработчик галки не знает, какая из них отбирает строки.
  const filterKeysSource = SESSIONS_HTML.match(/\n {2}const FILTER_KEYS = new Set\(.*\);\n/);
  assert.ok(filterKeysSource, 'FILTER_KEYS не найден в sessions.html — тест сторожит не то');
  const renderSource = SESSIONS_HTML.match(
    /\n {2}const toggleInputs = new Map\(\);\n\n {2}function renderChecks\(\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(renderSource, 'renderChecks не найден в sessions.html — тест сторожит не то');
  const calls = { render: 0, regroup: 0, saveUi: 0 };
  const ctx = {
    window: { UiState: require('../frontend-src/ui-state') },
    escapeHtml: Glyph.escapeHtml,
    statusChecks: fakeStatusChecks(),
    uiToggles,
    toggles: {},
    render: () => { calls.render += 1; },
    regroup: () => { calls.regroup += 1; },
    saveUi: () => { calls.saveUi += 1; },
  };
  vm.createContext(ctx);
  // `toggleInputs` объявлен внутри вычитанного исходника через const — такие
  // объявления не становятся свойствами контекста (в отличие от var), и без
  // явного экспорта ctx.toggleInputs остался бы undefined.
  vm.runInContext(
    `${checksSource[0]}${filterKeysSource[0]}\n${renderSource[0]}\nrenderChecks();`
    + `\nvar toggleInputsExport = toggleInputs;`,
    ctx, { filename: 'sessions.html' },
  );
  return { statusChecks: ctx.statusChecks, toggleInputs: ctx.toggleInputsExport, ctx, calls };
}

test('ни одна галка не вынесена — статуслайн пуст', () => {
  const { statusChecks, toggleInputs } = renderChecksWith({
    showPrompt: { list: true, statusline: false },
    showId: { list: false, statusline: false },
  });
  assert.strictEqual(statusChecks.innerHTML, '');
  assert.strictEqual(toggleInputs.size, 0);
});

test('все галки вынесены — статуслайн рисует все', () => {
  const { toggleInputs } = renderChecksWith({
    showPrompt: { list: true, statusline: true },
    showAnswer: { list: true, statusline: true },
    showPaths: { list: true, statusline: true },
    showHotkey: { list: true, statusline: true },
    showEvent: { list: false, statusline: true },
    showId: { list: false, statusline: true },
    showCost: { list: false, statusline: true },
    showContext: { list: true, statusline: true },
    showWindow: { list: true, statusline: true },
    onlyWindow: { list: false, statusline: true },
  });
  assert.strictEqual(toggleInputs.size, 10);
});

test('вынесена часть — статуслайн рисует ровно её, в порядке TOGGLE_CHECKS', () => {
  const { statusChecks, toggleInputs } = renderChecksWith({
    showPrompt: { list: true, statusline: true },
    showAnswer: { list: true, statusline: false },
    showId: { list: false, statusline: true },
    showCost: { list: false, statusline: false },
  });
  assert.deepStrictEqual([...toggleInputs.keys()], ['showPrompt', 'showId']);
  // Отбивка между группами (left → right) стоит на первом чекбоксе новой
  // группы — showId идёт вторым и сразу после showPrompt (left), сам group 'right'.
  assert.ok(statusChecks.innerHTML.includes('class="status-check gap"'), statusChecks.innerHTML);
});

test('клик по нарисованному чекбоксу правит ось list, не трогая statusline', () => {
  const uiToggles = {
    showPrompt: { list: true, statusline: true },
    showId: { list: false, statusline: true },
  };
  const { toggleInputs, ctx, calls } = renderChecksWith(uiToggles);
  const input = toggleInputs.get('showId');
  input.checked = true;
  input.listeners.change();
  // Не deepStrictEqual: объект собран внутри vm своим `{...spread}`, и его
  // прототип — из другого реалма (см. комментарий в frontend-load.test.js про
  // ту же ловушку). Сверяются только значения полей.
  assert.strictEqual(uiToggles.showId.list, true);
  assert.strictEqual(uiToggles.showId.statusline, true);
  // toggles — производная, её тоже обязаны пересчитать тем же тиком, иначе
  // отрисовка строк ещё один кадр рисовала бы колонку по старому значению.
  assert.strictEqual(ctx.toggles.showId, true);
  assert.strictEqual(calls.render, 1);
  assert.strictEqual(calls.saveUi, 1);
  // Колонка — это отрисовка, состав списка от неё не зависит: пересчитывать
  // группы незачем.
  assert.strictEqual(calls.regroup, 0);
});

test('клик по галке-фильтру пересчитывает состав списка, а не только рисунок', () => {
  // Фильтр отбирает строки, а отбор живёт в regroup. С одним только render
  // галка сработала бы к следующему ответу агрегатора — а на скрытом окне тот
  // приходит через минуты, и неизменившееся состояние отсекается по отпечатку.
  const uiToggles = {
    showPrompt: { list: true, statusline: true },
    showAll: { list: false, statusline: true },
  };
  const { toggleInputs, calls } = renderChecksWith(uiToggles);
  const input = toggleInputs.get('showAll');
  input.checked = true;
  input.listeners.change();
  assert.strictEqual(uiToggles.showAll.list, true);
  assert.strictEqual(calls.regroup, 1);
  // render зовёт сам regroup — второй раз отсюда он рисовал бы список дважды.
  assert.strictEqual(calls.render, 0);
  assert.strictEqual(calls.saveUi, 1);
});

// ── Таблицы галок в пикере и в настройках не расходятся (C-final) ───────────
//
// Ключи живут в двух окнах: TOGGLE_CHECKS в sessions.html и TOGGLE_LABELS +
// FILTER_LABELS в settings.html. Один список из другого не построить — это
// разные страницы, общего состояния у них нет, — а расхождение молчаливое и
// одностороннее: `normalizeUiState(load_ui(), UI_DEFAULTS)` в окне настроек
// оставляет только свои ключи, так что колонка, добавленная в пикер и забытая
// в настройках, теряла бы своё значение при каждом сохранении вкладки UI.
// Отсюда и сторож: сравниваются наборы, а не порядок — порядок у страниц свой
// (в статуслайне галки идут группами left/right/filter, в таблице настроек
// колонки отделены от фильтров).
const SETTINGS_HTML = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

function keysFromSettings() {
  const labels = SETTINGS_HTML.match(/\n {2}const TOGGLE_LABELS = \{[\s\S]*?\n {2}\};\n/);
  assert.ok(labels, 'TOGGLE_LABELS не найден в settings.html — тест сторожит не то');
  const filters = SETTINGS_HTML.match(/\n {2}const FILTER_LABELS = \{[^}]*\};\n/);
  assert.ok(filters, 'FILTER_LABELS не найден в settings.html — тест сторожит не то');
  const defaults = SETTINGS_HTML.match(/\n {2}const UI_DEFAULTS = \{[\s\S]*?\n {2}\};\n/);
  assert.ok(defaults, 'UI_DEFAULTS не найден в settings.html — тест сторожит не то');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `${labels[0]}\n${filters[0]}\n${defaults[0]}\nvar toggles = Object.keys(TOGGLE_LABELS);`
    + `\nvar filterKeys = Object.keys(FILTER_LABELS);`
    + `\nvar defaultKeys = Object.keys(UI_DEFAULTS.toggles);`,
    ctx, { filename: 'settings.html' },
  );
  return {
    toggles: Array.from(ctx.toggles),
    filters: Array.from(ctx.filterKeys),
    defaults: Array.from(ctx.defaultKeys),
  };
}

function checksFromPicker() {
  const source = SESSIONS_HTML.match(/\n {2}const TOGGLE_CHECKS = \[[\s\S]*?\n {2}\];\n/);
  assert.ok(source, 'TOGGLE_CHECKS не найден в sessions.html — тест сторожит не то');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nvar out = TOGGLE_CHECKS.map(c => ({ key: c.key, side: c.side }));`,
    ctx, { filename: 'sessions.html' });
  return Array.from(ctx.out).map(c => ({ key: c.key, side: c.side }));
}

test('окно настроек знает все галки пикера и ни одной лишней', () => {
  const checks = checksFromPicker();
  const settings = keysFromSettings();
  assert.deepStrictEqual(
    [...settings.toggles, ...settings.filters].sort(),
    checks.map(c => c.key).sort(),
  );
  // И третий список той же страницы — умолчания: по ним нормализуется
  // прочитанное, а таблица галок читает `ui.toggles[key].statusline` без
  // предохранителя. Подпись без умолчания уронила бы отрисовку вкладки UI.
  assert.deepStrictEqual(
    settings.defaults.sort(),
    [...settings.toggles, ...settings.filters].sort(),
  );
});

test('фильтры и колонки разделены в обоих окнах одинаково', () => {
  // Фильтр решает, какие строки попадут в список, а не какие колонки видны:
  // попав в таблицу колонок настроек, он обещал бы человеку не то, что делает.
  const checks = checksFromPicker();
  const settings = keysFromSettings();
  assert.deepStrictEqual(
    settings.filters.sort(),
    checks.filter(c => c.side === 'filter').map(c => c.key).sort(),
  );
});

// ── showAll перекрывает onlyLive из конфига ────────────────────────────────
//
// Галка и настройка отвечают на один вопрос, и связь между ними живёт ровно в
// одной строке `regroup()`. Строка эта незаметная: перепутанный знак не роняет
// ничего — список просто всегда фильтруется (или всегда не фильтруется), а
// заметить это можно только сравнив с содержимым config.yaml. Поэтому здесь
// вычитывается настоящий regroup, тем же приёмом, что renderChecks выше, и
// проверяется, что уезжает в buildSessionsPayload при всех четырёх сочетаниях.
function regroupWith(configOnlyLive, toggles) {
  const source = SESSIONS_HTML.match(/\n {2}function regroup\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(source, 'regroup не найден в sessions.html — тест сторожит не то');
  let opts = null;
  const ctx = {
    window: {
      SessionGroups: {
        buildSessionsPayload: (_state, sort, o) => { opts = o; return { groups: [], sort }; },
      },
    },
    CONFIG: { onlyLive: configOnlyLive, windowHost: 'win-host' },
    toggles,
    lastSessions: [],
    lastState: {},
    seen: {},
    sortMode: 'recent',
    groups: [],
    paintSort: () => {},
    paintToggles: () => {},
    render: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nregroup();`, ctx, { filename: 'sessions.html' });
  assert.ok(opts, 'buildSessionsPayload не позван');
  return opts;
}

test('showAll снимает onlyLive, заданный конфигом', () => {
  assert.strictEqual(regroupWith(true, { showAll: true }).onlyLive, false);
});

test('без showAll решает конфиг', () => {
  assert.strictEqual(regroupWith(true, { showAll: false }).onlyLive, true);
  assert.strictEqual(regroupWith(false, { showAll: false }).onlyLive, false);
});

test('showAll при выключенном onlyLive ничего не ломает', () => {
  // Галка — отступление от настройки, а не второй фильтр: включённая поверх
  // уже выключенного onlyLive она обязана остаться без последствий.
  assert.strictEqual(regroupWith(false, { showAll: true }).onlyLive, false);
});

test('onlyWindow едет мимо showAll', () => {
  // Два фильтра независимы: showAll про живость, onlyWindow про окна. Один
  // общий `&&` на оба схлопнул бы их в один, и «показать все» заодно
  // отключало бы фильтр по окнам.
  const opts = regroupWith(true, { showAll: true, onlyWindow: true });
  assert.strictEqual(opts.onlyWindow, true);
});

// ── Выбор виден поверх наведения ───────────────────────────────────────────
//
// `.row:hover` и `.row.active` красят один и тот же фон, и специфичность у них
// равная: класс с псевдоклассом против двух классов. Спор решает порядок в
// таблице стилей — и только он. Переставленные местами, они гасили бы выбор
// под курсором мыши: строка, которую откроет Enter, переставала бы отличаться
// от соседних ровно тогда, когда человек ведёт по ней мышью. Ни один тест
// разметки этого не увидит — классы на строке те же самые, разница только в
// том, какой из двух фонов победил.
test('подсветка наведения объявлена до подсветки выбора', () => {
  const hover = SESSIONS_HTML.indexOf('.row:hover {');
  const active = SESSIONS_HTML.indexOf('.row.active {');
  assert.notStrictEqual(hover, -1, '.row:hover пропал из sessions.html — тест сторожит не то');
  assert.notStrictEqual(active, -1, '.row.active пропал из sessions.html — тест сторожит не то');
  assert.ok(hover < active, 'при равной специфичности порядок решает всё: выбор должен быть ниже');
});

// Меню `^K` лежит поверх того же списка — свои два фона выдали бы его за
// другое окно. Поэтому сверяются не только порядок правил, но и цвета:
// разойдясь, они разойдутся молча, пикер на такое не падает.
test('строка меню красится тем же, чем строка списка', () => {
  const menuHover = SESSIONS_HTML.match(/\.action-row:hover \{ background: (#[0-9a-f]{6}); \}/);
  const menuActive = SESSIONS_HTML.match(/\.action-row\.active \{ background: (#[0-9a-f]{6}); \}/);
  const rowHover = SESSIONS_HTML.match(/\.row:hover \{ background: (#[0-9a-f]{6}); \}/);
  const rowActive = SESSIONS_HTML.match(/\.row\.active \{ background: (#[0-9a-f]{6}); \}/);
  assert.ok(menuHover, '.action-row:hover пропал — у меню снова нет подсветки под мышью');
  assert.ok(menuActive && rowHover && rowActive, 'правила фона переписаны — тест сторожит не то');
  assert.strictEqual(menuHover[1], rowHover[1], 'наведение в меню и в списке — один цвет');
  assert.strictEqual(menuActive[1], rowActive[1], 'выбор в меню и в списке — один цвет');
  assert.ok(
    menuHover.index < menuActive.index,
    'выбор должен стоять ниже наведения: специфичность равная, решает порядок',
  );
});

// Слот значка обязан быть у каждой строки меню, включая глифовые: строка без
// слота съезжает влево, и подписи в меню перестают стоять в одну линию.
test('строка меню начинается со слота значка', () => {
  const row = SESSIONS_HTML.match(/<div class="action-row\$\{[\s\S]*?<\/div>`/);
  assert.ok(row, 'шаблон строки меню не найден — тест сторожит не то');
  const icon = row[0].indexOf('${iconHtml}');
  const label = row[0].indexOf('<span class="action-label"');
  assert.notStrictEqual(icon, -1, 'у строки меню нет слота значка');
  assert.ok(icon < label, 'слот значка идёт перед подписью');
});

// Выбор «картинка или глиф» принадлежит модулю: собранный по месту, он
// разошёлся бы с таблицей глифов молча.
test('слот значка собирается через ActionIcons', () => {
  assert.match(
    SESSIONS_HTML,
    /window\.ActionIcons\.actionIcon\(action, actionIcons\)/,
    'значок должен выбирать модуль, а не разметка по месту',
  );
  assert.match(SESSIONS_HTML, /class="action-icon/, 'слот рисуется классом action-icon');
});

test('стиль слота задаёт одну ширину всем строкам меню', () => {
  assert.match(
    SESSIONS_HTML,
    /\.action-icon \{[^}]*flex: 0 0 16px/,
    'без фиксированной ширины подписи разъедутся на строке без иконки',
  );
});

// Иконки спрашиваются один раз при старте и ещё раз на config-changed — не
// при первом ^K: меню обязано открываться уже с картинками, а не дорисовывать
// их на глазах. Поймать это тестом поведения нельзя (страница целиком тут не
// живёт), поэтому сторожится форма: вызов есть в обоих местах.
//
// Сравнивать позиции вызовов с одним индексом `listen('config-changed'` уже
// нельзя: вызов внутри start() нарочно стоит после регистрации всех
// подписок, включая config-changed (см. комментарий у вызова в
// sessions.html) — раньше список ждал бы поход за иконками, которые нужны
// только к первому ^K. Поэтому здесь вырезается сам блок слушателя
// config-changed, и вызовы ищутся отдельно внутри него и отдельно снаружи —
// в любом месте start(), а не в жёстко заданной позиции.
test('иконки спрашиваются при старте и после смены конфига', () => {
  const startMatch = SESSIONS_HTML.match(/\n {2}async function start\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(startMatch, 'тест сторожит не то');
  const startBody = startMatch[0];
  const configChangedMatch = startBody.match(
    /await listen\('config-changed', async \(\) => \{[\s\S]*?\n {4}\}\);\n/,
  );
  assert.ok(configChangedMatch, 'тест сторожит не то');
  const blockStart = configChangedMatch.index;
  const blockEnd = blockStart + configChangedMatch[0].length;
  const calls = [...startBody.matchAll(/await loadActionIcons\(\)/g)].map(m => m.index);
  const outsideCalls = calls.filter(i => i < blockStart || i >= blockEnd);
  assert.ok(outsideCalls.length > 0, 'иконки не запрашиваются при старте');
  assert.ok(
    calls.some(i => i >= blockStart && i < blockEnd),
    'после смены конфига иконки остались бы от прежних приложений',
  );

  // Порядок внутри start() — не только наличие: вызов вне config-changed
  // обязан стоять после первого опроса и после ветки гонки первого показа, а
  // не перед ними (правки этого файла и 31ddb46 — ровно про эту перестановку,
  // и откат любой из них здесь должен покраснеть).
  const outsideCall = Math.max(...outsideCalls);
  const pollNowIndex = startBody.indexOf("applyState(await invoke('poll_now'))");
  assert.notStrictEqual(pollNowIndex, -1, 'тест сторожит не то');
  assert.ok(
    pollNowIndex < outsideCall,
    'список сессий не должен ждать иконок',
  );
  const alreadyVisibleIndex = startBody.indexOf('getCurrentWindow().isVisible()');
  assert.notStrictEqual(alreadyVisibleIndex, -1, 'тест сторожит не то');
  assert.ok(
    alreadyVisibleIndex < outsideCall,
    'поле поиска при гонке первого показа тоже не должно ждать иконок',
  );
});

// ── Правая кнопка открывает то же меню, что и `^K` ─────────────────────────
//
// Обработчик вычитывается из страницы и выполняется в vm — как choose выше.
// Проверять его иначе некому: в браузере тестов нет, а сломать здесь можно
// молча. Забытый preventDefault не гасит меню WebView2 — оно встаёт поверх
// нашего; забытый paint оставляет подсветку на прежней строке, и меню
// открывается для сессии, по которой не щёлкали.
function contextMenuOn(target, menuOpen) {
  const source = SESSIONS_HTML.match(
    /\n {2}list\.addEventListener\('contextmenu',[\s\S]*?\n {2}\}\);\n/,
  );
  assert.ok(source, 'обработчик contextmenu не найден в sessions.html — тест сторожит не то');
  const calls = [];
  const ctx = {
    menuOpen,
    active: 0,
    paint: () => calls.push('paint'),
    openMenu: () => calls.push('openMenu'),
    list: { addEventListener: (name, fn) => { ctx.handler = fn; } },
  };
  vm.createContext(ctx);
  vm.runInContext(source[0], ctx, { filename: 'sessions.html' });
  ctx.handler({
    preventDefault: () => calls.push('preventDefault'),
    target: { closest: sel => (sel === '.row' ? target : null) },
  });
  return { calls, active: ctx.active };
}

test('правый клик по строке переносит выбор и открывает меню', () => {
  const { calls, active } = contextMenuOn({ dataset: { index: '3' } }, false);
  assert.strictEqual(active, 3, 'меню читает rows[active] — выбор обязан переехать на строку под курсором');
  assert.deepStrictEqual(calls, ['preventDefault', 'paint', 'openMenu']);
});

test('правый клик мимо строки гасит только родное меню', () => {
  const { calls } = contextMenuOn(null, false);
  assert.deepStrictEqual(calls, ['preventDefault']);
});

test('при открытом меню правый клик ничего не открывает заново', () => {
  const { calls } = contextMenuOn({ dataset: { index: '3' } }, true);
  assert.deepStrictEqual(calls, ['preventDefault']);
});

/**
 * Пропустить строки общего списка настоящим путём: buildSessionsPayload →
 * filterSessions → renderSessions.
 *
 * Сестра renderProjectRows и renderSnapshotRows: те гоняют свои режимы, а
 * этот — общий список сессий. Понадобился он ради строк, которые сессиями не
 * являются: у зелийной нет ни pid, ни записи агента, ни каталога, и молчаливо
 * опустевшая колонка видна только здесь, где строку рисуют настоящей
 * renderSessions из sessions.html, а не вызовом отрисовщика по одному.
 */
function renderSessionRows(state, query, toggles) {
  // markToggleId вычитывается из той же страницы, а не подставляется заглушкой:
  // от неё зависит класс `markable`, то есть обещание про Shift+клик, и копия
  // разошлась бы с настоящим правилом молча.
  const source = pageFunctions(
    'markToggleId(row)', 'sessionItem(session, nowSec)', 'subheadItem(row)',
    'sectionItem(section)', 'itemsOfSection(section, nowSec)');
  const ctx = {
    // Ровно то, чем itemsOfSection пользуется снаружи себя.
    window: {
      SessionActions: { availableActions },
      PickerSections,
    },
    groups: buildSessionsPayload(state, 'recent').groups,
    rows: [],
    items: [],
    toggles: toggles || { showPaths: true },
    escapeHtml: Glyph.escapeHtml,
    shortPath: Glyph.shortPath,
    titleAttr: Glyph.titleAttr,
    statusDotHtml: Glyph.statusDotHtml,
    prBadgeHtml: Glyph.prBadgeHtml,
    windowHtml: Glyph.windowHtml,
    windowHostHtml: Glyph.windowHostHtml,
    stateHtml: Glyph.stateHtml,
    sessionIdHtml: Glyph.sessionIdHtml,
    hotkeyHtml: Glyph.hotkeyHtml,
    usageHtml: Glyph.usageHtml,
    ageHtml: Glyph.ageHtml,
    query: query || '',
    nowSec: NOW,
  };
  vm.createContext(ctx);
  const items = vm.runInContext(`${source}
    window.PickerSections.buildSections({ groups, mode: 'sessions', query, layout: 'narrow' })
      .flatMap(function (section) { return itemsOfSection(section, nowSec); });`,
  ctx, { filename: 'sessions.html' });
  return { items: Array.from(items), rows: ctx.rows };
}

// Shift+клик один, а отметки две. Развилку решает markToggleId, и она же
// решает, зажечь ли строке класс `markable` — то есть пообещать подсказкой то,
// что клик и сделает.
test('Shift выбирает отметку по состоянию строки', () => {
  const src = SESSIONS_HTML.match(/\n {2}function markToggleId\(row\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(src, 'markToggleId не найден в sessions.html — тест сторожит не то');
  const ctx = { window: { SessionActions: { availableActions } } };
  vm.createContext(ctx);
  vm.runInContext(`${src[0]}\nvar pick = markToggleId;`, ctx, { filename: 'sessions.html' });

  assert.strictEqual(ctx.pick({ id: 'a', lastActivity: 5, agentSeen: true }), 'unread');
  assert.strictEqual(ctx.pick({ id: 'a', lastActivity: 5, agentSeen: false }), 'seen');
  // Сессия без записи агента: отматывать нечего и отмечать нечего, а промах по
  // Shift не должен превращаться в открытие сессии.
  assert.strictEqual(ctx.pick({ id: 'a', lastActivity: 0, agentSeen: false }), null);
});

test('строка зелийной сессии доезжает до отрисовки и не пустует', () => {
  // Строки проектов живут в своём режиме, а эта идёт в общий список сессий —
  // дорогой, которой строка-не-сессия ещё не ходила. Здесь и видно, если
  // отрисовщик спросит поле, которого у неё нет.
  const state = { ok: true, sessions: [], zellij: [{ name: 'home', created: 1785591360, agents: 0 }] };
  const payload = buildSessionsPayload(state, 'recent');
  const group = payload.groups.find(g => g.label === 'Zellij');
  assert.ok(group, payload.groups.map(g => g.label));

  const { items } = renderSessionRows(state);
  const html = items.map(i => i.html).join('\n');
  assert.ok(html.includes('Zellij'), html);
  assert.ok(html.includes('home'), html);
  assert.ok(!html.includes('undefined'), html);
  // Ключ строки — с префиксом: он же уходит в picker-list-sync, и столкнись
  // он с uuid сессии, список перерисовывался бы целиком.
  assert.ok(items.some(i => i.key === 's:zellij:home'), items.map(i => i.key));
});

// Маркер вида строки — самый хрупкий инвариант широкого режима: карточка в
// `#list.blocks` бьёт по `.row.session`, и держится это на одном слове в
// шаблоне sessionItem. Потеряй он `session` — карточки молча исчезнут; потеряй
// `zellij` — зелийная псевдосессия молча станет карточкой, то есть вернётся
// уже чинённый дефект. Ни то, ни другое не видно ни в одном другом assert:
// ключи, колонки и подписи от подмены класса не меняются вовсе.
test('вид строки назван классом: сессия — session, зелийная — zellij', () => {
  const { items } = renderSessionRows({ ok: true, sessions: [aggregatorSession()] });
  assert.ok(items.length, 'сессия не доехала до отрисовки');
  // Ищется по ключу строки, а не по `class="row `: заголовок секции — теперь
  // тоже строка списка, и он стоит первым.
  const session = items.find(i => i.key.startsWith('s:'));
  assert.ok(/class="row session(?:[ "])/.test(session.html), session.html);

  const { items: zellij } = renderSessionRows(
    { ok: true, sessions: [], zellij: [{ name: 'home', created: 1785591360, agents: 0 }] });
  const row = zellij.find(i => i.key.startsWith('s:'));
  assert.ok(/class="row zellij(?:[ "])/.test(row.html), row.html);
  // И не «session» заодно: строка с двумя классами сразу поймалась бы обеими
  // проверками, а карточкой всё равно стала бы.
  assert.ok(!row.html.includes('row session'), row.html);
});

test('renderWide: номер строки в разметке совпадает с её местом в rows', () => {
  // По индексу строки ходит клик, по номеру секции — `←/→`. Подзаголовок
  // машины при этом элемент без строки, и арифметика «строк ровно столько же,
  // сколько элементов» на нём врёт — ради этого случая тест и написан.
  const SECTIONS = [
    {
      key: 'live', label: 'Active local sessions', kind: 'sessions',
      count: 1, lastAt: 0, collapsed: false, foldable: true, column: 1,
      rows: [{ id: 'a' }],
    },
    {
      key: 'remote', label: 'Active remote sessions', kind: 'sessions',
      count: 2, lastAt: 0, collapsed: false, foldable: true, column: 2,
      rows: [
        { kind: 'block-subhead', key: 'sub:alpha-host', label: 'alpha-host - 2' },
        { id: 'x' }, { id: 'y' },
      ],
    },
  ];

  const rows = [];
  // Заглушка строки: делает ровно то, что делают настоящие sessionItem и
  // соседи, — кладёт строку в rows и подписывает разметку её номером.
  const stubItem = (row) => {
    const index = rows.length;
    rows.push(row);
    return { key: `k:${index}`, html: `<div class="row" data-index="${index}"></div>` };
  };

  const ctx = vm.createContext({
    rows,
    escapeHtml: (s) => String(s),
    window: {
      PickerSections,
      // Отдаёт элементы как есть: что попало в план, то и нарисовано.
      PickerListSync: {
        planListSync: (_prev, items) => ({
          mode: 'rebuild', keys: items.map(i => i.key), html: items.map(i => i.html),
        }),
      },
    },
    // Каркас считается уже собранным: тогда renderWide не трогает `list`
    // вовсе, и двойник DOM нужен только на тела секций.
    // Тот же вид отпечатка, что и в renderWide: свёрнутость входит в него,
    // потому что от неё зависит класс блока.
    blocksShape: SECTIONS.map(s => `${s.key}|${s.column}|${s.collapsed ? 1 : 0}`).join('\n'),
    renderedBlocks: new Map(),
    blockBodies: new Map(SECTIONS.map(s => [s.key, { children: [] }])),
    applyPlan: () => {},
    sessionItem: stubItem,
    projectItem: stubItem,
    snapshotItem: stubItem,
    // Подзаголовок — подпись, а не строка: в rows он не попадает.
    subheadItem: (row) => ({ key: `sh:${row.key}`, html: '<div class="group-label"></div>' }),
    SECTIONS,
  });

  vm.runInContext(
    `${pageFunctions('sectionItem(section)', 'itemsOfSection(section, nowSec)', 'renderWide(sections, nowSec)')}
     renderWide(SECTIONS, 0);`,
    ctx, { filename: 'sessions.html' });

  // Две строки-заголовка и три сессии; подзаголовок машины строкой не стал.
  assert.deepStrictEqual(rows.map(r => r.kind || r.id), ['section', 'a', 'section', 'x', 'y']);
  // Номер секции стоит у каждой строки, включая заголовки.
  assert.deepStrictEqual(rows.map(r => r.block), [0, 0, 1, 1, 1]);
  // Заголовок знает свой ключ и своё состояние — по ним choose() переключает.
  assert.deepStrictEqual(
    rows.filter(r => r.kind === 'section').map(r => r.sectionKey),
    ['live', 'remote'],
  );
});

test('свёрнутая секция отдаёт один заголовок, но счёт в нём полный', () => {
  const rows = [];
  const ctx = vm.createContext({
    rows,
    escapeHtml: (s) => String(s),
    window: { PickerSections },
    sessionItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    projectItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    snapshotItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    subheadItem: () => { throw new Error('свёрнутая секция не должна рисовать строки'); },
    SECTION: {
      key: 'past', label: 'Not running', kind: 'sessions', count: 47,
      lastAt: 0, collapsed: true, foldable: true,
      rows: new Array(47).fill({ id: 'old' }),
    },
  });
  const items = vm.runInContext(
    `${pageFunctions('sectionItem(section)', 'itemsOfSection(section, nowSec)')}
     itemsOfSection(SECTION, 0);`,
    ctx, { filename: 'sessions.html' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(rows.length, 1);
  assert.ok(items[0].html.includes('Not running - 47'), items[0].html);
});

test('стрелки уходят в навигацию только на краю запроса и без выделения', () => {
  // Поле поиска сфокусировано всегда, и отнять у него стрелки насовсем значило
  // бы лишить человека правки запроса.
  const ctx = vm.createContext({});
  const check = (value, start, end, key) => {
    ctx.search = { value, selectionStart: start, selectionEnd: end };
    return vm.runInContext(
      `${pageFunctions('atQueryEdge(key)')}\natQueryEdge(${JSON.stringify(key)});`,
      ctx, { filename: 'sessions.html' });
  };
  assert.strictEqual(check('picker', 0, 0, 'ArrowLeft'), true);
  assert.strictEqual(check('picker', 6, 6, 'ArrowRight'), true);
  assert.strictEqual(check('picker', 3, 3, 'ArrowLeft'), false);
  assert.strictEqual(check('picker', 3, 3, 'ArrowRight'), false);
  // Есть выделение — стрелки остаются полю: ими его снимают.
  assert.strictEqual(check('picker', 0, 6, 'ArrowLeft'), false);
});

test('сброс выбора уводит его с заголовка секции, а наведённый — нет', () => {
  // Заголовок секции — обычная строка списка и всегда первая. Не снимай сброс
  // выбор с него, Enter сразу после открытия окна сворачивал бы верхнюю
  // секцию вместо того, чтобы открыть верхнюю сессию. А наведённый стрелками
  // выбор трогать нельзя: свернуть первую секцию с клавиатуры было бы нечем.
  const source = pageFunctions('render()');
  assert.ok(source.includes('selectionReset'),
    'render() обязан спрашивать про сброс выбора');
  assert.ok(source.includes("r.kind !== 'section'"),
    'сброс обязан искать первую строку, которая не заголовок');
  // Просят сброс ровно два места, и оба — начало нового отбора: новая строка
  // поиска и новый показ окна.
  for (const fn of ['onSearchInput()', 'beginShow()']) {
    assert.ok(pageFunctions(fn).includes('selectionReset = true;'), fn);
  }
});

test('меню не открывается на заголовке секции', () => {
  // Ни id, ни имени у него нет: меню вышло бы озаглавленным «undefined» и без
  // единого работающего пункта.
  const source = SESSIONS_HTML.match(/\n {2}function openMenu\(\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(source, 'openMenu не найден в sessions.html — тест сторожит не то');
  const calls = [];
  const ctx = {
    rows: [{ kind: 'section', sectionKey: 'live', collapsed: false }],
    active: 0,
    actionsFor: () => { throw new Error('меню на заголовке секции собираться не должно'); },
    renderMenu: () => calls.push(['renderMenu']),
  };
  vm.createContext(ctx);
  vm.runInContext(`${source[0]}\nopenMenu();`, ctx, { filename: 'sessions.html' });
  assert.deepStrictEqual(calls, []);
});

test('заголовок несворачиваемой секции — подпись, а не строка списка', () => {
  // Под запросом и под префиксом свернуть секцию нечем, и заголовок обязан
  // перестать быть строкой: иначе Enter на нём молчал бы, а стрелки ходили бы
  // через строку, по которой ничего не открывается.
  const rows = [];
  const ctx = vm.createContext({
    rows,
    escapeHtml: (s) => String(s),
    window: { PickerSections },
    SECTION: {
      key: 'past', label: 'Not running', kind: 'sessions', count: 3,
      lastAt: 0, collapsed: false, foldable: false, rows: [],
    },
  });
  const item = vm.runInContext(
    `${pageFunctions('sectionItem(section)')}\nsectionItem(SECTION);`,
    ctx, { filename: 'sessions.html' });
  assert.ok(item.html.includes('class="group-label"'), item.html);
  assert.ok(!item.html.includes('data-index'), item.html);
  assert.ok(!item.html.includes('▾'), item.html);
  // Главное: в rows он не попал, то есть ни стрелке, ни клику не виден.
  assert.strictEqual(rows.length, 0);
  // Счёт при этом на месте — подпись остаётся подписью секции.
  assert.ok(item.html.includes('Not running - 3'), item.html);
});
