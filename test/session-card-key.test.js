// Ключ карточки на окно: sessions.html поведенческим тестом не проверить —
// вся сборка строки и работа меню живут внутри одного файла без экспортов, —
// поэтому здесь текстовые сторожа, читающие исходник как строку. Они ловят
// ровно ту тихую развилку, которую описывает спека: два места, ищущие
// карточку по голому `session.id`, находят первую из пары и молча путают
// действие не с той карточкой, на которой его вызвали.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_HTML = fs.readFileSync(path.join(__dirname, '..', 'sessions.html'), 'utf8');

test('ключ строки собирает rowKey, а не голый `s:${id}`', () => {
  // Сессия с N окнами даёт N карточек с общим id — ключ `s:${session.id}`
  // слепил бы их в один узел, и planListSync правил бы вторую карточку поверх
  // первой при каждой перерисовке.
  assert.ok(/function rowKey\(/.test(SESSIONS_HTML),
    'rowKey не определена — строку больше нечем отличать от её двойника');
  assert.match(SESSIONS_HTML, /return \{ key: rowKey\(session\), html \};/,
    'sessionItem не зовёт rowKey — ключ карточки остался голым id');
});

test('rowKey различает машину окна этой карточки, а не row.windowHost', () => {
  // row.windowHost пуст у карточки со своим окном — оба своих окна дали бы
  // одинаковый пустой хвост ключа. Разбирать надо именно окно карточки
  // (session.window), приводя имя к сравнимому виду через normHost, как и
  // canFocusRow рядом.
  const match = SESSIONS_HTML.match(/function rowKey\([\s\S]{0,400}?\n  \}/);
  assert.ok(match, 'тело rowKey не найдено');
  const body = match[0];
  assert.match(body, /SessionWindows\.normHost/,
    'rowKey не приводит имя машины через normHost — регистр и пробелы будут слепливать разные машины');
  assert.match(body, /session\.window/,
    'rowKey не смотрит на окно самой карточки');
});

test('меню передаёт ключ карточки, а не только id', () => {
  // openMenu собирает данные для renderMenu; без ключа переоткрыть меню по
  // той самой карточке, на которой его вызвали, нечем.
  assert.match(SESSIONS_HTML, /renderMenu\(\{\s*id: session\.id,\s*key: rowKey\(session\),/,
    'openMenu не передаёт key: rowKey(session) в renderMenu');
});

test('runMenuAction ищет строку по ключу карточки, а не по голому id', () => {
  // На паре карточек `rows.find(r => r.id === id)` всегда находит первую —
  // действие («Mark unread», открытие, фокус) ушло бы не по той карточке, на
  // которой человек открыл меню.
  assert.ok(!/rows\.find\(r => r\.id === id\)/.test(SESSIONS_HTML),
    'runMenuAction всё ещё ищет строку по голому id — регрессия на паре карточек');
  assert.match(SESSIONS_HTML, /rows\.find\(r => rowKey\(r\) === key\)/,
    'runMenuAction не ищет строку по rowKey(r) === key');
});

test('меню держит переменную-ключ, а не menuSessionId', () => {
  // Старое имя намекало на «id сессии», а несёт оно теперь ключ карточки —
  // переименование делает несогласованность (кто-то забыл читатель) видимой
  // при первом же grep, а не молчаливой.
  assert.ok(!/menuSessionId/.test(SESSIONS_HTML),
    'menuSessionId всё ещё в коде — переменная не переведена на ключ карточки');
  assert.match(SESSIONS_HTML, /let menuKey = null;/);
  assert.match(SESSIONS_HTML, /menuKey = data\.key;/);
  assert.match(SESSIONS_HTML, /menuKey = null;/);
});
