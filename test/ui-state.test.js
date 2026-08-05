const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeUiState, uiStateToSave } = require('../frontend-src/ui-state');

const DEFAULTS = {
  sort: 'cost',
  toggles: { showPrompt: true, showId: false, showCost: true },
};

test('пустой файл даёт вид по умолчанию', () => {
  // Первый запуск: ui.json ещё нет, бэкенд отдаёт пустой объект.
  assert.deepStrictEqual(normalizeUiState({}, DEFAULTS), {
    sort: 'cost',
    toggles: { showPrompt: true, showId: false, showCost: true },
  });
  assert.deepStrictEqual(normalizeUiState(null, DEFAULTS), normalizeUiState({}, DEFAULTS));
  assert.deepStrictEqual(normalizeUiState('мусор', DEFAULTS), normalizeUiState({}, DEFAULTS));
});

test('сохранённый вид возвращается как был', () => {
  const saved = { sort: 'name', toggles: { showPrompt: false, showId: true, showCost: true } };
  assert.deepStrictEqual(normalizeUiState(saved, DEFAULTS), saved);
});

test('незнакомая сортировка не доживает до списка', () => {
  // Иначе список остался бы в порядке, которого нет ни в одном режиме, а
  // подпись в статуслайне показывала бы слово, которого не понимает cycleSort.
  assert.strictEqual(normalizeUiState({ sort: 'по-моему' }, DEFAULTS).sort, 'cost');
  assert.strictEqual(normalizeUiState({ sort: 42 }, DEFAULTS).sort, 'cost');
  assert.strictEqual(normalizeUiState({ sort: null }, DEFAULTS).sort, 'cost');
});

test('набор чекбоксов задают умолчания, а не файл', () => {
  const saved = { toggles: { showId: true, showДавноУбранный: true } };
  const ui = normalizeUiState(saved, DEFAULTS);
  // Пропавший из интерфейса чекбокс не тащится из файла дальше.
  assert.deepStrictEqual(Object.keys(ui.toggles), ['showPrompt', 'showId', 'showCost']);
  // Новый чекбокс получает своё умолчание, а не false: иначе добавление
  // колонки выключало бы её всем, у кого уже есть ui.json.
  assert.strictEqual(ui.toggles.showPrompt, true);
  assert.strictEqual(ui.toggles.showId, true);
});

test('нелогическое значение чекбокса заменяется умолчанием', () => {
  // 'false' строкой — самая частая правка руками, и она правдива в JS.
  const ui = normalizeUiState({ toggles: { showPrompt: 'false', showCost: 0 } }, DEFAULTS);
  assert.strictEqual(ui.toggles.showPrompt, true);
  assert.strictEqual(ui.toggles.showCost, true);
});

test('в файл уходит ровно то, что читается обратно', () => {
  const toggles = { showPrompt: false, showId: true, showCost: true };
  const saved = uiStateToSave('name', toggles);
  assert.deepStrictEqual(saved, { sort: 'name', toggles });
  assert.deepStrictEqual(normalizeUiState(saved, DEFAULTS), saved);
  // Мусорная сортировка не должна попасть даже в файл: перезапуск молча
  // починит её, но человек, заглянувший в ui.json, увидел бы неправду.
  assert.strictEqual(uiStateToSave('нет такой', toggles).sort, 'cost');
});
