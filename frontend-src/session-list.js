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
   *
   * Имена полей здесь — те же, что читают отрисовщики (session-glyph.js,
   * session-info.js, session-groups.js, picker-filter.js): всё, что пришло из
   * записи агента, носит префикс `agent`, а `pr_url` и `lastActivity` названы
   * так же, как у них. Один словарь на весь проект — иначе строка собирается
   * под одними именами, а рисуется по другим, и половина колонок молча пустеет.
   * Единственное поле, которое строка не отдаёт наружу, — `label`: его
   * приписывает labelSessions (session-groups.js) уже над готовым списком.
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
          // Окно терминала, если оно у сессии открыто. Приходит готовым от
          // агрегатора: он читает файл, который кладёт рядом оконный трекер с
          // той машины, где сессии видны на экране. Здесь про окна знать
          // неоткуда — тут виден только транскрипт и процесс.
          //
          // `null`, а не отсутствие поля: у отрисовщика не должно быть третьего
          // случая «поля нет вовсе». «Окна нет» и «про окна ничего не известно»
          // сознательно неразличимы — разница видна только в конфиге, а по
          // строке списка её не показать.
          window: s.window || null,
          branch: (agent || {}).branch || '',
          pr_url: (agent || {}).pr_url || '',
          agentState: (agent || {}).state || '',
          agentEvent: (agent || {}).event || '',
          // Уведомление агента. Непусто только на attention; у сессии, ждущей
          // разрешения, это единственное, что о ней известно — текста самого
          // вопроса там нет нигде.
          agentMessage: (agent || {}).message || '',
          agentDescription: agentApi.sessionDescription(agent),
          agentPrompt: (agent || {}).prompt || '',
          agentCostUsd: (agent || {}).costUsd || 0,
          agentContextPct: (agent || {}).contextPct || 0,
          // Начало текущего хода и старт всей сессии. Ноль — «сессия старше
          // появления поля»: колонка возраста тогда откатывается на
          // lastActivity, а строки карточки не печатаются.
          agentTurnAt: (agent || {}).turnAt || 0,
          agentStarted: (agent || {}).started || 0,
          lastActivity: agentApi.lastActivityAt(agent) || 0,
          // «Человек это видел», а не «не видел»: отрисовщики спрашивают именно
          // так (dotState гасит кружок по agentSeen, карточка печатает
          // «seen: yes»). У сессии без записи агента видеть нечего — там false,
          // и звать она всё равно не будет: и кружок, и текст статуса завязаны
          // на пустой agentState.
          agentSeen: agentApi.seenSinceUpdate(agent, focusedAt),
          agentBackground: active.background,
          agentSessionId: active.id,
          // Отметка открытия сессии, epoch-секунды: карточка показывает её
          // строкой «focused», и без неё seen нечем объяснить.
          focusedAt: focusedAt || 0,
        };
      });
  }

  return { buildSessionList };
});
