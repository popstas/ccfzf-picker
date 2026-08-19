// Порядок окон для просьбы о раскладке живёт в двух файлах на двух языках:
// страница считает его `placeIds` над нарисованным списком, а Rust —
// `place_order::tile_ids` над ответом агрегатора. Копия в Rust неизбежна:
// хоткей плитки жмут при скрытом пикере, а у скрытого окна WebView2 усыпляет
// страницу целиком — спросить у неё нечего. Согласие двух реализаций держится
// этим сторожем и общей фикстурой `test/fixtures/place-order.json`, которую
// читают оба теста.
//
// Ловит он самый тихий отказ из возможных: разошедшийся порядок поведением не
// поймать вовсе. Публикация проходит, брокер подтверждает, трекер окна
// раскладывает — только не в том порядке, который человек видит в списке. И
// сказать об этом некому: ответа у публикации нет.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const groups = require('../frontend-src/session-groups');
const windowsApi = require('../frontend-src/session-windows');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'place-order.json'), 'utf8'),
);

const PLACE_ORDER_RS = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'place_order.rs'),
  'utf8',
);

/**
 * Тот же путь, каким порядок получается в пикере: строки собираются и
 * группируются `buildSessionsPayload`, группы рисуются одна за другой, а
 * `placeIds` идёт по нарисованному.
 *
 * Отсевы (`onlyLive`, `onlyWindow`) не передаются намеренно: у хоткея их нет и
 * быть не может — строки поиска на скрытом пикере не существует.
 */
function pageOrder(mode, opts) {
  const res = { ok: true, ...FIXTURE.state, seen: {} };
  const built = groups.buildSessionsPayload(res, mode, { configHost: FIXTURE.configHost });
  const rows = built.groups.flatMap(g => g.sessions);
  return windowsApi.placeIds(rows, FIXTURE.state, FIXTURE.configHost, opts);
}

test('страница даёт по фикстуре ровно тот порядок, что записан в ней', () => {
  for (const [mode, expected] of Object.entries(FIXTURE.expected)) {
    assert.deepStrictEqual(pageOrder(mode), expected, `сортировка ${mode}`);
  }
});

test('страница отсеивает тусклые строки из раскладки по фикстуре', () => {
  // Свёрнутое окно и молчание дольше порога — два повода, и оба обязаны
  // работать в обеих реализациях одинаково: разошедшийся отсев так же тих,
  // как разошедшийся порядок, — публикация проходит, окна встают, только не
  // те, что человек видит в списке.
  const opts = { nowSec: FIXTURE.nowSec, stale: FIXTURE.stale };
  for (const [mode, expected] of Object.entries(FIXTURE.expectedStale)) {
    assert.deepStrictEqual(pageOrder(mode, opts), expected, `сортировка ${mode}`);
  }
});

test('снятая галка dim stale возвращает в раскладку весь порядок', () => {
  // Галка гасит правило целиком — и в списке, и здесь.
  const opts = { nowSec: FIXTURE.nowSec, stale: { ...FIXTURE.stale, enabled: false } };
  for (const [mode, expected] of Object.entries(FIXTURE.expected)) {
    assert.deepStrictEqual(pageOrder(mode, opts), expected, `сортировка ${mode}`);
  }
});

test('Rust проверяется на той же фикстуре, а не на своей копии', () => {
  // Две фикстуры разошлись бы на первой же правке, и сторож перестал бы
  // сторожить молча: оба теста продолжали бы зеленеть на разных входах.
  assert.match(
    PLACE_ORDER_RS,
    /include_str!\("[^"]*test\/fixtures\/place-order\.json"\)/,
    'Rust-тест не читает общую фикстуру',
  );
});

test('режимы сортировки у Rust те же, что у страницы', () => {
  // Разойдись списки — незнакомый режим откатился бы на `recent`, и выбранная
  // человеком сортировка молча перестала бы действовать на раскладку.
  const modes = PLACE_ORDER_RS.match(/const SORT_MODES:[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(modes, 'SORT_MODES не найден в place_order.rs');
  const names = [...modes[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(names, groups.SORT_MODES);

  const fallback = PLACE_ORDER_RS.match(/const DEFAULT_SORT: &str = "([^"]+)"/);
  assert.ok(fallback, 'DEFAULT_SORT не найден в place_order.rs');
  assert.strictEqual(fallback[1], groups.DEFAULT_SORT);
});

test('каждый режим сортировки разобран в Rust поимённо', () => {
  // Режим без своей ветки не падает и не жалуется — он сортирует по одному
  // тай-брейку, то есть по имени. Список из пяти строк выглядит при этом
  // отсортированным, просто не тем ключом.
  const arm = PLACE_ORDER_RS.match(/let primary = match mode \{([\s\S]*?)\n    \};/);
  assert.ok(arm, 'ветвление по режиму не найдено в place_order.rs');
  for (const mode of groups.SORT_MODES) {
    assert.ok(
      arm[1].includes(`"${mode}" =>`),
      `режим ${mode} не разобран в place_order.rs — он молча сортировался бы по имени`,
    );
  }
});

test('минута округления `recent` в Rust та же, что на странице', () => {
  // На секундном ключе две работающие сессии меняются первым местом каждый
  // тик, и попасть по такой строке нельзя. Разойдись делители — порядок
  // раскладки дрожал бы там, где список стоит смирно.
  assert.match(
    PLACE_ORDER_RS,
    /fn recent_key\(t: f64\) -> f64 \{[\s\S]*?\(t \/ 60\.0\)\.floor\(\)\.max\(1\.0\)/,
    'recent_key округляет не до минуты или потерял нижнюю границу',
  );
});
