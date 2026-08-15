// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UiState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const groupsApi = typeof module === 'object' && module.exports
    ? require('./session-groups')
    : globalThis.SessionGroups;

  /**
   * Вид списка, прочитанный из ~/.config/ccfzf-picker/ui.json.
   *
   * Файл пишет сам пикер, но правит его кто угодно и чем угодно, а испорченный
   * вид списка — это пикер, который открывается пустым или без нужных колонок,
   * и починить его изнутри уже нечем. Поэтому здесь не доверяется ничего:
   * незнакомая сортировка заменяется умолчанием, чужие ключи чекбоксов
   * выбрасываются, нелогические значения заменяются умолчанием своего ключа.
   *
   * Набор чекбоксов задаётся `defaults.toggles`: он же и определяет, какие
   * ключи вообще существуют. Так пропавший из интерфейса чекбокс не остаётся
   * жить в файле, а новый получает своё умолчание, а не `false`.
   */

  /**
   * Умолчания одной галки в двух осях.
   *
   * `list` — показывать ли колонку в строке списка (это и значила старая
   * плоская галка). `statusline` — выносить ли галку в статуслайн: место там
   * кончилось, и решать, что туда попадёт, стал человек.
   */
  function axesOf(fallback) {
    if (typeof fallback === 'boolean') return { list: fallback, statusline: false };
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    return { list: Boolean(base.list), statusline: Boolean(base.statusline) };
  }

  /**
   * Одна галка из файла.
   *
   * Булево значение — это старая форма ui.json, и понимать её обязательно:
   * иначе первый же запуск после обновления сбросил бы человеку все колонки, и
   * выглядело бы это потерей настроек, а не сменой формата. Значение старой
   * галки кладётся в `list` — она ровно это и значила.
   */
  function normalizeToggle(saved, fallback) {
    const def = axesOf(fallback);
    if (typeof saved === 'boolean') return { list: saved, statusline: def.statusline };
    if (!saved || typeof saved !== 'object') return def;
    return {
      list: typeof saved.list === 'boolean' ? saved.list : def.list,
      statusline: typeof saved.statusline === 'boolean' ? saved.statusline : def.statusline,
    };
  }

  // Раскладок две, и умолчания свёрнутости у них разные и по разным причинам:
  // в узкой история оттесняет живые сессии вниз, в широкой у неё своя колонка
  // и она никому не мешает. Один список на обе значил бы, что свёрнутая в
  // узком история опустошает колонку в широком.
  const COLLAPSE_LAYOUTS = ['narrow', 'wide'];

  /**
   * Свёрнутые секции из файла: только то, что человек трогал руками.
   *
   * Отсутствие ключа — не «развёрнута», а «как по умолчанию»: умолчание живёт
   * в коде (picker-sections.js), и так его можно менять, не переписывая людям
   * ui.json. Нелогические значения выбрасываются вместе с чужими раскладками —
   * файл правят чем угодно, а испорченный вид списка чинить изнутри нечем.
   */
  function normalizeFlagMap(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const layout of COLLAPSE_LAYOUTS) {
      const saved = src[layout] && typeof src[layout] === 'object' ? src[layout] : {};
      const one = {};
      for (const key of Object.keys(saved)) {
        if (typeof saved[key] === 'boolean') one[key] = saved[key];
      }
      out[layout] = one;
    }
    return out;
  }

  const normalizeCollapsed = normalizeFlagMap;

  /**
   * Спрятанные панели: та же форма, что у свёрнутости, и то же правило про
   * отсутствующий ключ — «как по умолчанию», то есть показывать.
   *
   * Отдельное поле, а не третье состояние свёрнутости: свернуть и спрятать —
   * разные просьбы. Свёрнутая панель остаётся строкой, по которой видно, что
   * она есть и сколько в ней; спрятанной на экране нет вовсе, и вернуть её
   * можно только из окна настроек. Поэтому же прячут её оттуда, а не
   * клавишей: случайно нажатая клавиша убрала бы панель без следа.
   */
  const normalizeHidden = normalizeFlagMap;

  // Колонок в широкой раскладке ровно три, и это свойство раскладки, а не
  // файла: прочитай пикер длину из ui.json — номер колонки стал бы зависеть
  // от содержимого файла, который правят чем угодно.
  const WIDE_COLUMNS = 3;

  /**
   * Ключи секций из файла: строки, и каждая ровно один раз.
   *
   * Задвоенный ключ — это спор о том, где стоит секция, а не две секции:
   * разрешается он в пользу первой записи, потому что список читается сверху
   * вниз и первое упоминание и есть то место, куда человек её перетащил.
   */
  function normalizeKeys(raw, seen) {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const key of src) {
      if (typeof key !== 'string') continue;
      const name = key.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }

  /**
   * Порядок секций из файла: своя половинка у каждой раскладки.
   *
   * Формы у половинок разные, и это не оплошность. В узком списке секции идут
   * одним потоком, и порядок — просто последовательность ключей. В широком
   * секцию можно перенести и в соседнюю колонку, поэтому порядок там — три
   * последовательности, по одной на колонку: так и колонка, и место внутри
   * неё записаны одной структурой, а разворот её колонка за колонкой даёт
   * ровно тот порядок чтения, по которому ходят `←/→`. Разъедься эти два
   * порядка — стрелка уводила бы не туда, куда смотрит глаз, и поймать это
   * тестом на одну функцию нельзя: врут они согласованно.
   *
   * Пустой список значит «как по умолчанию», а не «секций нет»: умолчание
   * живёт в коде (`buildSections`), и так его можно менять, не переписывая
   * людям ui.json. То же правило, что у `normalizeCollapsed`.
   *
   * Ключ, которого пикер не знает, здесь не выбрасывается — знать про набор
   * секций этот разбор не может вовсе: `remote:<host>` приходят и уходят
   * вместе с машинами, и выброси мы ключ уснувшего трекера, его место
   * забылось бы за один опрос. Незнакомое отсеивает уже `buildSections`, где
   * виден настоящий набор.
   */
  function normalizeOrder(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const wideSeen = new Set();
    const wide = [];
    const savedWide = Array.isArray(src.wide) ? src.wide : [];
    for (let i = 0; i < WIDE_COLUMNS; i++) {
      // Общий `wideSeen` на все колонки: одна секция не может стоять в двух
      // колонках сразу, и вторая запись про неё — спор, а не вторая секция.
      wide.push(normalizeKeys(savedWide[i], wideSeen));
    }
    return { narrow: normalizeKeys(src.narrow, new Set()), wide };
  }

  function normalizeUiState(raw, defaults) {
    const base = defaults || {};
    const baseToggles = base.toggles || {};
    const src = raw && typeof raw === 'object' ? raw : {};
    const srcToggles = src.toggles && typeof src.toggles === 'object' ? src.toggles : {};

    const toggles = {};
    for (const key of Object.keys(baseToggles)) {
      toggles[key] = normalizeToggle(srcToggles[key], baseToggles[key]);
    }
    return {
      sort: groupsApi.normalizeSort(src.sort),
      toggles,
      // Третье поле верхнего уровня, а не запись в toggles: у галки две оси
      // и чекбокс в статуслайне, а режим окна — не колонка. Нелогичное
      // значение читается как узкое окно: испорченный файл не должен
      // открывать окно, которого человек не просил.
      fullscreen: src.fullscreen === true,
      // Четвёртое поле верхнего уровня, рядом с sort/toggles/fullscreen.
      collapsed: normalizeCollapsed(src.collapsed),
      // Пятое, рядом с ними же: порядок секций, свой у каждой раскладки.
      order: normalizeOrder(src.order),
      // Шестое: спрятанные панели, той же формы, что и свёрнутость.
      hidden: normalizeHidden(src.hidden),
    };
  }

  /**
   * Что уходит в файл. Ровно то же, что читается: лишнего в ui.json пикер не
   * пишет — файл маленький и человекочитаемый, и заглянувший в него не должен
   * гадать, что из этого пикер и правда помнит.
   */
  function uiStateToSave(sort, toggles, fullscreen, collapsed, order, hidden) {
    return normalizeUiState(
      { sort, toggles, fullscreen, collapsed, order, hidden }, { toggles: toggles || {} });
  }

  /**
   * Плоская карта «показывать ли колонку» для рисовальщиков строк.
   *
   * Отдельная функция, а не второе поле состояния: рисовальщикам
   * (session-glyph) про статуслайн знать незачем, а держать две карты в
   * рассинхроне — вернейший способ показать колонку, которую выключили.
   */
  function listColumns(toggles) {
    const out = {};
    for (const key of Object.keys(toggles || {})) out[key] = Boolean((toggles[key] || {}).list);
    return out;
  }

  return { normalizeUiState, uiStateToSave, listColumns };
});
