// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickerSnapshots = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: тот виден только внешней функции шима, а внутрь
  // factory не передаётся.
  const filterApi = typeof module === 'object' && module.exports
    ? require('./picker-filter')
    : globalThis.PickerFilter;

  /**
   * Строки режима снимков — плоским списком, без механики сворачивания.
   *
   * Заголовок снимка и его сессии идут одним потоком: группы в списке уже
   * есть (ключ заголовка вида `g:snap:<id>`), и заводить рядом раскрытие
   * значило бы объяснять человеку второй способ навигации там, где хватает
   * стрелок.
   */

  /** Имя строки: каталог проекта, а не полный путь. */
  function projectBasename(session) {
    const cwd = session?.cwd != null ? String(session.cwd).trim() : '';
    if (cwd) {
      const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return String(session?.title ?? '').trim() || '—';
  }

  /**
   * Час и дата снимка. Часы впереди: снимков за день несколько, и различает их
   * именно время, а дата повторяется.
   *
   * Нет отметки — показывается id: строка без опознавательных знаков хуже
   * строки с непонятным, но своим именем.
   */
  function formatSnapshotTime(snapshot) {
    const sec = Number(snapshot?.created);
    if (Number.isFinite(sec) && sec > 0) {
      const d = new Date(sec * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}`
        + ` · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    return String(snapshot?.id ?? '');
  }

  /**
   * Сессии, у которых окно открыто прямо сейчас.
   *
   * Считается по тому же ответу агрегатора, что и весь список: поле `window`
   * приезжает от оконного трекера. Отдельного вызова, как в windows-mqtt, тут
   * не нужно — всё уже пришло.
   */
  function openIdsFromState(state) {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    return new Set(sessions.filter(s => s && s.window).map(s => s.id));
  }

  /**
   * Строки снимков, отобранные запросом.
   *
   * Отбор идёт по строкам сессий; заголовок сам по себе не ищется — искать по
   * дате незачем, а совпадение по ней оставляло бы на экране снимок, ни одна
   * сессия которого запросу не отвечает. Снимок без подошедших уходит целиком.
   */
  function buildSnapshotRows(snapshots, openIds, query) {
    const open = openIds instanceof Set ? openIds : new Set(openIds ?? []);
    const q = String(query ?? '').trim().toLowerCase();
    const out = [];
    for (const snap of snapshots ?? []) {
      const all = snap?.sessions ?? [];
      const rows = all
        .map(s => ({
          kind: 'snapshot-session',
          key: `snap:${snap.id}:${s.id}`,
          id: s.id,
          snapshotId: snap.id,
          cwd: String(s?.cwd ?? ''),
          label: projectBasename(s),
          open: open.has(s.id),
        }))
        // Сосед обязателен, без запасной ветки: подмена заглушкой молча
        // теряет обрезку `/home`-префикса и не даёт неверному порядку
        // тегов упасть — а именно на этом падении держится сторож порядка.
        .filter(r => !q || `${r.label} ${filterApi.searchableCwd(r.cwd)}`.toLowerCase().includes(q));
      // Снимок без сессий — ни строки: восстанавливать в нём нечего, а
      // заголовок обещал бы обратное.
      if (!rows.length) continue;
      out.push({
        kind: 'snapshot',
        key: `g:snap:${snap.id}`,
        id: snap.id,
        label: formatSnapshotTime(snap),
        total: all.length,
        missing: all.filter(s => !open.has(s.id)).length,
      });
      out.push(...rows);
    }
    return out;
  }

  return { buildSnapshotRows, openIdsFromState, formatSnapshotTime, projectBasename };
});
