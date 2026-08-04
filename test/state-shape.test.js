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
