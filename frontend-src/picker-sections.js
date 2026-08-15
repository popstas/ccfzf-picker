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
  // Счёт снимков берётся у соседа, а не пишется здесь второй раз: считать его
  // надо по заголовкам дней (строки свёрнутого дня в список не попадают), и
  // разойдись копии — заголовок секции показывал бы одно число, а режим `/s`
  // другое. Загрузка это выдерживает: picker-snapshots.js стоит в sessions.html
  // раньше (606 против 610) и в prepare-frontend.js тоже.
  const snapshotsApi = typeof module === 'object' && module.exports
    ? require('./picker-snapshots')
    : globalThis.PickerSnapshots;

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

  /**
   * Заголовок секции: подпись и счёт.
   *
   * Одна функция на обе раскладки. Счёт приписывается здесь, а не в
   * `groupSessions`: там он попадал бы в `label`, а по `label` считался ключ —
   * и уснувшая сессия сбрасывала бы свёрнутость секции.
   *
   * Даты последней сессии в заголовке больше нет. Свёрнутая история носила
   * хвост `· last Aug 12`, и обещал он больше, чем стоил: у истории сотни
   * строк за все времена, и дата самой свежей из них не отвечает ни на один
   * вопрос, с которым в историю приходят, — а место в узком заголовке
   * занимала. Сама `lastActivity` никуда не делась, она видна у каждой строки.
   */
  function sectionHeaderText(section) {
    return `${section.label} - ${section.count}`;
  }

  // Заголовок склеенной секции: тот же, каким чужие сессии назывались до
  // деления по машинам. Имени машины в нём быть не может — секция одна на все.
  const REMOTE_LABEL = 'Active remote sessions';
  // Ключ склеенной секции не зависит от набора машин: по ключу помнится и
  // отрисовка, и свёрнутость, и считайся он от имён — уснувшая на соседней
  // машине сессия пересобирала бы колонку целиком.
  const REMOTE_KEY = 'remote';
  // Ключ своих живых сессий — тот же, что даёт им `activeGroups`. Здесь он
  // нужен затем, что пустую панель этой секции список заводит сам (см. ниже),
  // и написанный вторым литералом ключ разошёлся бы с первым молча: панель
  // помнила бы свёрнутость и колонку под чужим именем.
  const LIVE_KEY = 'live';

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
   * groupSessions один в один, а чужие машины склеиваются в одну секцию в
   * обеих. От раскладки зависят ровно две вещи — номер колонки и умолчание
   * свёрнутости; обе перечислены ниже поимённо и больше нигде не решаются.
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
        // Чужие группы склеиваются в одну секцию — в обеих раскладках.
        // Узнаётся чужая группа по своей пометке (`group.remote`), а не по
        // заголовку: заголовок носит имя машины — данные с той стороны, — и
        // разбор текста сделал бы это имя форматом, который нельзя менять.
        //
        // Сперва склейка жила только в широкой: там секция занимает колонку, и
        // пять трекеров дали бы пять узких колонок, — а в узком списке строки
        // идут сверху вниз, и лишний заголовок ничего не стоит. Цена у деления
        // всё же нашлась, и не в заголовках: ключ `remote:<host>` непостоянен,
        // он приходит и уходит вместе с машиной. Панели с таким ключом нет в
        // `order`, пока её не перетащили, и после первого же перетаскивания
        // чего-нибудь другого она уезжает в конец узкого списка — под историю,
        // проекты и снимки, то есть с глаз. Постоянный `remote` этим не болеет,
        // а машины по-прежнему названы подзаголовками внутри блока.
        if (group.remote) {
          if (!remote) {
            remote = {
              key: REMOTE_KEY, label: REMOTE_LABEL, kind: 'sessions',
              rows: [], count: 0, past: false,
              ...(wide ? { column: COLUMN_NEAR } : {}),
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
          past: group.past === true,
          ...(wide ? { column: group.past ? COLUMN_PAST : COLUMN_LIVE } : {}),
        });
      }
    }

    // Свои живые сессии показываются всегда — даже когда их нет ни одной.
    //
    // Это главная панель списка, и в широкой раскладке ей отдана первая
    // колонка. Пустая колонка не рисуется (иначе она отняла бы у соседей долю
    // ширины ради пустоты), и на машине без единой своей живой сессии первая
    // колонка исчезала целиком: три назначенных колонки давали на экране две,
    // и выглядело это потерянной настройкой, а не отсутствием сессий. Поймано
    // на маке, где своих сессий обычно и нет.
    //
    // Решение это про показ, а не про группировку, поэтому живёт здесь, а не в
    // `groupSessions`: та рассказывает, что приехало, и выдумывать группу,
    // которой в данных нет, ей не по чину.
    //
    // Только в режиме без префикса и только на пустом запросе. Под запросом
    // секция без совпадений исчезает у всех одинаково, и пустой блок посреди
    // найденного был бы шумом; под `/l` про пустоту прямо говорит подпись
    // «No sessions on this machine.», и заголовок с нулём рядом с ней —
    // второй раз одно и то же.
    //
    // Заголовок называется по тому же правилу, что и в `activeGroups`: без
    // чужих машин он «Active sessions», с ними — «Active local sessions».
    // Разойдись эти два имени, панель называлась бы по-разному в зависимости
    // от того, пуста она или нет.
    if (mode === 'sessions' && !String(query).trim()
      && !sections.some(s => s.key === LIVE_KEY)) {
      // Ключ один на все машины в обеих раскладках, поэтому и вопрос один.
      const hasRemote = sections.some(s => s.key === REMOTE_KEY);
      sections.unshift({
        key: LIVE_KEY, label: hasRemote ? 'Active local sessions' : 'Active sessions',
        kind: 'sessions',
        // Подпись, а не строка списка: у `block-subhead` нет ни `data-index`,
        // ни класса `row`, поэтому ни стрелки, ни клик её не видят, и Enter на
        // ней невозможен. Тот же приём, что у подзаголовка машины внутри
        // склеенного блока, — и по той же причине она не входит в `count`.
        rows: [{ kind: 'block-subhead', key: 'live:none', label: 'No local sessions.' }],
        count: 0, past: false,
        ...(wide ? { column: COLUMN_LIVE } : {}),
      });
    }

    // Проекты и снимки — секции того же списка, а не отдельные режимы: их
    // видно сразу, свёрнутыми, и префикс оставляет на экране одну из них.
    if (mode === 'sessions' || mode === 'projects') {
      const rows = filterApi.filterProjects(o.projects || [], query);
      if (rows.length) {
        sections.push({
          key: 'projects', label: 'Projects', kind: 'projects',
          rows, count: rows.length, past: false,
          ...(wide ? { column: COLUMN_NEAR } : {}),
        });
      }
    }
    // Снимки уже отобраны запросом на стороне buildSnapshotRows: у них своя
    // пара «заголовок раскладки и её сессии», и отбор строкой порознь порвал
    // бы её. trackerHere — то же условие, что у ^S.
    //
    // Счёт здесь — не длина списка строк, а число снимков: строки идут тремя
    // видами (день, снимок, сессия), и день можно свернуть — `rows.length`
    // менялся бы на каждое сворачивание, будто снимки исчезают.
    if ((mode === 'sessions' || mode === 'snapshots') && o.trackerHere) {
      const rows = o.snapshots || [];
      if (rows.length) {
        sections.push({
          key: 'snapshots', label: 'Snapshots', kind: 'snapshots',
          rows, count: snapshotsApi.snapshotCount(rows), past: false,
          ...(wide ? { column: COLUMN_PAST } : {}),
        });
      }
    }

    // Спрятанные панели уходят до всего остального: их нет на экране вовсе,
    // и ни счёта, ни заголовка от них не остаётся. Прятать — просьба сильнее
    // сворачивания, и потому она переживает непустой запрос: свернуть значит
    // «покажи одной строкой», спрятать — «убери». Живёт она только в окне
    // настроек, случайной клавишей её не поставить, так что и удивиться
    // пропаже неоткуда.
    //
    // Исключение одно — префикс, назвавший панель поимённо (`/h`, `/p`, `/s`).
    // Он спрашивает про неё прямо, и молчать в ответ значило бы то же, что
    // молчащий Enter. То же исключение уже сделано для свёрнутости.
    const hidden = o.hidden && typeof o.hidden === 'object' ? o.hidden : {};
    const named = mode !== 'sessions';
    const shown = named ? sections : sections.filter(s => hidden[s.key] !== true);

    // Непустой запрос разворачивает всё, и это сильнее любой памяти о
    // свёрнутости: секция, свёрнутая под запросом, прятала бы ровно то, что
    // человек только что искал, — а о том, что оно там, ему узнать неоткуда.
    // Причина та же, по которой разворачивает префикс.
    const searching = String(query).trim() !== '';
    // Свернуть можно только ту секцию, чья свёрнутость не назначена сверху.
    // Под запросом и под префиксом она назначена, и Enter на заголовке не дал
    // бы ничего видимого: `collapsed: true` тут же затёрлось бы обратно.
    // Молчащий переключатель хуже отсутствующего, поэтому там заголовок —
    // подпись, а не строка списка (см. `sectionItem` в sessions.html), и в
    // `rows` он не попадает вовсе, как заголовок группы до всей этой затеи.
    const foldable = mode === 'sessions' && !searching;
    const shaped = shown.map(section => ({
      ...section,
      foldable,
      collapsed: !foldable ? false
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
    //
    // Всё это — умолчание, поверх которого ложится порядок, назначенный
    // человеком перетаскиванием заголовка. Назначенный порядок применяется
    // всегда, в том числе под запросом и под префиксом, где перетаскивать
    // нельзя: иначе секции прыгали бы местами на первую же набранную букву.
    if (!wide) return applyNarrowOrder(shaped, o.order);
    return applyWideOrder(shaped, o.order);
  }

  // «Места не назначено» — не ноль и не бесконечность: на бесконечности
  // разность двух неназначенных даёт NaN, и сортировка молча перестаёт
  // сравнивать. Большое конечное число сравнивается честно и даёт ноль,
  // отправляя пару в запасное сравнение по порядку сборки.
  const UNPLACED = Number.MAX_SAFE_INTEGER;

  /** Место ключа в списке; неназванный — в конец. */
  function placeOf(keys, key) {
    const at = keys.indexOf(key);
    return at === -1 ? UNPLACED : at;
  }

  /**
   * Узкий список в назначенном порядке.
   *
   * Названные секции идут в названном порядке, остальные — следом, в порядке
   * сборки. То же правило, что у `normalizeCollapsed`: чего в файле нет — то
   * по умолчанию, а умолчание для порядка и есть конец списка. Иначе новый
   * вид секции пришлось бы дописывать людям в ui.json.
   *
   * Незнакомый ключ отсеивается сам собой: `indexOf` его просто не находит у
   * секций, которых нет. Выбрасывать его из файла нельзя — `past:<N>` приходят
   * и уходят вместе с рабочими столами, и место опустевшего забылось бы за
   * один опрос. Тем же путём молча доживают свой век ключи `remote:<host>` из
   * времён, когда узкий список делил чужие машины по одной.
   */
  function applyNarrowOrder(sections, order) {
    const keys = Array.isArray(order) ? order : [];
    if (!keys.length) return sections;
    return sections
      .map((section, at) => ({ section, at }))
      .sort((a, b) => (placeOf(keys, a.section.key) - placeOf(keys, b.section.key))
        || (a.at - b.at))
      .map(({ section }) => section);
  }

  /**
   * Широкая раскладка в назначенном порядке.
   *
   * Здесь порядок называет и колонку, и место внутри неё: человек волен
   * перенести секцию в соседнюю колонку, и умолчание «колонку задаёт смысл
   * секции» отступает перед этим выбором. Секция, которую не переносили,
   * остаётся в своей колонке по смыслу — иначе одно перетаскивание сгоняло бы
   * весь список в первую колонку.
   *
   * Порядок результата — колонка за колонкой, сверху вниз внутри колонки, то
   * есть ровно порядок чтения, по которому ходят `←/→`.
   */
  function applyWideOrder(sections, order) {
    const columns = Array.isArray(order) ? order.filter(Array.isArray) : [];
    const placed = sections.map((section, at) => {
      // Колонка из файла главнее колонки по смыслу — но только для той
      // секции, которую в файле назвали.
      const col = columns.length ? columns.findIndex(keys => keys.includes(section.key)) : -1;
      return {
        section: col === -1 ? section : { ...section, column: col + 1 },
        at,
        place: col === -1 ? UNPLACED : columns[col].indexOf(section.key),
        // Свёрнутая — в низ своей колонки, поверх любого назначенного места.
        // Свёрнутая секция это одна строка заголовка, а доля колонки ей
        // достаётся такая же, как развёрнутому соседу: измерено, свёрнутая
        // история занимала 260 пикселей из 417 при содержимом в 25, и в
        // WebKit то же — 347 из 504. Полколонки пустоты, а рядом сосед,
        // которому не хватило.
        //
        // Опускание живёт здесь, а не в CSS: по этому же списку считается
        // `rows` и порядок блоков, по которому ходят `←/→`. Подвинь мы блок
        // одним оформлением — стрелка уводила бы не туда, куда смотрит глаз.
        sunk: section.collapsed === true ? 1 : 0,
      };
    });
    return placed
      .sort((a, b) => (a.section.column - b.section.column)
        || (a.sunk - b.sunk) || (a.place - b.place) || (a.at - b.at))
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
