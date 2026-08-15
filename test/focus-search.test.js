// `/` возвращает фокус в строку поиска — и только когда его там нет.
//
// Обработчик клавиш висит на document, поэтому клавиши работают всегда, а
// набранный текст уходит туда, где фокус. Клик по строке списка, по заголовку
// секции или по галке статуслайна уводит его с поля, и набор после этого
// проваливается в никуда — без единого признака, что что-то не так.
//
// Проверяется настоящий код страницы, а не его копия: функция вычитывается из
// sessions.html и исполняется в vm — тем же приёмом, что и в
// hide-before-request.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

function sourceOf(name) {
  const re = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`);
  const found = SESSIONS_HTML.match(re);
  assert.ok(found, `${name} не найдена в sessions.html — тест сторожит не то`);
  return found[0];
}

/** Прогнать настоящую focusSearch на поле с названным содержимым. */
function focus(value) {
  const calls = [];
  const search = {
    value,
    focus: () => { calls.push('focus'); },
    setSelectionRange: (from, to) => { calls.push(`caret:${from}:${to}`); },
  };
  const ctx = { search };
  vm.createContext(ctx);
  vm.runInContext(`${sourceOf('focusSearch')}\nfocusSearch();`, ctx, { filename: 'sessions.html' });
  return { calls, value: ctx.search.value };
}

test('фокус возвращается, а строка не трогается', () => {
  const { calls, value } = focus('/p foo');
  assert.ok(calls.includes('focus'), 'focus не позван');
  assert.strictEqual(value, '/p foo', 'запрос изменился');
});

test('каретка встаёт в конец, а не выделяет набранное', () => {
  // beginShow при показе окна как раз выделяет — там строку начинают заново.
  // Здесь человек возвращается к уже набранному, и следующая буква не должна
  // стереть его запрос.
  assert.ok(focus('/p foo').calls.includes('caret:6:6'));
  assert.ok(focus('').calls.includes('caret:0:0'));
});

test('ветка `/` срабатывает только при фокусе вне поля', () => {
  // Обязательное условие, а не осторожность: `/` начинает все пять префиксов
  // режимов, и перехватывай ветка его безусловно — набрать `/p` стало бы
  // нечем вовсе.
  const branch = SESSIONS_HTML.match(/if \(e\.key === '\/'[\s\S]*?\n {4}\}/);
  assert.ok(branch, 'ветки `/` нет в обработчике');
  assert.match(branch[0], /document\.activeElement !== search/,
    'ветка не спрашивает про фокус — `/p` станет не набрать');
  assert.match(branch[0], /preventDefault\(\)/, 'символ уедет в строку следом за фокусом');
  assert.match(branch[0], /focusSearch\(\)/, 'ветка не зовёт focusSearch');
});

test('`/` с модификаторами не перехватывается', () => {
  // Ctrl+/ и Alt+/ человек вправе назначить своему действию: isReserved
  // занимает за окном только форму «один Ctrl или Cmd плюс буква».
  const branch = SESSIONS_HTML.match(/if \(e\.key === '\/'[\s\S]*?\n {4}\}/)[0];
  assert.match(branch, /!\(e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\)/,
    'ветка съест и комбинации с модификаторами');
});

test('ветка стоит после ранних выходов оверлеев', () => {
  // У справочника, сведений и меню действий свои клавиши, и отбирать у них
  // `/` было бы неожиданно: там строки поиска на экране нет вовсе.
  const handler = SESSIONS_HTML.slice(SESSIONS_HTML.lastIndexOf("document.addEventListener('keydown'"));
  const slash = handler.indexOf("e.key === '/'");
  assert.ok(slash > 0, 'ветки `/` нет в основном обработчике');
  for (const guard of ['keysOpen', 'infoOpen', 'menuOpen']) {
    const at = handler.indexOf(`if (${guard})`);
    assert.ok(at > 0 && at < slash, `ветка «/» встала перед выходом по ${guard}`);
  }
});

test('справочник называет клавишу и её условие', () => {
  // Строка видна человеку и сверяется дословно. Без оговорки про фокус она
  // обещала бы, что `/` — команда всегда, а в поле поиска это обычный знак.
  const { buildKeyReference } = require('../frontend-src/key-reference');
  const rows = buildKeyReference({ trackerHere: true }).flatMap(s => s.rows);
  const slash = rows.find(r => r.key === '/');
  assert.ok(slash, '`/` не попал в справочник');
  assert.strictEqual(slash.label, 'Back to the search box (when it is not focused)');
});
