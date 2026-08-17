(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const agentApi = typeof module === 'object' && module.exports
    ? require('./session-agent')
    : globalThis.SessionAgent;
  const windowApi = typeof module === 'object' && module.exports
    ? require('./session-windows')
    : globalThis.SessionWindows;

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
  /**
   * Имена машин чужих окон этой строки.
   *
   * Своё имя тут шум: у большинства строк окно там же, где пикер, и колонка из
   * повторяющегося имени машины не сообщала бы ничего. Окон бывает несколько,
   * и тогда названы все чужие — а то, что среди них есть и своё, видно по
   * лишнему глифу рядом.
   *
   * Наружу — имя как его написал трекер, а не приведённое к нижнему регистру:
   * сравнивают машины без учёта регистра, а показывают как есть.
   */
  function foreignHosts(s, state, configHost) {
    const mine = windowApi.normHost(configHost);
    const out = [];
    for (const w of windowApi.windowsOf(s, state)) {
      const host = windowApi.normHost(w.host);
      if (!host || host === mine) continue;
      const named = String(w.host).trim();
      if (!out.includes(named)) out.push(named);
    }
    return out;
  }

  function buildSessionList({ sessions, seen, state, configHost } = {}) {
    const list = Array.isArray(sessions) ? sessions : [];
    const byId = {};
    for (const s of list) if (s && s.id) byId[s.id] = s;
    const marks = seen || {};

    return list
      .filter(s => s && s.id && s.kind !== 'background')
      .map(s => {
        const active = agentApi.activeAgent(s, byId);
        const agent = active.agent;
        // Отметок о просмотре две, и обе настоящие. Своя — от открытия сессии
        // из списка; она единственная там, где оконного трекера нет вовсе (на
        // маке). Чужая приезжает в `window` от трекера: он видит переход
        // взгляда на окно сессии, а пикер об этом не узнаёт ниоткуда — окон он
        // не видит, и без неё список продолжал бы звать к сессии, на которую
        // человек уже сходил руками.
        //
        // Побеждает поздняя: «посмотрел» верно с той секунды, когда посмотрели,
        // чем бы это ни было. Обратный ход — «Mark unread» — поэтому и не может
        // быть только местным: отмотанную здесь отметку трекерная перебила бы
        // на следующем же опросе, и её отматывают у трекера (см. markUnread в
        // sessions.html).
        //
        // Окон бывает несколько — сессию открывают на двух машинах сразу, — и
        // складывать надо по всем: смотрели на сессию, а не на окно, и взгляд
        // на любое из них гасит зов не хуже, чем взгляд на первое.
        const wins = windowApi.windowsOf(s, state);
        const focusedAt = Math.max(
          marks[s.id] || 0,
          ...wins.map(w => (w || {}).focusedAt || 0),
          0,
        );
        return {
          id: s.id,
          title: s.title || '',
          cwd: s.cwd || '',
          live: Boolean(s.live),
          frozen: Boolean(s.frozen),
          pid: s.pid || 0,
          tty: s.tty || '',
          tmux: s.tmux || null,
          // Зелийная сессия, в которой живёт процесс. Того же рода, что и
          // `tmux`, и читает её то же место (chooseOpenStrategy): отсоединённая
          // зелийная сессия — единственный случай, когда терминал сессии
          // существует, но не открыт нигде, и без этого поля найти его нечем.
          zellij: s.zellij || null,
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
          // Все окна сессии: её открывают и на двух машинах сразу. Список
          // приезжает готовым от агрегатора, порядок — «свежайший взгляд
          // первым», и здесь он не пересчитывается.
          windows: wins,
          // Машины чужих окон, через запятую, — и только когда они не наши.
          //
          // Своё имя тут шум: у большинства строк окно там же, где пикер, и
          // колонка из повторяющегося имени машины не сообщала бы ничего.
          // Отбор идёт здесь, а не в отрисовщике: `windowsOf` уже разбирается,
          // откуда взять `host` на старом агрегаторе, и второй разбор той же
          // развилки в глифе разошёлся бы с этим молча.
          windowHost: foreignHosts(s, state, configHost).join(', '),
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
          // started — не про то, кто сейчас работает, а про саму строку: она
          // принадлежит сессии, а не форку, который её на время увёл. Поэтому
          // здесь `s.agent`, а не активный `agent` — единственное поле из
          // четырёх, взятое не у него.
          agentStarted: (s.agent || {}).started || 0,
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
