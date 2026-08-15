// Справочник клавиш в окне пикера: разметка, порядок кнопок и источник списка.
//
// Сборку строк сторожит key-reference.test.js — она чистая и проверяется
// напрямую. Здесь проверяется то, что живёт только в sessions.html и ломается
// молча: порядок кнопок в статуслайне, наличие третьей ветки обработчика и
// то, что список собирается помощником, а не переписан в странице руками.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

test('кнопки статуслайна идут в своём порядке: `?`, раскладка, шестерёнка', () => {
  // Порядок этот человек видит и к нему привыкает, а держится он на одной
  // строке CSS: вправо ряд прижимает первая кнопка. Переставь их местами — и
  // отступ окажется в середине ряда, то есть дырой во всю ширину.
  const keys = SESSIONS_HTML.indexOf('id="keys-button"');
  const wide = SESSIONS_HTML.indexOf('id="wide-button"');
  const gear = SESSIONS_HTML.indexOf('id="settings-button"');
  assert.ok(keys > 0, 'кнопки `?` нет в разметке');
  assert.ok(wide > 0, 'кнопки раскладки нет в разметке');
  assert.ok(gear > 0, 'шестерёнки нет в разметке');
  assert.ok(keys < wide, 'кнопка раскладки оказалась перед `?`');
  assert.ok(wide < gear, 'кнопка раскладки оказалась после шестерёнки');
});

test('все три кнопки статуслайна несут общий класс', () => {
  // На нём висит и курсор, и подсветка, и отступ. Кнопка без класса выглядела
  // бы нерабочей: ни руки-курсора, ни отклика на наведение.
  for (const id of ['keys-button', 'wide-button', 'settings-button']) {
    const tag = SESSIONS_HTML.match(new RegExp(`<span id="${id}"[^>]*>`));
    assert.ok(tag, `${id} пропал из разметки`);
    assert.match(tag[0], /class="icon-button"/, `${id} без класса icon-button`);
  }
});

test('вправо ряд прижимает ровно одна кнопка', () => {
  // Здесь стояла цепочка из двух правил — отступ у `?` и его гашение у
  // шестерёнки соседним селектором, — и третья кнопка между ними разорвала бы
  // её молча. Второй `margin-left: auto` в ряду означал бы дыру.
  const styles = SESSIONS_HTML.split('</style>')[0];
  const pushers = (styles.match(/#(keys|wide|settings)-button[^{]*\{[^}]*margin-left:\s*auto/g) || []);
  assert.strictEqual(pushers.length, 1, `прижимающих правил ${pushers.length}: ${pushers.join(' | ')}`);
  assert.match(pushers[0], /#keys-button/, 'прижимает не первая кнопка ряда');
});

test('справочник собирается помощником, а не переписан в странице', () => {
  // Третья копия списка клавиш разошлась бы с обработчиком молча: окно
  // обещало бы клавишу, которую никто не слушает. За эту ошибку в проекте
  // уже заплачено дважды.
  assert.ok(/KeyReference\.buildKeyReference\(/.test(SESSIONS_HTML),
    'страница не зовёт buildKeyReference — список, похоже, написан руками');
});

test('key-reference.js загружается и в окне, и в сборке статики', () => {
  // Модуль, забытый в prepare-frontend.js, есть в разработке и отсутствует в
  // собранном бинаре — а падает это уже у человека.
  assert.ok(SESSIONS_HTML.includes('<script src="key-reference.js"></script>'),
    'sessions.html не грузит key-reference.js');
  const prepare = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'prepare-frontend.js'), 'utf8');
  assert.ok(prepare.includes('frontend-src/key-reference.js'),
    'prepare-frontend.js не копирует key-reference.js');
  // Порядок обязателен: key-reference берёт таблицу у action-hotkey в момент
  // загрузки, и в обратном порядке ему достался бы undefined.
  assert.ok(prepare.indexOf('action-hotkey.js') < prepare.indexOf('key-reference.js'),
    'в prepare-frontend.js key-reference стоит раньше action-hotkey');
  assert.ok(SESSIONS_HTML.indexOf('src="action-hotkey.js"')
    < SESSIONS_HTML.indexOf('src="key-reference.js"'),
    'в sessions.html key-reference стоит раньше action-hotkey');
});

test('справочник открывают F1 и Ctrl+?, и обе решает одна функция', () => {
  const source = SESSIONS_HTML.match(/\n {2}function isKeysHotkey\(e\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(source, 'isKeysHotkey не найдена — клавиши справочника решаются где-то ещё');
  assert.ok(/e\.key === 'F1'/.test(source[0]), 'ветки F1 в isKeysHotkey нет');
  // По коду, а не по знаку: в русской раскладке на этой клавише точка, и
  // `e.key` пришёл бы ею.
  assert.ok(/e\.code === 'Slash'/.test(source[0]), 'вторая клавиша сверяется не по e.code');
  assert.ok(/e\.ctrlKey \|\| e\.metaKey/.test(source[0]), 'вторая клавиша идёт без модификатора');
  // Голого `?` в обработчике быть не должно: он печатный знак, и прямая ветка
  // отобрала бы его у поля поиска насовсем — та же цена, за которую `seen`
  // уехал с `^V` на `^D`.
  assert.ok(!/e\.key === '\?'/.test(SESSIONS_HTML),
    '`?` повешен клавишей без модификатора — он нужен полю поиска');
  // Открывает и закрывает одна и та же функция: две проверки разошлись бы, и
  // справочник открывался бы клавишей, которой не закрывается.
  // Скобка на конце отсекает само объявление — считаются вызовы.
  assert.strictEqual((SESSIONS_HTML.match(/isKeysHotkey\(e\)\)/g) || []).length, 2,
    'isKeysHotkey зовётся не из обеих веток — открытие и закрытие разъедутся');
});

test('открытый справочник разбирается раньше остальных клавиш', () => {
  // Иначе Enter внутри модалки открыл бы выбранную строку списка за её спиной.
  const guard = SESSIONS_HTML.indexOf('if (keysOpen) {');
  const open = SESSIONS_HTML.indexOf('if (isKeysHotkey(e)) {');
  assert.ok(guard > 0, 'ранней ветки keysOpen нет');
  assert.ok(open > 0, 'ветки, открывающей справочник, нет');
  assert.ok(guard < open, 'keysOpen разбирается позже, чем открывающая его клавиша');
});

test('статуслайн больше не пересказывает список клавиш', () => {
  // Строка росла с каждой новой клавишей, занимала весь статуслайн и при этом
  // недоговаривала. Полный список живёт в модалке, где условность каждой
  // клавиши доживает до строки.
  const hint = SESSIONS_HTML.match(/menuHint\.textContent = ([^;]+);/);
  assert.ok(hint, 'menuHint не найден — тест сторожит не то');
  for (const key of ['^P', '^L', '^H', '^S', '^F', '^N']) {
    assert.ok(!hint[1].includes(key), `${key} всё ещё пересказан в статуслайне`);
  }
  assert.ok(hint[1].includes('^K'), 'вход в меню строки из статуслайна пропал');
});
