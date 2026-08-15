/** Справочник клавиш: то, что показывает модалка по кнопке `?` и по F1. */
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KeyReference = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const hotkeyApi = typeof module === 'object' && module.exports
    ? require('./action-hotkey')
    : globalThis.ActionHotkey;

  const { BUILTIN_SHORTCUTS, builtinGlyph, formatHotkey } = hotkeyApi;

  /**
   * Клавиши, которых нет и не может быть в `RESERVED_CODES`.
   *
   * Стрелки, Enter и Escape настроенному действию не достаются никогда:
   * `parseHotkey` принимает только буквы и цифры, и комбинации с этими
   * клавишами из конфига прийти не может вовсе. Поэтому список здесь второму
   * источнику правды не равен — разойтись ему не с чем.
   *
   * Мышь описана тут же, а не отдельной секцией: человек, открывший
   * справочник, ищет «как это сделать», а не «чем именно».
   */
  const NAVIGATION = [
    { key: '↑ / ↓', label: 'Move between rows' },
    { key: '← / →', label: 'Move between blocks (wide view)' },
    { key: 'Enter', label: 'Open the selected row' },
    { key: 'Esc', label: 'Hide the picker' },
    { key: 'F1', label: 'This list' },
    { key: 'Shift+click', label: 'Mark seen or unread' },
    { key: 'Right click', label: 'Session menu' },
  ];

  /** Строка справочника. `taken` рисуется зачёркнутой. */
  function row(key, label, taken) {
    return { key, label, taken: taken === true };
  }

  /**
   * Секции справочника.
   *
   * Встроенные клавиши берутся из `BUILTIN_SHORTCUTS` и только оттуда:
   * переписанные здесь заново, они разошлись бы с обработчиком молча — окно
   * обещало бы клавишу, которую никто не слушает. По этой же причине условие
   * показа `^S` приезжает в таблице признаком (`needsTracker`), а не
   * пересказывается тут своими словами.
   *
   * Пустая секция не возвращается вовсе: заголовок без строк обещает то,
   * чего нет.
   */
  function buildKeyReference(opts) {
    const o = opts || {};
    const actions = Array.isArray(o.actions) ? o.actions : [];
    const projects = Array.isArray(o.projects) ? o.projects : [];
    const taken = Array.isArray(o.hotkeysTaken) ? o.hotkeysTaken : [];
    // Признак «клавиша не встала» приезжает по каталогу проекта — тем же
    // ключом, каким его метит markHotkeysTaken.
    const takenCwds = new Set(taken.map(e => (e || {}).cwd).filter(Boolean));

    const shown = BUILTIN_SHORTCUTS.filter(s => !s.needsTracker || o.trackerHere === true);
    const sections = [
      {
        title: 'Session',
        rows: shown.filter(s => s.action).map(s => row(builtinGlyph(s.code), s.label)),
      },
      {
        title: 'Modes',
        rows: shown.filter(s => !s.action).map(s => row(builtinGlyph(s.code), s.label)),
      },
      { title: 'Navigation', rows: NAVIGATION.map(n => row(n.key, n.label)) },
      {
        // Действие без клавиши живёт только пунктом меню `^K`: строка о нём в
        // справочнике клавиш обещала бы клавишу, которой нет.
        title: 'Custom actions',
        rows: actions
          .filter(a => a && typeof a.hotkey === 'string' && a.hotkey.trim())
          .map(a => row(formatHotkey(a.hotkey), a.label || a.id || '')),
      },
      {
        // Отдельной секцией, потому что отличие настоящее: эти работают и
        // тогда, когда окна на экране нет вовсе.
        title: 'Global (work while the picker is hidden)',
        rows: [
          // Пустое поле значит «взять встроенное», а встроенное живёт в Rust,
          // где видно систему, и отсюда его не назвать. Показать пустую
          // клавишу — соврать точнее, чем промолчать.
          ...(typeof o.hotkey === 'string' && o.hotkey.trim()
            ? [row(formatHotkey(o.hotkey), 'Show the picker')] : []),
          ...(typeof o.projectsHotkey === 'string' && o.projectsHotkey.trim()
            ? [row(formatHotkey(o.projectsHotkey), 'Show the picker on projects')] : []),
          // Проектные хоткеи приезжают ответом агрегатора, а не из конфига:
          // список живёт у windows11-manager. Не вставшая клавиша остаётся в
          // списке зачёркнутой — убери её, и человек не отличит «не
          // настроено» от «отобрал сосед по системе», а это расследование
          // однажды заняло полдня.
          ...projects
            .filter(p => p && typeof p.hotkey === 'string' && p.hotkey.trim())
            .map(p => row(formatHotkey(p.hotkey), p.label || p.cwd || '', takenCwds.has(p.cwd))),
        ],
      },
    ];
    return sections.filter(s => s.rows.length);
  }

  return { buildKeyReference };
});
