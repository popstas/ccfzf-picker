const { test } = require('node:test');
const assert = require('node:assert');
const { buildZellijList } = require('../frontend-src/zellij-list');

test('строка собирается из записи агрегатора', () => {
  const [row] = buildZellijList({
    zellij: [{ name: 'obsidian-agent-base', created: 1785591360, pid: 1228224, agents: 1 }],
  });
  assert.strictEqual(row.kind, 'zellij');
  assert.strictEqual(row.id, 'zellij:obsidian-agent-base');
  assert.strictEqual(row.label, 'obsidian-agent-base');
  assert.strictEqual(row.zellij, 'obsidian-agent-base');
  assert.strictEqual(row.lastActivity, 1785591360);
  assert.strictEqual(row.agents, 1);
  assert.strictEqual(row.live, true);
});

test('источник переезжает в строку под тем же именем, что и у сессии', () => {
  // merge_state.rs метит источником и zellij тоже; attach в
  // open-strategy.js обязан пойти на ту же машину, где живёт эта зелийная
  // сессия, а не на CONFIG.sshHost по умолчанию.
  const [row] = buildZellijList({ zellij: [{ name: 'home', source: 'remote-host' }] });
  assert.strictEqual(row.source, 'remote-host');
});

test('пустой источник — пустая строка, а не undefined', () => {
  const [row] = buildZellijList({ zellij: [{ name: 'home' }] });
  assert.strictEqual(row.source, '');
});

test('id носит префикс, чтобы не столкнуться с uuid сессии', () => {
  // Ключ строки в DOM общий на весь список; зелийную сессию законно назвать
  // как угодно, в том числе тридцатью шестью шестнадцатеричными знаками.
  const [row] = buildZellijList({ zellij: [{ name: '0624d3a3-be36-4c4c-a383-269d3490a398' }] });
  assert.ok(row.id.startsWith('zellij:'), row.id);
});

test('мусор отсеивается, а не роняет список', () => {
  assert.deepStrictEqual(buildZellijList({}), []);
  assert.deepStrictEqual(buildZellijList({ zellij: null }), []);
  assert.deepStrictEqual(buildZellijList({ zellij: 'нет' }), []);
  assert.deepStrictEqual(buildZellijList({ zellij: [null, {}, { name: '' }] }), []);
});

test('недостающие числа становятся нулями, а не NaN', () => {
  // NaN в lastActivity утопил бы строку мимо missingLast, а в колонке
  // возраста нарисовался бы словом.
  const [row] = buildZellijList({ zellij: [{ name: 'home' }] });
  assert.strictEqual(row.lastActivity, 0);
  assert.strictEqual(row.agents, 0);
});
