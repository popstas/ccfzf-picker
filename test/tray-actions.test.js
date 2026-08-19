// Клик по иконке трея делает то, что назвал конфиг, и живёт эта дорога в двух
// файлах на двух языках: таблица `TRAY_CLICK_ACTIONS` в
// `src-tauri/src/main.rs` решает, что нажатие сделает, а `TRAY_ACTIONS` в
// `frontend-src/settings-form.js` показывает человеку список. Общего кода тут
// быть не может, и потому согласие держит этот сторож — тем же приёмом, что
// у `MODE_MENU`/`PREFIXES` и у `terminal_name`.
//
// Ловит он самый тихий отказ из возможных. Предложи окно действие, которого
// Rust не знает, — оно запишется в `config.yaml`, `tray_action` откатит его на
// умолчание, и клик будет делать не то, что выбрано. Ни ошибки, ни следа:
// ответа у нажатия нет вовсе, а обе половинки по отдельности работают верно.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PAGES } = require('../frontend-src/settings-form');

const MAIN_RS = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'),
  'utf8',
);

/** Записи `TRAY_CLICK_ACTIONS` из main.rs: значение конфига и подпись. */
function trayActions() {
  const table = MAIN_RS.match(/const TRAY_CLICK_ACTIONS[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(table, 'таблица TRAY_CLICK_ACTIONS не найдена в main.rs');
  const rows = [...table[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
  assert.ok(rows.length, 'в TRAY_CLICK_ACTIONS не разобрано ни одной записи');
  return rows.map(([, value, label]) => ({ value, label }));
}

/**
 * Поля выбора действия трея на вкладке хоткеев.
 *
 * Отбор по имени ключа, а не по одному типу поля: рядом на той же вкладке
 * стоит выпадашка действия проектных клавиш, и её список свой
 * (`PROJECT_OPEN_ACTIONS`, сторож — `test/project-open-actions.test.js`).
 * Забирай этот тест все `choice` подряд — он требовал бы от неё действий трея.
 */
function choiceFields() {
  const page = PAGES.find(p => p.id === 'hotkeys');
  const fields = page.fields.filter(f => f.type === 'choice' && f.id.startsWith('tray'));
  assert.ok(fields.length, 'выпадашек действий трея на вкладке не нашлось');
  return fields;
}

test('окно настроек предлагает ровно те действия, которые умеет Rust', () => {
  const expected = trayActions();
  for (const field of choiceFields()) {
    assert.deepStrictEqual(
      field.options.map(o => ({ value: o.value, label: o.label })),
      expected,
      `список поля ${field.id} разошёлся с TRAY_CLICK_ACTIONS`,
    );
  }
});

test('умолчание каждого жеста — действие из той же таблицы', () => {
  // Умолчания у жестов разные (левая кнопка показывает список, средняя
  // раскладывает окна), и в Rust они названы у самого нажатия, а не в
  // таблице. Названное здесь мимо таблицы значило бы, что выпадашка
  // открывается с пунктом, которого в ней нет, — то есть ни с каким.
  const known = trayActions().map(a => a.value);
  for (const field of choiceFields()) {
    assert.ok(
      known.includes(field.default),
      `умолчание ${field.default} поля ${field.id} не из TRAY_CLICK_ACTIONS`,
    );
  }
});

test('умолчания жестов те же, что подставляет Rust', () => {
  // Разойдись они — окно показывало бы одно действие, а ненастроенный клик
  // делал бы другое: ключа в config.yaml нет, пока человек его не выбрал.
  const byId = Object.fromEntries(choiceFields().map(f => [f.id, f.default]));
  for (const [key, fallback] of [
    ['trayClickAction', 'sessions'],
    ['trayMiddleClickAction', 'tile'],
  ]) {
    assert.ok(
      MAIN_RS.includes(`("${key}", "${fallback}")`),
      `в main.rs у ${key} умолчание не ${fallback}`,
    );
    assert.strictEqual(byId[key], fallback, `в форме у ${key} умолчание другое`);
  }
});

test('правая кнопка действия не получает — под ней меню трея', () => {
  // Меню — единственная дорога к настройкам, выходу и режимам. Заведись у
  // правой кнопки действие, оно либо не сработало бы, либо отобрало бы меню.
  const handler = MAIN_RS.split('.on_tray_icon_event')[1] || '';
  assert.ok(handler, 'обработчик клика по иконке пропал — тест сторожит не то');
  assert.match(handler, /MouseButton::Right => return/);
});
