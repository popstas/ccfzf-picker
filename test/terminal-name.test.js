// Имя выбранного терминала уезжает в теле просьбы к менеджеру окон, и живёт
// эта дорога в двух файлах на двух языках: `PRESETS`
// (`frontend-src/terminal-presets.js`) называет терминал, а таблица
// `TERMINAL_NAMES` в `src-tauri/src/mqtt.rs` считает то же имя от полей
// конфига. Копия в Rust неизбежна — ту же просьбу шлёт проектный хоткей, а у
// него webview спит, — и согласие двух таблиц держится этим сторожем.
//
// Ловит он тихий отказ: имя, разошедшееся с реестром менеджера, тот не узнает и
// молча возьмёт свой дефолт. Публикация проходит, PubAck приходит, окно
// открывается — только не тем терминалом, который стоит у человека в
// настройках. Ровно эта поломка и завела всю правку.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PRESETS, CUSTOM, presetsFor } = require('../frontend-src/terminal-presets');

const MQTT_RS = fs.readFileSync(
  path.join(__dirname, '..', 'src-tauri', 'src', 'mqtt.rs'),
  'utf8',
);

/**
 * Словарь имён из контракта — общий с реестром `claudeWt.terminals` у
 * windows11-manager. Имена без системы в названии: WezTerm на маке и на Windows
 * зовётся одинаково, а что за именем стоит, знает принимающая сторона.
 */
const DICTIONARY = ['wt', 'wezterm', 'kitty', 'ghostty', 'iterm2'];

/** Записи `TERMINAL_NAMES` из mqtt.rs: имя исполняемого → семейное имя. */
function rustTable() {
  const table = MQTT_RS.match(/const TERMINAL_NAMES[^=]*=\s*&\[([\s\S]*?)\];/);
  assert.ok(table, 'таблица TERMINAL_NAMES не найдена в mqtt.rs');
  const rows = [...table[1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
  assert.ok(rows.length, 'в TERMINAL_NAMES не разобрано ни одной записи');
  return new Map(rows.map(([, exe, name]) => [exe, name]));
}

/** То же, что делает `terminal_name` в Rust: имя файла без каталога. */
function exeOf(file) {
  return String(file).split(/[/\\]/).pop().toLowerCase();
}

test('у каждого пресета есть семейное имя из словаря', () => {
  for (const p of PRESETS) {
    assert.ok(p.terminal, `у пресета ${p.id} нет семейного имени`);
    assert.ok(
      DICTIONARY.includes(p.terminal),
      `пресет ${p.id} называется ${p.terminal} — этого имени нет в словаре контракта`,
    );
  }
});

test('Rust считает по пресету то же имя, что стоит в самом пресете', () => {
  const table = rustTable();
  for (const p of PRESETS) {
    const exe = exeOf(p.file);
    assert.ok(
      table.has(exe),
      `${p.id}: исполняемого ${exe} нет в TERMINAL_NAMES — просьба уйдёт без имени`,
    );
    assert.strictEqual(
      table.get(exe),
      p.terminal,
      `${p.id}: страница называет его ${p.terminal}, Rust — ${table.get(exe)}`,
    );
  }
});

test('в таблице Rust нет терминалов, которых не знает страница', () => {
  // Лишняя запись — это обещание имени, за которым в пикере нет пресета: в
  // выпадашке такого терминала не выбрать, а имя в просьбу поехало бы.
  const known = new Set(PRESETS.map(p => exeOf(p.file)));
  for (const exe of rustTable().keys()) {
    assert.ok(known.has(exe), `TERMINAL_NAMES знает ${exe}, а пресета с таким путём нет`);
  }
});

test('семейное имя — не то же самое, что id пресета', () => {
  // Два пресета WezTerm различаются только путём, и `id` у них разный именно
  // поэтому. Уедь в просьбу `id`, менеджер получил бы `wezterm-windows` —
  // имени, которого нет в его реестре, — и молча открыл бы свой дефолт.
  const wez = PRESETS.filter(p => p.terminal === 'wezterm');
  assert.strictEqual(wez.length, 2, 'ожидались два пресета WezTerm');
  assert.notStrictEqual(wez[0].id, wez[1].id);
  for (const p of wez) assert.strictEqual(p.terminal, 'wezterm');
});

test('у «Custom» имени нет и в списке оно последнее', () => {
  // Набранное руками нам неизвестно, и назови мы его чужим именем — менеджер
  // открыл бы не то, что стоит в поле. Тогда поле в просьбе не едет вовсе.
  const list = presetsFor('Win32');
  assert.strictEqual(list[list.length - 1].id, CUSTOM);
  assert.ok(!PRESETS.some(p => p.id === CUSTOM));
});
