// Подложка позади пикера обязана остаться нативным окном, а не вторым
// webview: второй webview — это второй процесс рендерера, вторая страница,
// вторая цепочка событий фокуса, — расходы, которых прозрачный прямоугольник
// не окупает. Договор проверяется текстом источника, а не поведением: и
// `WebviewWindowBuilder`, и окно с меткой "scrim" дали бы работающую
// подложку, только не ту, о которой договорились.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_RS = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'main.rs'), 'utf8');
const SCRIM_RS = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'scrim.rs'), 'utf8');

test('scrim не второй webview', () => {
  // `WebviewWindowBuilder` в `main.rs` не запрещён целиком: окно настроек
  // (`open_settings`, label "settings") законно им пользуется и не имеет к
  // подложке никакого отношения. Запрет уже, но острее — он ловит ровно то,
  // от чего предостерегает план: `scrim.rs` не создаёт Tauri-окно вовсе, а
  // метки "scrim" нет ни в одном из двух файлов.
  assert.doesNotMatch(SCRIM_RS, /WebviewWindowBuilder/);
  assert.doesNotMatch(MAIN_RS + SCRIM_RS, /label\(\s*"scrim"/);
});
