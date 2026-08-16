// Загружается дважды: как <script> в sessions.html и как модуль в тестах.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaleItems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SECONDS = { session: 3600, project: 86400 };

  /**
   * Достигла ли обычная сессия или проект своего порога старости.
   *
   * Нулевое и будущее время — неизвестное, а не старое. Неизвестный вид строки
   * тоже не затемняется: снимки и Zellij имеют другой смысл возраста.
   */
  function isStale(row, nowSec, stale, kind) {
    if (!stale || stale.enabled !== true || !SECONDS[kind]) return false;
    const rawLastActivity = row && row.lastActivity;
    if (typeof rawLastActivity !== 'number' || !Number.isFinite(rawLastActivity)) return false;
    const lastActivity = rawLastActivity;
    const now = Number(nowSec);
    const amount = Number(kind === 'project' ? stale.projectDays : stale.sessionHours);
    const threshold = amount * SECONDS[kind];
    return Number.isFinite(lastActivity)
      && lastActivity > 0
      && Number.isFinite(now)
      && now >= lastActivity
      && Number.isFinite(threshold)
      && threshold > 0
      && now - lastActivity >= threshold;
  }

  function staleClass(row, nowSec, stale, kind) {
    return isStale(row, nowSec, stale, kind) ? ' stale' : '';
  }

  return { isStale, staleClass };
});
