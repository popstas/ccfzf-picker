const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeUiState, uiStateToSave, listColumns } = require('../frontend-src/ui-state');

const DEFAULTS = {
  sort: 'recent',
  toggles: {
    showPrompt: { list: true, statusline: true },
    showId: { list: false, statusline: true },
    showCost: { list: true, statusline: false },
  },
};

test('пустой файл даёт вид по умолчанию', () => {
  // Первый запуск: ui.json ещё нет, бэкенд отдаёт пустой объект.
  assert.deepStrictEqual(normalizeUiState({}, DEFAULTS), {
    sort: 'recent',
    toggles: {
      showPrompt: { list: true, statusline: true },
      showId: { list: false, statusline: true },
      showCost: { list: true, statusline: false },
    },
    fullscreen: false,
    collapsed: { narrow: {}, wide: {} },
  });
  assert.deepStrictEqual(normalizeUiState(null, DEFAULTS), normalizeUiState({}, DEFAULTS));
  assert.deepStrictEqual(normalizeUiState('мусор', DEFAULTS), normalizeUiState({}, DEFAULTS));
});

test('сохранённый вид возвращается как был', () => {
  const saved = {
    sort: 'name',
    toggles: {
      showPrompt: { list: false, statusline: true },
      showId: { list: true, statusline: false },
      showCost: { list: true, statusline: true },
    },
    fullscreen: true,
    collapsed: { narrow: { past: true }, wide: {} },
  };
  assert.deepStrictEqual(normalizeUiState(saved, DEFAULTS), saved);
});

test('незнакомая сортировка не доживает до списка', () => {
  // Иначе список остался бы в порядке, которого нет ни в одном режиме, а
  // подпись в статуслайне показывала бы слово, которого не понимает cycleSort.
  assert.strictEqual(normalizeUiState({ sort: 'по-моему' }, DEFAULTS).sort, 'recent');
  assert.strictEqual(normalizeUiState({ sort: 42 }, DEFAULTS).sort, 'recent');
  assert.strictEqual(normalizeUiState({ sort: null }, DEFAULTS).sort, 'recent');
});

test('набор чекбоксов задают умолчания, а не файл', () => {
  const saved = {
    toggles: {
      showId: { list: true, statusline: true },
      showДавноУбранный: { list: true, statusline: true },
    },
  };
  const ui = normalizeUiState(saved, DEFAULTS);
  // Пропавший из интерфейса чекбокс не тащится из файла дальше.
  assert.deepStrictEqual(Object.keys(ui.toggles), ['showPrompt', 'showId', 'showCost']);
  // Новый чекбокс получает своё умолчание, а не false: иначе добавление
  // колонки выключало бы её всем, у кого уже есть ui.json.
  assert.deepStrictEqual(ui.toggles.showPrompt, { list: true, statusline: true });
  assert.deepStrictEqual(ui.toggles.showId, { list: true, statusline: true });
});

test('старая плоская форма поднимается, а не выбрасывается', () => {
  // Главный тест этой правки. Не поняв старый ui.json, первый же запуск после
  // обновления сбросил бы человеку все колонки — и выглядело бы это как
  // потеря настроек, а не как несовместимость.
  const old = { sort: 'name', toggles: { showPrompt: false, showId: true, showCost: false } };
  const ui = normalizeUiState(old, DEFAULTS);
  assert.strictEqual(ui.sort, 'name');
  // Значение старой галки — это ось list: она и значила «показывать колонку».
  assert.strictEqual(ui.toggles.showPrompt.list, false);
  assert.strictEqual(ui.toggles.showId.list, true);
  // Ось statusline в старом файле не записана ничем — берётся умолчание ключа.
  assert.strictEqual(ui.toggles.showPrompt.statusline, true);
  assert.strictEqual(ui.toggles.showCost.statusline, false);
});

test('половина записанной оси не роняет вторую', () => {
  // Файл правят руками, и половина пары там встречается чаще целой.
  const ui = normalizeUiState({ toggles: { showId: { statusline: false } } }, DEFAULTS);
  assert.deepStrictEqual(ui.toggles.showId, { list: false, statusline: false });
});

test('нелогические оси заменяются умолчаниями своего ключа', () => {
  const ui = normalizeUiState({ toggles: { showPrompt: { list: 'да', statusline: 0 } } }, DEFAULTS);
  assert.deepStrictEqual(ui.toggles.showPrompt, { list: true, statusline: true });
});

test('смешанный toggles разбирается по ключам независимо', () => {
  // В одном файле встречаются сразу все формы: старая плоская галка (файл не
  // трогали со времён миграции), уже поднятая пара (файл переписан свежим
  // пикером) и мусор от неудачной ручной правки. normalizeToggle решает
  // каждый ключ отдельно, и одна форма не должна ломать разбор соседней.
  const ui = normalizeUiState({
    toggles: {
      showPrompt: true, // старая плоская форма
      showId: { list: true, statusline: false }, // уже двухосная
      showCost: 'да', // мусор — ни булево, ни объект
    },
  }, DEFAULTS);
  assert.deepStrictEqual(ui.toggles, {
    showPrompt: { list: true, statusline: true },
    showId: { list: true, statusline: false },
    showCost: { list: true, statusline: false },
  });
});

test('listColumns отдаёт плоскую карту для отрисовки', () => {
  // Рисовальщики строк (session-glyph) знают только «показывать колонку или
  // нет» и не должны узнавать про статуслайн: у них другая забота.
  const ui = normalizeUiState({}, DEFAULTS);
  assert.deepStrictEqual(listColumns(ui.toggles), {
    showPrompt: true, showId: false, showCost: true,
  });
});

test('режим окна читается из файла и переживает запись', () => {
  const ui = normalizeUiState({ fullscreen: true }, { toggles: {} });
  assert.strictEqual(ui.fullscreen, true);
  assert.strictEqual(uiStateToSave(ui.sort, ui.toggles, ui.fullscreen).fullscreen, true);
});

test('старый ui.json без режима читается как узкое окно', () => {
  // Умолчание — то, с чем пикер жил до появления режима: файл, написанный
  // прошлой версией, не должен открывать окно, которого человек не просил.
  assert.strictEqual(normalizeUiState({ sort: 'name' }, { toggles: {} }).fullscreen, false);
  assert.strictEqual(normalizeUiState(null, { toggles: {} }).fullscreen, false);
});

test('нелогичный режим в файле заменяется умолчанием', () => {
  assert.strictEqual(normalizeUiState({ fullscreen: 'да' }, { toggles: {} }).fullscreen, false);
});

test('в файл уходит ровно то, что читается обратно', () => {
  const toggles = {
    showPrompt: { list: false, statusline: true },
    showId: { list: true, statusline: false },
    showCost: { list: true, statusline: false },
  };
  const saved = uiStateToSave('name', toggles);
  assert.deepStrictEqual(saved,
    { sort: 'name', toggles, fullscreen: false, collapsed: { narrow: {}, wide: {} } });
  assert.deepStrictEqual(normalizeUiState(saved, DEFAULTS), saved);
  // Мусорная сортировка не должна попасть даже в файл: перезапуск молча
  // починит её, но человек, заглянувший в ui.json, увидел бы неправду.
  assert.strictEqual(uiStateToSave('нет такой', toggles).sort, 'recent');
});

test('свёрнутость читается по раскладкам и чистится от мусора', () => {
  const ui = normalizeUiState({
    collapsed: {
      narrow: { past: true, projects: 'да', snapshots: false },
      wide: { past: false },
      garbage: { x: true },
    },
  }, { toggles: {} });
  assert.deepStrictEqual(ui.collapsed, {
    narrow: { past: true, snapshots: false },
    wide: { past: false },
  });
});

test('старый ui.json без collapsed читается как «человек ничего не трогал»', () => {
  // Не поняв старый файл, первый же запуск после обновления сбросил бы
  // человеку настройки — и выглядело бы это потерей, а не сменой формата.
  for (const raw of [{}, { collapsed: null }, { collapsed: 'нет' }, { collapsed: [] }]) {
    assert.deepStrictEqual(
      normalizeUiState(raw, { toggles: {} }).collapsed,
      { narrow: {}, wide: {} },
    );
  }
});

test('свёрнутость доезжает до файла четвёртым аргументом', () => {
  const saved = uiStateToSave('cost', {}, false, { narrow: { past: true }, wide: {} });
  assert.deepStrictEqual(saved.collapsed, { narrow: { past: true }, wide: {} });
});
