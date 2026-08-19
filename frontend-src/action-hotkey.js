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
   * Буква `terminal` — `t`, и вместе с ней действию достаётся `^T`: таблица
   * тут одна на подпись в меню и на прямую клавишу, и взять из неё половину
   * нельзя. Прежде этого действия здесь не было вовсе, и запись гласила, что
   * его и не нужно — на маке открытие сессии и есть открытие терминала. Это
   * по-прежнему верно про Enter, но пункт отвечает на другой вопрос: шелл в
   * том же каталоге, без агента.
   *
   * Буква `seen` — `d`, а не напрашивавшаяся `v` («viewed»): прямые клавиши
   * гасят событие через preventDefault, и `^V` перестал бы вставлять в поле
   * поиска. Вставляют туда как раз то, что теперь ищется, — начало id сессии.
   *
   * Буква `pr` — `g`, а не напрашивавшаяся `p`: `^P` отдан ярлыку режима
   * проектов. Мнемоника у `g` своя — GitHub, куда действие и ведёт.
   */
  const BUILTIN_ACTION_KEYS = {
    new: 'n', terminal: 't', pr: 'g', unread: 'u', seen: 'd', attach: 'r', info: 'i',
    comment: 'm',
  };

  /**
   * Буква на пункт меню `^K` — в том же порядке, что и сами пункты.
   *
   * Одна функция на два дела: ею подписывают пункт и ею же находят пункт по
   * нажатой клавише. Два счёта разошлись бы ровно там, где это дороже всего —
   * меню обещало бы букву, которая ничего не делает.
   *
   * Встроенные берут букву из BUILTIN_ACTION_KEYS, настроенные — из своего
   * `menuKey`. Из Ctrl-хоткея настроенного действия букву взять нельзя:
   * ^O занят сортировкой, ^P/^L/^H/^S — режимами, то есть у «открыть в
   * Cursor» глобальной комбинации не бывает вовсе, а в меню `o` свободна. В
   * этом весь смысл буквы без Ctrl.
   *
   * Только латиница: нажатие сверяется по `e.code` (`KeyO`), и ни кириллицу,
   * ни цифру им не назвать.
   */
  function menuKeys(actions) {
    const used = new Set();
    return (Array.isArray(actions) ? actions : []).map((action) => {
      const a = action || {};
      const raw = BUILTIN_ACTION_KEYS[a.id] || a.menuKey || '';
      const key = String(raw).trim().toLowerCase();
      if (!/^[a-z]$/.test(key) || used.has(key)) return '';
      used.add(key);
      return key;
    });
  }

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
    terminal: 'Open terminal',
    pr: 'Open PR',
    unread: 'Mark unread',
    seen: 'Mark seen',
    attach: 'Copy reptyr command',
    info: 'Session info',
    comment: 'Edit comment',
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
   * Клавиши, которые годятся в глобальный хоткей.
   *
   * Список сверен с `parse_key` в `global-hotkey` (`src/hotkey.rs`) — тем
   * самым разбором, через который строка из `config.yaml` проходит в Rust.
   * Всё, чего там нет (`F13`, `ContextMenu`, `IntlBackslash`), записалось бы
   * в файл строкой, которую пикер молча откатит на встроенное умолчание: окно
   * настроек ответило бы «saved», а клавиша не работала бы — ровно тот тихий
   * отказ, ради ухода от которого контрол записи и заведён.
   *
   * `Escape` в список не входит намеренно, хотя разбор его знает: им контрол
   * записи отменяют, и записать его тем же нажатием было бы нельзя.
   */
  const RECORDABLE_CODE = new RegExp('^(?:'
    + 'Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]'
    + '|Space|Enter|Tab|Backspace|Delete|Insert'
    + '|Home|End|PageUp|PageDown'
    + '|Arrow(?:Up|Down|Left|Right)'
    + '|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash'
    + '|Semicolon|Quote|Comma|Period|Slash'
    + '|Numpad[0-9]|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter|Equal)'
    + ')$');

  /**
   * Модификаторы в строку — порядком, которым написаны умолчания в Rust.
   *
   * `Control+Alt+Super+Shift` — тот же порядок и те же слова, что у
   * `DEFAULT_HOTKEY_ACCELERATOR` и соседей в `main.rs`
   * (`Control+Alt+Super+C`, `Super+Shift+C`, `Control+Super+F10`).
   * Парсеру порядок безразличен, а человеку, сверяющему поле с `config.yaml`,
   * — нет: два написания одной комбинации пришлось бы читать по буквам.
   *
   * `Super`, а не `Cmd` и не `Win`: слова `Win` разбор в Rust не знает вовсе,
   * а `Super` работает на обеих системах — им же написаны все умолчания.
   */
  const RECORD_MODIFIERS = [
    ['ctrlKey', 'Control'], ['altKey', 'Alt'], ['metaKey', 'Super'], ['shiftKey', 'Shift'],
  ];

  /**
   * Нажатие — в строку для `config.yaml`, либо пустая строка.
   *
   * Пустая значит «этим нажатием комбинацию не записать»: голая клавиша без
   * модификатора (глобальный хоткей на ней отобрал бы букву у всей системы),
   * один модификатор без клавиши (он приходит сюда сам по себе, пока человек
   * набирает комбинацию) или клавиша, которой не знает разбор в Rust.
   *
   * Имя клавиши — `e.code` без приставки `Key`/`Digit`: `KeyC` → `C`,
   * `Digit1` → `1`. Разбор принимает обе формы, а короткая — та, которой уже
   * написаны умолчания и подсказки. Остальные коды уходят как есть: `F10`,
   * `ArrowUp`, `Comma` — это и есть словарь `parse_key`.
   *
   * По `e.code`, а не `e.key`, и по той же причине, что у `matchesHotkey`:
   * `key` — напечатанный знак, и в русской раскладке та же клавиша пришла бы
   * буквой «с». Хоткей же регистрируется по физической клавише.
   */
  /**
   * Модификаторы, зажатые в этот миг, — тем же письмом и порядком.
   *
   * Нужны показу «по мере набора»: человек держит Ctrl и Super, обычной
   * клавиши ещё нет, и контрол обязан показать, что нажатие видно. Считается
   * той же таблицей, что и сама комбинация: второй список разошёлся бы с
   * первым, и записанное отличалось бы от показанного.
   */
  function heldModifiers(event) {
    if (!event) return [];
    return RECORD_MODIFIERS.filter(([flag]) => Boolean(event[flag])).map(([, name]) => name);
  }

  function comboFromEvent(event) {
    if (!event || !RECORDABLE_CODE.test(String(event.code || ''))) return '';
    const mods = RECORD_MODIFIERS.filter(([flag]) => Boolean(event[flag])).map(([, name]) => name);
    if (!mods.length) return '';
    const key = String(event.code).replace(/^(?:Key|Digit)/, '');
    return [...mods, key].join('+');
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
    parseHotkey, formatHotkey, builtinGlyph, isReserved, matchesHotkey, menuKeys,
    comboFromEvent, heldModifiers,
  };
});
