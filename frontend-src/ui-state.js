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
  function normalizeUiState(raw, defaults) {
    const base = defaults || {};
    const baseToggles = base.toggles || {};
    const src = raw && typeof raw === 'object' ? raw : {};
    const srcToggles = src.toggles && typeof src.toggles === 'object' ? src.toggles : {};

    const toggles = {};
    for (const key of Object.keys(baseToggles)) {
      toggles[key] = typeof srcToggles[key] === 'boolean' ? srcToggles[key] : !!baseToggles[key];
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

  return { normalizeUiState, uiStateToSave };
});
