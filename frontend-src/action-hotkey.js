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
   */
  const BUILTIN_ACTION_KEYS = { new: 'n', pr: 'p', unread: 'u', attach: 'r', info: 'i' };

  /**
   * Буквы, занятые окном пикера при одном Ctrl или Cmd. Меню (^K) — не
   * действие, поэтому в BUILTIN_ACTION_KEYS его нет, а клавишу оно занимает.
   */
  const RESERVED_CODES = [
    ...Object.values(BUILTIN_ACTION_KEYS).map(k => `Key${k.toUpperCase()}`),
    'KeyK',
    // Не действие, а ярлык: ставит `/a ` в начало строки поиска. Клавишу он
    // всё равно занимает, и настроенному действию её отдавать нельзя. Цена
    // известна: `^A` в поле поиска перестал быть «выделить всё».
    'KeyA',
  ];

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

  return { BUILTIN_ACTION_KEYS, RESERVED_CODES, parseHotkey, formatHotkey, isReserved, matchesHotkey };
});
