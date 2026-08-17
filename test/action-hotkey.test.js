const { test } = require('node:test');
const assert = require('node:assert');
const {
  BUILTIN_ACTION_KEYS, BUILTIN_SHORTCUTS, RESERVED_CODES,
  parseHotkey, isReserved, matchesHotkey, formatHotkey, builtinGlyph, menuKeys,
} = require('../frontend-src/action-hotkey');

/** Событие клавиатуры в том объёме, в каком его читает matchesHotkey. */
function ev(code, mods = {}) {
  return {
    code,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
  };
}

test('комбинация разбирается в модификаторы и физическую клавишу', () => {
  assert.deepStrictEqual(parseHotkey('Ctrl+Shift+E'), {
    code: 'KeyE', ctrl: true, meta: false, alt: false, shift: true,
  });
  assert.deepStrictEqual(parseHotkey('Cmd+1'), {
    code: 'Digit1', ctrl: false, meta: true, alt: false, shift: false,
  });
});

test('имена модификаторов принимаются в привычных написаниях', () => {
  const alt = parseHotkey('alt+shift+q');
  assert.strictEqual(alt.alt, true);
  assert.strictEqual(alt.shift, true);
  assert.strictEqual(alt.code, 'KeyQ');
  // Option — это Alt, Command и Super — это Meta.
  assert.strictEqual(parseHotkey('Option+Q').alt, true);
  assert.strictEqual(parseHotkey('Command+Q').meta, true);
  assert.strictEqual(parseHotkey('Super+Q').meta, true);
});

test('негодная комбинация даёт null, а не исключение', () => {
  // Конфиг правит человек, и опечатка в одной комбинации не должна лишать его
  // пикера: вызывающий на null оставляет действие в меню, но без клавиши.
  assert.strictEqual(parseHotkey('Ctrl+Влево'), null);
  assert.strictEqual(parseHotkey('Хрен+E'), null);
  assert.strictEqual(parseHotkey(''), null);
  assert.strictEqual(parseHotkey(null), null);
  assert.strictEqual(parseHotkey(42), null);
});

test('голая буква без модификатора не комбинация', () => {
  // Фокус в окне всегда стоит в поле поиска — такая клавиша ушла бы в фильтр.
  assert.strictEqual(parseHotkey('E'), null);
  assert.strictEqual(parseHotkey('Ctrl'), null);
  // Имя из цепочки прототипов — не модификатор. Иначе `constructor+E`
  // разбирался бы в комбинацию без единого флага, то есть в ту самую голую
  // букву, и срабатывал бы на набранное в поиске «E».
  assert.strictEqual(parseHotkey('constructor+E'), null);
  assert.strictEqual(parseHotkey('toString+E'), null);
  assert.strictEqual(formatHotkey('constructor+E'), 'constructor+E');
});

// Прямые клавиши действий гасят событие через preventDefault, а поле поиска в
// пикере сфокусировано всегда. Буква действия, совпавшая с правкой текста,
// отобрала бы её насовсем: `^V` перестал бы вставлять то, что ищут. Ярлыки
// режимов (`^P`, `^L`, `^H`, `^S`) в этот список не входят намеренно: они
// клавишу тоже отнимают, но сознательно, и цена `^H` на macOS записана в
// action-hotkey.js.
test('буква действия не отбирает у поиска буфер обмена', () => {
  const editing = ['c', 'v', 'x', 'z'];
  for (const [id, letter] of Object.entries(BUILTIN_ACTION_KEYS)) {
    assert.ok(!editing.includes(letter), `действие ${id} забрало ^${letter.toUpperCase()}`);
  }
});

test('занятыми считаются встроенные клавиши окна и только они', () => {
  for (const letter of Object.values(BUILTIN_ACTION_KEYS)) {
    assert.strictEqual(isReserved(parseHotkey(`Ctrl+${letter}`)), true, `Ctrl+${letter}`);
    assert.strictEqual(isReserved(parseHotkey(`Cmd+${letter}`)), true, `Cmd+${letter}`);
  }
  // Меню — не действие, но клавишу занимает.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+K')), true);
  // И `^P` — тоже не действие, а ярлык `/p ` в строке поиска; отдавать эту
  // букву настроенному действию нельзя, встроенная ветка перехватит первой.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+P')), true);
  assert.strictEqual(isReserved(parseHotkey('Cmd+P')), true);
  // `^L` и `^H` — ярлыки своих сессий и истории, по тому же правилу.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+L')), true);
  assert.strictEqual(isReserved(parseHotkey('Ctrl+H')), true);
  // А `^A` вернулся полю поиска: ярлык проектов уехал на `^P`, и «выделить
  // всё» в строке поиска снова работает.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+A')), false);
  assert.strictEqual(isReserved(parseHotkey('Cmd+A')), false);
  // ^S — ярлык режима снимков, не действие. Отдать его настроенному действию
  // значило бы увести `^S` в действие, а режим оставить только набором руками.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+S')), true);
  assert.strictEqual(isReserved(parseHotkey('Cmd+S')), true);
  // ^F — ярлык широкого режима, не действие. Не займи его окно, встроенная
  // ветка съедала бы событие у действия, которое человек назначил на Ctrl+F,
  // и оно молча перестало бы работать.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+F')), true);
  assert.strictEqual(isReserved(parseHotkey('Cmd+F')), true);
  // Та же буква с добавленным модификатором свободна.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Shift+K')), false);
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Alt+P')), false);
  // Ctrl и Cmd вместе окно не ловит.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Cmd+P')), false);
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Shift+E')), false);
  assert.strictEqual(isReserved(null), false);
});

// Справочник клавиш (модалка по `?`/F1) и RESERVED_CODES обязаны расти из
// одной таблицы. Написанный руками второй список разошёлся бы с первым молча:
// окно показывало бы клавишу, которую никто не слушает, — или, наоборот,
// незанятая буква досталась бы настроенному действию, которое встроенная
// ветка съедала бы первой. Ровно за это уже заплачено списком `c v x z` и
// правилом про `KeyF`.
test('RESERVED_CODES вырастает из таблицы справочника, а не пишется рядом', () => {
  assert.deepStrictEqual(RESERVED_CODES, BUILTIN_SHORTCUTS.map(s => s.code),
    'два списка разошлись — значит, один из них написан руками');
});

test('у каждой клавиши в таблице есть подпись', () => {
  // Пустая подпись — строка в справочнике, которая ничего не объясняет.
  for (const entry of BUILTIN_SHORTCUTS) {
    assert.ok(entry.code, `запись без code: ${JSON.stringify(entry)}`);
    assert.ok(entry.label && entry.label.trim(), `клавиша ${entry.code} без подписи`);
  }
});

test('каждое встроенное действие названо в таблице своей клавишей', () => {
  // Иначе действие есть, клавиша работает, а в справочнике её нет.
  for (const [id, letter] of Object.entries(BUILTIN_ACTION_KEYS)) {
    const code = `Key${letter.toUpperCase()}`;
    const entry = BUILTIN_SHORTCUTS.find(s => s.code === code);
    assert.ok(entry, `действие ${id} (${code}) выпало из таблицы`);
    assert.strictEqual(entry.action, id, `${code} назван не тем действием`);
  }
});

test('условная клавиша помечена в таблице, а не отбирается по месту', () => {
  // `^S` показывается только там, где трекер жив: подсказка про режим,
  // которого нет, обманывает так же, как молчащий Enter. Признак живёт в
  // таблице, чтобы справочник не пересказывал условие своими словами.
  const snapshots = BUILTIN_SHORTCUTS.find(s => s.code === 'KeyS');
  assert.strictEqual(snapshots.needsTracker, true);
  const other = BUILTIN_SHORTCUTS.filter(s => s.needsTracker);
  assert.deepStrictEqual(other.map(s => s.code), ['KeyS'], 'условная клавиша ровно одна');
});

test('встроенная клавиша показывается в том же виде, что и в статуслайне', () => {
  assert.strictEqual(builtinGlyph('KeyK'), '^K');
  assert.strictEqual(builtinGlyph('KeyF'), '^F');
  // Не буква — отдаётся как есть: у `Comma` своего знака нет, и выдумывать
  // его ради одной строки незачем.
  assert.strictEqual(builtinGlyph('Comma'), '^,');
});

test('событие сверяется по физической клавише', () => {
  const parsed = parseHotkey('Ctrl+Shift+E');
  assert.strictEqual(matchesHotkey(ev('KeyE', { ctrl: true, shift: true }), parsed), true);
  // Раскладка на code не влияет — это и есть причина сверять его, а не key.
  assert.strictEqual(matchesHotkey(ev('KeyF', { ctrl: true, shift: true }), parsed), false);
});

test('лишний модификатор в событии комбинацию не подходит', () => {
  // Иначе Ctrl+E срабатывал бы и на Ctrl+Shift+E, отбирая клавишу у соседа.
  const parsed = parseHotkey('Ctrl+E');
  assert.strictEqual(matchesHotkey(ev('KeyE', { ctrl: true }), parsed), true);
  assert.strictEqual(matchesHotkey(ev('KeyE', { ctrl: true, shift: true }), parsed), false);
  assert.strictEqual(matchesHotkey(ev('KeyE', { ctrl: true, alt: true }), parsed), false);
  // Ctrl и Cmd взаимозаменяемыми не считаются: конфиг свой на каждой машине.
  assert.strictEqual(matchesHotkey(ev('KeyE', { meta: true }), parsed), false);
});

test('без разобранной комбинации не совпадает ничего', () => {
  assert.strictEqual(matchesHotkey(ev('KeyE', { ctrl: true }), null), false);
  assert.strictEqual(matchesHotkey(null, parseHotkey('Ctrl+E')), false);
});

test('комбинация показывается символами, а не словами', () => {
  assert.strictEqual(formatHotkey('Ctrl+K'), '^K');
  assert.strictEqual(formatHotkey('Ctrl+Shift+E'), '^⇧E');
  assert.strictEqual(formatHotkey('Cmd+Shift+1'), '⌘⇧1');
  assert.strictEqual(formatHotkey('Alt+Shift+Q'), '⌥⇧Q');
});

test('порядок модификаторов не зависит от того, как их написали', () => {
  // Ctrl+Shift+E и Shift+Ctrl+E — одна и та же комбинация. Показывать её
  // двумя способами значит заставлять читателя сверять по буквам.
  assert.strictEqual(formatHotkey('Shift+Ctrl+E'), formatHotkey('Ctrl+Shift+E'));
});

test('функциональная клавиша доживает до подсказки', () => {
  // parseHotkey такую комбинацию не разбирает вовсе (только буквы и цифры), а
  // проектные хоткеи в конфиге — как раз Ctrl+F11/F12.
  assert.strictEqual(formatHotkey('Ctrl+F12'), '^F12');
});

test('непонятную строку formatHotkey отдаёт как есть', () => {
  // Конфиг правит человек, и опечатка не должна стирать подсказку целиком.
  assert.strictEqual(formatHotkey('Хрен+E'), 'Хрен+E');
  assert.strictEqual(formatHotkey('  Ctrl+  '), 'Ctrl+');
  assert.strictEqual(formatHotkey(''), '');
  assert.strictEqual(formatHotkey(null), '');
});

test('ярлыки режимов заняли свои буквы, а pr уступил свою', () => {
  // `^P` отдан ярлыку проектов, поэтому `pr` переехал на свободную `g`
  // (GitHub). Без переезда встроенная ветка перехватывала бы первой, и
  // действие молчало бы — ровно та поломка, за которую уже заплачено списком
  // `c v x z` и правилом про `KeyF`.
  assert.strictEqual(BUILTIN_ACTION_KEYS.pr, 'g');
  for (const code of ['KeyP', 'KeyL', 'KeyH', 'KeyS', 'KeyF', 'KeyK', 'KeyG']) {
    assert.ok(RESERVED_CODES.includes(code), code);
  }
  // `^A` вернулся полю поиска: ярлык проектов ушёл на `^P`, и «выделить всё»
  // в строке поиска снова работает.
  assert.ok(!RESERVED_CODES.includes('KeyA'));
});

test('буквы пунктов меню: встроенные из таблицы, настроенные из menuKey', () => {
  // Вторая таблица тех же букв разошлась бы с первой, поэтому встроенные
  // берутся из BUILTIN_ACTION_KEYS, а не переписываются здесь.
  const keys = menuKeys([
    { id: 'new', label: 'New session' },
    { id: 'cursor', label: 'Open in Cursor', menuKey: 'o' },
    { id: 'info', label: 'Session info' },
  ]);
  assert.deepStrictEqual(keys, ['n', 'o', 'i']);
});

test('букву забирает первый сверху пункт', () => {
  // Порядок меню человек видит глазами; второй список приоритетов разошёлся
  // бы с ним, а молчащая буква хуже отсутствующей.
  const keys = menuKeys([
    { id: 'new', label: 'New session' },
    { id: 'note', label: 'Note', menuKey: 'n' },
  ]);
  assert.deepStrictEqual(keys, ['n', '']);
});

test('буквой бывает только латинская буква', () => {
  // Нажатие сверяется по e.code (`KeyO`), а кириллицу и знаки им не назвать
  // вовсе: подпись обещала бы клавишу, которой не нажать.
  const keys = menuKeys([
    { id: 'a', label: 'A', menuKey: 'щ' },
    { id: 'b', label: 'B', menuKey: '5' },
    { id: 'c', label: 'C', menuKey: 'X' },
    { id: 'd', label: 'D' },
  ]);
  assert.deepStrictEqual(keys, ['', '', 'x', '']);
});
