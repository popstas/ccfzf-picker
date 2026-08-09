// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UiState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const groupsApi = typeof module === 'object' && module.exports
    ? require('./session-groups')
    : globalThis.SessionGroups;

  /**
   * Вид списка, прочитанный из ~/.config/ccfzf-picker/ui.json.
   *
   * Файл пишет сам пикер, но правит его кто угодно и чем угодно, а испорченный
   * вид списка — это пикер, который открывается пустым или без нужных колонок,
   * и починить его изнутри уже нечем. Поэтому здесь не доверяется ничего:
   * незнакомая сортировка заменяется умолчанием, чужие ключи чекбоксов
   * выбрасываются, нелогические значения заменяются умолчанием своего ключа.
   *
   * Набор чекбоксов задаётся `defaults.toggles`: он же и определяет, какие
   * ключи вообще существуют. Так пропавший из интерфейса чекбокс не остаётся
   * жить в файле, а новый получает своё умолчание, а не `false`.
   */

  /**
   * Умолчания одной галки в двух осях.
   *
   * `list` — показывать ли колонку в строке списка (это и значила старая
   * плоская галка). `statusline` — выносить ли галку в статуслайн: место там
   * кончилось, и решать, что туда попадёт, стал человек.
   */
  function axesOf(fallback) {
    if (typeof fallback === 'boolean') return { list: fallback, statusline: false };
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    return { list: Boolean(base.list), statusline: Boolean(base.statusline) };
  }

  /**
   * Одна галка из файла.
   *
   * Булево значение — это старая форма ui.json, и понимать её обязательно:
   * иначе первый же запуск после обновления сбросил бы человеку все колонки, и
   * выглядело бы это потерей настроек, а не сменой формата. Значение старой
   * галки кладётся в `list` — она ровно это и значила.
   */
  function normalizeToggle(saved, fallback) {
    const def = axesOf(fallback);
    if (typeof saved === 'boolean') return { list: saved, statusline: def.statusline };
    if (!saved || typeof saved !== 'object') return def;
    return {
      list: typeof saved.list === 'boolean' ? saved.list : def.list,
      statusline: typeof saved.statusline === 'boolean' ? saved.statusline : def.statusline,
    };
  }

  function normalizeUiState(raw, defaults) {
    const base = defaults || {};
    const baseToggles = base.toggles || {};
    const src = raw && typeof raw === 'object' ? raw : {};
    const srcToggles = src.toggles && typeof src.toggles === 'object' ? src.toggles : {};

    const toggles = {};
    for (const key of Object.keys(baseToggles)) {
      toggles[key] = normalizeToggle(srcToggles[key], baseToggles[key]);
    }
    return {
      sort: groupsApi.normalizeSort(src.sort),
      toggles,
    };
  }

  /**
   * Что уходит в файл. Ровно то же, что читается: лишнего в ui.json пикер не
   * пишет — файл маленький и человекочитаемый, и заглянувший в него не должен
   * гадать, что из этого пикер и правда помнит.
   */
  function uiStateToSave(sort, toggles) {
    return normalizeUiState({ sort, toggles }, { toggles: toggles || {} });
  }

  /**
   * Плоская карта «показывать ли колонку» для рисовальщиков строк.
   *
   * Отдельная функция, а не второе поле состояния: рисовальщикам
   * (session-glyph) про статуслайн знать незачем, а держать две карты в
   * рассинхроне — вернейший способ показать колонку, которую выключили.
   */
  function listColumns(toggles) {
    const out = {};
    for (const key of Object.keys(toggles || {})) out[key] = Boolean((toggles[key] || {}).list);
    return out;
  }

  return { normalizeUiState, uiStateToSave, listColumns };
});
