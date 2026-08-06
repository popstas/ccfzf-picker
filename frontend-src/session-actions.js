// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const glyphApi = typeof module === 'object' && module.exports
    ? require('./session-glyph')
    : globalThis.SessionGlyph;
  const openApi = typeof module === 'object' && module.exports
    ? require('./open-strategy')
    : globalThis.OpenStrategy;
  const pathApi = typeof module === 'object' && module.exports
    ? require('./path-map')
    : globalThis.PathMap;

  // Номер PR берётся у отрисовщика строки, а не разбирается здесь вторым
  // регэкспом. Два разбора одной ссылки разъезжаются молча: строка показала бы
  // бейдж «↗ #3» там, где меню не даёт пункта, или наоборот. Заодно это
  // единственное место, где проверяется форма ссылки перед тем, как она уйдёт
  // в аргумент команды открытия браузера, — дублировать такую проверку опасно.
  const prNumber = glyphApi.prNumber;

  /**
   * Что пикер может предложить для этой строки.
   *
   * Информация есть всегда: она рисуется из той же строки и ничего не
   * запрашивает. Возврат в непрочитанное бессмыслен и без записи агента
   * (`lastActivity === 0` — нечего отматывать), и у строки, которую и так не
   * читали: на маке «читал» — это `agentSeen`, отметку ставит открытие сессии.
   *
   * Открытия сессии в списке нет намеренно: оно висит на Enter и на клике, а не
   * прячется в меню.
   *
   * Настроенные действия открытия папки идут первыми: они самые частые, а
   * встроенные — про случай (есть PR, есть pid). Появляются они только там, где
   * путь сессии удалось перевести на эту машину: пункт, открывающий несуществующую
   * папку, хуже отсутствующего.
   *
   * `config` необязателен — без него список прежний. Так вызов остаётся годным
   * и там, где конфига под рукой нет (тесты формы строки).
   */
  function availableActions(row, config) {
    const actions = [];
    const cfg = config || {};
    if (pathApi.mapPath((row || {}).cwd, cfg.pathMap) !== null) {
      for (const a of cfg.actions || []) actions.push({ id: a.id, label: a.label, hotkey: a.hotkey });
    }
    const num = prNumber((row || {}).pr_url);
    if (num) actions.push({ id: 'pr', label: `Open PR #${num}` });
    if (row && row.lastActivity && row.agentSeen) actions.push({ id: 'unread', label: 'Mark unread' });
    // Переклейка предлагается только там, где ей есть за что тянуть: живая
    // сессия с известным pid. Пикер эту команду не выполняет — отдаёт человеку,
    // см. buildAttachCommand.
    if (row && row.live && openApi.buildAttachCommand(row)) {
      actions.push({ id: 'attach', label: 'Copy reptyr command' });
    }
    actions.push({ id: 'info', label: 'Session info' });
    return actions;
  }

  return { prNumber, availableActions };
});
