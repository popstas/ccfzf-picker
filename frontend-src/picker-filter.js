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

  function filterSessions(groups, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map(g => ({ ...g, sessions: g.sessions.filter(s =>
        `${s.label} ${searchableCwd(s.cwd)}`.toLowerCase().includes(q)
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
    return list.filter(r =>
      `${r.label} ${searchableCwd(r.cwd)}`.toLowerCase().includes(q));
  }

  return { filterSessions, filterProjects, searchableCwd };
});
