// Esc: сначала стереть строку поиска, и только на пустой — погасить окно.
//
// Режим пикера живёт префиксом в самой строке (`/p`, `/h`, `/s`), то есть
// выйти из режима — это стереть текст. Пока Esc гасил окно сразу, самая
// привычная клавиша отмены уводила из пикера вовсе, а вернуться к обычному
// списку можно было только стиранием руками.
//
// Проверяется настоящий код страницы, а не его копия: функция вычитывается из
// sessions.html и исполняется в vm — тем же приёмом, что и в
// hide-before-request.test.js. Копия разъехалась бы молча, а сторож остался бы
// зелёным.
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

/** Прогнать настоящую onEscape с названной строкой поиска. */
function press(value) {
  const calls = [];
  const ctx = {
    invoke: (cmd) => { calls.push(cmd); return Promise.resolve(); },
    search: { value },
    onSearchInput: () => { calls.push('onSearchInput'); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${sourceOf('onEscape')}\nonEscape();`, ctx, { filename: 'sessions.html' });
  return { calls, value: ctx.search.value };
}

test('на пустой строке Esc гасит пикер, как и раньше', () => {
  // Свежепоказанное окно всегда такое: beginShow чистит строку. Ломать этот
  // случай нельзя — Esc на открытом пикере закрывает его одним нажатием.
  const { calls } = press('');
  assert.deepStrictEqual(calls, ['hide_picker']);
});

test('непустая строка стирается, а окно остаётся', () => {
  const { calls, value } = press('/p');
  assert.strictEqual(value, '');
  assert.ok(!calls.includes('hide_picker'), `окно погасло: ${calls.join(', ')}`);
});

test('после очистки зовётся onSearchInput, а не одна перерисовка', () => {
  // В ней `active = 0` и `selectionReset`. Без неё выбор повис бы на строке,
  // которой в новом списке нет: список-то сменился целиком.
  const { calls } = press('/p foo');
  assert.deepStrictEqual(calls, ['onSearchInput']);
});

test('очистка одношаговая: префикс уходит вместе с текстом', () => {
  // Не «сначала текст, потом префикс»: выход из `/p foo` тремя нажатиями
  // читался бы как заедание клавиши. Обещание в справочнике — два нажатия.
  assert.strictEqual(press('/p foo').value, '');
  assert.strictEqual(press('/h').value, '');
  assert.strictEqual(press('просто поиск').value, '');
});

test('два нажатия подряд из режима закрывают окно', () => {
  // Ровно то, что обещано человеку: первый Esc — из режима, второй — из
  // пикера. Считается двумя прогонами, потому что строка между ними и есть
  // всё состояние.
  const first = press('/p');
  assert.ok(!first.calls.includes('hide_picker'));
  const second = press(first.value);
  assert.deepStrictEqual(second.calls, ['hide_picker']);
});

test('справочник обещает обе роли Esc, а не одну', () => {
  // Строка видна человеку, и сверяется она дословно: правка формулировки
  // обязана проходить через этот тест, иначе справочник разошёлся бы с
  // поведением молча.
  const { buildKeyReference } = require('../frontend-src/key-reference');
  const rows = buildKeyReference({ trackerHere: true }).flatMap(s => s.rows);
  const esc = rows.find(r => r.key === 'Esc');
  assert.ok(esc, 'Esc пропал из справочника');
  assert.strictEqual(esc.label, 'Clear the search, then hide the picker');
});
