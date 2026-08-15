// Кнопка широкого режима в статуслайне и её общий код с `^F`.
//
// Входов в переключение раскладки два — клавиша и кнопка, — и работа у них
// одна. Вторая копия `set_picker_size` + `saveUi` разъехалась бы с первой, а
// увидеть это можно было бы только глазами, на живом окне: одна из дорог
// молча перестала бы помнить режим или менять раму.
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

/** Прогнать настоящую toggleFullscreen из названной раскладки. */
function toggle(from) {
  const calls = [];
  const ctx = {
    fullscreen: from,
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(); },
    saveUi: () => { calls.push(['saveUi']); },
    paintToggles: () => { calls.push(['paintToggles']); },
    render: () => { calls.push(['render']); },
    error: '',
  };
  vm.createContext(ctx);
  vm.runInContext(`${sourceOf('toggleFullscreen')}\ntoggleFullscreen();`, ctx,
    { filename: 'sessions.html' });
  return { calls, fullscreen: ctx.fullscreen, names: calls.map(c => c[0]) };
}

test('переключение ходит в обе стороны', () => {
  assert.strictEqual(toggle(false).fullscreen, true);
  assert.strictEqual(toggle(true).fullscreen, false);
});

test('размер ставит Rust, и именно новый', () => {
  // Раму меняет только он: у окна нет декораций, и window.resizeTo на нём не
  // работает. Пошли мы прежнее значение — режим переключился бы, а окно нет.
  // Сверяется поле, а не объект целиком: аргумент приезжает из чужого realm'а
  // vm, и deepStrictEqual спотыкается о прототип, а не о значение.
  const size = toggle(false).calls.find(c => c[0] === 'set_picker_size');
  assert.ok(size, 'set_picker_size не позван');
  assert.strictEqual(size[1].fullscreen, true);
  assert.strictEqual(
    toggle(true).calls.find(c => c[0] === 'set_picker_size')[1].fullscreen, false);
});

test('режим запоминается, а не живёт до перезапуска', () => {
  assert.ok(toggle(false).names.includes('saveUi'), 'saveUi не позван');
});

test('кнопка перекрашивается тут же, а не к следующему ответу агрегатора', () => {
  // Красит её paintToggles, и `render` его не зовёт: с дороги от настроек
  // (`ui-changed`) сюда доходит regroup, а отсюда — никто. Без этого вызова
  // кнопка отставала бы на одно нажатие.
  const { names } = toggle(false);
  assert.ok(names.includes('paintToggles'), `paintToggles не позван: ${names.join(', ')}`);
  assert.ok(names.indexOf('paintToggles') < names.indexOf('render'),
    `перекраска после отрисовки: ${names.join(', ')}`);
});

test('клавиша и кнопка зовут одну и ту же функцию', () => {
  // Ровно то, ради чего работа вынесена из обработчика клавиш. Вторая копия
  // разъехалась бы с первой молча.
  assert.match(SESSIONS_HTML, /e\.code === 'KeyF'[\s\S]{0,400}?toggleFullscreen\(\)/,
    '^F больше не зовёт toggleFullscreen');
  assert.match(SESSIONS_HTML, /wideButton\.addEventListener\('click'[\s\S]{0,300}?toggleFullscreen\(\)/,
    'кнопка не зовёт toggleFullscreen');
});

test('клик по кнопке не всплывает до статуслайна', () => {
  // На статуслайне висит смена сортировки: без остановки всплытия переключение
  // раскладки заодно крутило бы её. Та же цена уже уплачена шестерёнкой.
  const handler = SESSIONS_HTML.match(
    /wideButton\.addEventListener\('click',[\s\S]*?\n {2}\}\);/);
  assert.ok(handler, 'обработчик клика по кнопке не найден');
  assert.match(handler[0], /stopPropagation\(\)/, 'клик всплывёт и крутанёт сортировку');
});

test('подпись кнопки называет действие и обе раскладки', () => {
  // Строка видна человеку и сверяется дословно — правка формулировки обязана
  // проходить через этот тест. Названо действие, а не текущее состояние: так
  // читается всякая кнопка, а состояние видно подсветкой.
  assert.ok(SESSIONS_HTML.includes("'Narrow view (Ctrl+F)'"), 'нет подписи узкой раскладки');
  assert.ok(SESSIONS_HTML.includes("'Wide view (Ctrl+F)'"), 'нет подписи широкой раскладки');
});
