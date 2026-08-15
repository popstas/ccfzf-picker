const { test } = require('node:test');
const assert = require('node:assert');
const { buildKeyReference } = require('../frontend-src/key-reference');
const { BUILTIN_SHORTCUTS } = require('../frontend-src/action-hotkey');

/** Развернуть секции в плоский список строк — так их удобнее искать. */
function flat(sections) {
  return sections.flatMap(s => s.rows);
}

function findKey(sections, key) {
  return flat(sections).find(r => r.key === key);
}

test('встроенные клавиши приезжают из таблицы, а не переписаны здесь', () => {
  // Тот самый единственный источник: пропусти справочник хоть одну запись —
  // окно молчало бы про работающую клавишу.
  const sections = buildKeyReference({ trackerHere: true });
  const shown = flat(sections).map(r => r.key);
  for (const entry of BUILTIN_SHORTCUTS) {
    assert.ok(shown.includes(`^${entry.code === 'Comma' ? ',' : entry.code.replace('Key', '')}`),
      `клавиша ${entry.code} выпала из справочника`);
  }
});

test('условная клавиша исчезает вместе с условием', () => {
  // `^S` без трекера — обещание режима, которого нет: та же ложь, что и
  // молчащий Enter.
  const withTracker = buildKeyReference({ trackerHere: true });
  const without = buildKeyReference({ trackerHere: false });
  assert.ok(findKey(withTracker, '^S'), 'с трекером ^S показан');
  assert.strictEqual(findKey(without, '^S'), undefined, 'без трекера ^S не обещается');
  // Остальные встроенные от трекера не зависят и никуда не деваются.
  assert.ok(findKey(without, '^K'));
  assert.ok(findKey(without, '^F'));
});

test('настроенные человеком действия названы своей комбинацией', () => {
  const sections = buildKeyReference({
    trackerHere: false,
    actions: [
      { id: 'edit', label: 'Open in editor', hotkey: 'Ctrl+Shift+E' },
      // Без клавиши — только пункт меню ^K, и в справочнике клавиш ему нечего
      // делать: строка без клавиши обещала бы клавишу.
      { id: 'noop', label: 'No hotkey' },
    ],
  });
  const row = findKey(sections, '^⇧E');
  assert.ok(row, 'настроенное действие не попало в справочник');
  assert.strictEqual(row.label, 'Open in editor');
  assert.strictEqual(flat(sections).some(r => r.label === 'No hotkey'), false);
});

test('глобальные хоткеи названы отдельно — они работают при скрытом окне', () => {
  const sections = buildKeyReference({
    trackerHere: false,
    hotkey: 'Cmd+Shift+C',
    projectsHotkey: 'Option+Cmd+Shift+C',
  });
  const global = sections.find(s => /hidden/i.test(s.title));
  assert.ok(global, 'секции глобальных клавиш нет');
  const keys = global.rows.map(r => r.key);
  assert.ok(keys.includes('⌘⇧C'), keys.join(' '));
  // Порядок знаков фиксированный (⌘⌥⇧), а не тот, что написан в конфиге, —
  // см. formatHotkey. Справочник берёт его как есть, ради единого вида.
  assert.ok(keys.includes('⌘⌥⇧C'), keys.join(' '));
});

test('пустой projectsHotkey не показывается пустой строкой', () => {
  // Пустое поле значит «взять встроенное», а встроенное живёт в Rust и
  // отсюда не видно. Показать пустую клавишу — соврать точнее, чем промолчать.
  const sections = buildKeyReference({ trackerHere: false, hotkey: 'Cmd+Shift+C', projectsHotkey: '' });
  const global = sections.find(s => /hidden/i.test(s.title));
  assert.deepStrictEqual(global.rows.map(r => r.key), ['⌘⇧C']);
});

test('проектные хоткеи приезжают из ответа агрегатора', () => {
  const sections = buildKeyReference({
    trackerHere: false,
    projects: [
      { label: 'picker', cwd: '/home/me/picker', hotkey: 'Ctrl+F11' },
      { label: 'no key', cwd: '/home/me/other', hotkey: '' },
    ],
  });
  const row = findKey(sections, '^F11');
  assert.ok(row, 'проектный хоткей не попал в справочник');
  assert.strictEqual(row.label, 'picker');
  assert.strictEqual(flat(sections).some(r => r.label === 'no key'), false);
});

test('не вставшая клавиша показана зачёркнутой, а не убрана', () => {
  // Убери её — и человек не отличит «не настроено» от «отобрал сосед по
  // системе». Ровно это расследование однажды заняло полдня.
  const sections = buildKeyReference({
    trackerHere: false,
    projects: [{ label: 'picker', cwd: '/home/me/picker', hotkey: 'Ctrl+F11' }],
    hotkeysTaken: [{ cwd: '/home/me/picker', hotkey: 'Ctrl+F11', reason: 'reserved' }],
  });
  const row = findKey(sections, '^F11');
  assert.ok(row, 'зачёркнутая клавиша всё равно показывается');
  assert.strictEqual(row.taken, true);
});

test('пустых секций в справочнике не бывает', () => {
  // Заголовок без строк обещает то, чего нет.
  const sections = buildKeyReference({ trackerHere: false });
  for (const section of sections) {
    assert.ok(section.rows.length, `секция «${section.title}» пуста`);
  }
});

test('мусор на входе не роняет справочник', () => {
  // Конфиг правит человек, ответ агрегатора приезжает с чужой машины.
  for (const opts of [undefined, {}, { actions: null, projects: 'nope', hotkeysTaken: 7 }]) {
    const sections = buildKeyReference(opts);
    assert.ok(Array.isArray(sections) && sections.length, JSON.stringify(opts));
  }
});
