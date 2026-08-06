// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionAgent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Строка, которую показывают все читатели.
   *
   * Считается в одном месте, чтобы не расходилась: `summary` пуст, пока ход
   * не закончен, и у работающей сессии годится только `lastSummary`.
   *
   * У сессии, стоящей на вопросе, обе сводки перебивает сам вопрос: сводка
   * отвечает «чем закончила», а такая сессия ничем не закончила — она ждёт, и
   * нужно от неё ровно одно: что у неё спросили.
   *
   * Сверка с состоянием обязательна, и она не перестраховка. Поле `question`
   * живёт только пока вызов AskUserQuestion не закрыт, но состояние `question`
   * хук ставит и на запрос разрешения — а там текста вопроса нет нигде. Без
   * сверки такая сессия показала бы вопрос, на который давно ответили.
   */
  function sessionDescription(agent) {
    const question = typeof (agent || {}).question === 'string' ? agent.question.trim() : '';
    if (question && (agent || {}).state === 'question') return question;
    const summary = typeof (agent || {}).summary === 'string' ? agent.summary.trim() : '';
    if (summary) return summary;
    return typeof (agent || {}).lastSummary === 'string' ? agent.lastSummary.trim() : '';
  }

  /** Когда сессия последний раз подавала признаки жизни, epoch-секунды. */
  function lastActivityAt(agent) {
    const updated = (agent || {}).updated || 0;
    return updated || null;
  }

  /**
   * Видел ли человек то состояние, в котором сессия находится сейчас.
   *
   * На маке отметку ставит не трекер окон, а само открытие сессии, но правило
   * то же: переход в ту же секунду, что и запись состояния, — это переход
   * после неё, поэтому сравнение нестрогое.
   */
  function seenSinceUpdate(agent, focusedAt) {
    const updated = (agent || {}).updated || 0;
    if (!updated) return false;
    const seen = Number.isFinite(focusedAt) ? focusedAt : 0;
    return seen >= updated;
  }

  /**
   * Кто на самом деле работает в этой сессии: она сама или её фоновый агент.
   *
   * `claude agents` уводит работу в форк: интерактивный процесс уходит, окно
   * остаётся с прежним заголовком, а хуки с этого момента пишет форк — под
   * своим id. Берётся тот, чья запись свежее; родитель может ожить обратно.
   */
  function activeAgent(session, byId) {
    let best = { id: session.id, agent: session.agent || null, background: false };
    for (const key of Object.keys(byId || {})) {
      const child = byId[key];
      if (!child || child.kind !== 'background' || child.parent !== session.id) continue;
      if (!child.agent) continue;
      if ((child.agent.updated || 0) <= ((best.agent || {}).updated || 0)) continue;
      best = { id: child.id, agent: child.agent, background: true };
    }
    return best;
  }

  return { sessionDescription, lastActivityAt, seenSinceUpdate, activeAgent };
});
