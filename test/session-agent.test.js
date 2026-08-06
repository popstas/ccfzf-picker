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
