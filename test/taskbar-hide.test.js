const test = require('node:test');
const assert = require('node:assert');
const { taskbarHideSets } = require('../frontend-src/taskbar-hide');

// Строки — как их строит buildSessionList: карточка на окно, своё окно
// карточки в `windows`, все окна сессии в `sessionWindows`.
const NB = { host: 'nb', mqttBase: 'home/nb/windows' };
const MAC = { host: 'mac', mqttBase: 'home/mac/windows' };
const STATE = { windowHosts: [{ host: 'nb', http: { port: 9722 } }, { host: 'mac' }] };
const card = (id, w = NB, over = {}) => ({
  id, agentState: 'idle', agentSeen: true, windows: [w], sessionWindows: [w], ...over,
});
// Погашено всё, что не названо свежим: предикат подаёт страница, здесь он подставной.
const opts = (over = {}) => ({
  enabled: true, configHost: 'nb', isDimmed: r => !r.fresh, warnIds: new Set(), ...over,
});
const only = sets => [...sets.values()];

test('выключено — пустая карта', () => {
  assert.strictEqual(taskbarHideSets([card('a')], STATE, opts({ enabled: false })).size, 0);
});

test('без строгого true — тоже пустая карта', () => {
  // `&&`-цепочка на странице может дать undefined: прятать кнопки по нему нельзя.
  assert.strictEqual(taskbarHideSets([card('a')], STATE, opts({ enabled: undefined })).size, 0);
});

test('погашенная сессия своей машины в наборе, чужой машины — нет', () => {
  const sets = taskbarHideSets([
    card('a'),
    card('b', MAC),
    card('c', NB, { fresh: true }),
  ], STATE, opts());
  assert.deepStrictEqual(only(sets), [{
    target: { base: 'home/nb/windows', http: 'nb:9722' },
    body: { sessions: ['a'] },
  }]);
});

test('вопрос, непросмотренный review и мигающая — не в наборе', () => {
  const sets = taskbarHideSets([
    card('q', NB, { agentState: 'question' }),
    card('r', NB, { agentState: 'review', agentSeen: false }),
    card('seen', NB, { agentState: 'review', agentSeen: true }),
    card('warn'),
  ], STATE, opts({ warnIds: new Set(['warn']) }));
  assert.deepStrictEqual(only(sets)[0].body.sessions, ['seen']);
});

test('две карточки одной сессии — один id', () => {
  const sets = taskbarHideSets([card('a'), card('a')], STATE, opts());
  assert.deepStrictEqual(only(sets)[0].body.sessions, ['a']);
});

test('сигнал на любой своей карточке держит кнопку сессии', () => {
  // Прячет служба по id — то есть все окна сессии разом. Карточка второго
  // окна со своим «не смотрели» иначе осталась бы без кнопки вместе с первой.
  const sets = taskbarHideSets([
    card('a'),
    card('a', NB, { agentState: 'review', agentSeen: false }),
  ], STATE, opts());
  assert.deepStrictEqual(only(sets)[0].body.sessions, []);
});

test('несвёрнутое второе окно той же сессии кнопку не прячет', () => {
  const sets = taskbarHideSets([card('a'), card('a', NB, { fresh: true })], STATE, opts());
  assert.deepStrictEqual(only(sets)[0].body.sessions, []);
});

test('id по порядку', () => {
  const sets = taskbarHideSets([card('c'), card('a'), card('b')], STATE, opts());
  assert.deepStrictEqual(only(sets)[0].body.sessions, ['a', 'b', 'c']);
});

test('включено и прятать нечего — цель с пустым списком', () => {
  // Пустой набор — тоже набор: heartbeat держит службу в курсе, что прятать нечего.
  const sets = taskbarHideSets([], STATE, opts());
  assert.deepStrictEqual(only(sets), [{ target: { base: '', http: 'nb:9722' }, body: { sessions: [] } }]);
});

test('нет трекера своей машины или не названа своя машина — пустая карта', () => {
  assert.strictEqual(taskbarHideSets([card('a')], STATE, opts({ configHost: 'other' })).size, 0);
  assert.strictEqual(taskbarHideSets([card('a')], STATE, opts({ configHost: '' })).size, 0);
});

test('цель одна, сколько бы машин ни было в ответе', () => {
  // Окна соседней машины не наши: иначе два пикера были бы двумя хозяевами
  // одного набора.
  const sets = taskbarHideSets([card('a'), card('b', MAC)], STATE, opts());
  assert.strictEqual(sets.size, 1);
});
