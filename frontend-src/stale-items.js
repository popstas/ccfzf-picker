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
   *
   * `minimized` — второй повод, кроме возраста: окно сессии свёрнуто на этой
   * машине. Считает его зовущий (`SessionWindows.minimizedHere`), потому что
   * знание про машину живёт там, а не здесь. Возраст при этом не спрашивается
   * вовсе: свёрнутое окно — не догадка по времени, а факт, и свежая сессия со
   * свёрнутым окном гасится наравне со старой.
   *
   * Выключателю `stale.enabled` свёрнутость подчиняется так же, как возраст:
   * галка «dim stale» — единственное, чем человек гасит затемнение целиком, и
   * строка, тускнеющая вопреки снятой галке, читалась бы как поломка.
   *
   * Сжатие (`agentCompactAt`, метку ставит агрегатор, пока сжатую сессию не
   * продолжили) — не повод гасить, а активность: возраст отсчитывается от
   * более позднего из `lastActivity` и сжатия. Решение владельца 24.11.2026
   * заменило прежнее «гаснет сразу» (20.11): сразу погашенная сжатая сессия
   * теряла и кнопку на панели задач (галка `hide dimmed windows`), а это
   * нелогично; нетронутая же гаснет обычным порогом после сжатия. Отдельный
   * отсчёт нужен потому, что хук на `/compact` свою отметку не двигает
   * (`KEEP_UPDATED` в `wt-progress.sh`), и `lastActivity` старше сжатия.
   * Только у сессии: у проекта своего сжатия нет.
   */
  function isStale(row, nowSec, stale, kind, minimized) {
    if (!stale || stale.enabled !== true || !AGE_KINDS.has(kind)) return false;
    if (minimized === true) return true;
    const compactAt = kind === 'session' ? Number(row && row.agentCompactAt) : 0;
    const rawActivity = row && row.lastActivity;
    const activity = typeof rawActivity === 'number' && Number.isFinite(rawActivity) ? rawActivity : null;
    const compacted = Number.isFinite(compactAt) && compactAt > 0 ? compactAt : null;
    if (activity === null && compacted === null) return false;
    const lastActivity = Math.max(activity ?? 0, compacted ?? 0);
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

  function staleClass(row, nowSec, stale, kind, minimized) {
    return isStale(row, nowSec, stale, kind, minimized) ? ' stale' : '';
  }

  return { isStale, staleClass };
});
