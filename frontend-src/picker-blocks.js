// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const filterApi = typeof module === 'object' && module.exports
    ? require('./picker-filter')
    : globalThis.PickerFilter;

  // Сворачивается только история: ради неё сворачивание и заведено — «что
  // было раньше» в широком окне не должно оттеснять вниз «что работает
  // сейчас». Признак — заголовок группы, который ставит groupSessions.
  const COLLAPSED_LABELS = ['Not running'];

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * Подпись свёрнутого блока: сколько сессий и когда была последняя.
   *
   * Месяц из своей таблицы, а не toLocaleDateString: у того вид зависит от
   * локали системы, а всё видимое человеку у нас английское — на чужой локали
   * подпись разошлась бы с остальным списком. Дата местная (getMonth/getDate),
   * потому что «когда я в это заходил» человек меряет своими часами.
   */
  function collapsedLabel(count, lastAt) {
    const word = count === 1 ? 'session' : 'sessions';
    if (!lastAt) return `${count} ${word}`;
    const d = new Date(lastAt * 1000);
    return `${count} ${word} · last ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  function lastActivityOf(sessions) {
    return sessions.reduce((max, s) => Math.max(max, (s || {}).lastActivity || 0), 0);
  }

  /** Одна строка свёрнутого блока. Enter на ней разворачивает блок. */
  function collapsedRow(block) {
    return {
      kind: 'block-toggle',
      blockKey: block.key,
      count: block.rows.length,
      label: collapsedLabel(block.rows.length, lastActivityOf(block.rows)),
    };
  }

  /**
   * Блоки широкого режима.
   *
   * Блоки сессий приезжают из groupSessions один в один: своего деления у
   * fullscreen нет намеренно — второе правило группировки разошлось бы с
   * первым на первой же правке, а признак деления живых («своё окно или
   * чужое») тот же, что решает поведение Enter.
   *
   * Отбор идёт теми же filterSessions/filterProjects, что и в узком списке:
   * запрос без префикса отбирает строки во всех блоках сразу, и блок, где не
   * нашлось ничего, исчезает.
   */
  function buildBlocks(opts) {
    const o = opts || {};
    const mode = o.mode || 'sessions';
    const query = o.query || '';
    const expanded = new Set(o.expanded || []);
    const blocks = [];

    if (mode === 'sessions') {
      for (const group of filterApi.filterSessions(o.groups || [], query)) {
        blocks.push({
          key: `g:${group.label}`, label: group.label, kind: 'sessions',
          rows: group.sessions, collapsed: false,
        });
      }
    }

    // Проекты и снимки — блоки того же ряда, а не отдельные режимы: в широком
    // окне они помещаются рядом с сессиями. Префикс при этом смысла не теряет,
    // он оставляет на экране один блок.
    if (mode === 'sessions' || mode === 'projects') {
      const rows = filterApi.filterProjects(o.projects || [], query);
      if (rows.length) blocks.push({ key: 'projects', label: 'Projects', kind: 'projects', rows, collapsed: false });
    }
    // Снимки уже отобраны запросом на стороне buildSnapshotRows: у них своя
    // пара «заголовок раскладки и её сессии», и отбор строкой порознь порвал
    // бы её. trackerHere — то же условие, что у ^S.
    if ((mode === 'sessions' || mode === 'snapshots') && o.trackerHere) {
      const rows = o.snapshots || [];
      if (rows.length) blocks.push({ key: 'snapshots', label: 'Snapshots', kind: 'snapshots', rows, collapsed: false });
    }

    return blocks.map(block => {
      if (!COLLAPSED_LABELS.includes(block.label) || expanded.has(block.key)) return block;
      return { ...block, collapsed: true, rows: [collapsedRow(block)] };
    });
  }

  return { buildBlocks, collapsedRow, collapsedLabel };
});
