// Loaded twice: as a <script> in sessions.html and as a module in the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TaskbarHide = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // globalThis, а не `root`: та же дорога, что у cache-warn.js. Тег стоит
  // ниже session-windows.js — сосед берётся на загрузке.
  const windowsApi = typeof module === 'object' && module.exports
    ? require('./session-windows')
    : globalThis.SessionWindows;
  const glyphApi = typeof module === 'object' && module.exports
    ? require('./session-glyph')
    : globalThis.SessionGlyph;

  /*
   * Кнопки погашенных сессий на панели задач (спека
   * docs/superpowers/specs/2026-11-24-taskbar-hide-dimmed-design.md).
   *
   * Прячет кнопки служба windows11-manager — она хозяин кнопок окон, — а кто
   * погашен, знает только пикер. Поэтому пикер отдаёт трекеру **весь набор**
   * `{sessions: [<id>, …]}`, а служба заменяет им свой. Отмена бесплатна:
   * сессия выпала из набора — кнопка вернулась. Возит набор тот же
   * отправитель, что у мигания кеша (`createCacheWarnSender` в cache-warn.js).
   */

  const normHost = windowsApi.normHost;

  /**
   * Есть ли у карточки то, ради чего человеку нужна кнопка: ровно то, что
   * зажигает оранжевый кружок строки (`needsAttention` и не просмотрено), или
   * мигание кеша. Свой предикат разошёлся бы со строкой: кнопка пряталась бы
   * у сессии, у которой в списке горит кружок.
   */
  function hasSignal(row, warnIds) {
    return (glyphApi.needsAttention(row) && !row.agentSeen) || warnIds.has(row.id);
  }

  /**
   * Набор для панели задач: ключ `base|http` → `{target, body}`, и цель
   * в нём не больше одной — трекер **этой** машины (`configHost`).
   *
   * Окна соседних машин не трогаются: их набор шлёт пикер той машины, и два
   * пикера были бы двумя хозяевами одного набора на одном менеджере. Нет
   * трекера своей машины — слать некому, карта пустая.
   *
   * `rows` — строки buildSessionList **до** отсевов: прятать надо и то, что
   * список сейчас не показывает. `isDimmed` — предикат страницы, тот же, каким
   * гасится строка. В набор идёт id сессии, у которой каждая карточка с окном
   * на этой машине погашена и ни одна не несёт сигнала (вопрос, непросмотренный
   * review, мигающий кеш — `warnIds`). Каждая, а не любая: служба прячет по id,
   * то есть все окна сессии разом, и второе окно — несвёрнутое или со своим
   * «не смотрели» — осталось бы без кнопки вместе с первым.
   *
   * `enabled` не строго `true` — пустая карта: вернуть кнопки — дело
   * отправителя, он шлёт пустой список цели, которой в карте не стало.
   * Включено и прятать нечего — цель всё равно в карте с пустым списком:
   * повтор раз в пять минут держит службу в курсе.
   */
  function taskbarHideSets(rows, state, { enabled, configHost, isDimmed, warnIds } = {}) {
    const out = new Map();
    if (enabled !== true) return out;
    const mine = normHost(configHost);
    if (!mine) return out;
    const tracker = windowsApi.trackerHosts(state).find(e => normHost(e.host) === mine);
    if (!tracker) return out;
    const signals = warnIds instanceof Set ? warnIds : new Set();
    const dimmed = typeof isDimmed === 'function' ? isDimmed : () => false;

    // id → прятать ли; ложь, единожды выставленная, не перебивается.
    const verdict = new Map();
    let base = '';
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !row.id) continue;
      const own = windowsApi.windowsOf(row, state).filter(w => w && normHost(w.host) === mine);
      if (!own.length) continue;
      if (!base) {
        base = own.map(w => (typeof w.mqttBase === 'string' ? w.mqttBase.trim() : '')).find(Boolean) || '';
      }
      const hide = dimmed(row) && !hasSignal(row, signals);
      verdict.set(row.id, verdict.has(row.id) ? verdict.get(row.id) && hide : hide);
    }
    // Своих окон нет вовсе — база с записи машины: ключ цели не должен
    // прыгать от того, есть ли сейчас что прятать.
    if (!base && typeof tracker.mqttBase === 'string') base = tracker.mqttBase.trim();

    const sessions = [...verdict].filter(([, hide]) => hide).map(([id]) => id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const target = { base, http: windowsApi.httpForHost(state, configHost) };
    out.set(`${target.base}|${target.http}`, { target, body: { sessions } });
    return out;
  }

  return { taskbarHideSets };
});
