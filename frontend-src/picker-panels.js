/** Панели списка: то, чем распоряжается вкладка Panels в настройках. */
// Loaded twice: as a <script> in both windows and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerPanels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WIDE_COLUMNS = 3;

  /**
   * Панели с постоянными ключами и их имена для окна настроек.
   *
   * Ключи те же, что у секций (`groupSessions` и `buildSections`), и другими
   * они быть не могут: по ним помнится и колонка, и свёрнутость, и спрятанность.
   *
   * Имена здесь свои, а не заголовки секций, и это не оплошность. Заголовок
   * зависит от содержимого — «Active sessions» без чужих машин и «Active local
   * sessions» с ними, — а в списке настроек строка обязана называться
   * одинаково всегда, иначе панель, которую человек прячет, называлась бы
   * по-разному в разные дни. Счёта в имени нет по той же причине.
   *
   * Порядок — тот, в котором панели собираются по умолчанию: список настроек
   * читается сверху вниз, и порядок сборки для него привычнее алфавита.
   *
   * Список один на обе раскладки, и чужие сессии в нём одна строка. Раньше у
   * неё стояла пометка `wideOnly`: склейка чужих машин жила только в широкой
   * раскладке, а в узкой каждая машина шла своим ключом `remote:<host>`. Теперь
   * склейка в обеих (`buildSections`, ветка `group.remote`), и постоянный ключ
   * `remote` — единственный, каким чужие сессии называются где бы то ни было.
   */
  const KNOWN_PANELS = [
    { key: 'live', label: 'Local sessions' },
    { key: 'remote', label: 'Remote sessions' },
    { key: 'past', label: 'History' },
    { key: 'zellij', label: 'Zellij' },
    { key: 'projects', label: 'Projects' },
    { key: 'snapshots', label: 'Snapshots' },
  ];

  /**
   * Панели с постоянными ключами в названной раскладке.
   *
   * Раскладка больше ничего не решает — список у обеих один, — но параметр
   * оставлен: он есть у всех соседних функций, и вызывающей стороне не надо
   * помнить, какая из них про раскладку знает, а какая нет.
   */
  function knownPanelsFor() {
    return KNOWN_PANELS.map(p => ({ key: p.key, label: p.label }));
  }

  // Ключ панели чужой машины из времён, когда узкий список делил их по машинам.
  // Панели с таким ключом нет теперь ни в одной раскладке, а в ui.json они
  // остались у всех, кто эти панели трогал.
  const STALE_HOST_KEY = /^remote:/;

  /**
   * Имя панели, которой нет в таблице.
   *
   * Такие бывают: история умеет делиться по рабочим столам (`past:2`). Окно
   * настроек про них не знает заранее — но если человек их уже трогал, они
   * лежат в ui.json, и промолчать о них значило бы показать список, из
   * которого не видно, откуда взялась настройка.
   */
  function labelForUnknown(key) {
    const name = String(key || '');
    if (name.startsWith('past:')) return `History: desktop ${name.slice('past:'.length)}`;
    return name;
  }

  /**
   * Свёрнута ли панель, если человек её не трогал.
   *
   * Спрашивать это обязательно: в узком списке история, проекты и снимки
   * приходят свёрнутыми по умолчанию, и галка «expanded», нарисованная без
   * оглядки на умолчание, показывала бы развёрнутыми три строки из пяти —
   * прямо противореча тому, что человек видит в пикере.
   *
   * Правило то же, что в `defaultCollapsed` (picker-sections.js), но считается
   * от ключа, а не от собранной секции: секций окно настроек не видит вовсе.
   * Второй источник правды тут неизбежен, поэтому он не молчаливый — сторож в
   * `test/picker-panels.test.js` сверяет обе функции на всех известных ключах.
   */
  /** Логическая половинка ui.json по ключу; нет записи — названное умолчание. */
  function flagOr(field, half, key, fallback) {
    const flags = ((field || {})[half]) || {};
    const saved = flags && typeof flags === 'object' ? flags[key] : undefined;
    return typeof saved === 'boolean' ? saved : fallback;
  }

  function defaultCollapsedFor(key, layout) {
    if (layout !== 'narrow') return false;
    const name = String(key || '');
    return name === 'past' || name.startsWith('past:')
      || name === 'projects' || name === 'snapshots';
  }

  /**
   * Ключи, про которые уже что-то записано в ui.json.
   *
   * Спрашивается всегда про одну раскладку: половинки у порядка разной формы
   * (в узкой один список ключей, в широкой три — по одному на колонку), а
   * смешивать их нельзя и по смыслу — спрятанная в широком режиме панель
   * ничего не говорит про узкий.
   */
  function keysInUi(ui, layout) {
    const state = ui && typeof ui === 'object' ? ui : {};
    const half = layout === 'narrow' ? 'narrow' : 'wide';
    const out = [];
    const push = (key) => {
      if (typeof key === 'string' && key && !out.includes(key)) out.push(key);
    };
    const order = ((state.order || {})[half]) || [];
    for (const item of Array.isArray(order) ? order : []) {
      // Узкая половинка — плоский список ключей, широкая — список колонок.
      if (Array.isArray(item)) for (const key of item) push(key);
      else push(item);
    }
    for (const field of ['collapsed', 'hidden']) {
      const flags = ((state[field] || {})[half]) || {};
      for (const key of Object.keys(flags && typeof flags === 'object' ? flags : {})) push(key);
    }
    return out;
  }

  /**
   * Колонка панели по назначенному порядку; ноль значит «как по умолчанию».
   *
   * Ноль, а не первая колонка: умолчание живёт в коде (`buildSections`
   * ставит колонку по смыслу секции), и подставь окно настроек единицу — оно
   * записало бы человеку в файл выбор, которого он не делал, и все панели
   * съехали бы в первую колонку.
   */
  function columnOf(ui, key) {
    const wide = (((ui || {}).order || {}).wide) || [];
    if (!Array.isArray(wide)) return 0;
    const at = wide.findIndex(column => Array.isArray(column) && column.includes(key));
    return at === -1 ? 0 : at + 1;
  }

  /**
   * Строки списка панелей для окна настроек.
   *
   * Известные панели идут первыми и всегда — даже те, которых сейчас нет на
   * экране: пустая история не повод прятать её настройку, иначе вернуть
   * спрятанную панель было бы нечем. Следом идут незнакомые ключи из ui.json.
   *
   * Незнакомые — это и есть цена выбранного устройства. Набор панелей
   * непостоянен (`past:<N>` приходят с рабочими столами), а окно настроек
   * ответа агрегатора не видит вовсе и второй дороги для данных между окнами
   * здесь не заведено. Поэтому рабочий стол появляется в списке только после
   * того, как его хоть раз свернули или перетащили в пикере: до этого про него
   * в ui.json нет ни строки, и взяться ей неоткуда.
   *
   * Ключи `remote:<host>` — исключение, и они выброшены. Это остаток прежнего
   * устройства узкого списка: панели с таким ключом нет теперь ни в одной
   * раскладке, а в ui.json они лежат у всех, кто эти панели трогал. Покажи их
   * окно — человек увидел бы строку «Remote: mac» рядом с настоящей «Remote
   * sessions» и настраивал бы то, чего на экране нет. Из файла они не
   * вычищаются: `buildSections` незнакомый ключ и так не находит, а чистка
   * переписывала бы человеку файл ради того, чего он не видит.
   *
   * Колонка есть только у широкой раскладки. В узком списке колонок нет вовсе,
   * и поле здесь не ноль, а отсутствует: ноль значил бы «колонка по
   * умолчанию», то есть обещал бы выбор, которого не существует.
   */
  function panelRows(ui, layout) {
    const state = ui && typeof ui === 'object' ? ui : {};
    const narrow = layout === 'narrow';
    const half = narrow ? 'narrow' : 'wide';
    const known = knownPanelsFor(layout);
    const knownKeys = new Set(known.map(p => p.key));
    const extra = keysInUi(state, layout)
      .filter(key => !knownKeys.has(key) && !STALE_HOST_KEY.test(key))
      .map(key => ({ key, label: labelForUnknown(key) }));
    return [...known, ...extra].map(panel => ({
      key: panel.key,
      label: panel.label,
      ...(narrow ? {} : { column: columnOf(state, panel.key) }),
      // Отсутствие ключа — «как по умолчанию», а не «развёрнута и показана»:
      // умолчание свёрнутости живёт в коде и в узком списке не пустое. То же
      // правило, что и во всём остальном ui.json.
      collapsed: flagOr(state.collapsed, half, panel.key,
        defaultCollapsedFor(panel.key, layout)),
      // А умолчание показа пустое в обеих раскладках: не спрятана.
      hidden: flagOr(state.hidden, half, panel.key, false),
    }));
  }

  /**
   * Переставить панель в названную колонку.
   *
   * Ноль значит «вернуть умолчание» — ключ уходит из порядка вовсе, и колонку
   * панели снова назначает смысл секции. Без этого выбор «по умолчанию» в
   * окне настроек было бы нечем выразить.
   *
   * Внутри колонки панель встаёт в конец: место внутри колонки задаётся
   * перетаскиванием, и подставлять сюда номер значило бы решать за человека
   * то, о чём он не спрашивал.
   */
  function withColumn(order, key, column) {
    const src = order && typeof order === 'object' ? order : {};
    const wide = [];
    const saved = Array.isArray(src.wide) ? src.wide : [];
    for (let i = 0; i < WIDE_COLUMNS; i++) {
      const column_i = Array.isArray(saved[i]) ? saved[i] : [];
      wide.push(column_i.filter(k => k !== key));
    }
    const at = Number(column);
    if (Number.isInteger(at) && at >= 1 && at <= WIDE_COLUMNS) wide[at - 1].push(key);
    return { ...src, wide };
  }

  return {
    KNOWN_PANELS, WIDE_COLUMNS, knownPanelsFor, panelRows, withColumn, columnOf,
    labelForUnknown, defaultCollapsedFor,
  };
});
