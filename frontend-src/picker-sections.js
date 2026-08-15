// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerSections = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const filterApi = typeof module === 'object' && module.exports
    ? require('./picker-filter')
    : globalThis.PickerFilter;

  // Колонки широкого режима. Раскладка задана человеком и держится на смысле
  // строк, а не на их числе:
  //
  //   1 — свои живые сессии (и зелий): главный список, ему отдана вся высота;
  //   2 — чужие живые сессии, под ними проекты;
  //   3 — история, под ней снимки.
  //
  // Номер живёт здесь, а не в CSS: колонку выбирают по тому же признаку, по
  // которому секция собрана (`group.remote`, `group.past`), а разбор заголовка
  // сделал бы видимую человеку строку форматом.
  const COLUMN_LIVE = 1;
  const COLUMN_NEAR = 2;
  const COLUMN_PAST = 3;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * Заголовок секции: подпись, счёт и — у свёрнутой истории — дата последней
   * сессии.
   *
   * Одна функция на обе раскладки. Счёт приписывается здесь, а не в
   * `groupSessions`: там он попадал бы в `label`, а по `label` считался ключ —
   * и уснувшая сессия сбрасывала бы свёрнутость секции.
   *
   * Месяц из своей таблицы, а не toLocaleDateString: у того вид зависит от
   * локали системы, а всё видимое человеку у нас английское. Дата местная
   * (getMonth/getDate), потому что «когда я в это заходил» человек меряет
   * своими часами.
   */
  function sectionHeaderText(section) {
    const head = `${section.label} - ${section.count}`;
    if (!section.collapsed || !section.lastAt) return head;
    const d = new Date(section.lastAt * 1000);
    return `${head} · last ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  function lastActivityOf(sessions) {
    return sessions.reduce((max, s) => Math.max(max, (s || {}).lastActivity || 0), 0);
  }

  // Заголовок склеенной секции: тот же, каким чужие сессии назывались до
  // деления по машинам. Имени машины в нём быть не может — секция одна на все.
  const REMOTE_LABEL = 'Active remote sessions';
  // Ключ склеенной секции не зависит от набора машин: по ключу помнится и
  // отрисовка, и свёрнутость, и считайся он от имён — уснувшая на соседней
  // машине сессия пересобирала бы колонку целиком.
  const REMOTE_KEY = 'remote';

  /**
   * Подзаголовок машины внутри склеенной секции чужих сессий.
   *
   * Строка эта — подпись, а не строка списка: выбрать её нельзя, Enter на ней
   * не сработает, и в `rows` страницы она не попадает вовсе (см. `subheadItem`
   * в sessions.html). Поэтому же она не входит в `count`.
   */
  function subheadRow(group) {
    return {
      kind: 'block-subhead',
      key: `sub:${group.host}`,
      label: `${group.host} - ${group.sessions.length}`,
    };
  }

  /**
   * Свёрнута ли секция, если человек её не трогал.
   *
   * В узком списке история оттесняет вниз то, что работает сейчас, а проекты и
   * снимки — справочники, за которыми приходят намеренно. В широком у каждой
   * из них своя колонка, и оттеснять там некого: умолчание перевёрнуто вместе
   * с причиной.
   */
  function defaultCollapsed(section, layout) {
    if (layout !== 'narrow') return false;
    return section.past === true || section.kind === 'projects' || section.kind === 'snapshots';
  }

  /**
   * Входит ли группа сессий в названный режим.
   *
   * Зелий виден только в общем списке: `/l` — это «мои сессии агента», а зелий
   * справочник о том, что ещё открыто на машине.
   */
  function groupInMode(group, mode) {
    if (mode === 'sessions') return true;
    if (mode === 'local') return group.key === 'live';
    if (mode === 'remote') return group.remote === true;
    if (mode === 'history') return group.past === true;
    return false;
  }

  const SESSION_MODES = ['sessions', 'local', 'remote', 'history'];

  /**
   * Секции списка — одни и те же для обеих раскладок.
   *
   * Своего правила группировки у раскладки нет: секции приезжают из
   * groupSessions один в один. От раскладки зависят ровно три вещи — склейка
   * чужих групп, номер колонки и умолчание свёрнутости; все три перечислены
   * ниже поимённо и больше нигде не решаются.
   *
   * Отбор идёт теми же filterSessions/filterProjects, что и раньше: запрос без
   * префикса отбирает строки во всех секциях сразу, и секция, где не нашлось
   * ничего, исчезает.
   *
   * `opts.collapsed` — карта «ключ секции → свёрнута ли», то, что человек
   * трогал руками. Отсутствие ключа значит «как по умолчанию», а не «развёрнута»:
   * так умолчание остаётся в коде и его можно менять, не переписывая людям
   * ui.json. В режиме с префиксом карта не спрашивается вовсе — названная
   * секция всегда развёрнута, иначе `/h` при свёрнутой истории показал бы один
   * заголовок, то есть ничего.
   */
  function buildSections(opts) {
    const o = opts || {};
    const mode = o.mode || 'sessions';
    const query = o.query || '';
    const wide = o.layout === 'wide';
    const override = o.collapsed && typeof o.collapsed === 'object' ? o.collapsed : {};
    const sections = [];

    if (SESSION_MODES.includes(mode)) {
      let remote = null;
      for (const group of filterApi.filterSessions(o.groups || [], query)) {
        if (!groupInMode(group, mode)) continue;
        // Склейка чужих групп — только в широкой раскладке, и только потому,
        // что секция там занимает колонку. Узнаётся чужая группа по своей
        // пометке (`group.remote`), а не по заголовку: заголовок носит имя
        // машины — данные с той стороны, — и разбор текста сделал бы это имя
        // форматом, который нельзя менять.
        if (wide && group.remote) {
          if (!remote) {
            remote = {
              key: REMOTE_KEY, label: REMOTE_LABEL, kind: 'sessions',
              rows: [], count: 0, lastAt: 0, past: false, column: COLUMN_NEAR,
            };
            sections.push(remote);
          }
          remote.rows = [...remote.rows, subheadRow(group), ...group.sessions];
          remote.count += group.sessions.length;
          continue;
        }
        sections.push({
          key: group.key, label: group.label, kind: 'sessions',
          rows: group.sessions, count: group.sessions.length,
          lastAt: lastActivityOf(group.sessions),
          past: group.past === true,
          ...(wide ? { column: group.past ? COLUMN_PAST : COLUMN_LIVE } : {}),
        });
      }
    }

    // Проекты и снимки — секции того же списка, а не отдельные режимы: их
    // видно сразу, свёрнутыми, и префикс оставляет на экране одну из них.
    if (mode === 'sessions' || mode === 'projects') {
      const rows = filterApi.filterProjects(o.projects || [], query);
      if (rows.length) {
        sections.push({
          key: 'projects', label: 'Projects', kind: 'projects',
          rows, count: rows.length, lastAt: 0, past: false,
          ...(wide ? { column: COLUMN_NEAR } : {}),
        });
      }
    }
    // Снимки уже отобраны запросом на стороне buildSnapshotRows: у них своя
    // пара «заголовок раскладки и её сессии», и отбор строкой порознь порвал
    // бы её. trackerHere — то же условие, что у ^S.
    if ((mode === 'sessions' || mode === 'snapshots') && o.trackerHere) {
      const rows = o.snapshots || [];
      if (rows.length) {
        sections.push({
          key: 'snapshots', label: 'Snapshots', kind: 'snapshots',
          rows, count: rows.length, lastAt: 0, past: false,
          ...(wide ? { column: COLUMN_PAST } : {}),
        });
      }
    }

    const shaped = sections.map(section => ({
      ...section,
      collapsed: mode !== 'sessions' ? false
        : (typeof override[section.key] === 'boolean'
          ? override[section.key]
          : defaultCollapsed(section, wide ? 'wide' : 'narrow')),
    }));

    // Порядок секций в узкой раскладке — порядок сборки: живые, чужие,
    // история, зелий, проекты, снимки. В широкой он пересчитывается по
    // колонкам: колонка за колонкой, сверху вниз внутри колонки. По этому же
    // порядку ходят `←/→` (moveBetweenBlocks), и разъедься он с видимым,
    // стрелка уводила бы не туда, куда смотрит глаз. Сортировка устойчива,
    // поэтому внутри колонки секции остаются в порядке сборки.
    if (!wide) return shaped;
    return shaped
      .map((section, at) => ({ section, at }))
      .sort((a, b) => (a.section.column - b.section.column) || (a.at - b.at))
      .map(({ section }) => section);
  }

  /** Индексы строк одной секции, в порядке показа. */
  function blockIndexes(rows, block) {
    const out = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].block === block) out.push(i);
    return out;
  }

  /**
   * `↑/↓` — внутри своей секции, с упором в края.
   *
   * Не по кругу, в отличие от узкого списка: там круг возвращает к началу
   * единственного списка, а здесь он гонял бы по одной колонке из шести, и на
   * глаз это неотличимо от «выбор застрял».
   */
  function moveInBlocks(rows, active, delta) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    const current = list[active];
    if (!current) return 0;
    const indexes = blockIndexes(list, current.block);
    const at = indexes.indexOf(active);
    const next = Math.min(indexes.length - 1, Math.max(0, at + delta));
    return indexes[next];
  }

  /**
   * `←/→` — в соседнюю секцию, на строку с тем же порядковым номером.
   *
   * Сосед короче — берётся его последняя строка: прыжок в начало сбивал бы
   * глаз, который держится за высоту строки, а не за её номер.
   */
  function moveBetweenBlocks(rows, active, delta) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return 0;
    const current = list[active];
    if (!current) return 0;
    const blocks = [...new Set(list.map(r => r.block))];
    const at = blocks.indexOf(current.block);
    const target = blocks[at + delta];
    if (target === undefined) return active;
    const offset = blockIndexes(list, current.block).indexOf(active);
    const indexes = blockIndexes(list, target);
    return indexes[Math.min(offset, indexes.length - 1)];
  }

  return { buildSections, sectionHeaderText, moveInBlocks, moveBetweenBlocks };
});
