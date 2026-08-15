/** Панели широкого режима: то, чем распоряжается вкладка Panels в настройках. */
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
   */
  const KNOWN_PANELS = [
    { key: 'live', label: 'Local sessions' },
    { key: 'remote', label: 'Remote sessions' },
    { key: 'past', label: 'Not running' },
    { key: 'zellij', label: 'Zellij' },
    { key: 'projects', label: 'Projects' },
    { key: 'snapshots', label: 'Snapshots' },
  ];

  const KNOWN_KEYS = new Set(KNOWN_PANELS.map(p => p.key));

  /**
   * Имя панели, которой нет в таблице.
   *
   * Такие бывают: история умеет делиться по рабочим столам (`past:2`), а
   * чужие машины в узком списке идут своими ключами (`remote:<host>`). Окно
   * настроек про них не знает заранее — но если человек их уже трогал, они
   * лежат в ui.json, и промолчать о них значило бы показать список, из
   * которого не видно, откуда взялась настройка.
   */
  function labelForUnknown(key) {
    const name = String(key || '');
    if (name.startsWith('remote:')) return `Remote: ${name.slice('remote:'.length)}`;
    if (name.startsWith('past:')) return `Not running: desktop ${name.slice('past:'.length)}`;
    return name;
  }

  /** Ключи, про которые уже что-то записано в ui.json. */
  function keysInUi(ui) {
    const state = ui && typeof ui === 'object' ? ui : {};
    const out = [];
    const push = (key) => { if (key && !out.includes(key)) out.push(key); };
    const wideOrder = ((state.order || {}).wide) || [];
    for (const column of Array.isArray(wideOrder) ? wideOrder : []) {
      for (const key of Array.isArray(column) ? column : []) push(key);
    }
    for (const field of ['collapsed', 'hidden']) {
      const half = ((state[field] || {}).wide) || {};
      for (const key of Object.keys(half && typeof half === 'object' ? half : {})) push(key);
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
   */
  function panelRows(ui) {
    const state = ui && typeof ui === 'object' ? ui : {};
    const extra = keysInUi(state)
      .filter(key => !KNOWN_KEYS.has(key))
      .map(key => ({ key, label: labelForUnknown(key) }));
    return [...KNOWN_PANELS, ...extra].map(panel => ({
      key: panel.key,
      label: panel.label,
      column: columnOf(state, panel.key),
      // Отсутствие ключа — «как по умолчанию»: развёрнута и показана. То же
      // правило, что и во всём остальном ui.json.
      collapsed: ((state.collapsed || {}).wide || {})[panel.key] === true,
      hidden: ((state.hidden || {}).wide || {})[panel.key] === true,
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

  return { KNOWN_PANELS, WIDE_COLUMNS, panelRows, withColumn, columnOf, labelForUnknown };
});
