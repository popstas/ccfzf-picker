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
   * Имя машины окна этой карточки, если оно чужое, и пустота, если своё.
   *
   * Своё имя тут шум: у большинства карточек окно там же, где пикер, и поле
   * из повторяющегося имени машины не сообщало бы ничего. Наружу — имя как
   * его написал трекер, а не приведённое к нижнему регистру: сравнивают
   * машины без учёта регистра (`windowApi.normHost`), а показывают как есть.
   *
   * Раньше это была функция `foreignHosts`, отдававшая список: одна строка
   * несла все окна сессии разом, и чужих машин у неё могло быть несколько.
   * Теперь окон в строке одно (карточка — по одной на окно), и вопрос всегда
   * «эта машина своя или чужая», а не «какие из них чужие».
   */
  function windowHostOf(win, configHost) {
    const raw = win && win.host;
    const host = windowApi.normHost(raw);
    if (!host) return '';
    const mine = windowApi.normHost(configHost);
    if (host === mine) return '';
    return String(raw).trim();
  }

  function buildSessionList({ sessions, seen, state, configHost } = {}) {
    const list = Array.isArray(sessions) ? sessions : [];
    const byId = {};
    for (const s of list) if (s && s.id) byId[s.id] = s;
    const marks = seen || {};

    const rows = [];
    for (const s of list) {
      if (!s || !s.id || s.kind === 'background') continue;
      const active = agentApi.activeAgent(s, byId);
      const agent = active.agent;
      // Все окна сессии: её открывают и на двух машинах сразу. Список
      // приезжает готовым от агрегатора, порядок — «свежайший взгляд
      // первым», и здесь он не пересчитывается.
      const sessionWindows = windowApi.windowsOf(s, state);
      const mark = marks[s.id] || 0;

      // Сессия с N окнами даёт N карточек — по одной на окно, — а сессия без
      // окон одну, как и раньше. Общие для сессии поля (работа агента,
      // стоимость, контекст) при этом повторяются на каждой карточке: агент
      // один, и ждёт он человека через любое из окон.
      const perCard = sessionWindows.length ? sessionWindows : [null];
      for (const w of perCard) {
        // Отметок о просмотре две, и обе настоящие. Своя — от открытия сессии
        // из списка; она единственная там, где оконного трекера нет вовсе (на
        // маке). Чужая приезжает от трекера **этого** окна: он видит переход
        // взгляда именно на него, а пикер об этом не узнаёт ниоткуда.
        //
        // Побеждает поздняя: «посмотрел» верно с той секунды, когда
        // посмотрели, чем бы это ни было. Обратный ход — «Mark unread» —
        // поэтому и не может быть только местным: отмотанную здесь отметку
        // трекерная перебила бы на следующем же опросе, и её отматывают у
        // трекера, причём у **всех** окон сессии разом (см. unreadBases в
        // session-windows.js и markUnread в sessions.html) — иначе сосед,
        // которого не тронули, вернул бы «просмотрено» на первой же карточке.
        const focusedAt = Math.max(mark, (w || {}).focusedAt || 0, 0);
        rows.push({
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
          // Своё окно этой карточки — то же самое, что и единственный элемент
          // `windows` ниже. `null`, а не отсутствие поля: у отрисовщика не
          // должно быть третьего случая «поля нет вовсе». «Окна нет» и «про
          // окна ничего не известно» сознательно неразличимы — разница видна
          // только в конфиге, а по строке списка её не показать.
          window: w,
          // Своё окно карточки, одним элементом. Отсюда получится и один
          // глиф на карточке, и верный Enter: `focusWindowOf` ходит через
          // `windowsOf`, а та читает именно это поле.
          windows: w ? [w] : [],
          // Машина этого окна, если она чужая, и пустота, если своя.
          windowHost: windowHostOf(w, configHost),
          // Заголовок своего окна — то самое имя, которым сессию завёл человек
          // (`claude -n tray-build-time`): по нему её и опознают. `title`
          // строки приезжает из транскрипта (custom-title/ai-title) и с ним
          // расходится — у долгой сессии он остаётся от той работы, ради
          // которой её когда-то завели. Поле отдельное, потому что читателей у
          // него двое: поиск (picker-filter.js) и подпись рядом с именем
          // (windowNameHtml). Пустая строка, а не отсутствие поля: стог поиска
          // склеивается из полей, и недостающее уехало бы туда словом
          // `undefined`.
          windowTitle: (w || {}).title || '',
          // Все окна сессии целиком, без урезания до «своего». Единственный
          // потребитель — unreadBases (session-windows.js): отмотка
          // «просмотрено» обязана уйти каждому трекеру сессии, а не только
          // трекеру окна этой карточки, — поэтому поле отдельное от `windows`,
          // а не общее с ним.
          sessionWindows,
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
          // Отметка открытия/взгляда, epoch-секунды: максимум своей (из
          // seen.json) и focusedAt именно этого окна — не всех окон сессии.
          // У карточки с двумя окнами это время своё для каждой.
          focusedAt: focusedAt || 0,
        });
      }
    }
    return rows;
  }

  return { buildSessionList };
});
