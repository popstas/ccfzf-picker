const { test } = require('node:test');
const assert = require('node:assert');
const { validateState } = require('../frontend-src/state-shape');

const good = {
  generated: 1785858452.9,
  sessions: [{
    id: '89e04faa-04fb-4828-96e2-21249b41fca3',
    cwd: '/home/user/projects/x',
    title: 'b2b-kpi',
    gist: 'что-то',
    mtime: 1785858452.9,
    live: true,
    frozen: false,
    kind: 'interactive',
    parent: '',
    pid: 1626189,
    tty: '/dev/pts/1',
    tmux: null,
    agent: null,
  }],
};

test('форма без претензий проходит', () => {
  assert.deepStrictEqual(validateState(good), []);
});

test('отсутствие sessions — претензия', () => {
  assert.deepStrictEqual(validateState({ generated: 1 }), ['sessions is not an array']);
});

test('сессия без id названа по индексу', () => {
  const bad = { generated: 1, sessions: [{ cwd: '/x' }] };
  assert.ok(validateState(bad).some(m => m.includes('sessions[0]') && m.includes('id')));
});

test('лишние поля не считаются ошибкой', () => {
  const extra = JSON.parse(JSON.stringify(good));
  extra.sessions[0].projects = ['/home/user/projects/x'];
  assert.deepStrictEqual(validateState(extra), []);
});

test('agent проверяется только когда он не null', () => {
  const withAgent = JSON.parse(JSON.stringify(good));
  withAgent.sessions[0].agent = { updated: 'вчера' };
  assert.ok(validateState(withAgent).some(m => m.includes('agent.updated')));
});

test('проекты проверяются, когда они есть', () => {
  const bad = validateState({
    generated: 1, sessions: [],
    projects: [{ path: '/p', name: 'p', sessions: '3', live: 0, mtime: 0 }],
  });
  assert.deepStrictEqual(bad, ['projects[0].sessions is not a number']);

  const ok = validateState({
    generated: 1, sessions: [],
    projects: [{ path: '/p', name: 'p', sessions: 3, live: 1, mtime: 100 }],
  });
  assert.deepStrictEqual(ok, []);
});

test('ответ без проектов — рабочее состояние, а не поломка', () => {
  // Агрегатор живёт на другой машине и обновляется отдельно от пикера. Старый
  // ответ без projects обязан открывать список сессий как ни в чём не бывало:
  // уронить его значило бы лишить человека пикера из-за не приехавшей фичи.
  assert.deepStrictEqual(validateState({ generated: 1, sessions: [] }), []);
});

test('проекты не массивом — это поломка', () => {
  assert.deepStrictEqual(
    validateState({ generated: 1, sessions: [], projects: {} }),
    ['projects is not an array'],
  );
});
