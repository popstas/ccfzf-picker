// Загружается дважды: как <script> в sessions.html и как модуль в тестах.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaleItems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Виды строк, у которых вообще есть смысл «возраста»: снимки и Zellij сюда
  // не входят — множество, а не множитель часов, чтобы читающий не принял
  // его за секунды в дне и не восстановил удалённый дневной порог.
  const AGE_KINDS = new Set(['session', 'project']);

  /**
   * Достигла ли обычная сессия или проект своего порога старости.
   *
   * Нулевое и будущее время — неизвестное, а не старое. Неизвестный вид строки
   * тоже не затемняется: снимки и Zellij имеют другой смысл возраста.
   */
  function isStale(row, nowSec, stale, kind) {
    if (!stale || stale.enabled !== true || !AGE_KINDS.has(kind)) return false;
    const rawLastActivity = row && row.lastActivity;
    if (typeof rawLastActivity !== 'number' || !Number.isFinite(rawLastActivity)) return false;
    const lastActivity = rawLastActivity;
    const now = Number(nowSec);
    const amount = Number(kind === 'project' ? stale.projectHours : stale.sessionHours);
    // Порог — не ранняя граница по amount: только произведение способно
    // переполниться до Infinity (amount = 1e308), и ловит это только
    // проверка threshold ниже.
    const threshold = amount * 3600;
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
