(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const agentApi = typeof module === 'object' && module.exports
    ? require('./session-agent')
    : globalThis.SessionAgent;

  /**
   * Строки списка из ответа агрегатора.
   *
   * Фоновый агент своей строки не получает: у него нет ни терминала, ни
   * заголовка — он форкнут от родителя и работает вместо него. Его поля
   * подставляются в строку родителя, а сам он из списка исключается.
   */
  function buildSessionList({ sessions, seen } = {}) {
    const list = Array.isArray(sessions) ? sessions : [];
    const byId = {};
    for (const s of list) if (s && s.id) byId[s.id] = s;
    const marks = seen || {};

    return list
      .filter(s => s && s.id && s.kind !== 'background')
      .map(s => {
        const active = agentApi.activeAgent(s, byId);
        const agent = active.agent;
        const focusedAt = marks[s.id];
        return {
          id: s.id,
          title: s.title || '',
          cwd: s.cwd || '',
          live: Boolean(s.live),
          frozen: Boolean(s.frozen),
          pid: s.pid || 0,
          tty: s.tty || '',
          tmux: s.tmux || null,
          kind: s.kind || 'interactive',
          mtime: s.mtime || 0,
          gist: s.gist || '',
          branch: (agent || {}).branch || '',
          prUrl: (agent || {}).pr_url || '',
          state: (agent || {}).state || '',
          event: (agent || {}).event || '',
          summary: agentApi.sessionDescription(agent),
          prompt: (agent || {}).prompt || '',
          cost: (agent || {}).costUsd || 0,
          contextPct: (agent || {}).contextPct || 0,
          updated: agentApi.lastActivityAt(agent) || 0,
          unread: Boolean(agent) && !agentApi.seenSinceUpdate(agent, focusedAt),
          background: active.background,
          agentSessionId: active.id,
        };
      });
  }

  return { buildSessionList };
});
