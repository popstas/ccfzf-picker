/** Pure shaping of the claude-wt session list for the picker. No I/O. */
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
// The project has no bundler, and duplicating this logic to make it testable
// would be worse than this shim.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const listApi = typeof module === 'object' && module.exports
    ? require('./session-list')
    : globalThis.SessionList;
  const zellijApi = typeof module === 'object' && module.exports
    ? require('./zellij-list')
    : globalThis.ZellijList;

  // Сессия с неизвестным столом сортируется перед всеми настоящими.
  const DESKTOP_UNKNOWN = -1;

  const SORT_MODES = ['cost', 'oldest', 'newest', 'recent', 'name'];
  const DEFAULT_SORT = 'recent';

  function normalizeSort(mode) {
    return SORT_MODES.includes(mode) ? mode : DEFAULT_SORT;
  }

  function cycleSort(mode) {
    const current = normalizeSort(mode);
    const i = SORT_MODES.indexOf(current);
    return SORT_MODES[(i + 1) % SORT_MODES.length];
  }

  /**
   * Имя, под которым сессию видно везде: строка списка, поиск, заголовок
   * диалога.
   *
   * Раньше здесь же двойники — одинаковые имя и проект, то есть переоткрытая
   * сессия или пара «живая и протухшая» — получали к имени хвост из четырёх
   * знаков id: больше на строке ничего не различалось. Теперь у короткого id своя
   * колонка со своим чекбоксом, и хвост стал вторым способом показать то же самое
   * — в имени, где он мешает и в списке, и в заголовках диалогов, и на панели.
   *
   * Ничего, кроме показа, на label не завязано: строки списка узнаются по
   * `s:<id>`, фокус уходит тоже по id.
   */
  function labelSessions(sessions) {
    return sessions.map(s => ({ ...s, label: s.title }));
  }

  function nameOf(s) {
    return s.label ?? s.title ?? '';
  }

  /** Missing / zero sort keys sink to the end so incomplete rows don't float up. */
  function missingLast(aVal, bVal, asc) {
    const aMissing = !aVal;
    const bMissing = !bVal;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return asc ? aVal - bVal : bVal - aVal;
  }

  function tieBreak(a, b) {
    return nameOf(a).localeCompare(nameOf(b)) || String(a.id).localeCompare(String(b.id));
  }

  /**
   * Ключ сортировки `recent` — минута последней активности, а не секунда.
   *
   * `lastActivity` двигает каждый вызов инструмента, а их десятки в минуту.
   * Подача тикает раз в секунду, и две работающие сессии на секундном ключе
   * менялись первым местом непрерывно — попасть по такой строке нельзя. С
   * округлением обе попадают в одну корзину, дальше их разводит tieBreak по
   * имени, и порядок перестаёт зависеть от того, кто дёрнулся последним.
   *
   * Округление до **абсолютной** минуты, а не до возраста ((now - t) / 60):
   * ключ не зависит от часов, и функция остаётся чистой.
   *
   * Ноль остаётся нулём — missingLast топит такие строки вниз, и делить их с
   * настоящей минутой было бы нечем. А вот `Math.max(1, …)` не для красоты:
   * деление само делает ноль из всякой метки моложе минуты, и без нижней
   * границы сессия, работавшая полминуты назад, притворилась бы строкой без
   * активности вовсе и утонула бы к ним в конец.
   *
   * В строке возраст по-прежнему с секундами: округление живёт только здесь,
   * ageHtml его не знает.
   */
  const MINUTE = 60;

  function recentKey(s) {
    const t = (s || {}).lastActivity ?? 0;
    return t ? Math.max(1, Math.floor(t / MINUTE)) : 0;
  }

  function compareSessions(a, b, mode) {
    const sort = normalizeSort(mode);
    let primary = 0;
    if (sort === 'cost') {
      primary = missingLast(a.agentCostUsd ?? 0, b.agentCostUsd ?? 0, false);
    } else if (sort === 'oldest') {
      primary = missingLast(a.agentStarted ?? 0, b.agentStarted ?? 0, true);
    } else if (sort === 'newest') {
      primary = missingLast(a.agentStarted ?? 0, b.agentStarted ?? 0, false);
    } else if (sort === 'recent') {
      primary = missingLast(recentKey(a), recentKey(b), false);
    } else if (sort === 'name') {
      primary = nameOf(a).localeCompare(nameOf(b));
    }
    return primary || tieBreak(a, b);
  }

  function sortGroupSessions(sessions, mode) {
    return sessions.sort((a, b) => compareSessions(a, b, mode));
  }

  /**
   * Живые сессии — одной группой сверху, остальные — под общим заголовком.
   *
   * На macOS нет ни окон, ни виртуальных столов, ни мониторов (см. Global
   * Constraints плана) — `s.desktop` в объектах, которые отдаёт `ccfzf
   * --state`, не бывает, так что группа мёртвых сессий здесь всегда одна на
   * весь список. Группировка по ключу `desktop` осталась внутри ради
   * структуры (несколько групп, отсортированных по номеру стола) — на этом
   * проекте она просто вырождается в единственную группу с одним и тем же
   * ключом `null`.
   *
   * Живые не делятся на подгруппы намеренно: их несколько, ищут их глазами, и
   * «что из этого работает прямо сейчас» важнее любой дальнейшей разбивки.
   *
   * Внутри группы — выбранный режим сортировки (по умолчанию cost desc).
   */
  function groupSessions(sessions, sort = DEFAULT_SORT) {
    const mode = normalizeSort(sort);
    // Зелийные строки отбираются до всего остального: у них live: true, и
    // живая группа всосала бы их к работающим агентам, где им не место.
    // Своя группа стоит последней — это справочник «что ещё открыто на
    // машине», а не то, к чему возвращаются в первую очередь.
    const zellij = [];
    const rest = [];
    for (const s of sessions) (s.kind === 'zellij' ? zellij : rest).push(s);
    sessions = rest;
    const open = [];
    const groups = new Map();
    for (const s of sessions) {
      // На маке нет окон — «открыта» здесь означает «процесс жив».
      if (s.live) { open.push(s); continue; }
      const desktop = s.desktop ?? null;
      const key = `${desktop}`;
      if (!groups.has(key)) {
        groups.set(key, { desktop, label: desktop === null ? 'Not running' : `Desktop ${desktop}`, sessions: [] });
      }
      groups.get(key).sessions.push(s);
    }

    const past = [...groups.values()];
    for (const g of past) sortGroupSessions(g.sessions, mode);
    past.sort((a, b) => (a.desktop ?? DESKTOP_UNKNOWN) - (b.desktop ?? DESKTOP_UNKNOWN));

    const tail = zellij.length
      ? [{ desktop: null, label: `Zellij - ${zellij.length}`, sessions: sortGroupSessions(zellij, mode) }]
      : [];

    if (!open.length) return [...past, ...tail];
    sortGroupSessions(open, mode);
    return [{ desktop: null, label: `Active sessions - ${open.length}`, sessions: open },
            ...past, ...tail];
  }

  /**
   * Ответ агрегатора (`ccfzf --state`) — в тот пакет claude-wt-sessions,
   * который читает пикер.
   *
   * Здесь и сходится вся цепочка, и другого места у неё нет: buildSessionList
   * превращает сырые сессии в строки, labelSessions приписывает им имя, под
   * которым их видно и ищут, groupSessions раскладывает по группам и сортирует.
   * Пропусти середину — и строка приедет в разметку без `label`: имя
   * нарисуется как `undefined`, а поиск перестанет находить хоть что-нибудь.
   *
   * `opts.onlyLive` оставляет в списке одни работающие сессии. Отсев идёт
   * здесь, а не до buildSessionList: фоновый агент ищется по всему ответу, и
   * отними у него соседей заранее — живая сессия, чью работу ведёт форк,
   * осталась бы без записи агента и выглядела бы замершей.
   *
   * `opts.onlyWindow` оставляет одни сессии с открытым окном. Само поле
   * `window` приезжает уже в ответе агрегатора и приписывается строке в
   * buildSessionList — здесь остаётся только отсев.
   *
   * Pure: берёт уже полученный `res`, сама ничего не читает.
   */
  function buildSessionsPayload(res, sort = DEFAULT_SORT, opts = {}) {
    const mode = normalizeSort(sort);
    if (!res.ok) return { ok: false, reason: res.reason };
    let rows = listApi.buildSessionList({ sessions: res.sessions, seen: res.seen });
    if (opts.onlyLive) rows = rows.filter(r => r.live);
    if (opts.onlyWindow) rows = rows.filter(r => r.window);
    // Отсевы выше — про сессии агента, и на зелийные строки они не
    // распространяются: окна у зелийной сессии нет никогда, и onlyWindow
    // вычистил бы весь режим целиком. Поэтому строки подмешиваются после.
    const zellij = zellijApi.buildZellijList({ zellij: res.zellij });
    return { ok: true, groups: groupSessions([...labelSessions(rows), ...zellij], mode), sort: mode };
  }

  return {
    SORT_MODES,
    DEFAULT_SORT,
    normalizeSort,
    cycleSort,
    compareSessions,
    labelSessions,
    groupSessions,
    buildSessionsPayload,
  };
});
