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

const { buildSessionsPayload } = require('../frontend-src/session-groups');
const Groups = require('../frontend-src/session-groups');
const Glyph = require('../frontend-src/session-glyph');
const { buildSessionInfoRows } = require('../frontend-src/session-info');
const { filterSessions } = require('../frontend-src/picker-filter');

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
    '<div class="usage"></div>');
  assert.strictEqual(Glyph.ageHtml(row, NOW), '<div class="age"></div>');
  assert.strictEqual(Glyph.prBadgeHtml(row), '');
  assert.strictEqual(Glyph.rowTitle(row), '~/projects/expertizeme/cup-dashboard');
  for (const r of buildSessionInfoRows(row, NOW)) {
    assert.ok(!r.value.includes('undefined'), `${r.label}: ${r.value}`);
  }
});

test('единственное поле без источника не роняет отрисовку', () => {
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
const NO_SOURCE = new Set(['hotkey', 'desktop']);

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
  assert.strictEqual(payload.groups[0].label, 'Active sessions - 1');
});

test('ошибочный ответ агрегатора не доходит до сборки строк', () => {
  assert.deepStrictEqual(
    Groups.buildSessionsPayload({ ok: false, reason: 'ccfzf: not found' }, 'cost'),
    { ok: false, reason: 'ccfzf: not found' },
  );
});
