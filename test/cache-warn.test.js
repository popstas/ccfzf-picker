const test = require('node:test');
const assert = require('node:assert');
const { cacheWarnSets, createCacheWarnSender, blinkingIds } = require('../frontend-src/cache-warn');

// Строки — как их строит buildSessionList: окна сессии в `sessionWindows`.
const NB = { host: 'nb', mqttBase: 'home/nb/windows' };
const MAC = { host: 'mac', mqttBase: 'home/mac/windows' };
const STATE = { windowHosts: [{ host: 'nb', http: { host: 'nb.example', port: 9722 } }, { host: 'mac' }] };
const row = (id, over = {}) => ({
  id, agentState: 'review', agentCacheAt: 100, sessionWindows: [NB], ...over,
});
const only = sets => [...sets.values()];

test('в набор не идут работающие, сессии без cacheAt и без окна', () => {
  const sets = cacheWarnSets([
    row('a'),
    row('b', { agentState: 'active' }),
    row('c', { agentCacheAt: 0 }),
    row('d', { sessionWindows: [] }),
  ], STATE, 10);
  assert.deepStrictEqual(only(sets).map(s => s.body), [{ warnMin: 10, sessions: [{ id: 'a', cacheAt: 100 }] }]);
});

test('две карточки одной сессии — одна запись, сессии по id', () => {
  const sets = cacheWarnSets([row('b'), row('a'), row('a')], STATE, 10);
  assert.deepStrictEqual(only(sets)[0].body.sessions.map(s => s.id), ['a', 'b']);
});

test('сессия с окнами на двух машинах попадает в набор обеих', () => {
  const sets = cacheWarnSets([row('a', { sessionWindows: [NB, MAC] })], STATE, 10);
  assert.strictEqual(sets.size, 2);
  for (const s of sets.values()) assert.deepStrictEqual(s.body.sessions, [{ id: 'a', cacheAt: 100 }]);
});

test('warnMin 0 — пустая карта', () => {
  assert.strictEqual(cacheWarnSets([row('a')], STATE, 0).size, 0);
});

function sender(over = {}) {
  const sent = [];
  const clock = { now: 0 };
  const s = createCacheWarnSender({
    send: (target, body) => { sent.push({ target, body }); return over.fail ? Promise.reject(new Error('down')) : Promise.resolve(); },
    onError: over.onError || (() => {}),
    nowMs: () => clock.now,
  });
  return { s, sent, clock };
}

test('тот же набор второй раз не уходит, через 5 минут уходит повтором', async () => {
  const { s, sent, clock } = sender();
  const sets = cacheWarnSets([row('a')], STATE, 10);
  await s.update(sets);
  await s.update(cacheWarnSets([row('a')], STATE, 10));
  assert.strictEqual(sent.length, 1);
  clock.now = 5 * 60 * 1000;
  await s.update(sets);
  assert.strictEqual(sent.length, 2);
});

test('изменившийся набор уходит сразу', async () => {
  const { s, sent } = sender();
  await s.update(cacheWarnSets([row('a')], STATE, 10));
  await s.update(cacheWarnSets([row('a', { agentCacheAt: 200 })], STATE, 10));
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1].body.sessions, [{ id: 'a', cacheAt: 200 }]);
});

test('пропавшая цель получает пустой список один раз', async () => {
  const { s, sent } = sender();
  await s.update(cacheWarnSets([row('a')], STATE, 10));
  await s.update(new Map());
  await s.update(new Map());
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1].body.sessions, []);
  assert.deepStrictEqual(sent[1].target, sent[0].target);
});

test('warnMin 0 отправляет пустой список целям, которым слали раньше', async () => {
  const { s, sent } = sender();
  await s.update(cacheWarnSets([row('a')], STATE, 10));
  await s.update(cacheWarnSets([row('a')], STATE, 0));
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent[1].body.sessions, []);
});

test('отказ send — повтор не раньше чем через минуту, ошибка уходит в onError', async () => {
  // Трекер со старым менеджером отвечает 404 — слать ему на каждом опросе
  // (раз в секунду) значило бы мигать ошибкой в статуслайне без конца.
  const errors = [];
  const { s, sent, clock } = sender({ fail: true, onError: e => errors.push(e.message) });
  const sets = cacheWarnSets([row('a')], STATE, 10);
  await s.update(sets);
  clock.now = 59 * 1000;
  await s.update(sets);
  assert.strictEqual(sent.length, 1);
  clock.now = 60 * 1000;
  await s.update(sets);
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(errors, ['down', 'down']);
});

test('отказ пустого списка пропавшей цели тоже ждёт минуту', async () => {
  let fail = false;
  const sent = [];
  const clock = { now: 0 };
  const s = createCacheWarnSender({
    send: (target, body) => { sent.push(body); return fail ? Promise.reject(new Error('down')) : Promise.resolve(); },
    onError: () => {},
    nowMs: () => clock.now,
  });
  await s.update(cacheWarnSets([row('a')], STATE, 10));
  fail = true;
  await s.update(new Map());
  clock.now = 1000;
  await s.update(new Map());
  assert.strictEqual(sent.length, 2);
  clock.now = 61 * 1000;
  await s.update(new Map());
  assert.strictEqual(sent.length, 3);
});

test('пока отправка идёт, тот же набор второй раз не уходит', async () => {
  const sent = [];
  let release;
  const s = createCacheWarnSender({
    send: (target, body) => { sent.push(body); return new Promise(r => { release = r; }); },
    onError: () => {},
    nowMs: () => 0,
  });
  const sets = cacheWarnSets([row('a')], STATE, 10);
  const first = s.update(sets);
  await s.update(sets);
  assert.strictEqual(sent.length, 1);
  release();
  await first;
});

test('без emptyOf пропавшая цель получает прежнее тело с warnMin', async () => {
  const { s, sent } = sender();
  await s.update(cacheWarnSets([row('a')], STATE, 10));
  await s.update(new Map());
  assert.deepStrictEqual(sent[1].body, { warnMin: 10, sessions: [] });
});

test('emptyOf решает, что получает пропавшая цель', async () => {
  // Тот же отправитель возит набор для панели задач, а у того тела warnMin нет.
  const sent = [];
  const s = createCacheWarnSender({
    send: (target, body) => { sent.push({ target, body }); return Promise.resolve(); },
    nowMs: () => 0,
    emptyOf: () => ({ sessions: [] }),
  });
  const target = { base: '', http: 'nb:9722' };
  await s.update(new Map([['|nb:9722', { target, body: { sessions: ['a'] } }]]));
  await s.update(new Map());
  assert.deepStrictEqual(sent[1], { target, body: { sessions: [] } });
});

test('blinkingIds: только сессии, чей кеш мигает сейчас', () => {
  // Метка кеша — время последнего ответа, и с остыванием кеша она не пропадает:
  // в наборе мигания стоит почти всякая неработающая сессия. Мигает же из них
  // та, у которой до конца часа осталось не больше warnMin минут.
  const now = 100000;
  const sets = cacheWarnSets([
    row('cold', { agentCacheAt: now - 7200 }),
    row('calm', { agentCacheAt: now - 600 }),
    row('warn', { agentCacheAt: now - 3000 }),
    row('edge', { agentCacheAt: now - 3595 }),
  ], STATE, 10);
  assert.deepStrictEqual([...blinkingIds(sets, now)].sort(), ['warn']);
});
