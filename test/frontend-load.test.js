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
  // Четыре модуля, которые берут соседа из globalThis на загрузке. Проверяются
  // не существованием, а работой: undefined вместо соседа виден только в вызове.
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
  // С непустым actions — иначе разбор конфига до ActionHotkey не доходит вовсе
  // и порядок этой пары тегов остался бы непроверенным.
  assert.strictEqual(
    ctx.ConfigShape.normalizeConfig({
      actions: [{ id: 'open', hotkey: 'Ctrl+Shift+E', argv: ['x', '{localPath}'] }],
    }).actions[0].hotkey,
    'Ctrl+Shift+E',
  );
  assert.strictEqual(
    ctx.UiState.normalizeUiState({ sort: 'нет такой' }, { toggles: {} }).sort,
    ctx.SessionGroups.DEFAULT_SORT,
  );
  // С непустым запросом — иначе отбор коротит на `!q` и до соседа не доходит.
  // Сосед у picker-snapshots обязателен: searchableCwd срезает `/home` из
  // пути, и без него отбор по снимкам молча начал бы находить каждую строку
  // по слову «home».
  assert.deepStrictEqual(
    [...ctx.PickerSnapshots.buildSnapshotRows(
      [{ id: 's1', created: 1, sessions: [{ id: 'a', cwd: '/home/user/projects/ccfzf', title: 'ccfzf' }] }],
      [], 'projects/ccfzf',
    ).map(r => r.kind)],
    ['snapshot-day', 'snapshot', 'snapshot-session'],
  );
  // picker-sections берёт filterSessions/filterProjects у picker-filter на
  // загрузке. Запрос обязан быть непустым по той же причине, что и у снимков:
  // с пустым отбор коротит и до соседа не доходит. Переставь кто-нибудь тег
  // picker-sections выше picker-filter — buildSections бросил бы на первой же
  // отрисовке, а весь набор остался бы зелёным: в picker-sections.test.js
  // сосед приезжает по require, и порядок тегов там не проверяется вовсе.
  assert.deepStrictEqual(
    [...ctx.PickerSections.buildSections({
      groups: [{ key: 'live', label: 'Running', sessions: [{ id: 'a', label: 'ccfzf', cwd: '/home/user/projects/ccfzf' }] }],
      projects: [{ label: 'other', cwd: '/home/user/projects/other' }],
      query: 'ccfzf',
    }).map(b => b.key)],
    ['live'],
  );
  // key-reference берёт таблицу клавиш у action-hotkey на загрузке, а не по
  // вызову: деструктуризация стоит прямо в теле factory. Переставь кто-нибудь
  // теги местами — модуль упал бы ещё при загрузке окна, а весь набор остался
  // бы зелёным: здесь сосед приезжает по require.
  assert.ok(
    [...ctx.KeyReference.buildKeyReference({ trackerHere: true })
      .flatMap(s => s.rows).map(r => r.key)].includes('^K'),
    'справочник клавиш не собрался — похоже, разъехался порядок тегов',
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

  // И третья: picker-snapshots берёт searchableCwd у picker-filter на
  // загрузке. Отбор с непустым запросом — единственное место, где недостача
  // видна: с пустым он коротит и до соседа не доходит.
  const filterLast = TAGS.filter(f => f !== 'picker-filter.js');
  filterLast.push('picker-filter.js');
  const ctx3 = loadAsBrowser(filterLast);
  assert.throws(() => ctx3.PickerSnapshots.buildSnapshotRows(
    [{ id: 's1', created: 1, sessions: [{ id: 'a', cwd: '/home/user/x', title: 'x' }] }],
    [], 'x',
  ));
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

test('settings.html грузит те же модули, что и зовёт', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  // Модуль, забытый в разметке, даёт пустую страницу настроек и ошибку в
  // консоли, которую в отдельном окне никто не видит.
  for (const src of ['settings-form.js', 'ui-state.js', 'session-groups.js', 'action-hotkey.js']) {
    assert.ok(html.includes(`src="${src}"`), `нет тега ${src}`);
  }
  // Вкладки и контейнер страницы — по ним рисование находит своё место.
  assert.ok(html.includes('id="tabs"'));
  assert.ok(html.includes('id="page"'));
});

test('settings.html попадает в сборку', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-frontend.js'), 'utf8');
  // Страница, не попавшая в frontend/, откроется пустым окном в собранном
  // приложении, а npm test при этом останется зелёным.
  assert.ok(script.includes('settings.html'), 'settings.html не копируется');
});
