// Подложка позади пикера обязана остаться нативным окном, а не вторым
// webview: второй webview — это второй процесс рендерера, вторая страница,
// вторая цепочка событий фокуса, — расходы, которых прозрачный прямоугольник
// не окупает. Договор проверяется текстом источника, а не поведением: и
// `WebviewWindowBuilder`, и лишний webview под любой меткой дали бы работающую
// подложку, только не ту, о которой договорились, — а разглядеть это на
// экране можно только зная, чего там быть не должно.
//
// Полный запрет `WebviewWindowBuilder` на весь `main.rs` был бы неверен: там
// уже законно живёт окно настроек (`open_settings`, метка "settings"), и оно
// к подложке отношения не имеет. Вместо запрета — перечень: все места во всём
// крейте, зовущие `WebviewWindowBuilder::new`, обязаны называть ровно один
// набор меток — тот, что есть сегодня. Второй scrim-webview, в любом файле и
// под любой меткой, раздул бы этот список и уронил тест — в отличие от
// одного лишь запрета на слово `WebviewWindowBuilder` в `main.rs`, который
// такую добавку не заметил бы вовсе, потому что тот же запрет уже нарушен
// легальным окном настроек.
//
// Проверка `.label("scrim")` из первой редакции этого файла снята: у
// `WebviewWindowBuilder::new(manager, label, url)` (tauri 2.11.5,
// `src/webview/webview_window.rs:101`) метка — позиционный второй аргумент, а
// `.label(...)` в этом крейте — только геттер без параметров. Строки вида
// `.label("scrim")` в этом API не бывает никогда, и проверка на неё не поймала
// бы ничего ни при каком содержимом файлов — то есть не была бы сторожем
// вовсе, а тихим декором.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src-tauri', 'src');
const SCRIM_RS = fs.readFileSync(path.join(SRC_DIR, 'scrim.rs'), 'utf8');

/** Метки всех `WebviewWindowBuilder::new(...)` во всех .rs файлах крейта. */
function webviewLabels() {
  const labels = [];
  for (const file of fs.readdirSync(SRC_DIR)) {
    if (!file.endsWith('.rs')) continue;
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    for (const m of src.matchAll(/WebviewWindowBuilder::new\(\s*[^,]+,\s*"([^"]+)"/g)) {
      labels.push(m[1]);
    }
  }
  return labels;
}

test('scrim.rs не создаёт webview напрямую', () => {
  assert.doesNotMatch(SCRIM_RS, /WebviewWindowBuilder/);
});

test('во всём крейте ровно один webview-строитель — окно настроек', () => {
  // Список жёсткий и с одним элементом: появление второго вызова
  // `WebviewWindowBuilder::new` где бы то ни было — хоть в main.rs под
  // меткой "scrim", хоть в новом файле под любым другим именем — меняет
  // этот список и валит тест независимо от выбранной метки.
  assert.deepStrictEqual(webviewLabels(), ['settings']);
});
