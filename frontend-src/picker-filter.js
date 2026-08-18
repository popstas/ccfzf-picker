// Loaded twice: as a <script> in sessions.html and as a module in the tests.
// The project has no bundler, and duplicating the filter to make it testable
// would be worse than this shim.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerFilter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Префикс домашней директории Linux не участвует в поиске: иначе «home»
  // совпадает с каждой сессией под /home/<user>/.... Сам каталог проекта
  // `.../home` и ярлык с именем home по-прежнему находятся.
  function searchableCwd(cwd) {
    return String(cwd ?? '').replace(/^\/home(?=\/|$)/i, '');
  }

  // Id участвует в отборе только началом, в отличие от имени и пути: он
  // длинный и случайный, и вхождение посередине давало бы ложные попадания.
  function matchesId(id, q) {
    return String(id ?? '').toLowerCase().startsWith(q);
  }

  /**
   * Раскладка ЙЦУКЕН → QWERTY, по позиции клавиши.
   *
   * Только буквы: знаки препинания сюда не входят намеренно. `.` → `/`
   * выглядит полезным для путей, но запрос из одной точки превратился бы в
   * запрос из одной косой черты — то есть нашёл бы каждый путь разом.
   */
  const PUNTO_RU = {
    й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p',
    ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l',
    я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm',
    ё: '`', ж: ';', э: "'", б: ',', ю: '.', х: '[', ъ: ']',
  };

  /**
   * Запрос, переложенный из русской раскладки в латинскую, — или пустая
   * строка, если кириллицы в нём нет вовсе.
   *
   * Переводится **запрос**, а не строки списка: запрос один, строк сотни, и
   * перевод обратим. Обратной половины (латиница → кириллица) нет: кириллицы
   * в именах сессий и путях не бывает, а заведённая «на всякий случай» она
   * давала бы ложные попадания.
   */
  function puntoRu(q) {
    let has = false;
    let out = '';
    for (const ch of String(q ?? '')) {
      const mapped = PUNTO_RU[ch];
      if (mapped) has = true;
      out += mapped || ch;
    }
    return has ? out : '';
  }

  /**
   * Единственный отбор по тексту на весь пикер: сессии, проекты и снимки.
   *
   * Совпадение по «исходный ИЛИ переложенный» — иначе `home`, набранное
   * верно, перестало бы находить само себя. Три копии `includes(q)` тут и
   * были причиной завести общую функцию: перевод, положенный в две из трёх,
   * дал бы поиск, который работает в сессиях и молчит в снимках.
   *
   * `q` приходит уже приведённым к нижнему регистру и обрезанным — так его
   * готовят все три звонящих.
   */
  function matchesText(text, q) {
    if (!q) return true;
    const hay = String(text ?? '').toLowerCase();
    if (hay.includes(q)) return true;
    const punto = puntoRu(q);
    return Boolean(punto) && hay.includes(punto);
  }

  function filterSessions(groups, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return groups;
    return groups
      // Имя окна в стоге третьим: `label` приходит из заголовка транскрипта, а
      // человек ищет сессию по тому имени, которым сам её завёл, — и оно живёт
      // только в заголовке окна (см. windowNameHtml). Комментарий — четвёртым,
      // и по той же причине, только сильнее: его человек пишет сам, своими
      // словами, то есть ровно теми, по которым потом и ищет.
      //
      // `?? ''` обязателен у обоих: ни окна, ни комментария у строки может не
      // быть вовсе, и undefined уехало бы в стог словом, которое нашло бы
      // разом всю историю.
      .map(g => ({ ...g, sessions: g.sessions.filter(s =>
        matchesText(
          `${s.label} ${searchableCwd(s.cwd)} ${s.windowTitle ?? ''} ${s.comment ?? ''}`, q)
        || matchesId(s.id, q)) }))
      .filter(g => g.sessions.length > 0);
  }

  /**
   * Отбор проектов. Тот же searchableCwd, что и у сессий: `/home` из пути
   * выброшен, иначе «home» совпадает со всем сразу.
   *
   * Плоский список, а не группы: у проектов группировки нет — их порядок задаёт
   * агрегатор (свежие сверху), и переставлять его здесь незачем.
   */
  function filterProjects(rows, query) {
    const list = Array.isArray(rows) ? rows : [];
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(r => matchesText(`${r.label} ${searchableCwd(r.cwd)}`, q));
  }

  return { filterSessions, filterProjects, searchableCwd, matchesText };
});
