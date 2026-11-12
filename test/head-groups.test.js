'use strict';
// Правило «чей ребёнок» живёт дважды: в дереве страницы (`nestByHead`) и в
// Rust (`place_order::head_parents`), который собирает группы для хоткея при
// спящей странице. Вход общий — `test/fixtures/head-groups.json`; Rust-половина
// сторожа — `head_groups_match_the_shared_fixture`. Разойдись они, хоткей
// разложил бы не ту группу, что нарисована, а ответа у просьбы нет.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { nestByHead } = require('../frontend-src/session-tree.js');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'head-groups.json'), 'utf8'));

/** Строки, как их видит дерево: только сессии с окном на этой машине. */
function rowsOf(c, host) {
  const byId = new Map(c.sessions.map(s => [s.id, s]));
  return c.order.map(id => {
    const s = byId.get(id);
    const own = (s.windows || []).find(w => w.host === host) || {};
    return { id: s.id, title: s.title, head: s.head || '', headId: s.headId || '', windowTitle: own.title || '' };
  });
}

/** Родители по глубине: у строки глубины d это ближайшая выше строка глубины d-1. */
function parentsOf(nested) {
  const out = {};
  const stack = [];
  for (const row of nested) {
    stack.length = row.treeDepth;
    if (row.treeDepth > 0) out[row.id] = stack[row.treeDepth - 1];
    stack.push(row.id);
  }
  return out;
}

test('правило родителя у дерева страницы и у хоткея группы одно', () => {
  assert.ok(FIXTURE.cases.length, 'в фикстуре нет ни одного случая');
  for (const c of FIXTURE.cases) {
    const nested = nestByHead(rowsOf(c, FIXTURE.host));
    assert.deepStrictEqual(parentsOf(nested), c.parents, c.name);
  }
});

test('каждая сессия фикстуры с окном здесь стоит в order', () => {
  // Иначе JS-половина проверяла бы меньше строк, чем Rust, и молча.
  for (const c of FIXTURE.cases) {
    const here = c.sessions.filter(s => (s.windows || []).some(w => w.host === FIXTURE.host)).map(s => s.id);
    assert.deepStrictEqual(c.order.slice().sort(), here.sort(), c.name);
  }
});
