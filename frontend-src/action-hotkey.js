/** Клавиши действий пикера: встроенная таблица и разбор комбинаций из конфига. */
// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActionHotkey = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Одна таблица «id встроенного действия ⇄ буква» на всё: подписи в меню ^K и
   * прямые клавиши в sessions.html читают именно её. Раньше она лежала прямо в
   * sessions.html; сюда переехала затем, чтобы разбор конфига мог свериться с
   * ней и не выдать настроенному действию уже занятую комбинацию.
   *
   * Действия `terminal` здесь нет намеренно: на маке открытие сессии и есть
   * открытие терминала, оно висит на Enter и на клике.
   *
   * Буква `seen` — `d`, а не напрашивавшаяся `v` («viewed»): прямые клавиши
   * гасят событие через preventDefault, и `^V` перестал бы вставлять в поле
   * поиска. Вставляют туда как раз то, что теперь ищется, — начало id сессии.
   *
   * Буква `pr` — `g`, а не напрашивавшаяся `p`: `^P` отдан ярлыку режима
   * проектов. Мнемоника у `g` своя — GitHub, куда действие и ведёт.
   */
  const BUILTIN_ACTION_KEYS = { new: 'n', pr: 'g', unread: 'u', seen: 'd', attach: 'r', info: 'i' };

  /**
   * Подписи встроенных действий для справочника клавиш.
   *
   * Слова взяты у меню `^K` (`availableActions` в session-actions.js), а не
   * придуманы заново: одно действие, названное в двух местах по-разному,
   * читается как два разных. Там, где меню называет строку по её содержимому
   * (`Open PR #123`), справочник берёт общую форму — он статичен и ни про
   * какую строку не знает.
   */
  const ACTION_LABELS = {
    new: 'New session',
    pr: 'Open PR',
    unread: 'Mark unread',
    seen: 'Mark seen',
    attach: 'Copy reptyr command',
    info: 'Session info',
  };

  /**
   * Клавиши окна, которые не являются действиями.
   *
   * Строки в меню `^K` у них нет — они переключают режим или раскладку, — но
   * клавишу они занимают ровно так же, и настроенному действию её отдавать
   * нельзя: встроенная ветка перехватит первой, и действие молча не сработает.
   */
  const BUILTIN_MODE_KEYS = [
    { code: 'KeyK', label: 'Session menu' },
    // Ставит `/p ` в начало строки поиска. Не режим и не переключатель:
    // состояние живёт в самом тексте.
    { code: 'KeyP', label: 'Projects' },
    // Ярлыки остальных режимов, у которых клавиша есть. `/r` клавиши не
    // получил намеренно — к чужим сессиям отдельно ходят реже, чем к своим и
    // к истории, а каждая буква отнимается у поля поиска насовсем.
    { code: 'KeyL', label: 'Local sessions' },
    // Цена `^H` известна и принята: на macOS это системная emacs-привязка
    // «удалить символ слева» в текстовом поле, и прямые клавиши гасят событие
    // через preventDefault. Backspace и Delete работают, теряется только она.
    { code: 'KeyH', label: 'History' },
    // Показывается только там, где трекер жив: подсказка про режим, которого
    // нет, обманывает так же, как молчащий Enter. Признак стоит здесь, в
    // таблице, а не проверкой по месту в справочнике: пересказанное своими
    // словами условие разошлось бы с настоящим.
    { code: 'KeyS', label: 'Snapshots', needsTracker: true },
    // Переключает раскладку списка. Действием не является, но клавишу
    // занимает — отдать её настроенному действию значило бы, что встроенная
    // ветка перехватит первой, и действие молчит.
    { code: 'KeyF', label: 'Wide view' },
    // Общесистемная привычка открывать настройки. В `isReserved` эта запись
    // не значит ничего — parseHotkey принимает только буквы и цифры, и
    // `Comma` из конфига прийти не может вовсе, — но в справочнике клавиша
    // нужна, а таблица здесь одна на оба применения.
    { code: 'Comma', label: 'Settings' },
  ];

  /**
   * Единственная таблица клавиш окна: и справочник, и `RESERVED_CODES`.
   *
   * Двух списков тут быть не может. Написанный руками второй разошёлся бы с
   * первым молча и в обе стороны: справочник обещал бы клавишу, которую никто
   * не слушает, либо незанятая буква досталась бы настроенному действию,
   * которое встроенная ветка съедала бы первой. За эту ошибку в проекте уже
   * заплачено дважды — списком `c v x z` и правилом про `KeyF`, — и правило
   * про `FILTER_KEYS`, считанный из `TOGGLE_CHECKS`, стоит в CLAUDE.md ровно
   * по этой причине.
   */
  const BUILTIN_SHORTCUTS = [
    ...Object.entries(BUILTIN_ACTION_KEYS).map(([id, key]) => ({
      code: `Key${key.toUpperCase()}`,
      label: ACTION_LABELS[id],
      action: id,
    })),
    ...BUILTIN_MODE_KEYS,
  ];

  /** Буквы, занятые окном пикера при одном Ctrl или Cmd. */
  const RESERVED_CODES = BUILTIN_SHORTCUTS.map(s => s.code);

  /**
   * Встроенная клавиша — в подсказку: `KeyK` → `^K`.
   *
   * `^`, а не `⌃` и не `⌘`: встроенные подсказки пишутся так с самого начала,
   * а ловят эти ветки и Ctrl, и Cmd — назвать одну из них значило бы соврать
   * на другой системе.
   */
  const CODE_GLYPHS = { Comma: ',' };

  function builtinGlyph(code) {
    const name = String(code || '');
    return `^${CODE_GLYPHS[name] || name.replace(/^Key/, '')}`;
  }

  const MODIFIERS = {
    ctrl: 'ctrl', control: 'ctrl',
    cmd: 'meta', command: 'meta', super: 'meta', meta: 'meta', win: 'meta',
    alt: 'alt', option: 'alt',
    shift: 'shift',
  };

  /**
   * Имя модификатора — во флаг, либо пустая строка.
   *
   * Через hasOwnProperty, а не простым `MODIFIERS[name]`: иначе `constructor+E`
   * находит функцию в цепочке прототипов, разбирается как настоящая
   * комбинация — и остаётся хоткеем без единого модификатора, то есть голой
   * буквой, которая должна была уйти в строку поиска.
   */
  function modifierFlag(part) {
    const name = String(part).toLowerCase();
    return Object.prototype.hasOwnProperty.call(MODIFIERS, name) ? MODIFIERS[name] : '';
  }

  /**
   * `Ctrl+Shift+E` — в то, с чем можно сверить событие клавиатуры.
   *
   * Непонятная строка даёт `null`, а не исключение: конфиг правит человек, и
   * опечатка в одной комбинации не должна лишать его пикера. Вызывающий на
   * `null` оставляет действие в меню, но без клавиши.
   *
   * Комбинация без модификаторов отвергается: фокус в окне всегда стоит в поле
   * поиска, и голая буква ушла бы в фильтр, а не в действие.
   *
   * Модификаторы `Ctrl` и `Cmd` — разные и взаимозаменяемыми не считаются, в
   * отличие от встроенных клавиш. Конфиг всё равно свой на каждой машине, и
   * угадывать за человека, что он имел в виду, здесь не за чем.
   */
  function parseHotkey(str) {
    if (typeof str !== 'string' || !str.trim()) return null;
    const parts = str.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    const key = parts[parts.length - 1];
    const out = { code: '', ctrl: false, meta: false, alt: false, shift: false };
    for (const part of parts.slice(0, -1)) {
      const flag = modifierFlag(part);
      if (!flag) return null;
      out[flag] = true;
    }

    if (/^[A-Za-z]$/.test(key)) out.code = `Key${key.toUpperCase()}`;
    else if (/^[0-9]$/.test(key)) out.code = `Digit${key}`;
    else return null;

    return out;
  }

  /**
   * Комбинация — в подсказку: `Ctrl+Shift+E` → `^⇧E`.
   *
   * Порядок символов **фиксированный**, а не тот, что в конфиге: `Shift+Ctrl+E`
   * и `Ctrl+Shift+E` — одна комбинация, и два разных вида заставляли бы сверять
   * её по буквам. Это отменяет прежнее правило «показывать строку из конфига
   * как есть»; расхождение с написанием в файле выбрано сознательно, ради
   * единого вида по всему окну.
   *
   * `^` для Ctrl, а не `⌃`: встроенные подсказки (`^K`, `^R`) пишутся так с
   * самого начала, и вводить рядом второй знак того же смысла незачем.
   *
   * Разбор свой, а не через parseHotkey: тот принимает только буквы и цифры,
   * а проектные хоткеи в конфиге — F11 и F12. Неразобранная строка отдаётся
   * как есть: конфиг правит человек, и опечатка не должна стирать подсказку.
   */
  const MODIFIER_GLYPHS = [['meta', '⌘'], ['ctrl', '^'], ['alt', '⌥'], ['shift', '⇧']];

  function formatHotkey(str) {
    if (typeof str !== 'string' || !str.trim()) return '';
    const raw = str.trim();
    const parts = raw.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return raw;
    const key = parts[parts.length - 1];
    const flags = { ctrl: false, meta: false, alt: false, shift: false };
    for (const part of parts.slice(0, -1)) {
      const flag = modifierFlag(part);
      if (!flag) return raw;
      flags[flag] = true;
    }
    const glyphs = MODIFIER_GLYPHS.filter(([f]) => flags[f]).map(([, g]) => g).join('');
    // Однобуквенная клавиша поднимается в верхний регистр, `F12` остаётся как
    // есть: у неё регистр — часть имени.
    return glyphs + (key.length === 1 ? key.toUpperCase() : key);
  }

  /**
   * Занята ли комбинация самим окном пикера.
   *
   * Считается занятой только форма «один Ctrl или Cmd плюс буква»: именно её
   * ловят встроенные обработчики. Та же буква с Shift или Alt свободна.
   */
  function isReserved(parsed) {
    if (!parsed) return false;
    if (parsed.alt || parsed.shift) return false;
    if (parsed.ctrl === parsed.meta) return false;
    return RESERVED_CODES.includes(parsed.code);
  }

  /**
   * Сверка события с разобранной комбинацией.
   *
   * По `e.code`, а не `e.key`: key — это напечатанный знак, и в русской
   * раскладке ^R приходит как «к». Физическая клавиша от раскладки не зависит.
   *
   * Модификаторы сверяются все четыре, включая отсутствующие: иначе `Ctrl+E`
   * срабатывал бы и на `Ctrl+Shift+E`, отбирая комбинацию у соседнего действия.
   */
  function matchesHotkey(event, parsed) {
    if (!event || !parsed || !parsed.code) return false;
    return event.code === parsed.code
      && Boolean(event.ctrlKey) === parsed.ctrl
      && Boolean(event.metaKey) === parsed.meta
      && Boolean(event.altKey) === parsed.alt
      && Boolean(event.shiftKey) === parsed.shift;
  }

  return {
    BUILTIN_ACTION_KEYS, BUILTIN_SHORTCUTS, RESERVED_CODES,
    parseHotkey, formatHotkey, builtinGlyph, isReserved, matchesHotkey,
  };
});
