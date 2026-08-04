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
   */
  function availableActions(row) {
    const actions = [];
    const num = prNumber((row || {}).pr_url);
    if (num) actions.push({ id: 'pr', label: `Open PR #${num}` });
    if (row && row.lastActivity && row.agentSeen) actions.push({ id: 'unread', label: 'Mark unread' });
    actions.push({ id: 'info', label: 'Session info' });
    return actions;
  }

  return { prNumber, availableActions };
});
