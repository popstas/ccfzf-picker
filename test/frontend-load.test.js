const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Остальные тесты грузят модули через require, а браузер — тегами <script>, и
// это разные пути. В CommonJS зависимость приезжает по require в момент
// вызова; в браузере модуль забирает соседа из globalThis в момент загрузки,
// то есть порядок тегов становится частью контракта. Разъехаться они могут
// молча: тесты зелёные, окно пустое.
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'sessions.html'), 'utf8');
const TAGS = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);

/** Загрузить модули тегами, как это делает окно, и вернуть получившийся global. */
function loadAsBrowser(files) {
  const ctx = { console };
  ctx.self = ctx;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, 'frontend-src', file), 'utf8');
    vm.runInContext(code, ctx, { filename: file });
  }
  return ctx;
}

test('порядок тегов таков, что каждый модуль находит своих соседей', () => {
  const ctx = loadAsBrowser(TAGS);
  // Три модуля, которые берут соседа из globalThis на загрузке. Проверяются не
  // существованием, а работой: undefined вместо соседа виден только в вызове.
  // Разложить в свой массив обязательно: у значений из vm-контекста другие
  // прототипы, и deepStrictEqual сравнивает в том числе их.
  assert.deepStrictEqual(
    [...ctx.SessionActions.availableActions({ id: 'a', live: true, pid: 42 }).map(a => a.id)],
    ['attach', 'info'],
  );
  assert.strictEqual(
    ctx.SessionGroups.buildSessionsPayload(
      { ok: true, sessions: [{ id: 'a', title: 'T', live: true }], seen: {} }, 'name',
    ).groups.length,
    1,
  );
  assert.strictEqual(ctx.ConfigShape.normalizeConfig(null).onlyLive, true);
  assert.strictEqual(
    ctx.UiState.normalizeUiState({ sort: 'нет такой' }, { toggles: {} }).sort,
    'cost',
  );
});

test('обратный порядок ломается — то есть тест и правда сторожит', () => {
  const swapped = TAGS.filter(f => f !== 'open-strategy.js');
  swapped.push('open-strategy.js');
  const ctx = loadAsBrowser(swapped);
  assert.throws(() => ctx.SessionActions.availableActions({ id: 'a', live: true, pid: 42 }));

  // То же самое для второй такой пары: ui-state берёт normalizeSort у
  // session-groups на загрузке.
  const late = TAGS.filter(f => f !== 'session-groups.js');
  late.push('session-groups.js');
  const ctx2 = loadAsBrowser(late);
  assert.throws(() => ctx2.UiState.normalizeUiState({}, { toggles: {} }));
});

// Буквенные хоткеи сверяются по физической клавише. `e.key` — это
// напечатанный знак: в русской раскладке ^R приходит как «к», ^K как «л», и
// действие молча перестаёт отзываться. Проверить это в браузере некому, а
// регрессия правится одним неосторожным `e.key` — поэтому сторож здесь.
test('буквенные клавиши не читаются через e.key', () => {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const suspects = [
    ...script.matchAll(/e\.key\s*===\s*'[A-Za-z]'/g),
    ...script.matchAll(/e\.key\.toLowerCase\(\)/g),
  ].map(m => m[0]);
  assert.deepStrictEqual(suspects, [], 'буква должна сверяться через e.code');
});

test('каждый тег из sessions.html копируется в frontend/', () => {
  const prepare = fs.readFileSync(path.join(ROOT, 'scripts/prepare-frontend.js'), 'utf8');
  const copied = [...prepare.matchAll(/'frontend-src\/([^']+)'/g)].map(m => m[1]);
  for (const file of TAGS) {
    assert.ok(copied.includes(file), `${file} есть в sessions.html, но не в prepare-frontend.js`);
  }
});
