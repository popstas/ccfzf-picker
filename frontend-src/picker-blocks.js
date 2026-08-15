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

  // Колонки широкого режима. Раскладка задана человеком и держится на смысле
  // строк, а не на их числе: слева то, с чем работают сейчас, посередине то,
  // что рядом, справа то, к чему возвращаются.
  //
  //   1 — свои живые сессии (и зелий): главный список, ему отдана вся высота;
  //   2 — чужие живые сессии, под ними проекты;
  //   3 — история, под ней снимки.
  //
  // Номер живёт здесь, а не в CSS: колонку выбирают по тому же признаку, по
  // которому блок собран (`group.remote`, `group.past`), а разбор заголовка
  // сделал бы видимую человеку строку форматом.
  const COLUMN_LIVE = 1;
  const COLUMN_NEAR = 2;
  const COLUMN_PAST = 3;

  // История приходит развёрнутой: сворачивание заводилось ради того, чтобы
  // «что было раньше» не оттесняло вниз «что работает сейчас», а со своей
  // колонкой она никого и не оттесняет. Механизм цел и работает по просьбе
  // (`opts.collapsed`): строка-переключатель, её Enter и подпись со счётом на
  // месте.

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

  // Заголовок склеенного блока: тот же, каким чужие сессии назывались до
  // деления по машинам. Имени машины в нём быть не может — колонка одна на все.
  const REMOTE_LABEL = 'Active remote sessions';
  // Ключ склеенного блока не зависит от набора машин: по ключу помнится
  // отрисовка блока, и считайся он от имён — уснувшая на соседней машине
  // сессия пересобирала бы колонку целиком.
  const REMOTE_KEY = 'g:remote';

  /**
   * Подзаголовок машины внутри склеенного блока чужих сессий.
   *
   * Склейка убрала заголовки групп, а вопрос «на какой машине» осталась —
   * ради него деление по машинам и заводили. Поэтому имя машины возвращается
   * строкой внутри блока: колонка одна, а разделение видно.
   *
   * Строка эта — подпись, а не строка списка: выбрать её нельзя, Enter на ней
   * не сработает, и в `rows` она не попадает вовсе (см. `subheadItem` в
   * sessions.html).
   */
  function subheadRow(group) {
    return {
      kind: 'block-subhead',
      key: `sub:${group.host}`,
      label: `${group.host} - ${group.sessions.length}`,
    };
  }

  /**
   * Блоки широкого режима.
   *
   * Блоки сессий приезжают из groupSessions один в один — с единственным
   * исключением: чужие группы склеиваются обратно в один блок. Своего правила
   * группировки у режима по-прежнему нет, есть правило раскладки — блок
   * занимает колонку, и пять трекеров дали бы пять узких колонок на то, что
   * человек читает как одно «не здесь». В узком списке строки идут сверху
   * вниз, лишний заголовок там ничего не стоит, и деление по машинам живёт
   * там.
   *
   * Чужая группа узнаётся по своей пометке (`group.remote`), а не по
   * заголовку: заголовок носит имя машины — данные с той стороны, — и разбор
   * текста сделал бы это имя форматом, который нельзя менять.
   *
   * Отбор идёт теми же filterSessions/filterProjects, что и в узком списке:
   * запрос без префикса отбирает строки во всех блоках сразу, и блок, где не
   * нашлось ничего, исчезает.
   */
  function buildBlocks(opts) {
    const o = opts || {};
    const mode = o.mode || 'sessions';
    const query = o.query || '';
    const collapsed = new Set(o.collapsed || []);
    const blocks = [];

    if (mode === 'sessions') {
      // Склеенный блок встаёт на место первой чужой группы: порядок групп
      // задан списком, и уводить чужие сессии в конец значило бы показывать их
      // не там, где они стоят в узком списке.
      let remote = null;
      let remoteCount = 0;
      for (const group of filterApi.filterSessions(o.groups || [], query)) {
        if (group.remote) {
          if (!remote) {
            remote = {
              key: REMOTE_KEY, label: REMOTE_LABEL, kind: 'sessions',
              rows: [], collapsed: false, column: COLUMN_NEAR,
            };
            blocks.push(remote);
          }
          // Подзаголовок перед каждой машиной — в том же массиве строк, что и
          // сессии: обход блока один, и вторая дорога для подписей разошлась бы
          // с первой на первой же правке.
          remote.rows = [...remote.rows, subheadRow(group), ...group.sessions];
          remoteCount += group.sessions.length;
          continue;
        }
        blocks.push({
          key: `g:${group.label}`, label: group.label, kind: 'sessions',
          rows: group.sessions, collapsed: false,
          column: group.past ? COLUMN_PAST : COLUMN_LIVE,
          past: group.past === true,
        });
      }
      // Счёт — по сессиям, а не по строкам: подзаголовки в него не входят.
      if (remote) remote.label = `${REMOTE_LABEL} - ${remoteCount}`;
    }

    // Проекты и снимки — блоки того же ряда, а не отдельные режимы: в широком
    // окне они помещаются рядом с сессиями. Префикс при этом смысла не теряет,
    // он оставляет на экране один блок.
    if (mode === 'sessions' || mode === 'projects') {
      const rows = filterApi.filterProjects(o.projects || [], query);
      if (rows.length) {
        blocks.push({
          key: 'projects', label: 'Projects', kind: 'projects',
          rows, collapsed: false, column: COLUMN_NEAR,
        });
      }
    }
    // Снимки уже отобраны запросом на стороне buildSnapshotRows: у них своя
    // пара «заголовок раскладки и её сессии», и отбор строкой порознь порвал
    // бы её. trackerHere — то же условие, что у ^S.
    if ((mode === 'sessions' || mode === 'snapshots') && o.trackerHere) {
      const rows = o.snapshots || [];
      if (rows.length) {
        blocks.push({
          key: 'snapshots', label: 'Snapshots', kind: 'snapshots',
          rows, collapsed: false, column: COLUMN_PAST,
        });
      }
    }

    const shaped = blocks.map(block => {
      if (!block.past || !collapsed.has(block.key)) return block;
      return { ...block, collapsed: true, rows: [collapsedRow(block)] };
    });
    // Порядок блоков — порядок чтения: колонка за колонкой, сверху вниз внутри
    // колонки. По этому же порядку ходят `←/→` (moveBetweenBlocks), и разъедься
    // он с видимым, стрелка уводила бы не туда, куда смотрит глаз. Сортировка
    // устойчива, поэтому внутри колонки блоки остаются в порядке сборки:
    // чужие сессии выше проектов, история выше снимков.
    return shaped
      .map((block, at) => ({ block, at }))
      .sort((a, b) => (a.block.column - b.block.column) || (a.at - b.at))
      .map(({ block }) => block);
  }

  /** Индексы строк одного блока, в порядке показа. */
  function blockIndexes(rows, block) {
    const out = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].block === block) out.push(i);
    return out;
  }

  /**
   * `↑/↓` — внутри своего блока, с упором в края.
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
   * `←/→` — в соседний блок, на строку с тем же порядковым номером.
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

  return { buildBlocks, collapsedRow, collapsedLabel, moveInBlocks, moveBetweenBlocks };
});
