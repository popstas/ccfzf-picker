const { test } = require('node:test');
const assert = require('node:assert');
const {
  BUILTIN_ACTION_KEYS, parseHotkey, isReserved, matchesHotkey, formatHotkey,
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
});

test('занятыми считаются встроенные клавиши окна и только они', () => {
  for (const letter of Object.values(BUILTIN_ACTION_KEYS)) {
    assert.strictEqual(isReserved(parseHotkey(`Ctrl+${letter}`)), true, `Ctrl+${letter}`);
    assert.strictEqual(isReserved(parseHotkey(`Cmd+${letter}`)), true, `Cmd+${letter}`);
  }
  // Меню — не действие, но клавишу занимает.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+K')), true);
  // Та же буква с добавленным модификатором свободна.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Shift+K')), false);
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Alt+P')), false);
  // Ctrl и Cmd вместе окно не ловит.
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Cmd+P')), false);
  assert.strictEqual(isReserved(parseHotkey('Ctrl+Shift+E')), false);
  assert.strictEqual(isReserved(null), false);
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
