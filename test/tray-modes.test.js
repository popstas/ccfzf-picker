// Меню трея открывает пикер в названном режиме, и живёт эта дорога в двух
// файлах на двух языках: таблица `MODE_MENU` в `src-tauri/src/main.rs` называет
// режим, страница ищет его в `PREFIXES`. Общего кода тут быть не может, и
// потому согласие держится этими сторожами.
//
// Ловят они самый тихий отказ из возможных: опечатка в имени режима не роняет
// ничего. Пункт меню есть, нажатие проходит, событие уезжает, `withPrefix`
// незнакомого режима не находит и возвращает строку как есть — окно просто
// открывается обычным списком, без единого слова о причине. Поведением такое
// не поймать: обе половинки по отдельности работают верно.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PREFIXES, withPrefix } = require('../frontend-src/picker-mode');

const MAIN_RS = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'),
  'utf8',
);
const SESSIONS_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'sessions.html'),
  'utf8',
);

/** Записи `MODE_MENU` из main.rs: id пункта, режим, подпись. */
function modeMenu() {
  const table = MAIN_RS.match(/const MODE_MENU[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(table, 'таблица MODE_MENU не найдена в main.rs');
  const rows = [...table[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
  assert.ok(rows.length, 'в MODE_MENU не разобрано ни одной записи');
  return rows.map(([, id, mode, label]) => ({ id, mode, label }));
}

test('каждый режим меню трея известен странице', () => {
  const known = PREFIXES.map(p => p.mode);
  for (const { id, mode } of modeMenu()) {
    assert.ok(
      known.includes(mode),
      `пункт ${id} называет режим ${mode}, которого нет в PREFIXES`,
    );
    // Не только «есть в таблице», но и «ставит префикс»: режим, известный
    // разбору и не известный вставке, оставил бы строку поиска пустой.
    assert.notStrictEqual(
      withPrefix('', mode),
      '',
      `режим ${mode} не ставит префикса в строку поиска`,
    );
  }
});

test('меню трея покрывает все режимы, у которых есть префикс', () => {
  // Кроме `local`: он есть на `^L`, а верхний пункт меню открывает общий
  // список — тот, у которого префикса нет вовсе. Оговорка названа здесь
  // поимённо, чтобы шестой заведённый режим свалил этот тест, а не тихо
  // остался без пункта меню.
  const inMenu = modeMenu().map(m => m.mode);
  const missing = PREFIXES.map(p => p.mode).filter(
    mode => mode !== 'local' && !inMenu.includes(mode),
  );
  assert.deepStrictEqual(missing, [], 'режимы без пункта в меню трея');
});

test('подписи пунктов называют режим, а не действие', () => {
  // Слово `Show` было бы одинаковым у всех пяти пунктов и потому не различало
  // бы ничего. Проверяется здесь, а не только в Rust: правило про язык
  // интерфейса живёт на обеих сторонах.
  for (const { id, label } of modeMenu()) {
    assert.ok(label.trim(), `пункт ${id} без подписи`);
    assert.ok(!/\bShow\b/.test(label), `подпись «${label}» со словом Show`);
  }
});

test('страница слушает picker-mode и разбирает тело события', () => {
  // Текстовый сторож: подписка на переименованное событие молчала бы — ни
  // ошибки, ни следа, окно просто открывалось бы обычным списком.
  assert.match(SESSIONS_HTML, /listen\('picker-mode'/);
  assert.match(SESSIONS_HTML, /showMode\(event\.payload\)/);
  assert.ok(
    !SESSIONS_HTML.includes("'picker-projects'"),
    'осталась подписка на picker-projects — Rust это событие больше не шлёт',
  );
  assert.ok(
    !MAIN_RS.includes('"picker-projects"'),
    'Rust всё ещё шлёт picker-projects — страница его больше не слушает',
  );
});
