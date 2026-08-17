// Затемнение старых строк: правила CSS и галка в статуслайне.
//
// Оба сторожа текстовые, и это не лень. Правило CSS поведением не проверить
// вовсе — DOM в тестах нет; а галка ломается тихо: перепутанная сторона в
// TOGGLE_CHECKS уводит её в фильтры, и она начинает пересобирать состав
// списка вместо перерисовки.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');
const STYLES = SESSIONS_HTML.split('</style>')[0];

test('выбор не снимает затемнение stale, наведение снимает', () => {
  // Выбор стоит на первой строке при каждом показе окна и при каждой правке
  // запроса — то есть сам собой. Снимая с неё затемнение, он делал старую
  // сессию самой яркой в списке. Наведение остаётся: это жест человека, по
  // одной строке и руками.
  assert.ok(/\.row\.stale:hover\s*\{[^}]*opacity:\s*1/.test(STYLES),
    'наведение перестало снимать затемнение stale');
  assert.ok(!/\.row\.stale\.active/.test(STYLES),
    'выделение снова снимает затемнение stale — первая строка станет самой яркой');
});

test('галка dim stale есть и она не фильтр', () => {
  // Сторона решает, что позовёт обработчик: фильтру — regroup (он меняет
  // состав списка), остальным — render. Затемнение состава не меняет, и
  // сторона `filter` заставила бы пересобирать группы на каждое нажатие.
  assert.match(SESSIONS_HTML, /\{ key: 'dimStale', label: 'dim stale', side: 'dim' \}/,
    'галки dim stale нет в TOGGLE_CHECKS или у неё другая сторона');
  const filters = SESSIONS_HTML.match(/side: 'filter'/g) || [];
  assert.strictEqual(filters.length, 2,
    'фильтров стало не два — проверь, не уехала ли dimStale в фильтры');
});

test('умолчание галки берётся из конфига, а не из литерала', () => {
  // В литерале умолчаний CONFIG ещё пустой (load_config идёт позже), и
  // значение застыло бы на встроенном. Обе дороги к normalizeUiState —
  // первая загрузка и событие ui-changed — обязаны звать одну функцию.
  assert.match(SESSIONS_HTML, /function toggleDefaults\(\)/,
    'нет функции toggleDefaults');
  assert.match(SESSIONS_HTML, /dimStale: \{ \.\.\.uiToggles\.dimStale, list: CONFIG\.stale\.enabled \}/,
    'умолчание dimStale считается не от CONFIG.stale.enabled');
  const calls = SESSIONS_HTML.match(/toggles: toggleDefaults\(\)/g) || [];
  assert.strictEqual(calls.length, 2,
    `normalizeUiState зовётся с toggleDefaults() ${calls.length} раз из двух`);
});

test('затемнение спрашивает галку, а не CONFIG.stale напрямую', () => {
  // Два вызова staleClass — у строки сессии и у строки проекта. Оставь один
  // из них на CONFIG.stale, и галка гасила бы половину списка.
  const direct = SESSIONS_HTML.match(/staleClass\([^)]*CONFIG\.stale[^)]*\)/g) || [];
  assert.deepStrictEqual(direct, [],
    `staleClass всё ещё зовётся с CONFIG.stale: ${direct.join(' | ')}`);
  const viaSettings = SESSIONS_HTML.match(/staleClass\([^)]*staleSettings\(\)[^)]*\)/g) || [];
  assert.strictEqual(viaSettings.length, 2,
    `через staleSettings() идёт ${viaSettings.length} вызова из двух`);
});
