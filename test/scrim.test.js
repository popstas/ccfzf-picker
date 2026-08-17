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

// ── клик по подложке гасит пикер ───────────────────────────────────────────
//
// Сторож текстовый, и другого тут быть не может: обе ветки, где живёт
// обработчик, под `#[cfg]` и на этой машине (Linux) не компилируются вовсе, а
// поведением клик по нативному окну не проверить ничем. Спека обещала, что
// работу сделает `hideOnBlur`, живая проверка владельца на Windows и macOS
// показала обратное — клик не делал ничего ни в одной раскладке.

test('нажатие мыши разбирает оконная процедура Windows, а не умолчание', () => {
  assert.match(SCRIM_RS, /WM_LBUTTONDOWN/,
    'wnd_proc обязана ловить нажатие: WS_EX_NOACTIVATE не даёт подложке забрать фокус');
  const branch = SCRIM_RS.split('unsafe extern "system" fn wnd_proc')[1] || '';
  assert.match(branch.split('DefWindowProcW(hwnd')[0], /super::dismiss\(\)/,
    'ветка нажатия обязана звать общую dismiss, а не гасить окно по-своему');
});

test('на macOS клик принимает своя вьюха, и первый клик она не съедает', () => {
  assert.match(SCRIM_RS, /method\(mouseDown:\)/,
    'без своего mouseDown: клик по borderless-окну проглатывается молча');
  assert.match(SCRIM_RS, /method\(acceptsFirstMouse:\)/,
    'подложка ключевым окном не бывает, то есть каждый её клик — «первый»');
  assert.match(SCRIM_RS, /window\.setContentView\(Some\(&view\)\)/,
    'вьюху надо поставить окну, иначе разбирать нажатие некому');
});

test('обе платформы гасят пикер одной и той же dismiss', () => {
  // Две копии «погасить окно» разошлись бы молча: ни одна из веток не
  // собирается на машине разработки, и заметить расхождение можно было бы
  // только выкаткой на обе системы сразу.
  assert.strictEqual((SCRIM_RS.match(/super::dismiss\(\)/g) || []).length, 2,
    'ровно два вызова: по одному на платформу');
  assert.match(SCRIM_RS, /fn dismiss\(\) \{[\s\S]*?crate::hide_window\(app\)/,
    'dismiss обязана звать общий hide_window — он же гасит и саму подложку');
});
