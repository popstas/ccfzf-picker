const { test } = require('node:test');
const assert = require('node:assert');
const {
  sessionDescription, lastActivityAt, seenSinceUpdate, activeAgent,
} = require('../frontend-src/session-agent');

test('сводка берётся из summary, а у работающей сессии — из lastSummary', () => {
  assert.strictEqual(sessionDescription({ summary: ' готово ', lastSummary: 'старое' }), 'готово');
  assert.strictEqual(sessionDescription({ summary: '', lastSummary: ' работаю ' }), 'работаю');
  assert.strictEqual(sessionDescription(null), '');
});

test('вопрос агента перебивает сводку, пока сессия на нём стоит', () => {
  const waiting = {
    state: 'question', question: ' Какой вариант? ',
    summary: 'Готово', lastSummary: 'старое',
  };
  assert.strictEqual(sessionDescription(waiting), 'Какой вариант?');
  // Ход кончился — вопрос уже неактуален, даже если поле ещё не стёрли.
  assert.strictEqual(sessionDescription({ ...waiting, state: 'review' }), 'Готово');
  assert.strictEqual(sessionDescription({ ...waiting, state: 'active' }), 'Готово');
  // Запрос разрешения: состояние то же самое, а текста вопроса нет нигде —
  // берётся сводка, иначе строка показала бы вопрос прошлой команды.
  assert.strictEqual(
    sessionDescription({ state: 'question', question: '   ', summary: 'Готово' }),
    'Готово',
  );
  // Вопрос есть, сводки нет вовсе — строка не пустеет.
  assert.strictEqual(
    sessionDescription({ state: 'question', question: 'Какой вариант?' }),
    'Какой вариант?',
  );
});

test('последняя активность — из отметки хука', () => {
  assert.strictEqual(lastActivityAt({ updated: 1785858452 }), 1785858452);
  assert.strictEqual(lastActivityAt({ updated: 0 }), null);
  assert.strictEqual(lastActivityAt(null), null);
});

test('без записи агента вопрос о прочитанности не имеет смысла', () => {
  assert.strictEqual(seenSinceUpdate(null, 999999), false);
  assert.strictEqual(seenSinceUpdate({ updated: 0 }, 999999), false);
});

test('просмотр в ту же секунду считается просмотром', () => {
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 100), true);
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 99), false);
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, undefined), false);
});

// Явное «непросмотрено» трекера (session-unread) перебивает отметку взгляда,
// пока новее её; взгляд в ту же секунду — уже после отметки.
test('unreadAt новее отметки взгляда — не видел', () => {
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 500, 600), false);
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 600, 600), true);
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 700, 600), true);
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 500, 0), true);
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 500, undefined), true);
  // И старое правило никуда не делось: отметка взгляда старше записи — не видел.
  assert.strictEqual(seenSinceUpdate({ updated: 100 }, 99, 0), false);
});

// Тихий конец хода не требует взгляда: сравнение с loudAt, а не с updated.
test('тихий ход — просмотрено, если видел последний нетихий', () => {
  const quiet = { updated: 200, quiet: true, loudAt: 100 };
  assert.strictEqual(seenSinceUpdate(quiet, 150), true);
  assert.strictEqual(seenSinceUpdate(quiet, 99), false, 'нетихий итог не видел');
  assert.strictEqual(seenSinceUpdate(quiet, 150, 160), false, 'unreadAt сильнее');
  assert.strictEqual(seenSinceUpdate({ updated: 200, quiet: true }, 150), false, 'без loudAt — как раньше');
  assert.strictEqual(seenSinceUpdate({ updated: 200, quiet: false, loudAt: 100 }, 150), false);
});

test('работу сессии говорит тот, чья запись свежее', () => {
  const parent = { id: 'p', agent: { updated: 100 } };
  const byId = {
    p: { id: 'p', kind: 'interactive', parent: '', agent: { updated: 100 } },
    c: { id: 'c', kind: 'background', parent: 'p', agent: { updated: 200 } },
  };
  const active = activeAgent(parent, byId);
  assert.strictEqual(active.id, 'c');
  assert.strictEqual(active.background, true);
  assert.strictEqual(active.agent.updated, 200);
});

test('родитель со свежей записью забирает голос обратно', () => {
  const byId = {
    p: { id: 'p', kind: 'interactive', parent: '', agent: { updated: 300 } },
    c: { id: 'c', kind: 'background', parent: 'p', agent: { updated: 200 } },
  };
  const active = activeAgent(byId.p, byId);
  assert.strictEqual(active.id, 'p');
  assert.strictEqual(active.background, false);
});

test('сессия без фоновых агентов говорит сама за себя', () => {
  const s = { id: 'p', kind: 'interactive', parent: '', agent: null };
  assert.deepStrictEqual(activeAgent(s, { p: s }), { id: 'p', agent: null, background: false });
});
